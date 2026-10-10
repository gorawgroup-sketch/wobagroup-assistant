import { validateDestination } from './capabilities.mjs';
export async function interpretNavigation(payload, {headers,signal,fetcher=fetch}) {
  const read=async(url,options={})=>{
    const response=await fetcher(url,{...options,headers,signal,cache:'no-store'});
    if(!response.ok) throw Error(`No se pudo consultar el navegador (${response.status}). Reintenta.`);
    return response.json();
  };
  const catalog=await read('/api/cerebro/navegador/catalogo');
  if(typeof catalog.version!=='string'||!Array.isArray(catalog.capacidades)||!Array.isArray(catalog.companias)) throw Error('Catálogo no válido. No se abre ningún destino.');
  const result=await read('/api/cerebro/navegador/interpretar',{method:'POST',body:JSON.stringify(payload)});
  if(result.requestId!==payload.requestId||typeof result.catalogVersion!=='string') throw Error('Respuesta de navegación no válida.');
  let current=catalog;
  if(result.catalogVersion!==catalog.version) current=await read('/api/cerebro/navegador/catalogo');
  if(current.version!==result.catalogVersion) throw Error('El catálogo cambió. Reintenta la petición.');
  const validate=proposal=>{
    const server=current.capacidades.find(c=>c.id===proposal.capabilityId&&c.acceso==='permitido'&&c.companies.includes(proposal.companyId));
    const local=validateDestination(proposal);
    return server&&current.companias.includes(proposal.companyId)&&local&&server.target.kind===local.target.kind&&server.target.id===local.target.id?local:null;
  };
  if(result.tipo==='destino') {
    if(!validate(result)||!Array.isArray(result.avisos)||result.avisos.some(a=>typeof a!=='string')) throw Error('Destino no válido. No se abre nada.');
  } else if(result.tipo==='aclaracion') {
    if(typeof result.pregunta!=='string'||!Array.isArray(result.opciones)||result.opciones.some(o=>!validate(o)||typeof o.etiqueta!=='string')) throw Error('Opciones no válidas.');
  } else if(result.tipo==='no_disponible') {
    if(typeof result.mensaje!=='string'||!['agente_previsto','destino_no_implementado','permiso_insuficiente','fuente_no_consultable'].includes(result.motivo)) throw Error('Respuesta no válida.');
  } else throw Error('Respuesta no reconocida.');
  return result;
}
