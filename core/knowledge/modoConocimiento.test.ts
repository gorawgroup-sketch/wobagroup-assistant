import test from "node:test";
import assert from "node:assert/strict";
import {
  alternarEmpresaConocimiento,
  capturarArchivoEnModoConocimiento,
  capturarTextoEnModoConocimiento,
  parsearComandoConocimiento,
  prepararCapturaDeTexto,
  tecladoModoConocimiento,
  type DependenciasModoConocimiento,
} from "./modoConocimiento";

function deps(modo: { empresas: string[] } | undefined, extra: Partial<DependenciasModoConocimiento> = {}) {
  const guardados: Array<{ texto: string; autor?: string; empresas?: string[] }> = [];
  const mensajes: string[] = [];
  const renovados: string[][] = [];
  const d: DependenciasModoConocimiento = {
    leerModo: async () => (modo ? { empresas: modo.empresas, expiraEn: Date.now() + 1000 } : undefined),
    renovarModo: async (_chat, empresas) => { renovados.push(empresas); },
    guardar: async (texto, autor, empresas) => { guardados.push({ texto, autor, empresas }); },
    transcribir: async () => "Contenido leído del documento",
    enviar: async (_chat, texto) => { mensajes.push(texto); },
    ...extra,
  };
  return { d, guardados, mensajes, renovados };
}

test("reconoce el comando del menú", () => {
  for (const t of ["/conocimiento", "/conocimiento@WobiBot", " /aprender ", "/CONOCIMIENTO"]) assert.equal(parsearComandoConocimiento(t), true, t);
  for (const t of ["conocimiento", "/conocimiento algo", "/soportes", "captura esto"]) assert.equal(parsearComandoConocimiento(t), false, t);
});

test("alternar empresas: varias a la vez, y sin ninguna se vuelve a General", () => {
  assert.deepEqual(alternarEmpresaConocimiento(["General"], "WOBA"), ["WOBA", "General"]);
  assert.deepEqual(alternarEmpresaConocimiento(["WOBA", "General"], "General"), ["WOBA"]);
  assert.deepEqual(alternarEmpresaConocimiento(["WOBA"], "WOBA"), ["General"]);
  assert.deepEqual(alternarEmpresaConocimiento(["EWORKS"], "Footprint"), ["EWORKS", "Footprint"]);
});

test("el teclado marca las seleccionadas y trae «Terminar»", () => {
  const filas = tecladoModoConocimiento(["WOBA"]).flat();
  assert.ok(filas.some((b) => b.text === "✅ WOBA" && b.callback_data === "conoc_t:WOBA"));
  assert.ok(filas.some((b) => b.text === "EWORKS"));
  assert.ok(filas.some((b) => b.callback_data === "conoc_fin"));
});

test("un enlace se guarda como referencia con su nota; el texto normal, tal cual", () => {
  assert.deepEqual(prepararCapturaDeTexto("https://wobagroup.com/guia"), { contenido: "Enlace: https://wobagroup.com/guia", resumen: "https://wobagroup.com/guia", conEnlaces: true });
  const conNota = prepararCapturaDeTexto("Guía de marca https://wobagroup.com/guia  y también https://x.com/a");
  assert.match(conNota.contenido, /^Enlaces: https:\/\/wobagroup.com\/guia , https:\/\/x.com\/a\nNota: Guía de marca y también$/);
  assert.deepEqual(prepararCapturaDeTexto("  El cliente paga a 30 días  "), { contenido: "El cliente paga a 30 días", resumen: "El cliente paga a 30 días", conEnlaces: false });
});

test("sin modo activo no se atiende ni se guarda nada (el mensaje sigue su camino normal)", async () => {
  const { d, guardados, mensajes } = deps(undefined);
  assert.equal(await capturarTextoEnModoConocimiento(1, "hola", "Carlos", d), false);
  assert.equal(await capturarArchivoEnModoConocimiento(1, { bytes: Buffer.from("x"), nombre: "a.pdf", mimeType: "application/pdf" }, d), false);
  assert.equal(guardados.length, 0);
  assert.equal(mensajes.length, 0);
});

test("con el modo activo, el texto se guarda para las empresas elegidas y se renueva el plazo", async () => {
  const { d, guardados, mensajes, renovados } = deps({ empresas: ["WOBA", "Footprint"] });
  assert.equal(await capturarTextoEnModoConocimiento(1, "El IVA de hospedaje es 10 %", "Carlos", d), true);
  assert.deepEqual(guardados, [{ texto: "El IVA de hospedaje es 10 %", autor: "Carlos", empresas: ["WOBA", "Footprint"] }]);
  assert.deepEqual(renovados, [["WOBA", "Footprint"]]);
  assert.match(mensajes[0], /Guardado como conocimiento \(WOBA, Footprint\)/);
});

test("un enlace avisa de que no se leyó la página", async () => {
  const { d, guardados, mensajes } = deps({ empresas: ["General"] });
  await capturarTextoEnModoConocimiento(1, "https://wobagroup.com/guia", "Carlos", d);
  assert.equal(guardados[0].texto, "Enlace: https://wobagroup.com/guia");
  assert.match(mensajes[0], /no leí la página/);
});

test("si guardar falla, lo dice, no confirma y deja el modo activo", async () => {
  const { d, mensajes, renovados } = deps({ empresas: ["General"] }, { guardar: async () => { throw new Error("Sheets caído"); } });
  assert.equal(await capturarTextoEnModoConocimiento(1, "algo", "Carlos", d), true);
  assert.equal(renovados.length, 0);
  assert.match(mensajes[0], /no se guardó nada/);
  assert.ok(!mensajes.some((m) => /Guardado como conocimiento/.test(m)));
});

test("un documento se lee y se guarda con su nombre; nada va a otro flujo", async () => {
  const { d, guardados, mensajes } = deps({ empresas: ["EWORKS"] });
  assert.equal(await capturarArchivoEnModoConocimiento(1, { bytes: Buffer.from("%PDF-1.7"), nombre: "politica.pdf", mimeType: "application/pdf", caption: "Política de viajes", autor: "Carlos" }, d), true);
  assert.equal(guardados.length, 1);
  assert.match(guardados[0].texto, /^Archivo: politica\.pdf\nNota: Política de viajes\n\nContenido leído del documento$/);
  assert.deepEqual(guardados[0].empresas, ["EWORKS"]);
  assert.match(mensajes.join("\n"), /Guardado como conocimiento \(EWORKS\): «politica\.pdf»/);
});

test("si la lectura del documento no devuelve nada o falla, no se guarda y se avisa", async () => {
  for (const transcribir of [async () => "   ", async () => { throw new Error("visión caída"); }]) {
    const { d, guardados, mensajes } = deps({ empresas: ["General"] }, { transcribir });
    assert.equal(await capturarArchivoEnModoConocimiento(1, { bytes: Buffer.from("x"), nombre: "a.png", mimeType: "image/png" }, d), true);
    assert.equal(guardados.length, 0);
    assert.match(mensajes[mensajes.length - 1], /no se guardó nada/);
  }
});

test("un archivo demasiado grande se rechaza sin leerlo", async () => {
  let transcrito = false;
  const { d, guardados, mensajes } = deps({ empresas: ["General"] }, { transcribir: async () => { transcrito = true; return "x"; } });
  assert.equal(await capturarArchivoEnModoConocimiento(1, { bytes: Buffer.alloc(16 * 1024 * 1024), nombre: "enorme.pdf", mimeType: "application/pdf" }, d), true);
  assert.equal(transcrito, false);
  assert.equal(guardados.length, 0);
  assert.match(mensajes[0], /pesa demasiado/);
});
