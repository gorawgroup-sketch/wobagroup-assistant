import type { Empresa } from "../holded/client";
import { sendTelegramMessage } from "../telegram/client";
import { obtenerRolUsuario } from "../telegram/authorizedUsersSheet";
import { prepararCampanaSoportes } from "./campanaSoportes";
import { ofrecerOtroCsv } from "./comandoSoportes";
import { aprenderIbans, empresasDeIbans } from "./cuentasRevolutSheet";
import { esExtractoRevolut, parsearExtractoRevolut } from "./extractoRevolut";
import { cerrarModoSoportes, leerModoSoportes } from "./modoSoportesStore";

/**
 * Puerta de entrada del flujo de soportes: un CSV de movimientos de Revolut subido al chat NO es un documento para
 * archivar, es la entrada que dice qué cargos reclamar y a quién. Se detecta por sus columnas (no por el nombre). El CSV
 * no se guarda en disco.
 *
 * La empresa se decide, por este orden: lo que Carlos nombre en el texto o en el nombre del archivo → la que eligió en
 * «/soportes» → la que ya se conoce por el IBAN de la cuenta. Si el IBAN ya es de otra empresa que la elegida, el
 * extracto NO se analiza (evita cruzar un CSV de EWORKS contra Holded de WOBA).
 */

export function pareceCsv(nombre: string | undefined, mime: string | undefined): boolean {
  return /\.csv$/i.test(nombre ?? "") || /csv/i.test(mime ?? "");
}

/** Empresa nombrada en el texto; undefined si no hay ninguna o hay varias (nunca se adivina). */
export function empresaDeTexto(...textos: Array<string | undefined>): Empresa | undefined {
  const t = textos.filter(Boolean).join(" ");
  const encontradas = new Set<Empresa>();
  if (/\bwoba\b/i.test(t)) encontradas.add("WOBA");
  if (/\be-?works\b/i.test(t)) encontradas.add("EWORKS");
  if (/\bfoot\s?print\b/i.test(t)) encontradas.add("Footprint");
  return encontradas.size === 1 ? [...encontradas][0] : undefined;
}

export type DecisionEmpresa =
  | { empresa: Empresa; origen: "texto" | "comando" | "iban" }
  | { error: "sin_empresa" | "iban_de_otra" | "iban_mezclado"; conocida?: Empresa; pedida?: Empresa };

/** Pura: decide la empresa del extracto a partir de lo que se sabe (ver el orden en el comentario del módulo). */
export function decidirEmpresa(deTexto: Empresa | undefined, deComando: Empresa | undefined, conocidasPorIban: Empresa[]): DecisionEmpresa {
  if (conocidasPorIban.length > 1) return { error: "iban_mezclado" };
  const conocida = conocidasPorIban[0];
  const elegida = deTexto ?? deComando;
  if (elegida) {
    if (conocida && conocida !== elegida) return { error: "iban_de_otra", conocida, pedida: elegida };
    return { empresa: elegida, origen: deTexto ? "texto" : "comando" };
  }
  return conocida ? { empresa: conocida, origen: "iban" } : { error: "sin_empresa" };
}

/** true si el archivo era un extracto de Revolut y ya se atendió (con éxito o con un aviso); false si no es de este flujo. */
export async function intentarExtractoRevolut(chatId: number, bytes: Buffer, nombre: string | undefined, mime: string | undefined, caption: string | undefined): Promise<boolean> {
  if (!pareceCsv(nombre, mime)) return false;
  const texto = bytes.toString("utf-8");
  if (!esExtractoRevolut(texto)) return false;

  // Muestra movimientos bancarios y puede acabar enviando correos: solo administración (en un chat privado el id del chat es el del usuario).
  const rol = await obtenerRolUsuario(chatId);
  if (rol !== "superadmin" && rol !== "admin") {
    await sendTelegramMessage(chatId, "Este archivo es un extracto bancario y solo lo puede procesar administración.");
    return true;
  }

  const ibans = [...new Set(parsearExtractoRevolut(texto).map((f) => f.ibanCuenta).filter(Boolean))];
  const decision = decidirEmpresa(empresaDeTexto(caption, nombre), await leerModoSoportes(chatId), await empresasDeIbans(ibans));

  if ("error" in decision) {
    const mensajes = {
      sin_empresa: "📄 Es un extracto de movimientos de Revolut, pero no sé de qué empresa es. Pulsa /soportes, elige la empresa y súbelo de nuevo.",
      iban_de_otra: `⚠️ Este extracto es de una cuenta que ya conozco como de ${decision.conocida}, pero me pediste ${decision.pedida}. No lo analicé para no cruzarlo con la empresa equivocada. Pulsa /soportes y elige la correcta.`,
      iban_mezclado: "⚠️ Este extracto mezcla cuentas de empresas distintas. No lo analicé; súbelo por separado, un CSV por empresa.",
    } as const;
    await sendTelegramMessage(chatId, mensajes[decision.error]);
    return true;
  }

  const { empresa } = decision;
  await sendTelegramMessage(chatId, `🔎 Extracto de Revolut de ${empresa}${decision.origen === "iban" ? " (reconocí la cuenta por su IBAN)" : ""} recibido. Lo cruzo con Bancos de Holded para ver qué cargos siguen sin soporte (puede tardar un minuto)...`);
  try {
    const resultado = await prepararCampanaSoportes(chatId, empresa, texto, nombre ?? "extracto.csv");
    if (resultado !== "empresa_dudosa") {
      await aprenderIbans(ibans, empresa).catch((error) => console.error("[soportes] No se pudo guardar el IBAN (no crítico):", error instanceof Error ? error.message : error));
    }
    await cerrarModoSoportes(chatId);
    if (resultado !== "empresa_dudosa") await ofrecerOtroCsv(chatId, empresa);
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error("[soportes] Error analizando el extracto:", mensaje);
    await sendTelegramMessage(chatId, `⚠️ No pude completar el análisis del extracto de ${empresa}: ${mensaje}\nNo se envió ni se pidió nada. Vuelve a subir el archivo para reintentar (el modo de /soportes sigue activo).`);
  }
  return true;
}
