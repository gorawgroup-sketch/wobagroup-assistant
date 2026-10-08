import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { explicarPendiente, FRASES_GENERICAS_PROHIBIDAS } from "../gmail/automatico/service";

/**
 * Punto 3 del plan contra la recurrencia (Carlos, 08-10-2026): cero etiquetas genéricas. Todo motivo que el correo automático
 * puede emitir tiene una explicación propia y concreta; ninguna cae en el comodín ni usa una frase prohibida. Los códigos se
 * extraen del código fuente real, así que un motivo nuevo sin explicación rompe esta prueba.
 */
function codigosEmitidos(): string[] {
  const fuentes = ["core/gmail/automatico/model.ts", "core/gmail/automatico/service.ts"]
    .map((f) => readFileSync(join(process.cwd(), f), "utf8")).join("\n");
  const patrones = [/motivos\.push\("([a-z_]+)"/g, /motivos: \["([a-z_]+)"/g, /operacionesBloqueadas\.set\(op\.id, \["([a-z_]+)"/g,
    /const motivo = "([a-z_]+)"/g, /return \{ correo, motivos: \["([a-z_]+)"/g, /\?\? "([a-z_]+)"\)/g, /motivoRelectura = [^;]*?"([a-z_]+)"[^;]*?"([a-z_]+)"[^;]*?"([a-z_]+)"/gs];
  const codigos = new Set<string>();
  for (const re of patrones) for (const m of fuentes.matchAll(re)) m.slice(1).filter(Boolean).forEach((c) => codigos.add(c));
  return [...codigos].filter((c) => !["analisis", "recuperacion", "verificacion", "alta"].includes(c)).sort();
}

const detalleMuestra = { proveedor: "Proveedor Muestra", empresa: "Footprint" as const, monto: 12.5, moneda: "EUR", motivos: [] as string[] };

test("todo motivo emitido tiene explicación propia, sin comodín ni frases genéricas", () => {
  const codigos = codigosEmitidos();
  assert.ok(codigos.length >= 25, `se esperaban al menos 25 códigos, hay ${codigos.length}: ${codigos.join(", ")}`);
  const sinExplicacion: string[] = [];
  for (const codigo of codigos) {
    const texto = explicarPendiente([codigo], detalleMuestra);
    if (/sin explicación catalogada/.test(texto) || FRASES_GENERICAS_PROHIBIDAS.some((f) => texto.includes(f))) sinExplicacion.push(`${codigo} → ${texto}`);
  }
  assert.deepEqual(sinExplicacion, []);
});

test("los motivos con dato lo muestran: lectura, relectura, error, operación y tipo de documento", () => {
  assert.match(explicarPendiente(["lectura_incompleta", "lectura:No pude leer el adjunto «a.pdf»"]), /No pude leer el adjunto «a\.pdf»/);
  assert.match(explicarPendiente(["relectura_no_coincide", "relectura:antes 10 EUR; ahora 12 EUR"]), /antes 10 EUR; ahora 12 EUR/);
  assert.match(explicarPendiente(["relectura_fallida", "error:Holded 502"]), /Holded 502/);
  assert.match(explicarPendiente(["operacion_conciliando:uuid-privado"]), /quedó a medias al conciliar/);
  assert.doesNotMatch(explicarPendiente(["operacion_conciliando:uuid-privado"]), /uuid-privado/);
  assert.match(explicarPendiente(["tipo_factura_completa"], detalleMuestra), /factura completa/);
  assert.match(explicarPendiente(["error_automatico:cuota de Sheets agotada"]), /cuota de Sheets agotada/);
});

test("ningún texto de la revisión manual usa la frase «fallo temporal al leerla»", () => {
  const fuente = readFileSync(join(process.cwd(), "core/jobs/revisionCorreoManual.ts"), "utf8");
  assert.doesNotMatch(fuente, /fallo temporal al leerla/);
});
