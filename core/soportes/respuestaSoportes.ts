import { createHash } from "node:crypto";
import { NORMA_EXTRACTOR } from "../ia/normaResolucionAutonoma";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { crearMensajeAnthropic } from "../ai/anthropicGateway";
import { resolverModeloDocumental } from "../ai/modelRouting";
import { crearEjecucionIA } from "../ai/policy";
import { extraerDatosFactura } from "../documental/extractInvoiceData";
import { buscarGastoProcesadoPorIdentidad } from "../gastos/gastoPorCorreoStore";
import { descargarAdjunto, extraerDireccionCorreo, type CorreoResumen } from "../gmail/client";
import type { AnalisisCorreo } from "../gmail/classifyEmail";
import { listBankMovements, listTreasuryAccounts, type Empresa } from "../holded/client";
import { ultimaSolicitudEnviada } from "./campanaSoportesStore";
import { lineaCargo, nombreDePila, type CargoCorreo } from "./redactarCorreoSoportes";

/**
 * Una persona responde al correo de «Soportes pendientes de tus gastos con tarjeta». El clasificador genérico de correo
 * lo resumía en un párrafo y proponía UNA acción para todo (Alejandro, 2026-10-06: tres cargos, tres respuestas distintas,
 * un soporte adjunto que ya estaba registrado y una captura de pantalla). Aquí se lee el cuerpo entero SIN las citas, se
 * leen los adjuntos, se contrasta cada cargo pedido con Holded y con el registro de soportes ya procesados, y se propone
 * UNA acción concreta POR CARGO. Solo lee: nunca crea, concilia ni envía nada (la propuesta pasa por los botones del correo).
 */

export type SituacionCargo = "soporte_adjunto" | "soporte_enviado_antes" | "compensado_reembolso" | "no_reconoce" | "otra_persona" | "sin_mencion";

export interface InterpretacionCargo {
  numero: number;
  situacion: SituacionCargo;
  /** Lo que la persona dice de este cargo, en una frase y con sus propias palabras. */
  loQueDice: string;
  /** Nombre del adjunto que dice que lo soporta, si lo hay. */
  adjunto?: string;
}

export interface SoporteLeido {
  nombre: string;
  esGasto: boolean;
  proveedor?: string;
  monto?: number;
  moneda?: string;
  fecha?: string;
  /** Si ese mismo archivo (o su número de documento) ya se convirtió en un gasto, cuál. */
  yaRegistrado?: { gastoId: string; proveedor?: string; monto?: number; moneda?: string; fecha?: string };
  /** Otro cargo del banco, ya conciliado, que corresponde al importe del gasto ya registrado. */
  cargoQueYaLoSoporta?: { fecha: string; importe: number; moneda: string };
  /** Qué es el documento cuando no es un gasto (una captura de la app del banco, un resumen…). */
  descripcion?: string;
}

export interface HechosCargo {
  movimiento?: { estado: string; fecha: string };
  reembolso?: { fecha: string; importe: number; moneda: string; estado: string };
}

export interface PropuestaCargo {
  resultado: string;
  accion: string;
  /** true si Alejandro tiene que hacer algo (mandar un soporte, aclarar): entra en la respuesta que se le propone. */
  pideAlRemitente?: string;
}

const dinero = (n: number, m: string): string => `${new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${m}`;
const fechaCorta = (iso: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : iso);

