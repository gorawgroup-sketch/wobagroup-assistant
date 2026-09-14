"use strict";

// La verificación usa exactamente el módulo compilado que ejecutará
// Railway. Si Chromium no arranca o no genera un PDF real, `npm run build`
// termina con error y Railway conserva el despliegue estable anterior.
const { verificarMotorComprobanteVisual } = require("../dist/core/gmail/generarComprobantePDF.js");

verificarMotorComprobanteVisual()
  .then(() => {
    process.stdout.write("Motor visual de comprobantes: OK\n");
  })
  .catch((error) => {
    console.error("Motor visual de comprobantes: ERROR", error);
    process.exitCode = 1;
  });
