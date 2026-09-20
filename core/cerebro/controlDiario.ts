import {
  obtenerAnalisisCostosDiario,
  type AnalisisCostosDiario,
} from "../claude/costTracking";
import {
  diagnosticarMemoriaConversacional,
  type DiagnosticoMemoriaConversacional,
} from "../claude/conversationStore";
import { cargarConfiguracionPoliticaApi, type ModoPoliticaApi } from "../ai/policy";
import { durableSendStore, type ResumenLedgerEnviosCorreo } from "../gmail/durableSendStore";
import { durableUploadStore, type ResumenLedgerSubidasDrive } from "../drive/durableUploadStore";
import { durablePurchaseStore, type ResumenLedgerCreacionesCompra } from "../holded/durablePurchaseStore";
import { durablePurchaseEditStore, type ResumenLedgerEdicionesCompra } from "../holded/durablePurchaseEditStore";
import {
  durablePurchaseAttachmentStore,
  type ResumenLedgerAdjuntosCompra,
} from "../holded/durablePurchaseAttachmentStore";
import {
  durableBankReconciliationStore,
  type ResumenLedgerConciliacionesMovimiento,
} from "../holded/durableBankReconciliationStore";
import {
  durableContactStore,
  type ResumenLedgerCreacionesContacto,
} from "../holded/durableContactStore";
import { obtenerRecomendacionesDescartadas } from "./controlDiarioDescartesStore";

export type EstadoControlDiario = "estable" | "atencion" | "critico";
export type PrioridadRecomendacion = "critica" | "alta" | "media" | "informativa";

export interface PoliticaControlDiario {
  modo: ModoPoliticaApi;
  killSwitch: boolean;
  umbralAlertaDiariaUSD?: number;
  limiteDiarioUSD: number;
  limiteMensualUSD: number;
  procesosPermitidos: number;
}

/**
 * Acción que el panel puede ejecutar por sí mismo sobre una recomendación — pedido explícito de
 * Carlos: ante una incidencia crítica, poder resolverla desde el front (o saber exactamente qué
 * hacer) en vez de solo leer un aviso. `id` es el contrato con POST /api/cerebro/control-diario/resolver.
 */
export interface AccionControlDiario {
  id: "verificar" | "revisar";
  etiqueta: string;
  descripcion: string;
}

export interface RecomendacionControlDiario {
  id: string;
  prioridad: PrioridadRecomendacion;
  titulo: string;
  detalle: string;
  siguientePaso: string;
  modulo: "accesos" | "conocimiento" | "conexiones";
  /** Instrucciones exactas, en orden — lo que hay que hacer para dejar esta recomendación en verde. */
  pasos?: string[];
  /** Botones que el panel ofrece para resolverla sin salir de la pantalla. */
  acciones?: AccionControlDiario[];
}

export interface ControlDiario {
  estado: EstadoControlDiario;
  resumen: string;
  generadoEn: string;
  costosDisponibles: boolean;
  costos: AnalisisCostosDiario | null;
  memoria: DiagnosticoMemoriaConversacional;
  politica: PoliticaControlDiario;
  enviosCorreo: ResumenLedgerEnviosCorreo | null;
  subidasDrive: ResumenLedgerSubidasDrive | null;
  comprasHolded: ResumenLedgerCreacionesCompra | null;
  edicionesHolded: ResumenLedgerEdicionesCompra | null;
  adjuntosHolded: ResumenLedgerAdjuntosCompra | null;
  conciliacionesHolded: ResumenLedgerConciliacionesMovimiento | null;
  contactosHolded: ResumenLedgerCreacionesContacto | null;
  recomendaciones: RecomendacionControlDiario[];
}

export interface EntradaControlDiario {
  costos: AnalisisCostosDiario | null;
  memoria: DiagnosticoMemoriaConversacional;
  politica: PoliticaControlDiario;
  /** undefined mantiene compatibilidad de pruebas/llamadores; null significa fallo real de lectura. */
  enviosCorreo?: ResumenLedgerEnviosCorreo | null;
  /** undefined mantiene compatibilidad; null significa fallo real de lectura. */
  subidasDrive?: ResumenLedgerSubidasDrive | null;
  /** undefined mantiene compatibilidad; null significa fallo real de lectura. */
  comprasHolded?: ResumenLedgerCreacionesCompra | null;
  /** undefined mantiene compatibilidad; null significa fallo real de lectura. */
  edicionesHolded?: ResumenLedgerEdicionesCompra | null;
  /** undefined mantiene compatibilidad; null significa fallo real de lectura. */
  adjuntosHolded?: ResumenLedgerAdjuntosCompra | null;
  /** undefined mantiene compatibilidad; null significa fallo real de lectura. */
  conciliacionesHolded?: ResumenLedgerConciliacionesMovimiento | null;
  /** undefined mantiene compatibilidad; null significa fallo real de lectura. */
  contactosHolded?: ResumenLedgerCreacionesContacto | null;
  /**
   * IDs de recomendación descartados vigentes (ver controlDiarioDescartesStore.ts) — pedido explícito
   * de Carlos: poder decirle a Wobi desde el chat que ya revisó una recomendación y que no vuelva a
   * mostrarla por un tiempo. Filtro puro sobre el resultado ya calculado, no cambia ninguna otra
   * lógica — undefined/vacío mantiene el comportamiento anterior (nada descartado).
   */
  recomendacionesDescartadas?: ReadonlySet<string>;
  generadoEn?: Date;
}