/** El cuerpo de la respuesta sin el correo citado debajo (líneas «>» y la cabecera «El … escribió:»). */
export function limpiarCuerpoSinCitas(cuerpo: string): string {
  const lineas = cuerpo.replace(/\r/g, "").split("\n");
  const corte = lineas.findIndex((l, i) => /^\s*(on|el)\b.{0,120}(wrote|escribi[óo]):?\s*$/i.test(l) || (/^\s*(on|el)\b.{0,80}$/i.test(l) && /(wrote|escribi[óo]):?\s*$/i.test(lineas[i + 1] ?? "")));
  const propias = (corte >= 0 ? lineas.slice(0, corte) : lineas).filter((l) => !/^\s*>/.test(l));
  return propias.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** «Re: Footprint · Soportes pendientes de tus gastos con tarjeta (…)» → { empresa }; undefined si no es la respuesta a esa solicitud. */
export function parsearAsuntoRespuesta(asunto: string): { empresa: Empresa } | undefined {
  const t = asunto.replace(/^(\s*(re|rv|fwd?|fw)\s*:\s*)+/i, "").trim();
  const m = /^(woba|eworks|footprint)\s*[·\-–]\s*soportes pendientes de tus gastos con tarjeta/i.exec(t);
  if (!m || /^\s*(fwd?|fw)\s*:/i.test(asunto)) return undefined;
  const e = m[1].toLowerCase();
  return { empresa: e === "woba" ? "WOBA" : e === "eworks" ? "EWORKS" : "Footprint" };
}

/** Qué hacer con UN cargo, a partir de lo que dice la persona y de lo que muestran Holded y el registro de soportes. Pura. */
export function proponerAccionCargo(cargo: CargoCorreo, dice: InterpretacionCargo | undefined, hechos: HechosCargo, soporte: SoporteLeido | undefined): PropuestaCargo {
  const importe = dinero(Math.abs(cargo.total), cargo.monedaCuenta);
  const situacion = dice?.situacion ?? "sin_mencion";
  const estado = hechos.movimiento?.estado;
  const yaConciliado = estado === "reconciled" || estado === "forced_reconciled";

  if (yaConciliado) {
    return { resultado: "En Holded este cargo ya figura conciliado.", accion: "Nada que hacer: darlo por resuelto." };
  }

  if (situacion === "soporte_adjunto" || situacion === "soporte_enviado_antes") {
    if (soporte?.yaRegistrado && soporte.cargoQueYaLoSoporta) {
      const otro = soporte.cargoQueYaLoSoporta;
      return {
        resultado: `El comprobante que adjunta (${soporte.nombre}: ${[soporte.proveedor, soporte.monto !== undefined ? dinero(soporte.monto, soporte.moneda ?? "") : "", soporte.fecha ? fechaCorta(soporte.fecha) : ""].filter(Boolean).join(" · ")}) ya está registrado como gasto y ya soporta OTRO cargo, conciliado: ${dinero(otro.importe, otro.moneda)} del ${fechaCorta(otro.fecha)}. No sirve para este de ${importe} del ${fechaCorta(cargo.fecha)}.`,
        accion: `Pedirle el recibo del viaje del ${fechaCorta(cargo.fecha)} (distinto al del ${fechaCorta(otro.fecha)}) y explicarle por qué el adjunto no cubre este cargo.`,
        pideAlRemitente: `el recibo del cargo de ${importe} del ${fechaCorta(cargo.fecha)} (${cargo.comercio.trim()}): el que envió ya soporta el cargo de ${dinero(otro.importe, otro.moneda)} del ${fechaCorta(otro.fecha)}`,
      };
    }
    if (soporte?.yaRegistrado) {
      return {
        resultado: `El comprobante ya estaba registrado como gasto (${soporte.yaRegistrado.proveedor ?? "sin proveedor"} ${soporte.yaRegistrado.monto !== undefined ? dinero(soporte.yaRegistrado.monto, soporte.yaRegistrado.moneda ?? "") : ""} · ${soporte.yaRegistrado.fecha ? fechaCorta(soporte.yaRegistrado.fecha) : "sin fecha"}), pero este cargo sigue sin conciliar.`,
        accion: "Conciliar ese gasto ya registrado con este cargo (revisar la diferencia de importe antes de aprobar).",
      };
    }
    if (soporte?.esGasto) {
      return {
        resultado: `El adjunto ${soporte.nombre} se lee como un gasto nuevo: ${[soporte.proveedor, soporte.monto !== undefined ? dinero(soporte.monto, soporte.moneda ?? "") : "", soporte.fecha ? fechaCorta(soporte.fecha) : ""].filter(Boolean).join(" · ")}.`,
        accion: "Crear el gasto desde ese comprobante y conciliarlo con este cargo: llega a continuación como propuesta con sus botones.",
      };
    }
    return {
      resultado: soporte ? `El adjunto ${soporte.nombre} no es un comprobante de gasto (${soporte.descripcion ?? "no trae proveedor ni importe"}).` : "Dice que lo envió, pero no encuentro ese comprobante ni en este correo ni ya registrado.",
      accion: "Pedirle de nuevo el recibo de este cargo.",
      pideAlRemitente: `el recibo del cargo de ${importe} del ${fechaCorta(cargo.fecha)} (${cargo.comercio.trim()})`,
    };
  }

  if (situacion === "compensado_reembolso") {
    if (hechos.reembolso) {
      const r = hechos.reembolso;
      const abonoConciliado = r.estado === "reconciled" || r.estado === "forced_reconciled";
      return {
        resultado: `En Holded hay un abono de ${dinero(r.importe, r.moneda)} el ${fechaCorta(r.fecha)} que compensa este cargo exactamente (${abonoConciliado ? "el abono ya figura conciliado —no por Wobi— y el cargo sigue pendiente" : "ambos siguen sin conciliar"}).`,
        accion: `Cargo y reembolso se anulan: no hace falta ningún soporte ni pedirle nada más. Hay que cerrarlos juntos en Holded${abonoConciliado ? " (primero ver contra qué enlazó Holded el abono)" : ""}; hoy Wobi no tiene botón para conciliar un cargo con su reembolso cuando no hay gasto de por medio, así que queda como pendiente de cierre manual.`,
      };
    }
    return {
      resultado: "Dice que el cargo se reembolsó, pero no encuentro ese abono en Holded.",
      accion: "Revisar el extracto del banco para confirmar el reembolso antes de darlo por resuelto.",
    };
  }

  if (situacion === "no_reconoce" || situacion === "otra_persona") {
    return {
      resultado: situacion === "otra_persona" ? "Dice que el cargo corresponde a otra persona." : "No reconoce el cargo y dice que no es un gasto suyo.",
      accion: situacion === "otra_persona"
        ? "Preguntar a quién corresponde y pedirle a esa persona el soporte; mientras tanto, mantener el cargo pendiente."
        : "Mantener el cargo pendiente como «no reconocido» y averiguar con el banco o el proveedor de la tarjeta si es indebido (o de otra tarjeta); no volver a reclamárselo.",
    };
  }

  return {
    resultado: "No dice nada de este cargo.",
    accion: "Mantenerlo pendiente y recordárselo.",
    pideAlRemitente: `el recibo del cargo de ${importe} del ${fechaCorta(cargo.fecha)} (${cargo.comercio.trim()})`,
  };
}

export function componerAnalisis(params: {
  nombre: string;
  cargos: CargoCorreo[];
  interpretaciones: InterpretacionCargo[];
  hechos: HechosCargo[];
  soportes: SoporteLeido[];
  adjuntosNoLeidos?: string[];
}): AnalisisCorreo {
  const { nombre, cargos, interpretaciones, hechos, soportes } = params;
  const propuestas = cargos.map((c, i) => {
    const dice = interpretaciones.find((x) => x.numero === i + 1);
    const soporte = dice?.adjunto ? soportes.find((s) => s.nombre.toLowerCase() === dice.adjunto?.toLowerCase()) : undefined;
    return { dice, propuesta: proponerAccionCargo(c, dice, hechos[i] ?? {}, soporte) };
  });
  const bloques = cargos.map((c, i) => {
    const { dice, propuesta } = propuestas[i];
    return [
      `${i + 1}. ${lineaCargo(c).replace(/^•\s*/, "")}`,
      dice?.loQueDice ? `   Dice: ${dice.loQueDice}` : "",
      `   Encontré: ${propuesta.resultado}`,
      `   ✅ Acción propuesta: ${propuesta.accion}`,
    ].filter(Boolean).join("\n");
  });
  const pendientes = propuestas.map((p) => p.propuesta.pideAlRemitente).filter((x): x is string => !!x);
  const adjuntos = soportes.length
    ? `Adjuntos leídos: ${soportes.map((s) => `${s.nombre} (${s.esGasto ? `gasto: ${[s.proveedor, s.monto !== undefined ? dinero(s.monto, s.moneda ?? "") : ""].filter(Boolean).join(" ")}` : s.descripcion ?? "no es un gasto"})`).join("; ")}.`
    : "El correo no trae adjuntos.";
  const resumen = [`Respuesta de ${nombre} a la solicitud de soportes — leí el cuerpo completo y los adjuntos; esto es lo que propongo por cada cargo pedido:`, adjuntos, "", ...bloques].join("\n");
  const accionSugerida = pendientes.length
    ? `Responder a ${nombreDePila(nombre) || nombre} confirmando lo resuelto y pidiéndole solo lo que falta: ${pendientes.join("; ")}.`
    : `Responder a ${nombreDePila(nombre) || nombre} agradeciendo la respuesta y confirmando lo resuelto; no queda nada por pedirle.`;
  return { tipo: "necesita_respuesta", resumen, accionSugerida, razon: "Respuesta a la solicitud de soportes de tarjeta: una acción por cargo." };
}

/* ───────────────────────────── parte con red (Gmail, Holded, IA) ───────────────────────────── */

const TOOL_NAME = "reportar_respuesta_soportes";

async function interpretarUnaVez(cargos: CargoCorreo[], cuerpo: string, adjuntos: Array<{ nombre: string; resumen: string }>): Promise<InterpretacionCargo[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Falta la variable de entorno ANTHROPIC_API_KEY");
  const cliente = new Anthropic({ apiKey });
  const tool: Anthropic.Tool = {
    name: TOOL_NAME,
    description: "Reporta, para CADA cargo pedido, qué responde la persona. Un elemento por cargo, en el mismo orden y con su número.",
    input_schema: {
      type: "object",
      properties: {
        cargos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              numero: { type: "number", description: "El Nº del cargo en la tabla enviada." },
              situacion: {
                type: "string",
                enum: ["soporte_adjunto", "soporte_enviado_antes", "compensado_reembolso", "no_reconoce", "otra_persona", "sin_mencion"],
                description: "soporte_adjunto: adjunta el comprobante en ESTE correo. soporte_enviado_antes: dice que ya lo envió en otro correo (aunque lo adjunte de nuevo, usa soporte_adjunto si lo adjunta ahora). compensado_reembolso: el cargo fue reembolsado/anulado. no_reconoce: dice que no es suyo y no lo reconoce. otra_persona: dice que lo hizo otra persona. sin_mencion: no habla de este cargo.",
              },
              lo_que_dice: { type: "string", description: "Lo que responde de ESTE cargo, en una frase y con sus datos (fechas, importes, asuntos de correos anteriores)." },
              adjunto: { type: "string", description: "Nombre EXACTO del adjunto que cita como soporte de este cargo, o vacío." },
            },
            required: ["numero", "situacion", "lo_que_dice"],
          },
        },
      },
      required: ["cargos"],
    },
  };
  const ejecucion = crearEjecucionIA("clasificar_correo");
  const respuesta = await crearMensajeAnthropic(cliente, ejecucion, {
    model: resolverModeloDocumental("clasificar_correo"),
    max_tokens: 8192,
    system: "Lees la respuesta de una persona a un correo que le pidió los soportes (facturas/recibos) de cargos hechos con su tarjeta. Para CADA cargo de la tabla, di qué responde de ese cargo concreto, leyendo el cuerpo completo (no las citas). Nunca asumas que algo está resuelto si no lo dice. Termina siempre llamando a la herramienta." + "\n\n" + NORMA_EXTRACTOR,
    tools: [tool],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{
      role: "user",
      content: [
        "Cargos pedidos (Nº · fecha · comercio · importe):",
        ...cargos.map((c, i) => `${i + 1}. ${lineaCargo(c).replace(/^•\s*/, "")}`),
        "",
        `Adjuntos del correo:\n${adjuntos.length ? adjuntos.map((a) => `- ${a.nombre}: ${a.resumen}`).join("\n") : "(ninguno)"}`,
        "",
        `Respuesta de la persona (sin el correo citado):\n${cuerpo.slice(0, 8000)}`,
      ].join("\n"),
    }],
  });
  const uso = respuesta.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME);
  const lista = extraerListaCargos(uso?.input);
  if (!lista) throw new Error(`El modelo no devolvió la interpretación por cargo (stop: ${respuesta.stop_reason}; entrada: ${JSON.stringify(uso?.input ?? null).slice(0, 300)}).`);
  return lista.map((x) => ({
    numero: Number(x.numero),
    situacion: (["soporte_adjunto", "soporte_enviado_antes", "compensado_reembolso", "no_reconoce", "otra_persona", "sin_mencion"].includes(String(x.situacion)) ? x.situacion : "sin_mencion") as SituacionCargo,
    loQueDice: String(x.lo_que_dice ?? ""),
    adjunto: typeof x.adjunto === "string" && x.adjunto.trim() ? x.adjunto.trim() : undefined,
  }));
}

