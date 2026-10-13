import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { reconocerCotidiano, nombreCercano, type IntencionCotidiana } from "./dialogo/cotidiano";
import type { RespuestaConversar } from "./conversar";
import { cargarCatalogoNavegacion } from "./catalogo";
import { crearRouterNavegador } from "./router";
import { crearAlmacenContexto } from "./contexto";

const grupos = {
  saludo: ["Hola WOBi", "Hey, ¿qué tal?", "Buenos días, ¿me puedes echar una mano?", "Hola Wobi cómo estás me puedes ayudar con algo", "Qué tal WOBi, hola", "Holaaa Woby", "Hola Guapi", "Wobi hola", "Hola Wobby qué tal"],
  estado: ["¿Me escuchas?", "¿Estás disponible ahora?", "¿Cómo te encuentras hoy?", "Oye, ¿todo bien?", "¿Cómo va todo?"],
  ayuda: ["Por favor, necesito que me ayudes", "¿Me echas una mano con algo?", "¿Qué puedo preguntarte?", "¿Para qué sirves?", "No sé por dónde empezar", "¿Me podrías orientar un poquito?", "¿Qué opciones puedes ofrecer?", "Wobi puedes ayudarme a encontrar algo para mí", "¿Puedes encontrar algo para mí?", "Necesito un poco de apoyo", "¿Qué puedes encontrar?", "Me puedes ayudar con algo", "Ayúdame con algo", "Qué sabes hacer"],
  presentacion: ["¿Me puedes decir quién eres?", "¿Cómo te llamas?", "Preséntate, por favor", "Puedes presentarte", "Sí preséntate Wobi", "Te puedes presentar hay alguien que te quiere conocer", "¿Eres un asistente?", "Wobi, ¿qué eres?"],
  identidad: ["¿Sabes quién soy?", "¿Recuerdas mi nombre?", "¿Me reconoces en esta sesión?", "¿Cómo me llamo?", "¿Qué usuario soy?"],
  gracias: ["Muchísimas gracias por tu ayuda", "Mil gracias, eres muy amable", "Te agradezco mucho", "Gracias WOBi"],
  despedida: ["Gracias y hasta luego", "Hablamos luego", "Nos vemos mañana", "Chao WOBi"],
  aclaracion: ["No entendí, ¿me lo puedes explicar más sencillo?", "Vamos paso a paso", "Explícame un poquito mejor", "No comprendo"],
  animo: ["Estoy un poco perdido", "Hoy estoy cansado", "Estoy bien, gracias"],
};
for (const [intencion, frases] of Object.entries(grupos)) test("variaciones cotidianas: " + intencion, () => {
  for (const frase of frases) assert.ok(reconocerCotidiano(frase)?.intenciones.includes(intencion as IntencionCotidiana), frase);
});
test("la cortesía no absorbe consultas específicas ni instrucciones", () => {
  for (const frase of ["hola abre seguros", "me puedes ayudar con los gastos de Nuria", "hola cuánto gastamos hoy", "gracias borra todo", "hola procesa una transferencia", "hola soy Ana", "cuéntame la capital de Francia", "hola muéstrame correos"]) assert.equal(reconocerCotidiano(frase), null, frase);
  assert.equal(nombreCercano("Carlos Gonzalez"), "Carlos");
  assert.equal(nombreCercano("<script>Carlos</script>"), undefined);
});

test("HTTP: nombres de cada sesión, contexto separado y cortesía sin perder las opciones pendientes", async () => {
  const almacen = crearAlmacenContexto();
  const app = express(); app.use(express.json());
  app.use("/nav", crearRouterNavegador({
    autorizar: async () => true, almacenContexto: almacen,
    identidad: async req => req.get("X-Test-Session") === "ana" ? { modo: "solo_lectura", chatId: 2, nombre: "Ana Pérez" } : { modo: "solo_lectura", chatId: 1, nombre: "Carlos Gonzalez" },
    catalogo: cargarCatalogoNavegacion,
  }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const send = async (texto: string, id?: string, sesion = "carlos", device = "dispositivo-prueba-uno") => {
    const response = await fetch("http://127.0.0.1:" + address.port + "/nav/conversar", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Test-Session": sesion, "X-Cerebro-Device": device },
      body: JSON.stringify({ texto, companyId: "WOBA", conversacionId: id, nombre: "Intruso", nombreSesion: "Intruso" }),
    });
    assert.equal(response.status, 200); return await response.json() as RespuestaConversar;
  };
  try {
    const hola = await send("Hola, cómo estás, me puedes ayudar con algo");
    assert.match(hola.resumen, /¡Hola, Carlos!/); assert.match(hola.resumen, /Claro, te ayudo/); assert.doesNotMatch(hola.resumen, /Intruso/);
    const si = await send("sí", hola.conversacionId); assert.match(si.resumen, /Carlos/); assert.match(si.resumen, /paso a paso/);
    const nombre = await send("¿Sabes quién soy?", si.conversacionId); assert.match(nombre.resumen, /como Carlos/);
    const ana = await send("¿Quién soy?", nombre.conversacionId, "ana"); assert.match(ana.resumen, /como Ana/); assert.doesNotMatch(ana.resumen, /Carlos/); assert.notEqual(ana.conversacionId, nombre.conversacionId);
    const ajeno = await send("y tú", hola.conversacionId, "carlos", "dispositivo-prueba-dos"); assert.doesNotMatch(ajeno.resumen, /Aquí estoy/);
    const repetir = await send("Repíteme lo que dijiste", nombre.conversacionId); assert.match(repetir.resumen, /como Carlos/);
    const nav = await send("seguros o corporate");
    assert.ok(nav.tipo === "aclaracion"); assert.ok(nav.opciones.length > 1);
    const gracias = await send("mil gracias", nav.conversacionId); assert.match(gracias.resumen, /Carlos/);
    const eleccion = await send("el primero", gracias.conversacionId); assert.ok(eleccion.tipo === "destino"); assert.equal(eleccion.capabilityId, nav.opciones[0].capabilityId);
    assert.doesNotMatch(JSON.stringify(almacen.volcar()), /Carlos|Ana|Intruso|Rep.teme/);
    const denegado = await send("hola abre finanzas"); assert.equal(denegado.tipo, "no_disponible"); assert.equal(denegado.motivo, "permiso_insuficiente");
  } finally { server.closeAllConnections(); server.close(); }
});
