import "dotenv/config";
import { obtenerAdmins } from "../core/telegram/authorizedUsersSheet";
import { obtenerResolucionesContactoPorChat } from "../core/gastos/contactoResolucionStore";
import {
  reprocesarAdjuntoCorreoConProveedorBancario,
  reprocesarResolucionConProveedorVacio,
} from "../core/gastos/reprocesarResolucionProveedor";
import type { Empresa } from "../core/holded/client";

async function obtenerPendientes() {
  const admins = await obtenerAdmins();
  const grupos = await Promise.all(admins.map((admin) => obtenerResolucionesContactoPorChat(admin.userId)));
  const unicas = new Map<string, (typeof grupos)[number][number]>();
  for (const resolucion of grupos.flat()) {
    if (!resolucion.propuesta.proveedor.trim()) unicas.set(resolucion.id, resolucion);
  }
  return [...unicas.values()].sort((a, b) => b.creadoEn - a.creadoEn);
}

async function main(): Promise<void> {
  const accion = process.argv[2] ?? "listar";

  if (accion === "listar") {
    const pendientes = await obtenerPendientes();
    console.log(JSON.stringify(pendientes.map((r) => ({
      id: r.id,
      creadoEn: new Date(r.creadoEn).toISOString(),
      empresa: r.empresaFinal,
      archivo: r.propuesta.nombreArchivoOriginal,
      asunto: r.propuesta.correoOrigen?.asunto,
      monto: r.propuesta.monto,
      moneda: r.propuesta.moneda,
    })), null, 2));
    return;
  }

  if (accion === "reprocesar-correo") {
    const mensajeIdGmail = process.argv[3];
    const chatId = Number(process.argv[4]);
    const empresa = process.argv[5] as Empresa;
    const nombreArchivo = process.argv[6];
    if (!mensajeIdGmail || !Number.isSafeInteger(chatId) || !["WOBA", "EWORKS", "Footprint"].includes(empresa)) {
      throw new Error("Uso: reprocesar-proveedor-vacio reprocesar-correo <mensajeIdGmail> <chatId> <WOBA|EWORKS|Footprint> [nombreArchivo]");
    }
    const resultado = await reprocesarAdjuntoCorreoConProveedorBancario(
      mensajeIdGmail,
      chatId,
      empresa,
      nombreArchivo
    );
    console.log(JSON.stringify({ mensajeIdGmail, ...resultado }));
    return;
  }

  if (accion !== "reprocesar") {
    throw new Error("Uso: reprocesar-proveedor-vacio listar | reprocesar <id>");
  }
  const pendientes = await obtenerPendientes();
  const id = process.argv[3];
  if (!id) throw new Error("Falta el id exacto de la resolución que se va a reprocesar.");
  const resolucion = pendientes.find((actual) => actual.id === id);
  if (!resolucion) throw new Error(`No existe una resolución vigente con proveedor vacío e id ${id}.`);

  const resultado = await reprocesarResolucionConProveedorVacio(resolucion);
  console.log(JSON.stringify({ id, ...resultado }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