/**
 * El modelo a veces entrega `cargos` como un TEXTO que contiene el JSON (a veces incluso envuelto en otro `{"cargos":[…]}`)
 * en vez de una lista: se aceptan las tres formas. Caso real 2026-10-07: la respuesta de Alejandro caía al análisis
 * genérico porque la lista llegó como cadena.
 */
export function extraerListaCargos(entrada: unknown): Array<Record<string, unknown>> | undefined {
  let valor: unknown = (entrada as { cargos?: unknown } | undefined)?.cargos;
  for (let i = 0; i < 2 && typeof valor === "string"; i++) {
    try { valor = JSON.parse(valor); } catch { return undefined; }
    if (valor && typeof valor === "object" && !Array.isArray(valor) && "cargos" in valor) valor = (valor as { cargos: unknown }).cargos;
  }
  return Array.isArray(valor) ? (valor as Array<Record<string, unknown>>) : undefined;
}

/** Un reintento: una respuesta mal formada del modelo no debe dejar la respuesta del correo sin análisis por cargo. */
async function interpretar(cargos: CargoCorreo[], cuerpo: string, adjuntos: Array<{ nombre: string; resumen: string }>): Promise<InterpretacionCargo[]> {
  try {
    return await interpretarUnaVez(cargos, cuerpo, adjuntos);
  } catch (error) {
    console.error("[respuestaSoportes] Interpretación fallida, se reintenta una vez:", error instanceof Error ? error.message : error);
    return interpretarUnaVez(cargos, cuerpo, adjuntos);
  }
}

