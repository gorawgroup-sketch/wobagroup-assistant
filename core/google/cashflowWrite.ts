import { google, sheets_v4 } from "googleapis";
import { loadServiceAccountCredentials } from "./serviceAccount";
import { invalidarCacheDetalleRegistros } from "./cashflowSheet";
import { textosParecidos } from "../utils/textoParecido";
import { montosCercanos } from "../utils/montos";

const CASHFLOW_SHEET_ID = process.env.CASHFLOW_SHEET_ID;

let writeClient: sheets_v4.Sheets | null = null;

/**
 * Cliente de Sheets con permiso de escritura (scope completo, distinto al
 * cliente de solo lectura usado por los tools de consulta). Se usa
 * exclusivamente desde el flujo de escritura aprobado por Telegram.
 */
function getSheetsWriteClient(): sheets_v4.Sheets {
  if (writeClient) return writeClient;

  const credentials = loadServiceAccountCredentials();

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  writeClient = google.sheets({ version: "v4", auth });
  return writeClient;
}

function assertSheetId(): string {
  if (!CASHFLOW_SHEET_ID) {
    throw new Error("Falta la variable de entorno CASHFLOW_SHEET_ID.");
  }
  return CASHFLOW_SHEET_ID;
}

export type BloqueEscritura =
  | "ingresos"
  | "pagos_proyectos"
  | "pagos_extras"
  | "gastos_fijos"
  | "impuestos_por_pagar"
  | "aplazamiento_impuestos"
  | "pagos_pendientes_alberto"
  | "deudas_pendientes";

/** Los últimos dos (columnas X:Z compartidas por título de sección) usan un escritor aparte, ver más abajo. */
export const BLOQUES_SECCION_COMPARTIDA: BloqueEscritura[] = ["pagos_pendientes_alberto", "deudas_pendientes"];

interface BloqueColumnas {
  /** Columna a usar para detectar la primera fila vacía (siempre VALOR). */
  columnaChequeo: string;
  /** Rango inicial (letra) del bloque, para construir el rango de escritura. */
  columnaInicio: string;
  /** Rango final (letra) del bloque. */
  columnaFin: string;
  /** Orden de campos tal como se escriben en las columnas del bloque. */
  campos: Array<"cliente" | "concepto" | "proyecto" | "semana" | "valor" | "empresa" | "banco">;
  tieneEmpresa: boolean;
}

// Solo los bloques de columnas FIJAS y contiguas — pagos_pendientes_alberto
// y deudas_pendientes comparten columnas (X:Z) separadas por título de
// sección, no encajan en este modelo, y usan un escritor aparte más abajo
// (registrarPendienteEnSheet).
const BLOQUE_CONFIG: Partial<Record<BloqueEscritura, BloqueColumnas>> = {
  ingresos: {
    columnaChequeo: "E",
    columnaInicio: "B",
    columnaFin: "F",
    campos: ["cliente", "proyecto", "semana", "valor", "empresa"],
    tieneEmpresa: true,
  },
  pagos_proyectos: {
    columnaChequeo: "Q",
    columnaInicio: "N",
    columnaFin: "R",
    campos: ["cliente", "proyecto", "semana", "valor", "empresa"],
    tieneEmpresa: true,
  },
  pagos_extras: {
    columnaChequeo: "V",
    columnaInicio: "T",
    columnaFin: "V",
    campos: ["cliente", "semana", "valor"],
    tieneEmpresa: false,
  },
  // Columnas I:L de DATOS (GASTO/SEMANA/VALOR/BANCO) — mismo bloque que ya
  // se lee para consultar_cashflow_detalle y para el comparativo contra
  // Holded, ahora también escribible.
  gastos_fijos: {
    columnaChequeo: "K",
    columnaInicio: "I",
    columnaFin: "L",
    campos: ["concepto", "semana", "valor", "banco"],
    tieneEmpresa: false,
  },
  // Bug real encontrado en vivo (2026-09-01): este bloque apuntaba a
  // columnas AC:AE, que Carlos ya no usa — la sección real "APLAZAMIENTO
  // IMPUESTOS POR PAGAR" se movió a la columna N, apilada bajo PAGOS
  // PROYECTOS e IMPUESTOS POR PAGAR (ver parsearSeccionesColumnaN en
  // cashflowSheet.ts, lado de LECTURA, ya corregido). Escribir con la
  // config vieja habría creado filas huérfanas en AC:AE que nadie vuelve a
  // leer — mejor que falle explícitamente (ver registrarMovimientoEnSheet)
  // a que pierda datos en silencio. Escribir en la nueva ubicación
  // apilada, de columnas compartidas con Pagos Proyectos, necesita su
  // propio escritor (como registrarPendienteEnSheet para X:Z) — todavía no
  // se construyó porque no hubo un caso real que lo necesitara. Constrúyelo
  // cuando aparezca uno.
};

