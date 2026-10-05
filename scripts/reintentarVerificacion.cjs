"use strict";

/**
 * Reintenta una verificación asíncrona antes de darla por fallida. Caso real 2026-10-05: dos compilaciones simultáneas (CI y
 * Railway) fallaron con «Timed out after 40000 ms while waiting for the WS endpoint URL»: el Chromium del chequeo del motor
 * visual tardó en arrancar en una máquina ocupada. Si el motor está de verdad roto, fallan TODOS los intentos y el despliegue
 * sigue sin salir; un arranque lento ya no tumba una compilación sana.
 */
async function reintentarVerificacion(verificar, { intentos = 3, pausaMs = 5000, esperar = (ms) => new Promise((r) => setTimeout(r, ms)), registrar = () => {} } = {}) {
  let ultimoError;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      return await verificar();
    } catch (error) {
      ultimoError = error;
      registrar(`Intento ${intento}/${intentos} fallido: ${error && error.message ? error.message : error}`);
      if (intento < intentos) await esperar(pausaMs);
    }
  }
  throw ultimoError;
}

module.exports = { reintentarVerificacion };
