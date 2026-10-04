import { useEffect, useRef, useState } from 'react';

export default function DocumentSearch({ company, apiKey, onClose }) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState({ status: 'idle' });
  const pending = useRef(null);
  useEffect(() => () => pending.current?.abort(), []);
  const search = async event => {
    event.preventDefault();
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setState({ status: 'loading' });
    const timer = setTimeout(() => controller.abort('timeout'), 35_000);
    try {
      const params = new URLSearchParams({ empresa: company.id, q: query.trim() });
      const response = await fetch(`/api/cerebro/documentos?${params}`, { headers: { 'X-Cerebro-Key': apiKey }, cache: 'no-store', signal: controller.signal });
      const result = await response.json();
      if (controller.signal.aborted || pending.current !== controller) return;
      if (!response.ok) throw Error(result.error || 'No se pudo consultar Drive.');
      if (result.empresa !== company.id || !Array.isArray(result.resultados)) throw Error('La respuesta no corresponde a esta compañía. Reintenta.');
      setState({ ...result, status: 'ready' });
    } catch (error) {
      if (pending.current !== controller || (controller.signal.aborted && controller.signal.reason !== 'timeout')) return;
      setState({ status: 'error', error: controller.signal.reason === 'timeout' ? 'Drive está tardando más de lo esperado. Reintenta en unos segundos.' : error.message });
    } finally { clearTimeout(timer); }
  };
  return <section className="nv-documents" aria-label={`Buscar documentos de ${company.name}`}>
    <div className="nv-document-title"><h2>Encuentra un documento</h2><button type="button" onClick={onClose} aria-label="Cerrar búsqueda de documentos">×</button></div>
    <p>Busca por nombre en el Drive de <strong>{company.name}</strong>. Puedes abrir archivos y carpetas.</p>
    <form onSubmit={search}><label htmlFor="nv-document-query">Nombre o palabras del documento</label><div><input id="nv-document-query" value={query} onChange={event => setQuery(event.target.value)} placeholder="Ej. escritura, estatutos, póliza…" minLength={3} maxLength={80} required autoFocus /><button type="submit" disabled={state.status === 'loading'}>{state.status === 'loading' ? 'Buscando…' : 'Buscar'}</button></div></form>
    <div className="nv-document-results" aria-live="polite" aria-busy={state.status === 'loading'}>
      {state.status === 'loading' && <p>Consultando Drive y verificando las rutas de {company.name}…</p>}
      {state.status === 'error' && <p className="nv-document-error" role="alert">{state.error}</p>}
      {state.status === 'ready' && <><p>{state.resultados.length} coincidencias verificadas para «{state.consulta}» · {new Date(state.consultadoEn).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</p>
        {state.resultados.length === 0 && <p>No se obtuvieron coincidencias verificadas. Prueba otro nombre o una sola palabra.</p>}
        <ul>{state.resultados.map(file => <li key={file.id}><span>{file.friendlyType}</span><strong>{file.name}</strong><small>{company.name} / {file.folderPath}</small>{/^https:\/\/(drive|docs)\.google\.com\//.test(file.webViewLink) && <a href={file.webViewLink} target="_blank" rel="noopener noreferrer">Abrir en Drive ↗</a>}</li>)}</ul>
        <small>Solo se muestran archivos cuya ruta se pudo verificar. Pueden faltar coincidencias por permisos de Drive o por el nombre utilizado.</small></>}
    </div>
  </section>;
}