const PRIMERA_FILA_DATOS = 6;
const ULTIMA_FILA_BUSQUEDA = 500;

/**
 * Busca la primera fila REALMENTE vacía dentro del bloque, a partir de la
 * fila 6, para escribir ahí una fila NUEVA sin pisar datos existentes.
 *
 * Chequea TODAS las columnas del bloque, no solo VALOR — bug real encontrado
 * y corregido en auditoría: gastos_fijos tiene sub-encabezados de categoría
 * ("Impuestos", "Créditos", "Servicios"...) que ocupan la columna de
 * CONCEPTO pero dejan VALOR vacío; chequear solo VALOR marcaba esa fila
 * como "disponible" y sobrescribía el sub-encabezado. Verificado en vivo
 * contra la fila real, restaurada tras el hallazgo.
 */
async function findNextEmptyRow(bloque: BloqueEscritura): Promise<number> {
  const sheetId = assertSheetId();
  const sheets = getSheetsWriteClient();
  const config = BLOQUE_CONFIG[bloque];
  if (!config) {
    if (bloque === "aplazamiento_impuestos" || bloque === "impuestos_por_pagar") {
      throw new Error(
        `Todavía no se puede registrar automáticamente en "${bloque}" — esa sección vive en columnas ` +
          `compartidas con Pagos Proyectos (columna N, apilada) y necesita su propio escritor, que aún no ` +
          `se construyó. Regístralo a mano en el Sheet por ahora.`
      );
    }
    throw new Error(`El bloque "${bloque}" no usa findNextEmptyRow — usa registrarPendienteEnSheet.`);
  }
  const { columnaInicio, columnaFin } = config;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `DATOS!${columnaInicio}${PRIMERA_FILA_DATOS}:${columnaFin}${ULTIMA_FILA_BUSQUEDA}`,
    valueRenderOption: "FORMATTED_VALUE",
  });

  // La API de Sheets no devuelve filas vacías al final del rango (las trunca),
  // así que `values` solo cubre hasta la última fila con contenido. Un hueco
  // vacío ENTRE filas con datos sí se devuelve como fila []. Por eso:
  // - si hay un hueco real (TODAS las columnas del bloque vacías) dentro de
  //   los datos devueltos, se usa ese;
  // - si no hay hueco, la siguiente fila vacía es la que sigue al final de
  //   lo devuelto (values.length), no un error.
  const values = resp.data.values ?? [];
  const filaVacia = (row: unknown[] | undefined): boolean =>
    !row || row.every((celda) => celda === undefined || celda === null || String(celda).trim() === "");
  const offsetConHueco = values.findIndex((row) => filaVacia(row));
  const offset = offsetConHueco !== -1 ? offsetConHueco : values.length;

  const fila = PRIMERA_FILA_DATOS + offset;

  if (fila > ULTIMA_FILA_BUSQUEDA) {
    throw new Error(
      `El bloque "${bloque}" no tiene espacio disponible dentro del rango de búsqueda ` +
        `(filas ${PRIMERA_FILA_DATOS}-${ULTIMA_FILA_BUSQUEDA}). Amplía ULTIMA_FILA_BUSQUEDA.`
    );
  }

  return fila;
}

