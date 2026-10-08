import { lecturaDisponible, ordenarDocumentos } from './segurosView.mjs';
function Documento({ documento: d }) {
  return <article className="sg-document">
    <strong>{d.nombre}</strong><span>{d.tipo} · Fecha: {d.fechaDocumento || 'sin dato'}</span>
    <strong className="sg-document-period">Vigencia: {d.vigencia || 'sin dato'}</strong>
    <span>Prima: {d.prima || 'sin dato'} · Capital: {d.capital || 'sin dato'}</span>
    {d.resumen && <><p className="sg-document-preview">{d.resumen.length > 280 ? `${d.resumen.slice(0, 277).trimEnd()}…` : d.resumen}</p><details className="sg-details"><summary>Ver resumen completo</summary><p className="sg-exact-text">{d.resumen}</p></details></>}
    {d.enlace && <a href={d.enlace} target="_blank" rel="noopener noreferrer">Abrir en Drive ↗</a>}
  </article>;
}
export default function SegurosDocumentos({ documentos, polizaId, complementosDisponibles }) {
  const archivos = ordenarDocumentos(Array.isArray(documentos) ? documentos.filter(d => d.polizaId === polizaId) : null);
  const sinLectura = lecturaDisponible(archivos, complementosDisponibles);
  const lista = archivos?.map((d, i) => <Documento documento={d} key={`${d.enlace}-${i}`} />);
  return <div className="sg-documents"><h5>Documentos leídos</h5>{sinLectura ? <p className="sg-muted">{sinLectura}</p>
    : !archivos.length ? <p className="sg-muted">Ningún documento leído para esta póliza.</p>
    : archivos.length > 2 ? <details className="sg-details"><summary>Ver {archivos.length} documentos · más recientes primero</summary>{lista}</details> : lista}</div>;
}