function nombreProceso(proceso: string): string {
  const nombres: Record<string, string> = {
    extraer_factura: "extracción de facturas",
    chat_conversacional: "chat conversacional",
    clasificar_correo: "clasificación de correo",
    clasificar_documento: "clasificación de documentos",
    extraer_gasto_correo: "extracción de gastos desde correo",
    correo_gastos_automatico: "análisis automático de correo (gastos)",
    respuesta_correo_automatica: "respuestas automáticas de correo",
    autorrevision_codigo: "autorrevisión de código",
    sin_atribuir: "consumo todavía sin atribuir",
  };
  return nombres[proceso] ?? proceso.replaceAll("_", " ");
}

/** Primer paso al investigar un proceso que concentra el gasto: no presupone la causa. */
const CONSEJO_PROCESO =
  "Revisa cuántas llamadas hace este proceso por caso y si repite el análisis de los mismos datos (por ejemplo, el mismo correo o documento) antes de tocar modelos o calidad.";

const ACCION_VERIFICAR: AccionControlDiario = {
  id: "verificar",
  etiqueta: "Verificar ahora",
  descripcion:
    "Vuelve a comprobar cada elemento incierto contra el sistema real (solo lectura, nunca repite una escritura). " +
    "Los que ya coincidan quedan resueltos.",
};

const ACCION_REVISAR: AccionControlDiario = {
  id: "revisar",
  etiqueta: "Revisar y cerrar",
  descripcion:
    "Muestra cada documento afectado con su estado real y permite darlo por revisado (sin modificar Holded).",
};

/** Pasos comunes de las incidencias 'resultado incierto' de un ledger durable. */
function pasosIncierto(que: string, donde: string, tieneRevision: boolean): string[] {
  return [
    `Pulsa «Verificar ahora»: se vuelven a leer ${que} en ${donde} (solo lectura) y se cierran solos los que ya coinciden.`,
    tieneRevision
      ? "Si siguen apareciendo, pulsa «Revisar y cerrar»: verás cada documento afectado con su estado real."
      : `Si siguen apareciendo, abre ${donde} y comprueba a mano esos elementos (proveedor, fecha, importe).`,
    tieneRevision
      ? "Si los datos son correctos, marca esas compras y pulsa «Dar por revisadas las seleccionadas» (pide confirmación y no toca Holded). Si algo está mal, corrígelo en Holded y vuelve a verificar."
      : "No autorices una operación equivalente hasta confirmar que la anterior no se aplicó o quedó bien aplicada.",
  ];
}

/** Pasos de las incidencias 'no se pudo leer' un ledger (fallo de lectura de Google Sheets). */
function pasosLedgerNoDisponible(pestana: string): string[] {
  return [
    "Comprueba que la cuenta de servicio de Google conserva acceso de edición a la hoja de cálculo del cashflow.",
    `Abre la pestaña ${pestana} y verifica que existe y que su fila 1 conserva los encabezados.`,
    "Cuando el acceso esté correcto, esta alerta desaparece sola en la siguiente lectura (o recarga el panel).",
  ];
}

/** Carlos gestiona 3 Holded distintos (WOBA/EWORKS/Footprint) — sin nombrar la empresa, una incidencia crítica no dice dónde corregir. */
function listaEmpresas(empresas: string[]): string {
  return empresas.length > 0 ? empresas.join(", ") : "empresa sin determinar";
}

