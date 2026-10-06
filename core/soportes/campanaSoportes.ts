import { randomUUID } from "node:crypto";
import { listBankMovements, listTreasuryAccounts, type Empresa } from "../holded/client";
import { obtenerPropuestasGastoPorEmpresa } from "../gastos/gastoProposalSheet";
import { editTelegramMessage, sendTelegramMessage, sendTelegramMessageWithButtons } from "../telegram/client";
import type { InlineKeyboardButton } from "../telegram/types";
import { crearCampana, fijarMensaje, leerCampana, type PersonaCampana } from "./campanaSoportesStore";
import {
  agruparPorTitular, coincideConPropuestaPendiente, cruzarConBanco, elegirCuentasHolded, esTitularEmpresa, VENTANA_DIAS_CRUCE,
  type CargoCruzado, type MovimientoBanco,
} from "./cruceExtracto";
import { esPagoConTarjeta, parsearExtractoRevolut, periodoDelExtracto } from "./extractoRevolut";
import { totalesPorMoneda } from "./redactarCorreoSoportes";
import { leerSolicitudes, pedidoRecientemente } from "./solicitudesSoportesSheet";
import { resolverEmailCompleto } from "./emailTitular";

/**
 * Del extracto de Revolut al mensaje resumen: qué cargos con tarjeta siguen sin soporte conciliado en Holded, de quién
 * es cada uno y a quién se le escribe. Todo es lectura (extracto + Holded + Sheets propios): nada sale por correo hasta
 * que Carlos pulse «Enviar» en el resumen (soportesTelegram.ts).
 */

const DIAS_PARA_CONSIDERAR_ANTIGUO = 10;
const MAX_ANTIGUOS_LISTADOS = 6;
const dinero = (n: number, moneda: string): string => `${new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${moneda}`;
const fecha = (iso: string): string => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
const sumarDias = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface ResultadoAnalisis {
  desde: string;
  hasta: string;
  cargos: CargoCruzado[];
  paraPedir: CargoCruzado[];
  recuento: { pagosConTarjeta: number; conciliados: number; parciales: number; noSincronizados: number; ambiguos: number; conPropuestaPendiente: number; pedidosRecientemente: number; otrosMovimientos: number };
  cuentasSinResolver: string[];
}

export async function analizarExtracto(empresa: Empresa, texto: string, ahora = Date.now()): Promise<ResultadoAnalisis & { yaSolicitados: Set<string> }> {
  const filas = parsearExtractoRevolut(texto);
  const periodo = periodoDelExtracto(filas);
  if (!periodo) throw new Error("El extracto no tiene movimientos con fecha.");
  const pagos = filas.filter(esPagoConTarjeta);

  // Holded: solo las cuentas que corresponden a cada cuenta del extracto, y solo el rango del extracto.
  const cuentas = (await listTreasuryAccounts(empresa)).filter((c) => !c.archived);
  const cuentasSinResolver: string[] = [];
  const movimientos = new Map<string, MovimientoBanco>();
  for (const nombreCuenta of new Set(pagos.map((p) => p.cuenta))) {
    const elegidas = elegirCuentasHolded(nombreCuenta, cuentas);
    if (elegidas.length === 0) { cuentasSinResolver.push(nombreCuenta); continue; }
    for (const c of elegidas) {
      // Un fallo de Holded NO es un dato (feedback 2026-09-28): se propaga y no se reclama nada a ciegas.
      const lista = await listBankMovements(empresa, c.id, sumarDias(periodo.desde, -VENTANA_DIAS_CRUCE - 1), sumarDias(periodo.hasta, VENTANA_DIAS_CRUCE + 1));
      for (const m of lista) {
        if (!m.id) continue;
        movimientos.set(String(m.id), {
          id: String(m.id), cuentaId: c.id, cuenta: c.name ?? "", fecha: String(m.booking_date ?? "").slice(0, 10),
          importe: Number(m.amount ?? 0), moneda: String(m.currency ?? c.currency ?? "EUR").toUpperCase(),
          estado: String(m.status ?? ""), descripcion: String(m.description ?? ""),
        });
      }
    }
  }

  const cargos = cruzarConBanco(pagos.filter((p) => !cuentasSinResolver.includes(p.cuenta)), [...movimientos.values()]);
  const propuestas = (await obtenerPropuestasGastoPorEmpresa(empresa)).map((p) => ({ proveedor: p.proveedor, monto: p.monto, moneda: p.moneda, fecha: p.fecha }));
  const solicitudes = await leerSolicitudes(empresa);

  const sinConciliar = cargos.filter((c) => c.estado === "sin_conciliar");
  const conPropuesta = sinConciliar.filter((c) => coincideConPropuestaPendiente(c, propuestas));
  const restantes = sinConciliar.filter((c) => !conPropuesta.includes(c));
  const recientes = restantes.filter((c) => pedidoRecientemente(solicitudes.get(c.fila.id), ahora));
  const paraPedir = restantes.filter((c) => !recientes.includes(c));
  const yaSolicitados = new Set(paraPedir.filter((c) => solicitudes.has(c.fila.id)).map((c) => c.fila.id));

  return {
    cargos, paraPedir, desde: periodo.desde, hasta: periodo.hasta, yaSolicitados, cuentasSinResolver,
    recuento: {
      pagosConTarjeta: pagos.length,
      conciliados: cargos.filter((c) => c.estado === "conciliado").length,
      parciales: cargos.filter((c) => c.estado === "parcial").length,
      noSincronizados: cargos.filter((c) => c.estado === "no_sincronizado").length,
      ambiguos: cargos.filter((c) => c.estado === "ambiguo").length,
      conPropuestaPendiente: conPropuesta.length,
      pedidosRecientemente: recientes.length,
      otrosMovimientos: filas.length - pagos.length,
    },
  };
}