async function leerAdjuntos(correo: CorreoResumen, empresa: Empresa): Promise<Array<SoporteLeido & { huella: string }>> {
  const salida: Array<SoporteLeido & { huella: string }> = [];
  const carpeta = await mkdtemp(join(tmpdir(), "respuesta-soportes-"));
  try {
    for (const a of correo.adjuntos) {
      if (!/^(application\/pdf|image\/)/i.test(a.mimeType)) { salida.push({ nombre: a.filename, esGasto: false, descripcion: `archivo ${a.mimeType}`, huella: "" }); continue; }
      const bytes = await descargarAdjunto(correo.id, a.attachmentId);
      const huella = createHash("sha256").update(bytes).digest("hex");
      const ruta = join(carpeta, a.filename.replace(/[^\w.\-]+/g, "_"));
      await writeFile(ruta, bytes);
      try {
        const d = await extraerDatosFactura(ruta, a.mimeType, `Adjunto de una respuesta a una solicitud de soportes de tarjeta de ${empresa}`, a.filename);
        const reg = await buscarGastoProcesadoPorIdentidad(empresa, { huellaContenido: huella, numeroDocumento: d.numeroDocumento, proveedor: d.proveedor, monto: d.monto, moneda: d.moneda, fecha: d.fecha });
        salida.push({
          nombre: a.filename, esGasto: d.esFacturaOGasto, proveedor: d.proveedor, monto: d.monto, moneda: d.moneda, fecha: d.fecha, huella,
          descripcion: d.esFacturaOGasto ? undefined : String((d as { motivo?: string; razon?: string }).motivo ?? (d as { razon?: string }).razon ?? "").slice(0, 200) || "no trae proveedor ni importe",
          yaRegistrado: reg ? { gastoId: reg.registro.gastoId, proveedor: reg.registro.identidad?.proveedor, monto: reg.registro.identidad?.monto, moneda: reg.registro.identidad?.moneda, fecha: reg.registro.identidad?.fecha } : undefined,
        });
      } catch (error) {
        console.error(`[respuestaSoportes] No se pudo leer el adjunto «${a.filename}»:`, error instanceof Error ? error.message : error);
        salida.push({ nombre: a.filename, esGasto: false, descripcion: "no se pudo leer", huella });
      }
    }
  } finally {
    await rm(carpeta, { recursive: true, force: true }).catch(() => undefined);
  }
  return salida;
}

