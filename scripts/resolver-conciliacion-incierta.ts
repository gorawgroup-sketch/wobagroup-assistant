// Script standalone: a diferencia de src/server.ts y scripts/start.ts, nadie
// más carga dotenv por él. Sin esto, CASHFLOW_SHEET_ID y el resto de
// variables solo existen si ya están en el entorno del shell que lo invoca.
import "dotenv/config";
import { durableBankReconciliationStore } from "../core/holded/durableBankReconciliationStore";
import { verificarAusenciaDeEfectoPorLectura } from "../core/holded/revertirConciliacionIncierta";

interface Argumentos {
  clave: string;
  movementId: string;
  documentId: string;
  motivo: string;
  aplicar: boolean;
  /** true: en vez de cancelar, vuelve a «preparada» tras demostrar por lectura que el POST anterior no tuvo efecto. */
  revertir: boolean;
}

function leerArgumentos(argv: string[]): Argumentos {
  const valores = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const nombre = argv[i];
    if (nombre === "--apply" || nombre === "--revertir") {
      valores.set(nombre, "true");
      continue;
    }
    const valor = argv[i + 1];
    if (!nombre?.startsWith("--") || !valor || valor.startsWith("--")) {
      throw new Error(`Argumento inválido: ${nombre ?? "(vacío)"}.`);
    }
    valores.set(nombre, valor);
    i += 1;
  }
  const clave = valores.get("--clave") ?? "";
  const movementId = valores.get("--movement") ?? "";
  const documentId = valores.get("--document") ?? "";
  const motivo = valores.get("--motivo") ?? "";
  if (!/^[a-f0-9]{64}$/.test(clave) || !movementId || !documentId || !motivo.trim()) {
    throw new Error(
      "Uso: --clave <sha256> --movement <id> --document <id> --motivo <texto> [--revertir] [--apply]"
    );
  }
  return {
    clave, movementId, documentId, motivo: motivo.trim(),
    aplicar: valores.has("--apply"), revertir: valores.has("--revertir"),
  };
}

async function main(): Promise<void> {
  const args = leerArgumentos(process.argv.slice(2));
  const registro = await durableBankReconciliationStore.obtener(args.clave);
  if (!registro) throw new Error("No existe una conciliación con esa clave.");
  if (registro.movementId !== args.movementId || registro.documentId !== args.documentId) {
    throw new Error("La clave existe, pero no corresponde exactamente al movimiento y documento esperados.");
  }

  console.log(JSON.stringify({
    modo: args.aplicar ? "apply" : "dry-run",
    accion: args.revertir ? "revertir_a_preparada" : "cancelar",
    clave: registro.clave,
    empresa: registro.empresa,
    estado: registro.estado,
    movementId: registro.movementId,
    documentId: registro.documentId,
    actualizadoEn: new Date(registro.actualizadoEn).toISOString(),
  }, null, 2));

  if (args.revertir) {
    // Solo lectura: demuestra que el POST anterior no tuvo efecto antes de permitir un único reintento protegido.
    const verificacion = await verificarAusenciaDeEfectoPorLectura(registro);
    console.log(JSON.stringify({ verificacion }, null, 2));
    if (!verificacion.ok) throw new Error("No se demostró la ausencia de efecto; no se modificó nada.");
    if (!args.aplicar) return;
    await durableBankReconciliationStore.revertirIncierta(args.clave, `${args.motivo} — ${verificacion.motivo}`);
    const revertido = await durableBankReconciliationStore.obtener(args.clave);
    if (revertido?.estado !== "preparada") throw new Error("No se pudo confirmar la reversión auditada en el ledger.");
    console.log(JSON.stringify({ resultado: "revertida_a_preparada", clave: revertido.clave, documentId: revertido.documentId }, null, 2));
    return;
  }

  if (!args.aplicar) return;
  if (registro.estado !== "incierta") {
    throw new Error(`Se esperaba estado incierta y se encontró ${registro.estado}; no se modificó nada.`);
  }

  await durableBankReconciliationStore.marcarCancelada(args.clave, args.motivo);
  const confirmado = await durableBankReconciliationStore.obtener(args.clave);
  if (confirmado?.estado !== "cancelada" || confirmado.resolucion !== args.motivo) {
    throw new Error("No se pudo confirmar la cancelación auditada en el ledger.");
  }
  console.log(JSON.stringify({
    resultado: "cancelada",
    clave: confirmado.clave,
    resueltoEn: confirmado.resueltoEn ? new Date(confirmado.resueltoEn).toISOString() : undefined,
    resolucion: confirmado.resolucion,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