export function notaDeRecuento(r: ResultadoAnalisis, nombreArchivo: string): string {
  const x = r.recuento;
  const l = [
    `Analicé ${nombreArchivo}: ${x.pagosConTarjeta} pagos con tarjeta (${x.otrosMovimientos} movimientos más —transferencias, ingresos, cambios— no llevan soporte de un titular).`,
    `• ${x.conciliados} ya tienen su soporte conciliado en Holded.`,
    `• ${r.paraPedir.length} siguen sin conciliar y hay que pedirlos.`,
  ];
  if (x.conPropuestaPendiente) l.push(`• ${x.conPropuestaPendiente} ya llegaron y esperan tu aprobación en el chat: no se piden.`);
  if (x.pedidosRecientemente) l.push(`• ${x.pedidosRecientemente} se pidieron hace menos de 7 días: no se repiten todavía.`);
  if (x.parciales) l.push(`• ${x.parciales} con conciliación parcial: se revisan aparte, no se reclaman.`);
  const sinMovimiento = r.cargos.filter((c) => c.estado === "no_sincronizado");
  const antiguos = sinMovimiento.filter((c) => Date.parse(`${r.hasta}T00:00:00Z`) - Date.parse(`${c.fila.fecha}T00:00:00Z`) > DIAS_PARA_CONSIDERAR_ANTIGUO * 86_400_000);
  if (sinMovimiento.length - antiguos.length > 0) l.push(`• ${sinMovimiento.length - antiguos.length} aún no aparecen en Bancos de Holded (sin sincronizar): no se reclaman todavía.`);
  if (antiguos.length) l.push(`• ${antiguos.length} de hace más de ${DIAS_PARA_CONSIDERAR_ANTIGUO} días no tienen en Holded un movimiento con ese mismo importe (puede ser una retención de otro importe o un movimiento que falta): no se reclaman, revísalos: ${antiguos.slice(0, MAX_ANTIGUOS_LISTADOS).map((c) => `${fecha(c.fila.fecha)} ${c.fila.comercio.replace(/\s+/g, " ")} ${dinero(Math.abs(c.fila.total), c.fila.monedaCuenta)}`).join("; ")}${antiguos.length > MAX_ANTIGUOS_LISTADOS ? ` y ${antiguos.length - MAX_ANTIGUOS_LISTADOS} más` : ""}.`);
  if (x.ambiguos) l.push(`• ${x.ambiguos} no puedo asignarlos con seguridad (mismo importe, distinto titular): revísalos a mano.`);
  if (r.cuentasSinResolver.length) l.push(`⚠️ No encontré en Holded la cuenta «${r.cuentasSinResolver.join("», «")}»: sus cargos no se analizaron.`);
  return l.join("\n");
}