interface MovimientoSimple { cuentaId: string; fecha: string; importe: number; moneda: string; estado: string }

async function movimientosCercanos(empresa: Empresa, cargos: CargoCorreo[]): Promise<MovimientoSimple[]> {
  const fechas = cargos.map((c) => c.fecha).sort();
  const dia = 86_400_000;
  const desde = new Date(Date.parse(`${fechas[0]}T00:00:00Z`) - 7 * dia).toISOString().slice(0, 10);
  const hasta = new Date(Date.parse(`${fechas[fechas.length - 1]}T00:00:00Z`) + 10 * dia).toISOString().slice(0, 10);
  const monedas = new Set(cargos.map((c) => c.monedaCuenta));
  const salida: MovimientoSimple[] = [];
  for (const cuenta of (await listTreasuryAccounts(empresa)).filter((c) => !c.archived)) {
    if (cuenta.currency && !monedas.has(cuenta.currency.toUpperCase())) continue;
    for (const m of await listBankMovements(empresa, cuenta.id, desde, hasta)) {
      salida.push({ cuentaId: cuenta.id, fecha: String(m.booking_date ?? "").slice(0, 10), importe: Number(m.amount ?? 0), moneda: String(m.currency ?? cuenta.currency ?? "EUR").toUpperCase(), estado: String(m.status ?? "") });
    }
  }
  return salida;
}

