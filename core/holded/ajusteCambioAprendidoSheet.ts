import { actualizarFila, agregarFilaAtomica, leerFilas } from "../google/sheetsKeyValueStore";
import { conMutex } from "../utils/asyncMutex";
import type { Empresa } from "./client";

/**
 * Pedido explícito de Carlos (2026-09-16): "que la inteligencia del sistema vaya aprendiendo cada vez
 * que haga un ajuste en cuál tipo de transacción es en la que debería hacerlo... si en algún momento
 * yo lo corrijo y lo quito, el sistema debe identificar que ahí no va" — mismo principio que los demás
 * stores de aprendizaje del proyecto (proveedorAliasSheet.ts, cuentaCorregidaAprendidaSheet.ts, etc.):
 * una corrección humana EXPLÍCITA (acá, borrar el pago de ajuste que Wobi creó) se convierte en una
 * exclusión permanente y exacta por proveedor — nunca fuzzy, nunca se "olvida" sola.
 *
 * El ajuste de cambio de divisa corre en modo totalmente automático (sin botón de confirmación, pedido
 * explícito de Carlos) — esta es la única red de seguridad basada en aprendizaje: si Carlos revierte un
 * ajuste ya aplicado a un proveedor concreto, ese proveedor deja de recibir ajustes automáticos y vuelve
 * al camino de "requiere_revision" (avisar y esperar revisión manual), sin bloquear a ningún otro.
 */
const TAB_NAME = "_ajustes_cambio_aprendizaje";
const HEADERS = ["clave", "empresa", "contactId", "contactName", "vecesAplicado", "vecesRevertido", "excluido", "actualizadoEn"];
const NUM_COLS = HEADERS.length;
const CLAVE_MUTEX = `holded-ajustes-cambio-aprendizaje:${TAB_NAME}`;

interface RegistroAprendizaje {
  rowIndex: number;
  clave: string;
  empresa: Empresa;
  contactId: string;
  contactName: string;
  vecesAplicado: number;
  vecesRevertido: number;
  excluido: boolean;
  actualizadoEn: number;
}

function clave(empresa: Empresa, contactId: string): string {
  return `${empresa}:${contactId.trim()}`;
}

function desdeFila(rowIndex: number, valores: string[]): RegistroAprendizaje | undefined {
  if (!valores[0] || !valores[2]) return undefined;
  const empresa = valores[1] as Empresa;
  if (!(["WOBA", "EWORKS", "Footprint"] as string[]).includes(empresa)) return undefined;
  return {
    rowIndex,
    clave: valores[0],
    empresa,
    contactId: valores[2],
    contactName: valores[3] || "",
    vecesAplicado: Number(valores[4]) || 0,
    vecesRevertido: Number(valores[5]) || 0,
    excluido: valores[6] === "true",
    actualizadoEn: Number(valores[7]) || 0,
  };
}

function aFila(registro: Omit<RegistroAprendizaje, "rowIndex">): (string | number)[] {
  return [
    registro.clave,
    registro.empresa,
    registro.contactId,
    registro.contactName,
    registro.vecesAplicado,
    registro.vecesRevertido,
    registro.excluido ? "true" : "false",
    registro.actualizadoEn,
  ];
}

let cache: Map<string, RegistroAprendizaje> | undefined;

async function cargar(): Promise<Map<string, RegistroAprendizaje>> {
  if (cache) return cache;
  const filas = (await leerFilas(TAB_NAME, NUM_COLS, HEADERS))
    .map((f) => desdeFila(f.rowIndex, f.valores))
    .filter((f): f is RegistroAprendizaje => Boolean(f));
  cache = new Map(filas.map((r) => [r.clave, r]));
  return cache;
}

/** Consultada ANTES de aplicar un ajuste automático — si excluido, cae al camino manual de siempre. */
export async function proveedorExcluidoDeAjusteCambio(empresa: Empresa, contactId: string): Promise<boolean> {
  if (!contactId.trim()) return false;
  const mapa = await cargar();
  return mapa.get(clave(empresa, contactId))?.excluido ?? false;
}

async function actualizar(
  empresa: Empresa,
  contactId: string,
  contactName: string,
  cambio: (actual: RegistroAprendizaje | undefined) => Pick<RegistroAprendizaje, "vecesAplicado" | "vecesRevertido" | "excluido">
): Promise<void> {
  if (!contactId.trim()) return;
  await conMutex(CLAVE_MUTEX, async () => {
    const mapa = await cargar();
    const k = clave(empresa, contactId);
    const actual = mapa.get(k);
    const siguienteValores = cambio(actual);
    const siguiente: Omit<RegistroAprendizaje, "rowIndex"> = {
      clave: k,
      empresa,
      contactId,
      contactName: contactName || actual?.contactName || "",
      ...siguienteValores,
      actualizadoEn: Date.now(),
    };
    if (actual) {
      await actualizarFila(TAB_NAME, actual.rowIndex, NUM_COLS, aFila(siguiente));
      mapa.set(k, { ...siguiente, rowIndex: actual.rowIndex });
    } else {
      const rowIndex = await agregarFilaAtomica(TAB_NAME, NUM_COLS, HEADERS, aFila(siguiente));
      mapa.set(k, { ...siguiente, rowIndex });
    }
  });
}

/** Llamada cada vez que ejecutarAjusteCambioDurable aplica un ajuste con éxito. */
export async function registrarAjusteCambioAplicado(empresa: Empresa, contactId: string, contactName: string): Promise<void> {
  await actualizar(empresa, contactId, contactName, (actual) => ({
    vecesAplicado: (actual?.vecesAplicado ?? 0) + 1,
    vecesRevertido: actual?.vecesRevertido ?? 0,
    excluido: actual?.excluido ?? false,
  }));
}

/**
 * Llamada por revisarAjustesCambioRevertidos.ts cuando detecta que un pago de ajuste ya verificado
 * desapareció de Holded — Carlos lo borró a mano. Una sola reversión ya excluye al proveedor
 * (mismo criterio "nunca fuzzy, siempre exacto" que el resto de los stores de máxima confianza):
 * más vale preguntar de más que repetir un ajuste que Carlos ya rechazó una vez.
 */
export async function registrarAjusteCambioRevertido(empresa: Empresa, contactId: string, contactName: string): Promise<void> {
  await actualizar(empresa, contactId, contactName, (actual) => ({
    vecesAplicado: actual?.vecesAplicado ?? 0,
    vecesRevertido: (actual?.vecesRevertido ?? 0) + 1,
    excluido: true,
  }));
}

export function invalidarCacheAjusteCambioAprendido(): void {
  cache = undefined;
}