export function textoResumen(personas: PersonaCampana[]): string {
  const primera = personas[0];
  const encabezado = `📋 Soportes pendientes — ${primera.empresa} · ${fecha(primera.desde)} → ${fecha(primera.hasta)}`;
  const lineas = personas.map((p) => {
    const tot = totalesPorMoneda(p.cargos).map((t) => dinero(t.total, t.moneda)).join(" + ");
    const marca = p.estado === "enviado" ? "📤" : p.estado === "fallido" ? "⚠️" : p.estado === "omitido" ? "—" : p.seleccionado ? "☑" : "☐";
    const destino = p.titular === "(sin titular)"
      ? "el extracto no dice quién gastó: revisa estos cargos a mano"
      : esTitularEmpresa(p.titular)
      ? "es una tarjeta de empresa, no de una persona: revisa estos cargos a mano"
      : p.email
      ? `${p.email}${p.fuenteEmail === "directorio" ? " (del directorio, confírmalo)" : p.fuenteEmail === "buzon" ? " (del buzón de Wobi, confírmalo)" : ""}`
      : p.sugerencias
      ? `⚠️ sin email seguro. Posibles: ${p.sugerencias}. Dime cuál: «el correo de ${p.titular} es …» y pulsa 🔄`
      : `⚠️ sin email: escríbeme «el correo de ${p.titular} es …» y pulsa 🔄`;
    const estado = p.estado === "enviado" ? " — ENVIADO" : p.estado === "fallido" ? " — FALLÓ el envío, se puede reintentar" : "";
    return `${marca} ${p.titular} — ${p.cargos.length} ${p.cargos.length === 1 ? "cargo" : "cargos"} · ${tot}${p.yaSolicitados ? ` (${p.yaSolicitados} recordatorio)` : ""}\n     ${destino}${estado}`;
  });
  return [encabezado, "", primera.nota, "", "Un correo por persona, desde asistente@wobagroup.com:", ...lineas].join("\n");
}

export function botonesResumen(personas: PersonaCampana[]): InlineKeyboardButton[][] {
  const id = personas[0].campana;
  const filas: InlineKeyboardButton[][] = [];
  for (const p of personas) {
    if (p.estado === "enviado" || p.estado === "omitido" || !p.email) continue;
    const corto = p.titular.split(/\s+/).slice(0, 2).join(" ");
    filas.push([
      { text: `${p.seleccionado ? "☑" : "☐"} ${corto} (${p.cargos.length})`, callback_data: `sop_t:${id}:${p.indice}` },
      { text: "👁 Ver correo", callback_data: `sop_v:${id}:${p.indice}` },
    ]);
  }
  const aEnviar = personas.filter((p) => p.seleccionado && p.email && ["pendiente", "enviando", "fallido"].includes(p.estado)).length;
  const hayPendientes = personas.some((p) => ["pendiente", "enviando", "fallido"].includes(p.estado));
  if (hayPendientes) {
    if (personas.some((p) => p.email && !p.seleccionado && ["pendiente", "fallido"].includes(p.estado))) {
      filas.push([{ text: "☑ Marcar todos los que tienen email", callback_data: `sop_m:${id}` }]);
    }
    filas.push([
      { text: aEnviar ? `📤 Enviar ${aEnviar} ${aEnviar === 1 ? "correo" : "correos"}` : "📤 Enviar (marca a alguien)", callback_data: `sop_e:${id}` },
      { text: "🔄 Actualizar emails", callback_data: `sop_a:${id}` },
    ]);
    filas.push([{ text: "❌ Cancelar", callback_data: `sop_c:${id}` }]);
  }
  return filas;
}

export async function mostrarResumen(personas: PersonaCampana[]): Promise<void> {
  const p0 = personas[0];
  await editTelegramMessage(p0.chatId, p0.messageId, textoResumen(personas), botonesResumen(personas));
}