const diasEntre = (a: string, b: string): number => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

export function hechosDelCargo(cargo: CargoCorreo, movimientos: MovimientoSimple[]): HechosCargo {
  const mismo = movimientos
    .filter((m) => m.moneda === cargo.monedaCuenta && m.importe < 0 && Math.abs(Math.abs(m.importe) - Math.abs(cargo.total)) < 0.006 && diasEntre(m.fecha, cargo.fecha) <= 4)
    .sort((a, b) => diasEntre(a.fecha, cargo.fecha) - diasEntre(b.fecha, cargo.fecha))[0];
  const abono = mismo
    ? movimientos.find((m) => m.cuentaId === mismo.cuentaId && m.moneda === mismo.moneda && m.importe > 0 && Math.abs(m.importe - Math.abs(mismo.importe)) < 0.006 && Date.parse(m.fecha) >= Date.parse(mismo.fecha) && diasEntre(m.fecha, mismo.fecha) <= 7)
    : undefined;
  return {
    movimiento: mismo ? { estado: mismo.estado, fecha: mismo.fecha } : undefined,
    reembolso: abono ? { fecha: abono.fecha, importe: abono.importe, moneda: abono.moneda, estado: abono.estado } : undefined,
  };
}

/** Otro cargo ya conciliado, mismo importe que el gasto ya registrado y fecha cercana. */
export function cargoQueYaSoporta(yaRegistrado: NonNullable<SoporteLeido["yaRegistrado"]>, movimientos: MovimientoSimple[]): SoporteLeido["cargoQueYaLoSoporta"] {
  if (yaRegistrado.monto === undefined || !yaRegistrado.moneda) return undefined;
  const m = movimientos
    .filter((x) => x.moneda === yaRegistrado.moneda!.toUpperCase() && x.importe < 0 && Math.abs(Math.abs(x.importe) - Math.abs(yaRegistrado.monto!)) < 0.006 && (x.estado === "reconciled" || x.estado === "forced_reconciled") && (!yaRegistrado.fecha || diasEntre(x.fecha, yaRegistrado.fecha) <= 5))
    .sort((a, b) => diasEntre(a.fecha, yaRegistrado.fecha ?? a.fecha) - diasEntre(b.fecha, yaRegistrado.fecha ?? b.fecha))[0];
  return m ? { fecha: m.fecha, importe: Math.abs(m.importe), moneda: m.moneda } : undefined;
}

