const normalize=text=>typeof text==='string'?text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase():'';
const monetary=/\b(?:costos?|costes?|gastos?|gasta|gastamos|gastado|consumo|consume|cuesta|precio)\b/;
export function operatingCostRequest(text){
 const q=normalize(text);
 return !/\bno (?:quiero|muestres|consultes)\b/.test(q)&&monetary.test(q)&&/\b(?:sistema|wobi|api|inteligencia artificial|control diario)\b/.test(q);
}
export function numericRequest(text){
 return /\b(?:costos?|costes?|gastos?|cuanto|saldos?|importes?|total(?:es)?|cifras?|estados? financieros?)\b/.test(normalize(text));
}
const valid=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const usd=value=>new Intl.NumberFormat('es-ES',{style:'currency',currency:'USD',minimumFractionDigits:4,maximumFractionDigits:4}).format(value);
export function operatingCostAnswer(text,data){
 const q=normalize(text),control=data?.controlDiario,costs=control?.costos;
 const source=(data?.fuentes||[]).find(f=>f.fuente==='controlDiario');
 const readAt=source?.ultimoExitoEn||control?.generadoEn;
 const stale=Boolean(source?.conservado||source?.ok===false||data?.refrescando);
 const context='Fuente: Pendientes → Ver control diario. Alcance: sistema completo, no una compañía. Importes en USD; hoy, semana y mes están en curso.';
 const limits='Es el gasto real de API registrado. No incluye cuotas fijas de suscripción, alojamiento ni otros proveedores sin registrar. La proyección mensual es una estimación, no un costo ya pagado.';
 if(!control?.costosDisponibles||!costs||!readAt||!Number.isFinite(Date.parse(readAt)))return {available:false,summary:'No hay una lectura verificada de los costos de operación. Puedes abrir Control diario o continuar en el chat de WOBi en Telegram.',context,limits,rows:[]};
 if(/\b(?:suscripci(?:on|ones)|alojamiento|hosting|railway|euros?|eur|pesos?|cop|licencias?)\b/.test(q))return {available:false,summary:'Control diario registra el gasto real de API en USD. El costo o la moneda que pides requiere una consulta en Telegram.',context,limits,rows:[]};
 const all=[['Hoy',costs.hoy?.gastoRealApiUSD,'hoy'],['Ayer',costs.ayer?.gastoRealApiUSD,'ayer'],['Semana actual',costs.semanaActual?.gastoRealApiUSD,'semana'],['Mes actual',costs.mesActual?.gastoRealApiUSD,'mes']];
 const period=/\bayer\b/.test(q)?'ayer':/\bsemana(?:l)?\b/.test(q)?'semana':/\bmes\b|\bmensual\b/.test(q)?'mes':/\bhoy\b/.test(q)?'hoy':null;
 // Solo períodos que ya contiene el snapshot. Nunca presentar el mes actual como un mes histórico.
 if(/\b(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|20\d\d|anteayer|manana|pasad[oa]s?|anterior(?:es)?|ultim[oa]s?|proxim[oa]s?)\b|\b\d{1,2}[/-]\d{1,2}\b|\bhace \d+ dias?\b/.test(q))return {available:false,summary:'Control diario contiene hoy, ayer, semana y mes actuales. El período que pides requiere una consulta en Telegram.',context,limits,rows:[]};
 const rows=(period?all.filter(r=>r[2]===period):all).map(([label,value])=>({label,value:valid(value)?usd(value):'No disponible'}));
 const available=(period?all.filter(r=>r[2]===period):all).some(r=>valid(r[1]));
 const processes=period==='semana'?costs.porProcesoSemana:period==='ayer'?costs.porProcesoAyer:period==='mes'?[]:costs.porProcesoHoy;
 const breakdown=(Array.isArray(processes)?processes:[]).filter(p=>typeof p.proceso==='string'&&valid(p.gastoRealApiUSD)).sort((a,b)=>b.gastoRealApiUSD-a.gastoRealApiUSD).slice(0,5).map(p=>({label:p.proceso,value:usd(p.gastoRealApiUSD)}));
 const projection=valid(costs.proyeccionMensualUSD)?usd(costs.proyeccionMensualUSD):'No disponible';
 const summary=available?`Gasto real de API del sistema: ${rows.map(r=>`${r.label}: ${r.value}`).join('; ')}.${stale?' Lectura conservada o actualización en curso; revisa la fecha de lectura.':''} ${limits}`:'Los importes solicitados no están disponibles en la lectura de Control diario. Puedes continuar en Telegram.';
 return {available,summary,context,limits,rows,breakdown,breakdownLabel:period==='semana'?'Semana actual':period==='ayer'?'Ayer':'Hoy',projection,readAt,stale};
}