export interface NuevoMovimiento {
  bloque: BloqueEscritura;
  cliente_o_concepto: string;
  proyecto?: string;
  /** Solo aplica a 'gastos_fijos' (columna banco). Ignorado en el resto de bloques. */
  banco?: string;
  semana: string;
  valor: number;
  empresa: "WOBA" | "EWORKS";
}

export interface ResultadoEscritura {
  ok: boolean;
  mensaje: string;
  fila?: number;
  rango?: string;
}

/**
 * Escribe una fila NUEVA (nunca modifica una existente) en el bloque
 * correspondiente de la hoja DATOS, y lee de vuelta la celda escrita para
 * confirmar que se guardó correctamente.
 */
export async function registrarMovimientoEnSheet(movimiento: NuevoMovimiento): Promise<ResultadoEscritura> {
  const sheetId = assertSheetId();
  const sheets = getSheetsWriteClient();
  const config = BLOQUE_CONFIG[movimiento.bloque];
  if (!config) {
    if (movimiento.bloque === "aplazamiento_impuestos" || movimiento.bloque === "impuestos_por_pagar") {
      throw new Error(
        `Todavía no se puede registrar automáticamente en "${movimiento.bloque}" — esa sección vive en ` +
          `columnas compartidas con Pagos Proyectos (columna N, apilada) y necesita su propio escritor, que ` +
          `aún no se construyó. Regístralo a mano en el Sheet por ahora.`
      );
    }
    throw new Error(`El bloque "${movimiento.bloque}" no usa registrarMovimientoEnSheet — usa registrarPendienteEnSheet.`);
  }

  const fila = await findNextEmptyRow(movimiento.bloque);
  const rango = `DATOS!${config.columnaInicio}${fila}:${config.columnaFin}${fila}`;

  const valoresPorCampo: Record<string, string | number> = {
    cliente: movimiento.cliente_o_concepto,
    concepto: movimiento.cliente_o_concepto,
    proyecto: movimiento.proyecto ?? "",
    banco: movimiento.banco ?? "",
    semana: movimiento.semana,
    valor: movimiento.valor,
    empresa: movimiento.empresa,
  };

  const fila_valores = config.campos.map((campo) => valoresPorCampo[campo]);

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: rango,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [fila_valores] },
  });

  const verificacion = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: rango,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const filaEscrita = verificacion.data.values?.[0];
  const valorEscrito = filaEscrita?.[config.campos.indexOf("valor")];

  if (!filaEscrita || valorEscrito === undefined || valorEscrito === "") {
    return {
      ok: false,
      mensaje:
        `Se intentó escribir en ${rango} pero la verificación de lectura no encontró el valor esperado. ` +
        "Revisa manualmente la hoja antes de reintentar.",
      fila,
      rango,
    };
  }

  invalidarCacheDetalleRegistros();
  return {
    ok: true,
    mensaje: `Movimiento registrado y verificado en ${rango}.`,
    fila,
    rango,
  };
}

// Columnas X:Z de DATOS: dos secciones apiladas bajo su propio título
// ("PAGOS PENDIENTES ALBERTO" y "DEUDAS PENDIENTES OTROS"), sin rango de
// filas fijo por sección — mismos títulos que ya usa el lado de LECTURA
// (parsearSeccionesPendientes en cashflowSheet.ts).
const SECCION_COLUMNA_INICIO = "X";
const SECCION_COLUMNA_FIN = "Z";
const SECCION_RANGO_LECTURA = `DATOS!${SECCION_COLUMNA_INICIO}1:${SECCION_COLUMNA_FIN}500`;

