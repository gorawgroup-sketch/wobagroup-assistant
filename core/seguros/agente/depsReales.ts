/**
 * Dependencias REALES del especialista (Sheets, Holded, Drive, Gmail, Anthropic). Aparte de agente.ts y
 * herramientas.ts para que toda la lógica se pruebe con dependencias falsas; este es el único archivo que toca los
 * sistemas de verdad.
 */
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { crearMensajeAnthropic } from "../../ai/anthropicGateway";
import { crearEjecucionIA } from "../../ai/policy";
import { invalidarEstadoCerebro } from "../../cerebro/estadoAgregado";
import { publicarCambioCerebro } from "../../cerebro/realtime";
import { invalidarComplementosSeguros } from "../estadoCerebro";
import { searchDriveFilesAllRoots } from "../../drive/client";
import { ROOT_FOLDERS } from "../../drive/rootFolders";
import { buscarMensajes, obtenerCuerpoCompletoCorreo, obtenerResumenCorreo } from "../../gmail/client";
import { listBankMovements, listTreasuryAccounts, type Empresa } from "../../holded/client";
import { sendTelegramMessageWithButtons } from "../../telegram/client";
import { obtenerRolUsuario } from "../../telegram/authorizedUsersSheet";
import { descargarArchivoDrive } from "../../drive/client";
import { esFormatoVisual, extraerTextoDeterminista } from "../../documental/extractReadableText";
import { transcribirParaCaptura } from "../../documental/transcribeForCapture";
import { formatDateLocal } from "../../utils/dateFormat";
import { listarDocumentosPoliza } from "../documentosPolizaStore";
import { leerBitacora } from "../bitacora/bitacoraStore";
import { entradaVigilante } from "../bitacora/entradas";
import { registrarActividad } from "../bitacora/registrar";
import { leerPagosSeguros } from "../pagos/pagosStore";
import { actualizarPoliza, listarPolizas } from "../polizaRegistroSheet";
import { leerCorreosDeSeguros } from "../vigilante/correos";
import { guardarEstadoVigilante } from "../vigilante/estadoStore";
import { restarDias } from "../vigilante/fechas";
import { fuentesRealesVigilante } from "../vigilante/fuentesReales";
import { leerMovimientosBancarios } from "../vigilante/lecturaBancaria";
import { EMPRESAS_VIGILADAS } from "../vigilante/tipos";
import { ejecutarVigilanteSeguros } from "../vigilante/vigilante";
import { PROCESO_IA_AGENTE, resolverModeloAgente, type DepsConsulta } from "./agente";
import { almacenCambiosReal, type DepsAplicar } from "./cambiosPendientes";
import { almacenConocimientoReal } from "./conocimiento";
import { diferirPropuesta } from "./propuestasDiferidas";
import { almacenTextosReal, textoDeDocumento, type LectorDocumentos } from "./textosStore";

let clienteAnthropic: Anthropic | null = null;
function cliente(): Anthropic {
  if (clienteAnthropic) return clienteAnthropic;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Falta la variable de entorno ANTHROPIC_API_KEY");
  clienteAnthropic = new Anthropic({ apiKey });
  return clienteAnthropic;
}

const hoy = () => formatDateLocal(new Date());

const UPLOADS_DIR = join(process.cwd(), "tmp", "uploads");

/** Lector real de documentos: descarga de Drive, texto sin IA y, solo para PDF e imágenes, visión. */
const lectorReal: LectorDocumentos = {
  descargar: (docId) => descargarArchivoDrive(docId),
  deterministico: (bytes, mimeType, nombre) => extraerTextoDeterminista(bytes, mimeType, nombre),
  esVisual: esFormatoVisual,
  transcribir: async (bytes, mimeType, nombre, contexto) => {
    await mkdir(UPLOADS_DIR, { recursive: true });
    const ruta = join(UPLOADS_DIR, `${Date.now()}_${nombre.replace(/[^\w.\-]+/g, "_").slice(0, 150)}`);
    await writeFile(ruta, bytes);
    try {
      return await transcribirParaCaptura(ruta, mimeType, contexto);
    } finally {
      await unlink(ruta).catch(() => {});
    }
  },
};

/** Lo que necesita aplicar un cambio aprobado: el registro, la memoria y el refresco de Cerebro. */
export function depsAplicarReales(): DepsAplicar {
  return {
    hoy,
    listarPolizas,
    actualizarPoliza,
    conocimiento: almacenConocimientoReal,
    invalidarCerebro: () => {
      invalidarComplementosSeguros();
      invalidarEstadoCerebro(["seguros"]);
      publicarCambioCerebro("seguros:agente");
    },
  };
}

