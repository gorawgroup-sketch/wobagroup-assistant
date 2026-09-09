import { createHash } from "node:crypto";
import { obtenerTokenTemporalValido } from "./tempTokenStore";
import { obtenerVinculoChat } from "./chatLinkStore";
import { obtenerUsuariosAutorizados, type Rol } from "../telegram/authorizedUsersSheet";

export interface IdentidadChatWeb {
  chatId: number;
  nombre: string;
  rol?: Rol;
  vinculadaTelegram: boolean;
  modo: "completo" | "solo_lectura";
}

export function esDeviceIdValido(deviceId: string): boolean {
  return /^[a-zA-Z0-9_-]{16,128}$/.test(deviceId);
}

export function chatIdAisladoParaDevice(deviceId: string, nombre = ""): number {
  const identidadLocal = nombre.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  const fragmento = createHash("sha256").update(`wobi-web:${deviceId}:${identidadLocal}`).digest("hex").slice(0, 12);
  return -(Number.parseInt(fragmento, 16) + 1);
}

export async function resolverIdentidadChatWeb(
  credencial: string,
  nombreSolicitado: string,
  deviceId: string
): Promise<IdentidadChatWeb | null> {
  if (!esDeviceIdValido(deviceId)) return null;

  const keyMaestra = process.env.CEREBRO_API_KEY;
  const esMaestra = Boolean(keyMaestra && credencial === keyMaestra);
  const tokenTemporal = esMaestra ? undefined : await obtenerTokenTemporalValido(credencial);
  if (!esMaestra && !tokenTemporal) return null;

  const nombre = (tokenTemporal?.nombre || nombreSolicitado).trim().slice(0, 100);
  if (!nombre) return null;

  const vinculo = await obtenerVinculoChat(deviceId, nombre);
  if (vinculo?.telegramUserId) {
    const usuarios = await obtenerUsuariosAutorizados();
    const usuario = usuarios.find((item) => item.userId === vinculo.telegramUserId);
    if (usuario) {
      return {
        chatId: usuario.userId,
        nombre: usuario.nombre || vinculo.nombreTelegram || nombre,
        rol: usuario.rol,
        vinculadaTelegram: true,
        modo: "completo",
      };
    }
  }

  return {
    chatId: chatIdAisladoParaDevice(deviceId, nombre),
    nombre,
    vinculadaTelegram: false,
    modo: "solo_lectura",
  };
}
