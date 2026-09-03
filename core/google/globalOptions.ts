import { google } from "googleapis";

/**
 * Causa raíz real, encontrada en vivo (2026-09-02): "Enviando solicitud..."
 * colgado para siempre en el front del cerebro, y por separado "el Chat está
 * pegado" tras /revisarcorreo. Se aisló con un script de diagnóstico en un
 * proceso nuevo (no el servidor desplegado): crearSolicitudAcceso tardó 184
 * segundos en responder — no un error, un cuelgue real a nivel de red. Ninguna
 * de las ~36 tiendas Sheets/Gmail/Drive del proyecto le pone timeout a sus
 * llamadas (google.auth.JWT + googleapis por defecto esperan indefinidamente
 * si la conexión se traba), así que un blip de red entre Railway y Google se
 * traduce en una promesa que nunca resuelve NI rechaza — ni siquiera el
 * .catch() que avisa el error en Telegram llega a dispararse.
 *
 * google.options() es GLOBAL de verdad: googleapis-common relee
 * `google._options` en CADA petición (apirequest.js, createAPIRequestAsync),
 * no solo al construir el cliente — así que esta única llamada, importada una
 * vez al arrancar el servidor, protege TODAS las tiendas ya existentes y
 * cualquiera nueva que se agregue después, sin tener que tocar archivo por
 * archivo ni acordarse de repetir esto la próxima vez. Al fallar rápido en
 * vez de colgarse, el try/catch que ya existe en cada llamador (rutas HTTP,
 * revisarCorreoNuevo, etc.) puede hacer su trabajo normal.
 *
 * 45s, no 20s (ajustado en la auditoría posterior): el mismo timeout se
 * aplica a TODA llamada a Google, incluida la subida real de archivos a
 * Drive (subirArchivoADrive) — un PDF/imagen grande por conexión lenta
 * puede legítimamente tardar más de 20s sin estar colgado, y 20s convertía
 * esa subida lenta-pero-real en un falso error. 45s sigue siendo muchísimo
 * menos que el cuelgue real de 184s que motivó este archivo, así que
 * protege igual contra ese caso, con más margen para subidas grandes
 * genuinas.
 */
google.options({ timeout: 45_000 });