const TITULO_SECCION: Record<"pagos_pendientes_alberto" | "deudas_pendientes", string> = {
  pagos_pendientes_alberto: "PAGOS PENDIENTES ALBERTO",
  deudas_pendientes: "DEUDAS PENDIENTES OTROS",
};

/**
 * Encuentra la primera fila EN BLANCO dentro de la sección pedida, sin
 * invadir la sección siguiente. Deliberadamente NUNCA inserta una fila
 * nueva (insertDimension): como las dos secciones comparten columnas con
 * TODOS los demás bloques de DATOS en la misma hoja, insertar una fila en
 * medio correría también las filas de Ingresos/Gastos Fijos/Pagos
 * Proyectos/etc. que están más abajo, aunque no tengan nada que ver —
 * solo escribe en huecos que ya existen. Si no hay hueco disponible, falla
 * explícitamente pidiendo que se amplíe el espacio a mano en el Sheet, en
 * vez de arriesgarse a invadir la sección de al lado.
 */
async function encontrarFilaDisponibleEnSeccion(
  seccion: "pagos_pendientes_alberto" | "deudas_pendientes"
): Promise<number> {
  const sheetId = assertSheetId();
  const sheets = getSheetsWriteClient();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: SECCION_RANGO_LECTURA,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const rows = resp.data.values ?? [];

  const indiceDeTitulo = (titulo: string): number => {
    const idx = rows.findIndex((row) => String(row[0] ?? "").trim().toUpperCase() === titulo);
    if (idx === -1) throw new Error(`No se encontró la sección "${titulo}" en la hoja DATOS (columna ${SECCION_COLUMNA_INICIO}).`);
    return idx; // 0-indexado dentro de `rows`, que arranca en la fila 1 real
  };

  const idxAlberto = indiceDeTitulo(TITULO_SECCION.pagos_pendientes_alberto);
  const idxDeudas = indiceDeTitulo(TITULO_SECCION.deudas_pendientes);

  // Solo Alberto tiene un límite estricto real (el título de Deudas, que
  // nunca debe invadirse). Deudas es la ÚLTIMA sección conocida — la API de
  // Sheets trunca las filas vacías al final de un rango leído, así que
  // `rows.length` ahí NO es un límite real del Sheet, solo el final de lo
  // que se devolvió; escribir justo después de la última fila con datos es
  // seguro (no hay ninguna sección más abajo que proteger).
  const tieneLimiteEstricto = seccion === "pagos_pendientes_alberto";
  const idxInicio = tieneLimiteEstricto ? idxAlberto : idxDeudas;
  const idxTopeEscaneo = tieneLimiteEstricto ? idxDeudas : rows.length;

  let idxUltimoConDatos = idxInicio;
  for (let i = idxInicio + 1; i < idxTopeEscaneo; i++) {
    const cliente = String(rows[i]?.[0] ?? "").trim();
    if (cliente && cliente.toUpperCase() !== "CLIENTE") {
      idxUltimoConDatos = i;
    }
  }

  const idxDisponible = idxUltimoConDatos + 1;
  if (tieneLimiteEstricto && idxDisponible >= idxDeudas) {
    throw new Error(
      `No hay filas vacías disponibles en la sección "${TITULO_SECCION[seccion]}" de la hoja DATOS — agrega ` +
        `manualmente más espacio en blanco entre las secciones antes de continuar.`
    );
  }

  return idxDisponible + 1; // fila real 1-indexada
}

export interface NuevoPendiente {
  seccion: "pagos_pendientes_alberto" | "deudas_pendientes";
  cliente: string;
  /** Puede ir vacío — pedido explícito: estos pagos van sin semana mientras no se sepa cuándo se pagarán. */
  semana?: string;
  valor: number;
}

