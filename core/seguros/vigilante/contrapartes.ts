/**
 * ¿A quién le pagamos? — reconocimiento de aseguradoras y corredurías en la descripción de un apunte bancario.
 *
 * Cada contraparte tiene un MODO que decide qué hace el vigilante con un cargo suyo:
 *  - "poliza"           → se espera una póliza registrada de esa empresa; sin ella se avisa.
 *  - "fuera_de_alcance" → decisión explícita de Carlos de no seguirla en Wobi Seguros (silencio).
 *  - "puntual"          → cargos sueltos y esperados (seguros de viaje por trayecto): silencio.
 *  - "baja"             → servicio dado de baja: cualquier cargo nuevo es una anomalía y se avisa.
 *  - "desconocida"      → aseguradora que el sistema no conocía: se avisa una vez para que Carlos la clasifique.
 *
 * Los modos «fuera_de_alcance», «puntual» y «baja» no son opiniones del código: salen de decisiones de Carlos ya
 * escritas en docs/wobi-seguros.md (§13 puntos 9, 10 y 12, §16) y en docs/calendario_fiscal.json. Si Carlos cambia
 * una, se cambia aquí y en ese documento.
 *
 * Los patrones se aplican sobre texto normalizado (minúsculas, sin tildes, sin signos) y siempre con límite de
 * palabra: la primera pasada manual del 27/09/2026 ya tuvo un falso positivo real («reale» dentro de «CORREALES»,
 * el apellido de una persona de Footprint), y «iati» aparece dentro de «ASSOCIATION».
 */

export type ModoContraparte = "poliza" | "fuera_de_alcance" | "puntual" | "baja" | "desconocida";

export interface Contraparte {
  /** Identificador estable (minúsculas): «markel», «acodrid»… o «generica:<huella>» si no hay nombre reconocible. */
  clave: string;
  nombre: string;
  modo: ModoContraparte;
  /** Por qué tiene ese modo (se cita en los avisos y en el código de quien lo lea). */
  motivo: string;
}

interface EntradaCatalogo extends Contraparte {
  patron: RegExp;
}

export function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const CATALOGO: EntradaCatalogo[] = [
  { clave: "acodrid", nombre: "Acodrid (correduría)", modo: "poliza", motivo: "correduría de WOBA, EWORKS y Footprint", patron: /\bacodrid\b/ },
  { clave: "markel", nombre: "Markel Insurance", modo: "poliza", motivo: "RC de WOBA, EWORKS y Footprint", patron: /\bmarkel\b/ },
  { clave: "allianz", nombre: "Allianz", modo: "poliza", motivo: "todo riesgo del showroom de WOBA", patron: /\ballianz\b/ },
  {
    clave: "aegon",
    nombre: "Aegon (seguro de salud)",
    modo: "fuera_de_alcance",
    motivo: "Carlos lo excluyó del alcance de Wobi Seguros (27/09/2026, docs/wobi-seguros.md §13 punto 9)",
    patron: /\baegon\b/,
  },
  {
    clave: "pelayo",
    nombre: "Pelayo (coche, moto y piso)",
    modo: "fuera_de_alcance",
    motivo: "ya se avisan por el calendario fiscal (seguro_coche, seguro_moto, seguro_piso_perez_lavid)",
    patron: /\bpelayo\b/,
  },
  {
    clave: "iati",
    nombre: "IATI (seguros de viaje)",
    modo: "puntual",
    motivo: "seguros de viaje contratados trayecto a trayecto con tarjeta (Footprint); la póliza anual se descartó el 30/09/2026",
    patron: /\biati\b/,
  },
  {
    clave: "solunion",
    nombre: "Solunion (seguro de crédito)",
    modo: "baja",
    motivo: "Carlos confirmó el 27/09/2026 que ya no lo tienen (docs/wobi-seguros.md §13 punto 10)",
    patron: /\bsolunion\b/,
  },
  {
    clave: "suramericana",
    nombre: "Suramericana",
    modo: "fuera_de_alcance",
    motivo: "fuera del alcance inicial (Carlos, 27/09/2026, docs/wobi-seguros.md §16)",
    patron: /\bsuramericana\b/,
  },
];

