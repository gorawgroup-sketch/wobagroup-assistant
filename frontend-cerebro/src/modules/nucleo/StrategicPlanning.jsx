import './strategic-planning.css';

const SHEETS = [
  { name: 'Objetivos', unit: 'Una fila por objetivo estratégico', fields: 'id_objetivo · empresa · eje · objetivo · responsable · patrocinador · fecha_inicio · fecha_fin · prioridad · estado' },
  { name: 'Iniciativas', unit: 'Una fila por proyecto que ejecuta un objetivo', fields: 'id_iniciativa · id_objetivo · empresa · iniciativa · responsable · fecha_inicio · fecha_fin · avance_pct · estado · enlace_evidencia' },
  { name: 'Indicadores', unit: 'Una fila por indicador medible', fields: 'id_indicador · id_objetivo · nombre · unidad · linea_base · meta · sentido · frecuencia · responsable' },
  { name: 'Seguimiento', unit: 'Una fila nueva por revisión; no sobrescribir la anterior', fields: 'id_revision · fecha_corte · id_iniciativa · id_indicador · valor_actual · avance_pct · resultado · bloqueo · siguiente_accion · proxima_revision · enlace_evidencia' },
];

export default function StrategicPlanning({ company, onOpenDocuments }) {
  return <div className="nv-strategy">
    <div className="nv-strategy-intro">
      <div>
        <span className="nv-strategy-eyebrow">CORPORATE / {company.name}</span>
        <h2>Del plan a la ejecución</h2>
        <p>Este espacio quedará vinculado a la hoja de planeación de {company.name} cuando el plan esté aprobado. WOBi podrá seguir fechas, indicadores y evidencias sin mezclar compañías.</p>
      </div>
      <span className="nv-strategy-status"><i /> Fuente pendiente</span>
    </div>

    <div className="nv-strategy-flow" aria-label="Flujo previsto para la planeación">
      <span><strong>01</strong> Objetivos</span><b aria-hidden="true">→</b>
      <span><strong>02</strong> Iniciativas</span><b aria-hidden="true">→</b>
      <span><strong>03</strong> Indicadores</span><b aria-hidden="true">→</b>
      <span><strong>04</strong> Seguimiento</span>
    </div>

    <div className="nv-strategy-empty" role="status">
      <span className="nv-strategy-empty-icon" aria-hidden="true">◇</span>
      <div><strong>Aún no hay un plan conectado</strong><p>No se muestran avances, alertas ni porcentajes sin una fuente verificada. Cuando la hoja esté lista, este panel mostrará responsables, próximos hitos, desviaciones y decisiones pendientes.</p></div>
    </div>

    <details className="nv-strategy-schema">
      <summary>Ver estructura recomendada de la hoja</summary>
      <p>Un libro en Drive con estas cuatro pestañas. Los identificadores unen las filas; «empresa» separa WOBA, Footprint y eWorks si se usa un solo libro.</p>
      <div className="nv-strategy-sheets">{SHEETS.map(sheet => <div key={sheet.name}><strong>{sheet.name}</strong><small>{sheet.unit}</small><code>{sheet.fields}</code></div>)}</div>
      <p className="nv-strategy-rule">Fechas en formato AAAA-MM-DD; estados con valores acordados; un enlace a evidencia por avance. Las revisiones se agregan como filas nuevas para conservar el historial.</p>
    </details>
    <button type="button" className="nv-strategy-documents" onClick={onOpenDocuments}>Buscar documentos corporativos de {company.name} ↗</button>
  </div>;
}