/**
 * Registra una fila nueva en Pagos Pendientes Alberto o Deudas Pendientes
 * Otros — a diferencia de registrarMovimientoEnSheet, la semana es opcional
 * (estos son saldos pendientes sin fecha de pago conocida) y no hay columna
 * de empresa (aplica al grupo, no a WOBA/EWORKS por separado).
 */
export async function registrarPendienteEnSheet(pendiente: NuevoPendiente): Promise<ResultadoEscritura> {
  const sheetId = assertSheetId();
  const sheets = getSheetsWriteClient();

  const fila = await encontrarFilaDisponibleEnSeccion(pendiente.seccion);
  const rango = `DATOS!${SECCION_COLUMNA_INICIO}${fila}:${SECCION_COLUMNA_FIN}${fila}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: rango,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[pendiente.cliente, pendiente.semana ?? "", pendiente.valor]] },
  });

  const verificacion = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: rango,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const filaEscrita = verificacion.data.values?.[0];
  const valorEscrito = filaEscrita?.[2];

  if (!filaEscrita || valorEscrito === undefined || valorEscrito === "") {
    return {
      ok: false,
      mensaje:
        `Se intentó escribir en ${rango} pero la verificación de lectura no encontró el valor esperado. ` +
        "Revisa manualmente la hoja antes de reintentar.",
      fila,
      rango,
    };
  }

  invalidarCacheDetalleRegistros();
  return {
    ok: true,
    mensaje: `Movimiento registrado y verificado en ${rango}.`,
    fila,
    rango,
  };
}

// ── Edición de un valor YA ESCRITO en una fila existente ────────────────────
//
// Pedido explícito de Carlos: hasta ahora este sistema solo podía registrar
// movimientos NUEVOS (arriba) — no había ninguna forma de corregir un monto
// ya escrito en una fila existente, ni siquiera con aprobación explícita por
// botón, a diferencia del resto de las escrituras de este sistema (Holded,
// gastos, pagos recurrentes). Igual que esas, esto NUNCA escribe directo —
// solo propone (ver core/tools/editarValorCashflow.ts) tras aprobación por
// botón (ver core/google/edicionValorCashflowCallbackHandler.ts).
//
// Solo cubre los bloques de BLOQUE_CONFIG (columnas fijas y contiguas) — los
// de sección compartida (pagos_pendientes_alberto/deudas_pendientes) y los
// que todavía no tienen escritor (impuestos_por_pagar/aplazamiento_impuestos)
// quedan fuera por ahora, mismo criterio de "construir cuando aparezca un
// caso real" que ya sigue el resto de este archivo.

const TOLERANCIA_VALOR_ACTUAL = 0.01;

/** Desplaza una columna de una sola letra N posiciones (ej. "I" + 2 → "K") — suficiente para los bloques de este archivo, todos dentro de A-Z. */
function letraColumna(base: string, offset: number): string {
  return String.fromCharCode(base.charCodeAt(0) + offset);
}

export interface CriteriosBusquedaValorCashflow {
  bloque: BloqueEscritura;
  cliente_o_concepto: string;
  /** Vacío para buscar sin filtrar por semana (poco recomendable — puede haber varias filas del mismo cliente/concepto en semanas distintas). */
  semana: string;
  valorActual: number;
}

export interface FilaCashflowEncontrada {
  fila: number;
  clienteOConcepto: string;
  semana: string;
  valorActual: number;
  banco?: string;
  proyecto?: string;
}

/**
 * Busca, dentro del bloque indicado, la(s) fila(s) que coincidan con
 * cliente/concepto (parecido, no exacto — ver textosParecidos) + semana
 * (exacta) + el valor actual que se cree que tiene (con tolerancia de
 * redondeo) — el mismo criterio de "concepto + semana + monto actual" que
 * describió Carlos. Puede devolver más de una coincidencia real (dos filas
 * del mismo proveedor y semana con el mismo monto, por ejemplo) — nunca
 * adivina cuál es, quien llame decide qué hacer si hay más de una.
 *
 * Hallazgo real de auditoría xhigh (5 agentes independientes, confirmado):
 * esta función tuvo brevemente un atajo que, cuando había una fila
 * "aprendida" (ver cashflowFilaAprendidaSheet.ts) para el mismo
 * bloque+cliente+semana, la revalidaba y devolvía SOLA, saltándose por
 * completo el escaneo del resto del bloque — rompiendo justo la garantía de
 * "nunca adivina cuál es" que este mismo comentario promete, porque nunca
 * llegaba a comprobar si OTRA fila también calzaba. La clave de la caché ni
 * siquiera incluye "proyecto"/"banco", así que dos filas del mismo
 * cliente+semana en proyectos distintos (posible en ingresos/pagos_proyectos)
 * eran indistinguibles para ella. Dado que este Sheet es dinero real y Carlos
 * prioriza corrección sobre velocidad en todo lo financiero, se quitó el
 * atajo — esta función siempre escanea el bloque completo, igual que antes
 * de que la caché existiera.
 */
export async function buscarFilaCashflowParaEditar(criterios: CriteriosBusquedaValorCashflow): Promise<FilaCashflowEncontrada[]> {
  const config = BLOQUE_CONFIG[criterios.bloque];
  if (!config) {
    throw new Error(
      `El bloque "${criterios.bloque}" no admite edición de valor todavía (columnas de sección compartida, o sin escritor) — corrígelo a mano en el Sheet.`
    );
  }

  const sheetId = assertSheetId();
  const sheets = getSheetsWriteClient();

  const idxNombre = config.campos.indexOf(config.campos.includes("cliente") ? "cliente" : "concepto");
  const idxSemana = config.campos.indexOf("semana");
  const idxValor = config.campos.indexOf("valor");
  const idxBanco = config.campos.indexOf("banco");
  const idxProyecto = config.campos.indexOf("proyecto");
  // Hallazgo real de auditoría: sin este chequeo, un BLOQUE_CONFIG futuro
  // sin "valor"/"cliente"/"concepto"/"semana" haría que indexOf devuelva -1
  // en silencio, y letraColumna(base, -1) escribiría en una columna ANTES
  // de columnaInicio sin ningún error — nunca debe pasar desapercibido.
  if (idxNombre === -1 || idxSemana === -1 || idxValor === -1) {
    throw new Error(`Configuración inválida para el bloque "${criterios.bloque}": faltan columnas de nombre/semana/valor en BLOQUE_CONFIG.`);
  }
  const semanaBuscada = criterios.semana.trim().toUpperCase();

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `DATOS!${config.columnaInicio}${PRIMERA_FILA_DATOS}:${config.columnaFin}${ULTIMA_FILA_BUSQUEDA}`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = resp.data.values ?? [];

  const encontradas: FilaCashflowEncontrada[] = [];
  rows.forEach((row, i) => {
    const nombre = String(row[idxNombre] ?? "").trim();
    if (!nombre) return;
    const semana = String(row[idxSemana] ?? "").trim();
    const valorCrudo = row[idxValor];
    // Hallazgo real de auditoría: Number("") da 0 (no NaN) — una celda de
    // VALOR vacía (ej. las filas de sub-encabezado de categoría de
    // gastos_fijos: "Impuestos", "Créditos", "Servicios", que sí tienen
    // texto en concepto pero VALOR vacío — ver comentario de
    // findNextEmptyRow más arriba en este mismo archivo) pasaría el chequeo
    // de Number.isFinite como si fuera un valor real de 0, permitiendo
    // "encontrar" y proponer editar una fila de título en vez de un dato
    // real. Se rechaza explícitamente antes de intentar convertir.
    if (valorCrudo === undefined || valorCrudo === null || valorCrudo === "") return;
    const valor = typeof valorCrudo === "number" ? valorCrudo : Number(valorCrudo);
    if (!Number.isFinite(valor)) return;

    if (!textosParecidos(criterios.cliente_o_concepto, nombre)) return;
    if (semanaBuscada && semana.toUpperCase() !== semanaBuscada) return;
    if (!montosCercanos(valor, criterios.valorActual, TOLERANCIA_VALOR_ACTUAL)) return;

    encontradas.push({
      fila: PRIMERA_FILA_DATOS + i,
      clienteOConcepto: nombre,
      semana,
      valorActual: valor,
      banco: idxBanco !== -1 ? String(row[idxBanco] ?? "") || undefined : undefined,
      proyecto: idxProyecto !== -1 ? String(row[idxProyecto] ?? "") || undefined : undefined,
    });
  });

  return encontradas;
}

/**
 * Corrige el valor de una fila YA IDENTIFICADA (ver buscarFilaCashflowParaEditar)
 * — nunca toca ningún otro campo de la fila. Antes de escribir, relee la
 * celda y confirma que sigue teniendo el valor esperado (el que se vio al
 * proponer el cambio): si cambió mientras tanto (Carlos lo corrigió a mano,
 * u otra escritura concurrente), aborta en vez de sobrescribir a ciegas —
 * la propuesta pudo quedar pendiente de aprobación un buen rato. Después de
 * escribir, relee de nuevo para verificar que el nuevo valor quedó guardado.
 */
export async function editarValorEnFilaCashflow(
  bloque: BloqueEscritura,
  fila: number,
  valorEsperadoActual: number,
  valorNuevo: number
): Promise<ResultadoEscritura> {
  const config = BLOQUE_CONFIG[bloque];
  if (!config) throw new Error(`El bloque "${bloque}" no admite edición de valor.`);

  const idxValor = config.campos.indexOf("valor");
  // Mismo chequeo que buscarFilaCashflowParaEditar — nunca escribir en una
  // columna calculada a partir de un índice -1 sin avisar.
  if (idxValor === -1) {
    throw new Error(`Configuración inválida para el bloque "${bloque}": falta la columna "valor" en BLOQUE_CONFIG.`);
  }
  const columnaValor = letraColumna(config.columnaInicio, idxValor);
  const rango = `DATOS!${columnaValor}${fila}`;

  const sheetId = assertSheetId();
  const sheets = getSheetsWriteClient();

  const actual = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: rango,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const valorActualCrudo = actual.data.values?.[0]?.[0];
  const valorActualNumero = typeof valorActualCrudo === "number" ? valorActualCrudo : Number(valorActualCrudo);
  if (!Number.isFinite(valorActualNumero) || !montosCercanos(valorActualNumero, valorEsperadoActual, TOLERANCIA_VALOR_ACTUAL)) {
    return {
      ok: false,
      mensaje:
        `El valor en ${rango} ya no es ${valorEsperadoActual} (ahora es "${valorActualCrudo}") — algo cambió desde que se propuso ` +
        "esta edición. Revísalo a mano en el Sheet antes de reintentar.",
      fila,
      rango,
    };
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: rango,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[valorNuevo]] },
  });

  const verificacion = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: rango,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const valorEscritoCrudo = verificacion.data.values?.[0]?.[0];
  const valorEscrito = typeof valorEscritoCrudo === "number" ? valorEscritoCrudo : Number(valorEscritoCrudo);

  if (!Number.isFinite(valorEscrito) || !montosCercanos(valorEscrito, valorNuevo, TOLERANCIA_VALOR_ACTUAL)) {
    return {
      ok: false,
      mensaje: `Se intentó escribir ${valorNuevo} en ${rango} pero la verificación no coincide (quedó "${valorEscritoCrudo}") — revisa manualmente la hoja.`,
      fila,
      rango,
    };
  }

  invalidarCacheDetalleRegistros();
  return {
    ok: true,
    mensaje: `Valor corregido y verificado en ${rango}: ${valorEsperadoActual} → ${valorNuevo}.`,
    fila,
    rango,
  };
}