export function depsRealesAgente(): DepsConsulta {
  return {
    hoy,
    listarPolizas,
    listarDocumentos: listarDocumentosPoliza,
    listarPagos: leerPagosSeguros,
    listarActividad: leerBitacora,
    buscarDocumentosDrive: async (consulta, empresa) => {
      const raices = empresa && ROOT_FOLDERS[empresa] ? { [empresa]: ROOT_FOLDERS[empresa] } : ROOT_FOLDERS;
      const encontrados = await searchDriveFilesAllRoots(raices, consulta, 4, 30);
      return encontrados.map((r) => ({ id: r.id, name: r.name, folderPath: r.folderPath, webViewLink: r.webViewLink, empresa: r.empresa }));
    },
    leerDocumentoDrive: async (doc) => {
      const { texto, desdeCache } = await textoDeDocumento(
        doc,
        `Documento de una póliza de seguros del grupo (${doc.empresa}${doc.folderPath ? `, ${doc.folderPath}` : ""}), leído para responder una consulta de Wobi Seguros.`,
        lectorReal,
        almacenTextosReal
      );
      console.log("[agenteSeguros] documento leído", JSON.stringify({ nombre: doc.name, desdeCache, caracteres: texto.length }));
      return `📄 «${doc.name}» (${doc.empresa}${doc.folderPath ? `, ${doc.folderPath}` : ""}, ${doc.webViewLink}):\n\n${texto}`;
    },
    leerBanco: (dias) => leerMovimientosBancarios(EMPRESAS_VIGILADAS, restarDias(hoy(), dias), hoy(), { listTreasuryAccounts, listBankMovements }),
    saldos: async (empresa) => {
      const empresas = (empresa ? [empresa] : [...EMPRESAS_VIGILADAS]) as Empresa[];
      const filas: Array<{ empresa: string; cuenta: string; moneda: string; saldo: string }> = [];
      for (const e of empresas) {
        for (const c of await listTreasuryAccounts(e)) {
          if (!c.archived && c.type !== "gateway") filas.push({ empresa: e, cuenta: (c.name ?? c.id).trim(), moneda: c.currency ?? "EUR", saldo: c.balance ?? "?" });
        }
      }
      return filas;
    },
    correosRecientes: (dias) => leerCorreosDeSeguros(restarDias(hoy(), dias), { buscarMensajes, obtenerResumenCorreo }),
    cuerpoCorreo: obtenerCuerpoCompletoCorreo,
    revisarAhora: async (puedeActuar) => {
      const reales = fuentesRealesVigilante();
      if (!puedeActuar) {
        // Consulta: ni escribe en el registro ni marca nada como avisado (quien pregunta sin permiso no puede cambiar datos ni consumir los avisos de Carlos).
        const consulta = { ...reales, actualizarPoliza: async () => {}, guardarEstado: async () => {}, borrarEstado: async () => {}, purgarCorreosVistos: async () => 0, invalidarCerebro: () => {} };
        return (await ejecutarVigilanteSeguros(consulta, { aplicar: false })).respuestaChat;
      }
      const resultado = await ejecutarVigilanteSeguros(reales);
      // Lo que se cuenta aquí ya lo ha visto la persona: no se vuelve a avisar por Telegram.
      await guardarEstadoVigilante(resultado.clavesAvisadas).catch((e) => console.error("[agenteSeguros] No se pudo marcar lo avisado (no crítico):", e));
      // Una revisión pedida desde el chat también queda en la bitácora (no es una pasada programada: no cuenta para «va al día»).
      await registrarActividad(entradaVigilante({ resultado, informe: null, entregado: null, origen: "manual" }));
      return resultado.respuestaChat;
    },
    conocimiento: almacenConocimientoReal,
    // La propuesta no sale en mitad del turno: se encola y sale justo DESPUÉS de la respuesta de Wobi, para que sus botones
    // queden al final del chat (propuestasDiferidas.ts). La fila y el mensaje se crean juntos al enviarla.
    proponerCambio: async (chatId, propuesta) => {
      diferirPropuesta(chatId, async () => {
        const cambio = await almacenCambiosReal.crear({ chatId, accion: propuesta.accion, datos: JSON.stringify(propuesta.datos), cita: propuesta.cita });
        let messageId: number;
        try {
          messageId = await sendTelegramMessageWithButtons(chatId, propuesta.texto, [[
            { text: "✅ Aplicar", callback_data: `segcambio_aplicar:${cambio.id}` },
            { text: "❌ Cancelar", callback_data: `segcambio_cancelar:${cambio.id}` },
          ]]);
        } catch (error) {
          // Sin mensaje no hay botón que la decida: no se deja una propuesta huérfana en la hoja.
          await almacenCambiosReal.consumir(cambio.id).catch((e) => console.error("[depsReales] No se pudo retirar la propuesta sin mensaje:", e instanceof Error ? e.message : e));
          throw error;
        }
        await almacenCambiosReal.actualizarMessageId(cambio.id, messageId);
      });
    },
    // Solo un superadministrador en un chat privado de Telegram: es quien puede aprobar el botón (ACCIONES_SENSIBLES).
    puedeProponer: async (chatId) => chatId != null && chatId > 0 && (await obtenerRolUsuario(chatId)) === "superadmin",
    crearMensaje: (chatId) => {
      const ejecucion = crearEjecucionIA(PROCESO_IA_AGENTE);
      return (params) => crearMensajeAnthropic(cliente(), ejecucion, params, chatId);
    },
    modelo: () => resolverModeloAgente(),
  };
}
