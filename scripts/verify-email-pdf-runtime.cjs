"use strict";

// La verificación usa exactamente el módulo compilado que ejecutará
// Railway. Si Chromium no arranca o no genera un PDF real, `npm run build`
// termina con error y Railway conserva el despliegue estable anterior.
// Se reintenta (3 intentos): un arranque lento de Chromium en una máquina de
// compilación ocupada no debe tumbar una compilación sana (ver reintentarVerificacion.cjs).
const { verificarMotorComprobanteVisual } = require("../dist/core/gmail/generarComprobantePDF.js");
const { reintentarVerificacion } = require("./reintentarVerificacion.cjs");

reintentarVerificacion(verificarMotorComprobanteVisual, { registrar: (mensaje) => console.warn(`Motor visual de comprobantes: ${mensaje}`) })
  .then(() => {
    process.stdout.write("Motor visual de comprobantes: OK\n");
  })
  .catch((error) => {
    console.error("Motor visual de comprobantes: ERROR", error);
    process.exitCode = 1;
  });
