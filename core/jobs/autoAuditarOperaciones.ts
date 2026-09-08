import { obtenerComprasDelDia, type CompraDelDia } from "../holded/write";
import type { Empresa } from "../holded/client";
import { palabrasDe } from "../utils/textoParecido";
import { montosCercanos } from "../utils/montos";
import { verificarConversion } from "../utils/exchangeRate";
import { obtenerAdmins } from "../telegram/authorizedUsersSheet";
import { sendTelegramMessage } from "../telegram/client";
import { formatDateLocal } from "../utils/dateFormat";

const EMPRESAS: Empresa[] = ["WOBA", "EWORKS", "Footprint"];

/**
 * Pedido explícito de Carlos, tras varios errores reales la misma noche (Uber Colombia asignado a un
 * viaje de México, Uber Eats registrado en "Otros servicios" en vez de la cuenta real de alimentación,
 * GoTo facturado a nombre de LinkedIn, un gasto de Google en USD convertido a EUR sin verificar la
 * tasa real): "auto audítate tu trabajo diariamente... para disminuir errores". Este job corre una vez
 * al final del día y revisa TODAS las compras creadas ese día en las 3 empresas, buscando los mismos
 * patrones que ya causaron un error real — nunca corrige ni decide nada por sí solo, solo junta lo que
 * encuentra y se lo manda a los admins para que lo revisen.
 *
 * v1 — tres chequeos, elegidos porque cada uno reutiliza infraestructura ya construida y probada esta
 * misma noche, sin necesitar un sistema nuevo de registro de decisiones (la propuesta original de un
 * gasto se borra al crearlo — no queda nada que auditar ahí salvo lo que el propio documento de Holded
 * ya conserva):
 *   1) Posibles duplicados: mismo proveedor + monto parecido, mismo día.
 *   2) Contacto sin ningún rastro textual real en la descripción del gasto (el patrón del caso GoTo/
 *      LinkedIn) — señal, no prueba; puede tener falsos positivos (revisar, no un error confirmado).
 *   3) Conversión de moneda sospechosa: cuando la descripción trae el patrón "(<monto> <moneda>,
 *      comprobante en <moneda>)" (ver conceptoConMonedaOriginal en procesarGastoEntrante.ts), se
 *      compara contra la tasa real del BCE ese día (ver exchangeRate.ts) — solo se avisa si la
 *      diferencia supera el spread normal de tarjeta.
 */
const TOLERANCIA_DUPLICADO_EUR = 0.02;
const TOLERANCIA_CONVERSION_PCT = 4; // spread normal de tarjeta ronda 1-3% — 4% ya vale la pena revisar

const PALABRAS_GENERICAS_CONTACTO = new Set([
  "company",
  "compania",
  "companies",
  "unlimited",
  "limited",
  "technologies",
  "technology",
  "sociedad",
  "anonima",
  "limitada",
  "spain",
  "espana",
  "madrid",
  "sl",
  "sa",
  "sau",
  "slu",
  "ltd",
  "inc",
  "corp",
  "corporation",
  "group",
  "grupo",
  "holdings",
  "international",
  "services",
  "servicios",
  "solutions",
  "systems",
  "global",
]);

interface Hallazgo {
  compra: CompraDelDia;
  motivo: string;
}

function detectarPosiblesDuplicados(compras: CompraDelDia[]): Hallazgo[] {
  const hallazgos: Hallazgo[] = [];
  const yaMarcados = new Set<string>();

  for (let i = 0; i < compras.length; i++) {
    if (yaMarcados.has(compras[i].id)) continue;
    for (let j = i + 1; j < compras.length; j++) {
      if (yaMarcados.has(compras[j].id)) continue;
      const a = compras[i];
      const b = compras[j];
      const mismoProveedor = a.contactName === b.contactName;
      const montoParecido = a.moneda === b.moneda && montosCercanos(a.total, b.total, TOLERANCIA_DUPLICADO_EUR);
      if (mismoProveedor && montoParecido) {
        hallazgos.push({
          compra: a,
          motivo: `posible duplicado — mismo proveedor y monto que la compra ${b.id} (${b.total.toFixed(2)} ${b.moneda})`,
        });
        hallazgos.push({
          compra: b,
          motivo: `posible duplicado — mismo proveedor y monto que la compra ${a.id} (${a.total.toFixed(2)} ${a.moneda})`,
        });
        yaMarcados.add(a.id);
        yaMarcados.add(b.id);
      }
    }
  }

  return hallazgos;
}

