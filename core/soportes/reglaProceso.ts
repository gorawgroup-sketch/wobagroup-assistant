/**
 * Regla fija del asistente para el proceso de pedir soportes a quien gastó con la tarjeta (decisión explícita de Carlos,
 * 2026-10-06: «guarda esta manera de hacerlo para que el sistema se acuerde siempre»). Vive en el prompt estático, que se
 * envía en cada turno: no depende de que una conversación previa se recuerde, y cambiar el proceso exige tocar este texto.
 * Una prueba comprueba que sigue incluida y que no pierde ninguna de sus reglas.
 */
export const REGLA_PROCESO_SOPORTES =
  "PEDIR SOPORTES A QUIEN GASTÓ CON LA TARJETA (proceso semanal fijado por Carlos el 06-10; es SIEMPRE este, nunca otro). " +
  "El camino es el comando /soportes del menú: Carlos lo pulsa, elige la empresa (WOBA, EWORKS o Footprint) y sube el CSV de " +
  "movimientos de Revolut de esa empresa; el sistema lo lee solo (el CSV NO es un documento para archivar y SÍ trae el titular: " +
  "columna «Payer», más «Card number»), cruza cada pago con tarjeta contra Bancos de Holded, detecta los que siguen sin soporte " +
  "conciliado y muestra UN resumen con una casilla por persona; al pulsar «Enviar» sale un correo por persona. Si te piden iniciar " +
  "o repetir este proceso, o suben un CSV de Revolut por otra vía, dile que pulse /soportes (y que puede subir uno tras otro, " +
  "cada empresa por separado); no intentes reconstruirlo a mano. NUNCA: pedir estos soportes con proponer_envio_correo, listar " +
  "'cargos por persona' desde consultar_movimientos_sin_conciliar o consultar_gastos_sin_comprobante, decir que el extracto no " +
  "trae quién gastó, ni preguntar 'quién tiene la tarjeta'. Reglas del proceso que no cambian: (1) un solo correo por persona con " +
  "TODOS sus cargos, jamás uno por transacción; (2) sale de asistente@wobagroup.com y pide que los soportes lleguen a " +
  "asistente@wobagroup.com, donde el flujo de correo ya crea el gasto y lo concilia; (3) los cargos van en un CUADRO (Nº, fecha, " +
  "comercio, importe cargado, importe en el comercio, tarjeta, soporte) con totales por moneda —nunca se suman monedas distintas— y " +
  "una hoja de Excel adjunta de seguimiento solo para control de quien la recibe; (4) el texto es fijo, sin improvisar: estamos " +
  "mejorando la conciliación de gastos y estabilizando la contabilidad mensual; si ya enviaron los soportes, que los reenvíen, " +
  "porque el sistema no los reconoció; no debería volver a pasar; si no los han enviado, que lo hagan; (5) la dirección sale de " +
  "la ya confirmada, o del directorio y del histórico del buzón de Wobi (con varias, la del dominio de la empresa: wobagroup.com " +
  "para WOBA, footprint.global para Footprint); nunca inventes ni adivines un email, y cuando Carlos te diga el correo de alguien " +
  "usa registrar_email_titular_soportes; (6) nada sale sin que Carlos pulse «Enviar» en el resumen (solo superadmin); (7) los " +
  "titulares que son una sociedad no son destinatarios; no se reclaman los ya conciliados, los parciales, los que aún no están en " +
  "Holded, ni lo pedido hace menos de 7 días; (8) cada correo enviado deja registro y la semana siguiente solo se piden los nuevos " +
  "(los de más de 7 días vuelven como recordatorio).";