/** Otras aseguradoras que el sistema reconoce por el nombre pero que no tiene registradas: un cargo suyo se avisa. */
const OTRAS_ASEGURADORAS = [
  "mapfre", "axa", "generali", "hiscox", "zurich", "mutua madrilena", "sanitas", "adeslas", "caser", "reale", "liberty",
  "ocaso", "catalana occidente", "santalucia", "santa lucia", "helvetia", "cesce", "dkv", "asisa", "cigna", "segurcaixa",
  "nationale nederlanden", "linea directa", "verti", "bupa", "chubb", "sompo", "aviva", "hdi", "plus ultra", "fiatc",
  "arag", "kinsale", "bass underwriters", "qbe", "wakam", "intermundial", "heymondo", "safetywing", "cover genius",
];
const PATRON_OTRAS = new RegExp(`\\b(${OTRAS_ASEGURADORAS.join("|")})\\b`);

/** Palabras que delatan un seguro aunque el nombre no esté en la lista. */
const PATRON_GENERICO = /\b(seguros?|aseguradora|correduria|poliza|reaseguros?|insurance|assurance|underwriters?)\b/;

/**
 * Movimientos entre cuentas o empresas del propio grupo: nunca son un cargo de una aseguradora, aunque su concepto
 * hable de seguros (caso real, 01/09/2026: «Transferencia propia seguro resp. civil», 1.300 € que Carlos pasó de
 * Main a BBVA para cubrir los recibos; el vigilante lo avisó como «cargo a una aseguradora desconocida»).
 */
const PATRON_ENTRE_CUENTAS_PROPIAS =
  /\b(transferencia propia|traspaso propio|entre empresas?|business atelier|compania de proyectos eworks|business footprint)\b/;

const PALABRAS_VACIAS = new Set([
  "adeudo", "adeudos", "de", "del", "a", "su", "cargo", "recibo", "recibos", "poliza", "polizas", "transferencia",
  "transferencias", "to", "from", "n", "s", "l", "sa", "sl", "sas", "sociedad", "seguros", "seguro", "la", "el", "y",
]);

/**
 * Nombre estable de una contraparte sin catalogar: las primeras palabras con letras, sin cifras ni palabras vacías.
 * «N 2026252000055653 AEGON ESPANA S.A. ADEUDO DE SEGUROS» → «aegon-espana». Sirve para avisar UNA vez por
 * contraparte y no una vez por cada mes en que cambia el número de remesa.
 */
export function huellaContraparte(descripcion: string): string {
  const palabras = normalizarTexto(descripcion)
    .split(" ")
    .filter((p) => p && !/\d/.test(p) && !PALABRAS_VACIAS.has(p));
  const huella = palabras.slice(0, 3).join("-");
  return huella || "sin-nombre";
}

/** Qué contraparte de seguros es un apunte (o null si no parece un pago de seguros). */
export function clasificarContraparte(descripcion: string): Contraparte | null {
  const texto = normalizarTexto(descripcion);
  if (!texto || PATRON_ENTRE_CUENTAS_PROPIAS.test(texto)) return null;

  for (const { patron, ...contraparte } of CATALOGO) {
    if (patron.test(texto)) return contraparte;
  }

  const otra = texto.match(PATRON_OTRAS);
  if (otra) {
    return {
      clave: otra[1].replace(/ /g, "-"),
      nombre: otra[1],
      modo: "desconocida",
      motivo: "aseguradora que Wobi Seguros no tiene registrada",
    };
  }

  if (PATRON_GENERICO.test(texto)) {
    return {
      clave: `generica:${huellaContraparte(descripcion)}`,
      nombre: huellaContraparte(descripcion),
      modo: "desconocida",
      motivo: "el concepto del banco habla de seguros pero no es una aseguradora conocida",
    };
  }

  return null;
}

/**
 * Claves de contraparte con las que se reconoce una póliza del registro, a partir de su aseguradora y su correduría.
 * Una póliza de Markel gestionada por Acodrid se reconoce por ambas: el cargo puede venir de la aseguradora
 * («Markel Insurance SE ADEUDO») o de la correduría («To Correduria De Seguros Acodrid»).
 */
export function clavesDePoliza(aseguradora: string, correduria: string): string[] {
  const claves = new Set<string>();
  for (const campo of [aseguradora, correduria]) {
    const texto = normalizarTexto(campo ?? "");
    if (!texto) continue;
    for (const { patron, clave } of CATALOGO) if (patron.test(texto)) claves.add(clave);
    const otra = texto.match(PATRON_OTRAS);
    if (otra) claves.add(otra[1].replace(/ /g, "-"));
  }
  return [...claves];
}