function contactoSinRastroEnElTexto(compra: CompraDelDia): boolean {
  const palabrasContacto = palabrasDe(compra.contactName, 5).filter((p) => !PALABRAS_GENERICAS_CONTACTO.has(p));
  if (palabrasContacto.length === 0) return false; // el nombre del contacto no tiene ninguna palabra propia distintiva — no se puede evaluar

  const textoGasto = `${compra.descripcion} ${compra.nombresLinea.join(" ")}`;
  const palabrasTexto = new Set(palabrasDe(textoGasto, 4));

  return !palabrasContacto.some((p) => palabrasTexto.has(p));
}

function detectarContactoSinRastro(compras: CompraDelDia[]): Hallazgo[] {
  return compras
    .filter(contactoSinRastroEnElTexto)
    .map((compra) => ({
      compra,
      motivo: `el nombre del contacto ("${compra.contactName}") no aparece por ningún lado en la descripción del gasto — revisar si el proveedor es el correcto`,
    }));
}

const PATRON_MONEDA_ORIGINAL = /\(([\d.,]+)\s+([A-Z]{3}),\s*comprobante en \2\)/;

async function detectarConversionesSospechosas(compras: CompraDelDia[]): Promise<Hallazgo[]> {
  const hallazgos: Hallazgo[] = [];

  for (const compra of compras) {
    const match = compra.descripcion.match(PATRON_MONEDA_ORIGINAL);
    if (!match) continue;

    const montoOriginal = Number(match[1].replace(/,/g, ""));
    const monedaOriginal = match[2];
    if (!Number.isFinite(montoOriginal) || monedaOriginal === compra.moneda) continue;

    const verificacion = await verificarConversion(montoOriginal, monedaOriginal, compra.total, compra.moneda, compra.fecha).catch(
      (error) => {
        console.error(`[autoAuditarOperaciones] Error verificando conversión de la compra ${compra.id} (no crítico):`, error);
        return undefined;
      }
    );
    if (!verificacion) continue; // no se pudo verificar — nunca se avisa sobre una duda

    if (verificacion.diferenciaPct > TOLERANCIA_CONVERSION_PCT) {
      hallazgos.push({
        compra,
        motivo:
          `conversión ${monedaOriginal}→${compra.moneda} se aleja ${verificacion.diferenciaPct.toFixed(1)}% de la tasa real del BCE ese día ` +
          `(esperado ≈${verificacion.montoEsperado.toFixed(2)} ${compra.moneda} a tasa ${verificacion.tasaReal.toFixed(4)}, registrado ${compra.total.toFixed(2)} ${compra.moneda})`,
      });
    }
  }

  return hallazgos;
}

/**
 * Caso real (RapidOps/Salesmate, Footprint, 2026-09-08): una compra en USD quedó con
 * payments_pending>0 después de conciliarse — el movimiento bancario real ya estaba conciliado al
 * 100%, pero Holded aplicó el equivalente en EUR (pensado solo para reportes) como si fuera el pago
 * real, dejando un saldo pendiente ficticio. Mismo comportamiento ya detectado en el momento (ver
 * reconciliarMovimiento, core/holded/write.ts) para conciliaciones NUEVAS — este chequeo cubre
 * además cualquier compra vieja que haya quedado así sin que nadie lo note. Señal, no prueba: un
 * pendiente real y genuino (factura todavía sin pagar del todo) también entra acá — se reporta como
 * "revisar", nunca como error confirmado. Solo aplica a compras en moneda distinta a EUR, que es
 * donde existe este comportamiento de Holded; un pendiente en EUR es simplemente un pendiente real.
 */