/** Analiza el extracto, guarda la campaña y muestra el resumen con una casilla por persona. */
export type ResultadoCampana = "campana" | "nada_que_pedir" | "empresa_dudosa";

/**
 * Si casi ningún pago del extracto aparece en Bancos de Holded de la empresa elegida, lo más probable es que el CSV sea
 * de otra empresa: se frena antes de armar nada, en vez de mostrar un resumen vacío que parezca «todo en orden».
 */
export function pareceDeOtraEmpresa(r: Pick<ResultadoAnalisis, "recuento">): boolean {
  const x = r.recuento;
  return x.pagosConTarjeta >= 5 && (x.pagosConTarjeta - x.noSincronizados) / x.pagosConTarjeta < 0.3;
}

export async function prepararCampanaSoportes(chatId: number, empresa: Empresa, texto: string, nombreArchivo: string): Promise<ResultadoCampana> {
  const a = await analizarExtracto(empresa, texto);
  if (pareceDeOtraEmpresa(a)) {
    await sendTelegramMessage(chatId, `⚠️ Solo ${a.recuento.pagosConTarjeta - a.recuento.noSincronizados} de los ${a.recuento.pagosConTarjeta} pagos con tarjeta de este extracto aparecen en Bancos de Holded de ${empresa}. Lo más probable es que el CSV sea de otra empresa (o que Holded no esté sincronizado). No armé ningún correo. Pulsa /soportes, elige la empresa correcta y súbelo de nuevo.`);
    return "empresa_dudosa";
  }
  const nota = notaDeRecuento(a, nombreArchivo);
  const grupos = agruparPorTitular(a.paraPedir);
  if (grupos.length === 0) {
    await sendTelegramMessage(chatId, `✅ ${empresa}: no hay nada que pedir.\n\n${nota}`);
    return "nada_que_pedir";
  }
  const campana = randomUUID().slice(0, 8);
  const creadoEn = Date.now();
  const personas: Array<Omit<PersonaCampana, "rowIndex">> = [];
  for (const [indice, g] of grupos.entries()) {
    const sinTitular = !g.clave || esTitularEmpresa(g.titular);
    const r = sinTitular ? ({ tipo: "nada" } as const) : await resolverEmailCompleto(g.titular, empresa);
    personas.push({
      campana, indice, chatId, messageId: 0, empresa, desde: a.desde, hasta: a.hasta, titular: g.titular,
      email: r.tipo === "resuelto" ? r.email : "", fuenteEmail: r.tipo === "resuelto" ? r.fuente : "",
      sugerencias: r.tipo === "varios" || r.tipo === "sugerencias" ? r.candidatos.join(", ") : "",
      // Solo el email que Carlos ya confirmó se marca solo; el del directorio o del buzón lo confirma él tocando la casilla.
      seleccionado: r.tipo === "resuelto" && r.fuente === "confirmado",
      estado: sinTitular ? "omitido" : "pendiente",
      yaSolicitados: g.cargos.filter((c) => a.yaSolicitados.has(c.fila.id)).length,
      creadoEn, nota: indice === 0 ? nota : "",
      cargos: g.cargos.map((c) => ({ id: c.fila.id, fecha: c.fila.fecha, comercio: c.fila.comercio, total: c.fila.total, monedaCuenta: c.fila.monedaCuenta, importeOriginal: c.fila.importeOriginal, monedaOriginal: c.fila.monedaOriginal, tarjeta4: c.fila.tarjeta4 })),
    });
  }
  await crearCampana(personas);
  const guardadas = personas.map((p, i) => ({ ...p, rowIndex: i }));
  // El envío con botones colapsa los textos largos; este resumen es una lista de casillas y debe verse entera: se manda
  // un aviso corto y se edita enseguida con el texto completo (mostrarResumen, sin colapsar).
  const messageId = await sendTelegramMessageWithButtons(chatId, "📋 Preparando el resumen de soportes…", botonesResumen(guardadas));
  await fijarMensaje(campana, messageId);
  await mostrarResumen(await leerCampana(campana));
  return "campana";
}