/**
 * Punto de entrada: devuelve el análisis por cargo si el correo es la respuesta a una solicitud de soportes que Wobi envió
 * y se encuentran los cargos pedidos; undefined en cualquier otro caso (entonces sigue el clasificador genérico).
 */
export async function analizarRespuestaDeSoportes(correo: CorreoResumen, cuerpoCompleto: string): Promise<AnalisisCorreo | undefined> {
  const asunto = parsearAsuntoRespuesta(correo.asunto);
  if (!asunto) return undefined;
  const email = extraerDireccionCorreo(correo.de);
  const solicitud = email ? await ultimaSolicitudEnviada(email, asunto.empresa) : undefined;
  if (!solicitud) return undefined;

  const cargos = [...solicitud.cargos].sort((a, b) => a.fecha.localeCompare(b.fecha));
  const cuerpo = limpiarCuerpoSinCitas(cuerpoCompleto);
  const adjuntos = await leerAdjuntos(correo, asunto.empresa);
  const interpretaciones = await interpretar(cargos, cuerpo, adjuntos.map((a) => ({ nombre: a.nombre, resumen: a.esGasto ? `comprobante de gasto: ${[a.proveedor, a.monto, a.moneda, a.fecha].filter((x) => x !== undefined && x !== "").join(" ")}` : (a.descripcion ?? "no es un comprobante") })));

  let movimientos: MovimientoSimple[] = [];
  try {
    movimientos = await movimientosCercanos(asunto.empresa, cargos);
  } catch (error) {
    // Un fallo de Holded no es un dato: sin movimientos no se afirma nada del banco, solo se propone con lo que dice el correo.
    console.error("[respuestaSoportes] No se pudieron leer los movimientos de Holded:", error instanceof Error ? error.message : error);
  }
  const soportes: SoporteLeido[] = adjuntos.map(({ huella: _h, ...s }) => ({ ...s, cargoQueYaLoSoporta: s.yaRegistrado ? cargoQueYaSoporta(s.yaRegistrado, movimientos) : undefined }));
  return componerAnalisis({ nombre: solicitud.titular, cargos, interpretaciones, hechos: cargos.map((c) => hechosDelCargo(c, movimientos)), soportes });
}
