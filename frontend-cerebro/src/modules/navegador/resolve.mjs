import { buildCapabilities } from './capabilities.mjs';
const normalize = text => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
export function findDestinations(text, catalog = buildCapabilities()) {
  const query=normalize(text);
  if (!query) return { status:'empty', entries:[] };
  // Interim local discovery, not an AI interpreter or a source of financial answers.
  const terms=query.replace(/\b(abre|abrir|muestra|muestrame|ver|busca|buscar|quiero|el|la|los|las|de|del|en|por|favor)\b/g,' ').split(/\s+/).filter(Boolean);
  if (!terms.length) return {status:'unknown',entries:[]};
  const unsupported=/\b(pendientes?|hoy|ayer|costos?|cuanto|cuantos|sin conciliar|pagos|renovaciones|woba|eworks|footprint|empresa)\b/.test(query);
  const entries=catalog.filter(entry=>terms.some(term=>normalize(entry.label).includes(term)));
  return {status:unsupported?'needs_interpretation':entries.length?'choices':'unknown',entries};
}