export function generarControlDiario(entrada: EntradaControlDiario): ControlDiario {
  const recomendaciones: RecomendacionControlDiario[] = [];
  const { costos, memoria, politica } = entrada;

  if (entrada.enviosCorreo === null) {
    recomendaciones.push({
      id: "ledger-correo-no-disponible",
      prioridad: "critica",
      titulo: "No se pudo comprobar la continuidad del correo",
      detalle: "El control diario no pudo leer el ledger durable de envíos; no se asume que esté vacío.",
      siguientePaso: "Revisar permisos de Google Sheets y la pestaña _envios_correo_durables antes de reenviar correos.",
      modulo: "conexiones",
      pasos: pasosLedgerNoDisponible("_envios_correo_durables"),
    });
  } else if (entrada.enviosCorreo && entrada.enviosCorreo.incierto > 0) {
    recomendaciones.push({
      id: "envios-correo-inciertos",
      prioridad: "critica",
      titulo: "Hay envíos de correo con resultado incierto",
      detalle: `${entrada.enviosCorreo.incierto} envío(s) no pudieron confirmarse contra la carpeta Enviados.`,
      siguientePaso: "Comprobar esos correos en Gmail antes de autorizar cualquier envío equivalente nuevo.",
      modulo: "conexiones",
      pasos: pasosIncierto("los envíos", "la carpeta Enviados de Gmail", false),
      acciones: [ACCION_VERIFICAR],
    });
  }

  if (entrada.subidasDrive === null) {
    recomendaciones.push({
      id: "ledger-drive-no-disponible",
      prioridad: "critica",
      titulo: "No se pudo comprobar la continuidad de Drive",
      detalle: "El control diario no pudo leer el ledger durable de subidas; no se asume que esté vacío.",
      siguientePaso: "Revisar permisos de Google Sheets y la pestaña _subidas_drive_durables antes de repetir archivados.",
      modulo: "conexiones",
      pasos: pasosLedgerNoDisponible("_subidas_drive_durables"),
    });
  } else if (entrada.subidasDrive && entrada.subidasDrive.incierta > 0) {
    recomendaciones.push({
      id: "subidas-drive-inciertas",
      prioridad: "critica",
      titulo: "Hay subidas a Drive con resultado incierto",
      detalle: `${entrada.subidasDrive.incierta} subida(s) no pudieron confirmarse mediante su marcador privado.`,
      siguientePaso: "Comprobar el ledger y Drive antes de autorizar otra carga equivalente.",
      modulo: "conexiones",
      pasos: pasosIncierto("las subidas", "Google Drive", false),
      acciones: [ACCION_VERIFICAR],
    });
  }

  if (entrada.comprasHolded === null) {
    recomendaciones.push({
      id: "ledger-holded-no-disponible",
      prioridad: "critica",
      titulo: "No se pudo comprobar la continuidad de Holded",
      detalle: "El control diario no pudo leer el ledger durable de compras; no se asume que esté vacío.",
      siguientePaso: "Revisar permisos de Google Sheets y la pestaña _compras_holded_durables antes de repetir una compra.",
      modulo: "conexiones",
      pasos: pasosLedgerNoDisponible("_compras_holded_durables"),
    });
  } else if (entrada.comprasHolded && entrada.comprasHolded.incierta > 0) {
    recomendaciones.push({
      id: "compras-holded-inciertas",
      prioridad: "critica",
      titulo: "Hay compras de Holded con resultado incierto",
      detalle: `${entrada.comprasHolded.incierta} compra(s) no pudieron confirmarse mediante su marcador interno (Holded ${listaEmpresas(entrada.comprasHolded.empresasConIncertidumbre)}).`,
      siguientePaso: "Comprobar esas compras en Holded antes de autorizar un registro equivalente.",
      modulo: "conexiones",
      pasos: pasosIncierto("las compras", "Holded", false),
      acciones: [ACCION_VERIFICAR],
    });
  }

  if (entrada.edicionesHolded === null) {
    recomendaciones.push({
      id: "ledger-ediciones-holded-no-disponible",
      prioridad: "critica",
      titulo: "No se pudo comprobar la continuidad de las ediciones de Holded",
      detalle: "El control diario no pudo leer el ledger durable de ediciones; no se asume que esté vacío.",
      siguientePaso: "Revisar permisos de Google Sheets y la pestaña _ediciones_holded_durables antes de repetir una corrección.",
      modulo: "conexiones",
      pasos: pasosLedgerNoDisponible("_ediciones_holded_durables"),
    });
  } else if (entrada.edicionesHolded && entrada.edicionesHolded.incierta > 0) {
    recomendaciones.push({
      id: "ediciones-holded-inciertas",
      prioridad: "critica",
      titulo: "Hay ediciones de Holded con resultado incierto",
      detalle: `${entrada.edicionesHolded.incierta} edición(es) no coinciden todavía con su huella esperada (Holded ${listaEmpresas(entrada.edicionesHolded.empresasConIncertidumbre)}).`,
      siguientePaso: "Comprobar esos documentos en Holded antes de autorizar otra corrección equivalente.",
      modulo: "conexiones",
      pasos: pasosIncierto("las ediciones", "Holded", true),
      acciones: [ACCION_VERIFICAR, ACCION_REVISAR],
    });
  }

  if (entrada.adjuntosHolded === null) {
    recomendaciones.push({
      id: "ledger-adjuntos-holded-no-disponible",
      prioridad: "critica",
      titulo: "No se pudo comprobar la continuidad de los comprobantes",
      detalle: "El control diario no pudo leer el ledger durable de adjuntos de Holded; no se asume que esté vacío.",
      siguientePaso: "Revisar permisos de Google Sheets y la pestaña _adjuntos_holded_durables antes de repetir una carga.",
      modulo: "conexiones",
      pasos: pasosLedgerNoDisponible("_adjuntos_holded_durables"),
    });
  } else if (entrada.adjuntosHolded && entrada.adjuntosHolded.incierto > 0) {
    recomendaciones.push({
      id: "adjuntos-holded-inciertos",
      prioridad: "critica",
      titulo: "Hay comprobantes de Holded con resultado incierto",
      detalle: `${entrada.adjuntosHolded.incierto} comprobante(s) no pudieron confirmarse descargando y comparando sus bytes (Holded ${listaEmpresas(entrada.adjuntosHolded.empresasConIncertidumbre)}).`,
      siguientePaso: "Comprobar esos adjuntos en Holded antes de autorizar otra carga equivalente.",
      modulo: "conexiones",
      pasos: pasosIncierto("los comprobantes", "Holded", false),
      acciones: [ACCION_VERIFICAR],
    });
  }

  if (entrada.conciliacionesHolded === null) {
    recomendaciones.push({
      id: "ledger-conciliaciones-holded-no-disponible",
      prioridad: "critica",
      titulo: "No se pudo comprobar la continuidad de conciliaciones",
      detalle: "El control diario no pudo leer el ledger durable de conciliaciones bancarias; no se asume que esté vacío.",
      siguientePaso: "Revisar permisos de Google Sheets y la pestaña _conciliaciones_holded_durables antes de repetir una conciliación.",
      modulo: "conexiones",
      pasos: pasosLedgerNoDisponible("_conciliaciones_holded_durables"),
    });
  } else if (entrada.conciliacionesHolded && entrada.conciliacionesHolded.incierta > 0) {
    recomendaciones.push({
      id: "conciliaciones-holded-inciertas",
      prioridad: "critica",
      titulo: "Hay conciliaciones bancarias con resultado incierto",
      detalle: `${entrada.conciliacionesHolded.incierta} conciliación(es) no pudieron confirmarse contra el movimiento en Holded (${listaEmpresas(entrada.conciliacionesHolded.empresasConIncertidumbre)}).`,
      siguientePaso: "Comprobar esos movimientos y documentos en Holded antes de autorizar otra conciliación.",
      modulo: "conexiones",
      pasos: pasosIncierto("las conciliaciones", "Holded", false),
      acciones: [ACCION_VERIFICAR],
    });
  }
  if (entrada.conciliacionesHolded && entrada.conciliacionesHolded.verificadaRevision > 0) {
    recomendaciones.push({
      id: "conciliaciones-holded-revision",
      prioridad: "alta",
      titulo: "Hay conciliaciones confirmadas con saldo por revisar",
      detalle: `${entrada.conciliacionesHolded.verificadaRevision} conciliación(es) sí quedaron vinculadas, pero conservan un saldo, pago parcial o ajuste pendiente (Holded ${listaEmpresas(entrada.conciliacionesHolded.empresasConRevision)}).`,
      siguientePaso: "Revisar el saldo residual en el documento; no repetir la conciliación bancaria.",
      modulo: "conexiones",
      pasos: [
        "Abre en Holded cada documento afectado y revisa el saldo, pago parcial o ajuste que conserva.",
        "Si el residual es correcto (por ejemplo, una diferencia de cambio), no hace falta nada más; si no lo es, regularízalo en Holded.",
        "No repitas la conciliación bancaria: ya quedó vinculada.",
      ],
    });
  }

  if (entrada.contactosHolded === null) {
    recomendaciones.push({
      id: "ledger-contactos-holded-no-disponible",
      prioridad: "critica",
      titulo: "No se pudo comprobar la continuidad de contactos",
      detalle: "El control diario no pudo leer el ledger durable de proveedores; no se asume que esté vacío.",
      siguientePaso: "Revisar permisos de Google Sheets y la pestaña _contactos_holded_durables antes de crear otro proveedor.",
      modulo: "conexiones",
      pasos: pasosLedgerNoDisponible("_contactos_holded_durables"),
    });
  } else if (entrada.contactosHolded && entrada.contactosHolded.incierta > 0) {
    recomendaciones.push({
      id: "contactos-holded-inciertos",
      prioridad: "critica",
      titulo: "Hay contactos de Holded con resultado incierto",
      detalle: `${entrada.contactosHolded.incierta} contacto(s) no pudieron confirmarse por código fiscal o nombre exacto (Holded ${listaEmpresas(entrada.contactosHolded.empresasConIncertidumbre)}).`,
      siguientePaso: "Comprobar esos proveedores en Holded y resolver coincidencias duplicadas antes de autorizar otra creación.",
      modulo: "conexiones",
      pasos: pasosIncierto("los proveedores", "Holded", false),
      acciones: [ACCION_VERIFICAR],
    });
  }

  if (!costos) {
    recomendaciones.push({
      id: "costos-no-disponibles",
      prioridad: "critica",
      titulo: "No se pudo leer la telemetría de costes",
      detalle: "El panel no puede confirmar llamadas, gasto ni anomalías. Nunca se representa este fallo como coste cero.",
      siguientePaso: "Revisar permisos de Google Sheets y la pestaña _costos_ia.",
      modulo: "conexiones",
      pasos: pasosLedgerNoDisponible("_costos_ia"),
    });
  }

  if (!memoria.ok) {
    recomendaciones.push({
      id: "memoria-no-integra",
      prioridad: "critica",
      titulo: "La memoria requiere revisión",
      detalle: memoria.filasCorruptas > 0
        ? `${memoria.filasCorruptas} fila(s) de memoria no tienen una estructura válida.`
        : "No fue posible confirmar la integridad de la memoria persistente.",
      siguientePaso: "Comprobar permisos y reparar únicamente las filas afectadas antes de purgar información.",
      modulo: "conocimiento",
      pasos:
        memoria.filasCorruptas > 0
          ? [
              "Abre la pestaña _historial_conversaciones de la hoja de cálculo del cashflow.",
              "Busca las filas donde la columna B no es una lista JSON válida (debe empezar por «[») o la columna C no es una fecha.",
              "Repara solo esas filas; si no es posible, borra únicamente esa fila: solo se pierde el contexto de esa conversación, no datos contables.",
              "Recarga el panel: cuando ninguna fila esté corrupta, esta alerta desaparece.",
            ]
          : pasosLedgerNoDisponible("_historial_conversaciones"),
    });
  }

  if (costos?.ejecucionesConMuchasLlamadasAyer) {
    recomendaciones.push({
      id: "posibles-repeticiones",
      prioridad: "critica",
      titulo: "Hay ejecuciones con demasiadas llamadas",
      detalle: `${costos.ejecucionesConMuchasLlamadasAyer} ejecución(es) superaron 12 llamadas en un mismo proceso.`,
      siguientePaso: "Revisar la ejecución y detener la ruta con el kill switch si continúa creciendo.",
      modulo: "accesos",
      pasos: [
        "En «Qué está generando el gasto de hoy», localiza el proceso con más llamadas.",
        "Revisa esa ruta: si repite llamadas sobre los mismos datos, hay que corregirla en el código.",
        "Si el gasto sigue creciendo y no puede esperar, pon WOBI_AI_API_KILL_SWITCH=true en las variables del servicio en Railway. Bloquea TODAS las llamadas de IA hasta que lo quites.",
      ],
    });
  }

  if (costos?.esAnomaliaAyer) {
    recomendaciones.push({
      id: "gasto-anomalo",
      prioridad: "alta",
      titulo: "El gasto de ayer fue anómalo",
      detalle: `La API consumió $${costos.ayer.gastoRealApiUSD.toFixed(2)} frente a una media previa de $${costos.promedio7DiasPreviosUSD.toFixed(2)} al día.`,
      siguientePaso: "Revisar primero los procesos que concentran el gasto antes de modificar modelos o calidad.",
      modulo: "accesos",
      pasos: [
        "Abre el desglose por proceso del gasto de la semana y localiza el que concentra el aumento.",
        "Compara sus llamadas con las de días normales antes de tocar modelos o calidad.",
      ],
    });
  }

  const umbralAlertaDiaria = politica.umbralAlertaDiariaUSD ?? 0;
  if (costos && umbralAlertaDiaria > 0 && costos.hoy.gastoRealApiUSD >= umbralAlertaDiaria) {
    recomendaciones.push({
      id: "umbral-diario-coste-ia",
      prioridad: "alta",
      titulo: "El consumo de IA de hoy requiere justificación",
      detalle: `Hoy se han consumido $${costos.hoy.gastoRealApiUSD.toFixed(2)}; el umbral informativo es $${umbralAlertaDiaria.toFixed(2)}. La operación sigue disponible hasta el techo de emergencia.`,
      siguientePaso: "Comprobar en el desglose por proceso que el consumo corresponde a trabajo útil solicitado y no a una rutina repetitiva.",
      modulo: "accesos",
    });
  }

  if (costos && costos.ayer.ahorroNetoCacheUSD > 0.001) {
    recomendaciones.push({
      id: "cache-efectiva",
      prioridad: "informativa",
      titulo: "La caché está reduciendo el gasto",
      detalle: `Ayer reutilizó ${costos.ayer.cacheReadTokens.toLocaleString("es-ES")} tokens y ahorró aproximadamente $${costos.ayer.ahorroNetoCacheUSD.toFixed(2)} netos.`,
      siguientePaso: "Mantener estables los prefijos compartidos y seguir midiendo por proceso.",
      modulo: "accesos",
    });
  } else if (
    costos &&
    costos.ayer.llamadas >= 10 &&
    costos.ayer.cacheCreationTokens >= 50_000 &&
    costos.ayer.cacheReadTokens === 0
  ) {
    recomendaciones.push({
      id: "cache-sin-reuso",
      prioridad: "media",
      titulo: "La caché se crea pero no se reutiliza",
      detalle: `Ayer se escribieron ${costos.ayer.cacheCreationTokens.toLocaleString("es-ES")} tokens de caché sin ninguna lectura posterior.`,
      siguientePaso: "Revisar estabilidad y orden de los prefijos antes de ampliar la caché a más procesos.",
      modulo: "accesos",
    });
  }

  if (politica.modo === "observe") {
    recomendaciones.push({
      id: "politica-observe",
      prioridad: politica.limiteDiarioUSD <= 0 || politica.limiteMensualUSD <= 0 ? "alta" : "media",
      titulo: "La API continúa en modo observación",
      detalle:
        politica.limiteDiarioUSD <= 0 || politica.limiteMensualUSD <= 0
          ? "La configuración todavía no tiene un techo diario y mensual efectivo."
          : "Se registra el consumo, pero todavía no se bloquean procesos fuera de una lista explícita.",
      siguientePaso: "Definir límites validados y pasar a allowlist después del periodo de comparación.",
      modulo: "accesos",
      pasos: [
        "En Railway, servicio principal → Variables: define WOBI_AI_API_DAILY_LIMIT_USD y WOBI_AI_API_MONTHLY_LIMIT_USD con valores mayores que 0.",
        "Define WOBI_AI_API_ALLOWED_PROCESSES con TODOS los procesos que deben seguir funcionando (separados por comas). Cualquier proceso que no esté en la lista se bloqueará.",
        "Solo entonces cambia WOBI_AI_API_MODE a allowlist. Mientras esté en observe, el consumo solo se registra y no se bloquea nada.",
      ],
    });
  }

  if (
    costos &&
    politica.limiteMensualUSD > 0 &&
    costos.proyeccionMensualUSD >= politica.limiteMensualUSD * 0.7
  ) {
    recomendaciones.push({
      id: "proyeccion-presupuesto",
      prioridad: costos.proyeccionMensualUSD >= politica.limiteMensualUSD ? "alta" : "media",
      titulo: "La proyección mensual se acerca al límite",
      detalle: `Proyección actual: $${costos.proyeccionMensualUSD.toFixed(2)} de un límite de $${politica.limiteMensualUSD.toFixed(2)}.`,
      siguientePaso: "Priorizar filtros deterministas en el proceso más costoso y conservar las rutas críticas.",
      modulo: "accesos",
      pasos: [
        "Identifica en «Qué está generando el gasto de la semana» el proceso más costoso.",
        "Aplica filtros deterministas (reglas fijas) antes de llamar a la IA en ese proceso, sin tocar las rutas críticas.",
        "Si necesitas un tope duro, define WOBI_AI_API_MONTHLY_LIMIT_USD y el modo allowlist (ver la recomendación de política).",
      ],
    });
  }

  // Pedido explícito de Carlos: "no me interesa el gasto de ayer, me interesa qué está generando el
  // gasto de hoy". El aviso de anomalía de arriba solo miraba el día anterior completo, así que un
  // pico que ocurre HOY (caso real 2026-09-20: $22,91 frente a ~$4/día, 99% de un solo proceso)
  // no avisaba hasta el día siguiente. La referencia son los 7 días completos anteriores a hoy.
  if (costos) {
    const puntos = costos.ultimos7Dias ?? [];
    const promedioReciente = puntos.length
      ? puntos.reduce((total, punto) => total + punto.gastoRealApiUSD, 0) / puntos.length
      : 0;
    const umbralHoy = Math.max(1, promedioReciente * 2);
    const principal = costos.porProcesoHoy?.[0];
    const porcentaje =
      principal && costos.hoy.gastoRealApiUSD > 0
        ? Math.round((principal.gastoRealApiUSD / costos.hoy.gastoRealApiUSD) * 100)
        : 0;
    const fraseProceso = principal
      ? ` Lo genera sobre todo ${nombreProceso(principal.proceso)}: $${principal.gastoRealApiUSD.toFixed(2)} (${porcentaje}%, ${principal.llamadas} llamadas).`
      : "";
    const pasosGastoHoy = [
      "Mira la tabla «Qué está generando el gasto de hoy» y confirma qué proceso concentra las llamadas.",
      principal ? CONSEJO_PROCESO : "Revisa esa ruta y comprueba si repite llamadas sobre los mismos datos.",
      "Si no puede esperar, pon WOBI_AI_API_KILL_SWITCH=true en las variables del servicio en Railway (bloquea TODAS las llamadas de IA hasta que lo quites).",
    ];
    // Si ya salta el umbral diario configurado (arriba), no se duplica la tarjeta: se completa esa misma con
    // el proceso que genera el gasto y los pasos exactos.
    const avisoUmbral = recomendaciones.find((r) => r.id === "umbral-diario-coste-ia");
    if (avisoUmbral) {
      avisoUmbral.detalle += fraseProceso;
      avisoUmbral.pasos = pasosGastoHoy;
    } else if (promedioReciente > 0 && costos.hoy.gastoRealApiUSD >= umbralHoy) {
      // Sin media de referencia (instalación nueva o serie vacía) no hay contra qué comparar: avisar
      // "por encima de lo normal" sería inventar una normalidad.
      recomendaciones.push({
        id: "gasto-hoy-elevado",
        prioridad: "alta",
        titulo: "El gasto de hoy va muy por encima de lo normal",
        detalle:
          `Hoy llevas $${costos.hoy.gastoRealApiUSD.toFixed(2)} (media de los últimos 7 días: $${promedioReciente.toFixed(2)} al día).` +
          fraseProceso,
        siguientePaso: principal
          ? CONSEJO_PROCESO
          : "Revisar en «Qué está generando el gasto de hoy» qué proceso concentra las llamadas.",
        modulo: "accesos",
        pasos: pasosGastoHoy,
      });
    }
  }

  // Antes se calculaba sobre AYER (un día completo ya pasado, casi siempre sin interés): pedido
  // explícito de Carlos, "qué está generando el gasto de hoy". Se usa el día en curso si ya tiene un
  // gasto material y, si no, la semana en curso.
  const hayGastoHoy = costos ? costos.hoy.gastoRealApiUSD >= 0.5 : false;
  const ventanaPrincipal = hayGastoHoy ? "hoy" : "la semana";
  const gastoVentana = costos ? (hayGastoHoy ? costos.hoy.gastoRealApiUSD : costos.semanaActual?.gastoRealApiUSD ?? 0) : 0;
  const procesoPrincipal = hayGastoHoy ? costos?.porProcesoHoy?.[0] : costos?.porProcesoSemana?.[0];
  // Por debajo de $1 en la ventana no vale la pena recomendar optimizar nada (ruido).
  if (procesoPrincipal && gastoVentana >= 1 && procesoPrincipal.gastoRealApiUSD / gastoVentana >= 0.4) {
    const porcentaje = Math.round((procesoPrincipal.gastoRealApiUSD / gastoVentana) * 100);
    recomendaciones.push({
      id: "proceso-principal",
      prioridad: "media",
      titulo: `Optimizar ${nombreProceso(procesoPrincipal.proceso)}`,
      detalle: `Concentra el ${porcentaje}% del gasto de ${ventanaPrincipal} ($${procesoPrincipal.gastoRealApiUSD.toFixed(2)}).`,
      siguientePaso: "Medir contexto, caché y llamadas por caso; aplicar cambios únicamente con casos de prueba equivalentes.",
      modulo: "accesos",
      pasos: [
        `Mide las llamadas, el contexto y la caché de ${nombreProceso(procesoPrincipal.proceso)} caso por caso.`,
        "Aplica cambios solo si tienes casos de prueba equivalentes que demuestren que la calidad no baja.",
      ],
    });
  }

  // Filtro puro sobre lo ya calculado — un descarte vigente (ver controlDiarioDescartesStore.ts)
  // quita la tarjeta Y recalcula el estado/resumen general a partir de lo que quede, para que un
  // hallazgo descartado no siga mostrando "Incidencia crítica" con la tarjeta ya oculta.
  const descartadas = entrada.recomendacionesDescartadas;
  // La lista se titula "priorizadas": lo crítico y lo alto (p. ej. el gasto de HOY disparado) va antes que las
  // recomendaciones de ajuste. Orden estable: dentro de una misma prioridad se conserva el orden de generación.
  const ORDEN_PRIORIDAD: Record<PrioridadRecomendacion, number> = { critica: 0, alta: 1, media: 2, informativa: 3 };
  const recomendacionesVisibles = (
    descartadas?.size ? recomendaciones.filter((r) => !descartadas.has(r.id)) : [...recomendaciones]
  ).sort((a, b) => ORDEN_PRIORIDAD[a.prioridad] - ORDEN_PRIORIDAD[b.prioridad]);

  const hayCritica = recomendacionesVisibles.some((r) => r.prioridad === "critica");
  const hayAtencion = recomendacionesVisibles.some((r) => r.prioridad === "alta" || r.prioridad === "media");
  const estado: EstadoControlDiario = hayCritica ? "critico" : hayAtencion ? "atencion" : "estable";
  const resumen =
    estado === "critico"
      ? "Hay una incidencia que requiere intervención antes de confiar en el control automático."
      : estado === "atencion"
        ? `${recomendacionesVisibles.length} recomendación(es) priorizada(s) para controlar coste y estabilidad.`
        : "Costes, memoria y política de uso están dentro de los controles configurados.";

  return {
    estado,
    resumen,
    generadoEn: (entrada.generadoEn ?? new Date()).toISOString(),
    costosDisponibles: costos !== null,
    costos,
    memoria,
    politica,
    enviosCorreo: entrada.enviosCorreo ?? null,
    subidasDrive: entrada.subidasDrive ?? null,
    comprasHolded: entrada.comprasHolded ?? null,
    edicionesHolded: entrada.edicionesHolded ?? null,
    adjuntosHolded: entrada.adjuntosHolded ?? null,
    conciliacionesHolded: entrada.conciliacionesHolded ?? null,
    contactosHolded: entrada.contactosHolded ?? null,
    recomendaciones: recomendacionesVisibles,
  };
}

