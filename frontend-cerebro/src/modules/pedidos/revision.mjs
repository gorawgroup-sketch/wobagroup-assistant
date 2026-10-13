// No hay un borrador nuevo ni un envío hasta confirmar que el original no puede enviarse.
export async function cancelForRevision(client,pedido,signal){
 if(pedido?.estado!=='pendiente_confirmacion')throw Error('Consulta el estado del pedido antes de corregirlo.');
 const cancelled=await client.cancel(pedido.pedidoId,signal);
 if(!['cancelado','expirado'].includes(cancelled.estado)||cancelled.ejecucion!=='no_enviada')throw Error('No pude confirmar la cancelación. Consulta el estado antes de preparar otra solicitud.');
 return {cancelled,texto:pedido.texto};
}
