import { UsoApiNoAutorizadoError } from "../../../ai/policy";
import { evidenciaFixture } from "../fixtures";
import { VERSION_POLITICA } from "../model";
import { correoCaso, operacionPrevia, reciboCaso, type CasoReal } from "./arnes";

const GENERICO_LECTURA = /no dio por completa la lectura/;
const CODIGOS_INTERNOS = /lectura_incompleta|relectura_|proveedor_no_verificado|mensajeId/;

/** Los casos reales que bloquearon la revisión de correo. Añadir uno nuevo = copiar el correo (anonimizado), el análisis que dio y lo que debía salir. */
export const CASOS: CasoReal[] = [
  {
    nombre: "control: recibo completo se crea, adjunta y concilia",
    origen: "Flujo feliz (control del banco de casos).",
    correo: correoCaso("control"),
    analisis: { completo: true, resumen: "Ticket", otrasAcciones: false, recibos: [reciboCaso({ empresa: "WOBA", evidenciaEmpresa: "WOBA" })] },
    espera: [/Gastos creados, soportados y conciliados: 1\./],
    noEspera: [/Por qué quedaron gastos para revisión manual/],
  },
  {
    nombre: "Xue Cafe: adjunto ilegible se dice con el nombre del adjunto",
    origen: "07/08-10-2026: «Fwd: Café - 19.513,00 cop - revolut», jpg de 3,2 MB; salía «no dio por completa la lectura» sin decir qué.",
    correo: correoCaso("xue", { asunto: "Fwd: Café - 19.513,00 cop - revolut", adjuntos: [{ id: "adj1", nombre: "20260924_074802.jpg", mime: "image/jpeg" } as never] }),
    analisis: { completo: false, otrasAcciones: false, resumen: "Imagen del ticket ilegible.",
      detalleIncompleto: "No pude leer el adjunto «20260924_074802.jpg»: la imagen está borrosa y no se distingue el total.",
      recibos: [reciboCaso({ fuente: "adj1", proveedor: "Xue Cafe", moneda: "COP", monto: 19513, confianza: "baja" })] },
    espera: [/El analizador no pudo leer una parte de este correo: No pude leer el adjunto «20260924_074802\.jpg»/],
    noEspera: [GENERICO_LECTURA, CODIGOS_INTERNOS],
  },
  {
    nombre: "Antaris Suite: la relectura no coincide con la operación anterior y se dice con las dos versiones",
    origen: "07/08-10-2026: dos recibos de Antaris Suite (340 y 628 MXN) con operación de una política anterior; la relectura daba otra fecha y salía «lectura incompleta».",
    correo: correoCaso("antaris", { asunto: "Antaris Suite - hospedaje" }),
    analisis: { completo: true, resumen: "Recibo de hotel", otrasAcciones: false,
      recibos: [reciboCaso({ proveedor: "Antaris Suite", moneda: "MXN", monto: 340, fecha: "2026-09-21", concepto: "Hospedaje" })] },
    operacionesPrevias: [operacionPrevia({ id: "op-antaris", correo: correoCaso("antaris"), estado: "completada", compraId: "compra-antaris", version: "politica-anterior",
      recibo: reciboCaso({ proveedor: "Antaris Suite", moneda: "MXN", monto: 340, fecha: "2026-09-20", concepto: "Hospedaje" }) })],
    espera: [/Al releer el correo, el recibo no coincide con el de la operación anterior \(antes 340 MXN del 2026-09-20; ahora 340 MXN del 2026-09-21 \(Footprint\); difiere en: otra fecha\)/],
    noEspera: [GENERICO_LECTURA, CODIGOS_INTERNOS],
  },
  {
    nombre: "Delhaize: sin cargo en el banco y proveedor aproximado, se dicen las dos cosas",
    origen: "07/08-10-2026: «Delhaize Hoogstraten» 140,41 EUR encontrado por aproximación.",
    correo: correoCaso("delhaize", { asunto: "Ticket supermercado" }),
    analisis: { completo: true, resumen: "Ticket", otrasAcciones: false, recibos: [reciboCaso({ proveedor: "Delhaize", monto: 140.41 })] },
    evidencia: { ...evidenciaFixture(), contacto: { id: "p-delhaize", nombre: "Delhaize Hoogstraten", exacto: false, metodo: "aproximado_unico" } as never },
    espera: [/Todavía no hay en el banco un cargo que coincida; además falta confirmar que «Delhaize Hoogstraten» sea el proveedor/],
    noEspera: [GENERICO_LECTURA, CODIGOS_INTERNOS],
  },
  {
    nombre: "tope diario de IA: fallo técnico que se reintenta, nunca «lectura incompleta»",
    origen: "07-10-2026: 7 correos bloqueados por el tope de 4 USD del proceso manual.",
    correo: correoCaso("tope"),
    analisis: () => { throw new UsoApiNoAutorizadoError("correo_gastos_automatico_manual", "limite_diario_proceso_alcanzado"); },
    espera: [/El análisis no se ejecutó porque se alcanzó el presupuesto diario de IA configurado/, /No se clasificaron como correos ilegibles/],
    noEspera: [GENERICO_LECTURA, CODIGOS_INTERNOS],
  },
  {
    nombre: "operación anterior incierta (conciliación partial) se informa como tal",
    origen: "Compra 6abb8a39… de Footprint, «Conciliación no confirmada al 100 %: partial», revisada en cada pasada desde el 07-10-2026.",
    correo: correoCaso("partial", { asunto: "MCA Airports" }),
    analisis: { completo: true, resumen: "Recibo", otrasAcciones: false, recibos: [reciboCaso({ proveedor: "MCA Airports", moneda: "USD", monto: 16.54 })] },
    correoYaLeido: true,
    conciliacionNoVerificable: true,
    conciliarFalla: "Conciliación no confirmada al 100 %: partial.",
    operacionesPrevias: [operacionPrevia({ id: "op-partial", correo: correoCaso("partial"), estado: "incierta", pasoIncierto: "conciliando", compraId: "compra-mca",
      version: VERSION_POLITICA, detalle: "Conciliación no confirmada al 100 %: partial.", recibo: reciboCaso({ proveedor: "MCA Airports", moneda: "USD", monto: 16.54 }) })],
    // Contrato del informe: el paso que quedó a medias, sin exponer ids ni detalles técnicos (ver service.test.ts).
    espera: [/La operación de una revisión anterior quedó en estado incierto \(Holded no confirmó el último paso\)/, /Footprint · MCA Airports · 16\.54 USD/],
    noEspera: [GENERICO_LECTURA, CODIGOS_INTERNOS],
  },
];
