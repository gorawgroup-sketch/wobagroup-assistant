export function pedidoGuidance(p) {
 return ({recibido:'WOBi recibió tu solicitud. La respuesta llegará a tu Telegram.',procesando:'WOBi está procesando tu solicitud. Puedes seguirla en Telegram.',terminado:'WOBi terminó el procesamiento. Consulta la respuesta en Telegram.',cancelado:'Solicitud cancelada. No se ha enviado.',expirado:'El envío caducó sin enviarse. Prepara otra solicitud.',fallido:'No pude verificar el resultado. Consulta Telegram antes de volver a enviar.'})[p?.estado] || p?.mensaje || '';
}