function detectarSaldoPendienteSospechoso(compras: CompraDelDia[]): Hallazgo[] {
  return compras
    .filter((c) => c.moneda !== "EUR" && c.pagosPendiente > 0.01 && c.pagosTotal > 0.01)
    .map((compra) => ({
      compra,
      motivo:
        `saldo pendiente de ${compra.pagosPendiente.toFixed(2)} ${compra.moneda} tras un pago parcial de ${compra.pagosTotal.toFixed(2)} ${compra.moneda} — ` +
        `revisar si el movimiento bancario real ya está conciliado al 100% (posible saldo ficticio de Holded en monedas no-EUR, ver reconciliarMovimiento)`,
    }));
}

async function auditarEmpresa(empresa: Empresa, desde: string, hasta: string): Promise<{ compra: CompraDelDia; motivos: string[] }[]> {
  const compras = await obtenerComprasDelDia(empresa, desde, hasta).catch((error) => {
    console.error(`[autoAuditarOperaciones] Error obteniendo las compras de ${empresa} (${desde} a ${hasta}):`, error);
    return [] as CompraDelDia[];
  });
  if (compras.length === 0) return [];

  const [duplicados, contactos, conversiones, saldosPendientes] = await Promise.all([
    Promise.resolve(detectarPosiblesDuplicados(compras)),
    Promise.resolve(detectarContactoSinRastro(compras)),
    detectarConversionesSospechosas(compras),
    Promise.resolve(detectarSaldoPendienteSospechoso(compras)),
  ]);

  const porCompra = new Map<string, { compra: CompraDelDia; motivos: string[] }>();
  for (const h of [...duplicados, ...contactos, ...conversiones, ...saldosPendientes]) {
    const entry = porCompra.get(h.compra.id) ?? { compra: h.compra, motivos: [] };
    entry.motivos.push(h.motivo);
    porCompra.set(h.compra.id, entry);
  }

  return Array.from(porCompra.values());
}

// 2 días (hoy + ayer), no solo hoy — hallazgo real al probarlo en vivo: los gastos que Carlos procesa
// un día casi nunca tienen la FECHA DE FACTURA de ese mismo día (suele trabajar una cola de correos
// atrasados) — filtrar solo por "hoy" habría dejado la auditoría vacía casi todas las noches. No es
// una solución completa (un documento con fecha de factura de hace más de un día seguiría sin
// revisarse), pero cubre el caso real más común sin necesitar un registro nuevo de "qué se creó hoy"
// que Holded no expone por API.
const DIAS_VENTANA_AUDITORIA = 1;

/** Corre una vez al final del día — revisa las 3 empresas y avisa a los admins si encuentra algo. Silencio total si no hay nada (mismo criterio que el resumen diario de pendientes). */
export async function autoAuditarOperacionesDiarias(): Promise<void> {
  const hoy = new Date();
  const ayer = new Date(hoy.getTime() - DIAS_VENTANA_AUDITORIA * 86400000);
  const desde = formatDateLocal(ayer);
  const hasta = formatDateLocal(hoy);

  const porEmpresa = await Promise.all(EMPRESAS.map(async (empresa) => ({ empresa, hallazgos: await auditarEmpresa(empresa, desde, hasta) })));
  const conHallazgos = porEmpresa.filter((p) => p.hallazgos.length > 0);
  if (conHallazgos.length === 0) return;

  const bloques = conHallazgos.map(({ empresa, hallazgos }) => {
    const lineas = hallazgos.map(
      ({ compra, motivos }) =>
        `• ${compra.contactName} — ${compra.total.toFixed(2)} ${compra.moneda} (id ${compra.id})\n  ${motivos.join("\n  ")}`
    );
    return `*${empresa}* (${hallazgos.length}):\n${lineas.join("\n")}`;
  });

  const texto =
    `🔎 *Auto-auditoría (${desde} a ${hasta})* — encontré ${conHallazgos.reduce((acc, p) => acc + p.hallazgos.length, 0)} operación(es) que valen la pena revisar (ninguna se tocó, esto es solo un aviso):\n\n` +
    bloques.join("\n\n") +
    `\n\nRevísalas cuando puedas — dime si alguna está mal y la corrijo.`;

  const admins = await obtenerAdmins();
  for (const admin of admins) {
    await sendTelegramMessage(admin.userId, texto).catch((error) =>
      console.error(`[autoAuditarOperaciones] Error avisando al chat ${admin.userId}:`, error)
    );
  }
}