export async function construirControlDiario(referencia: Date = new Date()): Promise<ControlDiario> {
  const [costos, memoria, enviosCorreo, subidasDrive, comprasHolded, edicionesHolded, adjuntosHolded, conciliacionesHolded, contactosHolded, recomendacionesDescartadas] = await Promise.all([
    obtenerAnalisisCostosDiario(referencia)
      .catch((error) => {
        console.error("[controlDiario] No se pudo leer la telemetría de costes:", error instanceof Error ? error.name : "Error");
        return null;
      }),
    diagnosticarMemoriaConversacional(),
    durableSendStore.obtenerResumen().catch((error) => {
      console.error("[controlDiario] No se pudo leer el ledger de correo:", error instanceof Error ? error.name : "Error");
      return null;
    }),
    durableUploadStore.obtenerResumen().catch((error) => {
      console.error("[controlDiario] No se pudo leer el ledger de Drive:", error instanceof Error ? error.name : "Error");
      return null;
    }),
    durablePurchaseStore.obtenerResumen().catch((error) => {
      console.error("[controlDiario] No se pudo leer el ledger de Holded:", error instanceof Error ? error.name : "Error");
      return null;
    }),
    durablePurchaseEditStore.obtenerResumen().catch((error) => {
      console.error("[controlDiario] No se pudo leer el ledger de ediciones de Holded:", error instanceof Error ? error.name : "Error");
      return null;
    }),
    durablePurchaseAttachmentStore.obtenerResumen().catch((error) => {
      console.error("[controlDiario] No se pudo leer el ledger de adjuntos de Holded:", error instanceof Error ? error.name : "Error");
      return null;
    }),
    durableBankReconciliationStore.obtenerResumen().catch((error) => {
      console.error("[controlDiario] No se pudo leer el ledger de conciliaciones de Holded:", error instanceof Error ? error.name : "Error");
      return null;
    }),
    durableContactStore.obtenerResumen().catch((error) => {
      console.error("[controlDiario] No se pudo leer el ledger de contactos de Holded:", error instanceof Error ? error.name : "Error");
      return null;
    }),
    obtenerRecomendacionesDescartadas().catch((error) => {
      console.error("[controlDiario] No se pudo leer los descartes de recomendaciones (se asume ninguno):", error instanceof Error ? error.name : "Error");
      return new Set<string>();
    }),
  ]);
  const config = cargarConfiguracionPoliticaApi();

  return generarControlDiario({
    costos,
    memoria,
    politica: {
      modo: config.modo,
      killSwitch: config.killSwitch,
      umbralAlertaDiariaUSD: config.umbralAlertaDiariaUSD,
      limiteDiarioUSD: config.limiteDiarioUSD,
      limiteMensualUSD: config.limiteMensualUSD,
      procesosPermitidos: config.procesosPermitidos.size,
    },
    enviosCorreo,
    subidasDrive,
    comprasHolded,
    edicionesHolded,
    adjuntosHolded,
    conciliacionesHolded,
    contactosHolded,
    recomendacionesDescartadas,
    generadoEn: referencia,
  });
}
