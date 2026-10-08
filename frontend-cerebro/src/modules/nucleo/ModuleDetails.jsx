import { useEffect, useState } from 'react';
import { companyCashflowRows } from './cashflowView.mjs';

/** Shared existing module content. Business actions remain in their original components. */
export default function ModuleDetails({ m, liveData, groupData, companyId, fuentesFallidas, periodoCashflow, setPeriodoCashflow, verPagosRecurrentes, setVerPagosRecurrentes, verDocumentos, setVerDocumentos, verCapturasRecientes, setVerCapturasRecientes, verCorreccionesRecientes, setVerCorreccionesRecientes, C, get, timeAgo, Desplegable, liveRowsForModule, auditContent, children }) {
  const [showGroupCashflow, setShowGroupCashflow] = useState(false);
  useEffect(() => { setShowGroupCashflow(false); }, [companyId]);
  const scopedCashflow = m.id === 'cashflow' && Boolean(companyId);
  const footprintWithoutCashflow = scopedCashflow && companyId === 'Footprint';
  const displayData = scopedCashflow && showGroupCashflow ? groupData : liveData;
  const showPeriod = m.id === 'cashflow' && !footprintWithoutCashflow && (!scopedCashflow || showGroupCashflow);
  const sourcePrefix = ({ calendario: 'crm', auditoria: 'auditoriaProgramada' })[m.id] || m.id;
  const failedModuleSources = fuentesFallidas.filter(source => source.fuente === sourcePrefix || source.fuente.startsWith(`${sourcePrefix}.`));
  const hideUnverifiedModule = m.id !== 'cashflow' && failedModuleSources.length > 0;
  const rows = footprintWithoutCashflow && !showGroupCashflow ? []
    : scopedCashflow && !showGroupCashflow ? companyCashflowRows(displayData, companyId)
    : liveRowsForModule(m.id, displayData, periodoCashflow);
  return <div className="nv-module-details">
              {scopedCashflow && <div className="nv-cashflow-scope" role="note">
                {footprintWithoutCashflow ? 'Footprint aún no tiene un Cashflow conectado. No se muestran balances ni importes como si fueran de esta compañía.'
                  : showGroupCashflow ? 'Balance conjunto del archivo WOBA/eWorks. Estas cifras no son un balance individual de la compañía seleccionada.'
                  : 'Vista de la compañía: propuestas y pagos identificados. Los balances del archivo son conjuntos para WOBA/eWorks.'}
                {!footprintWithoutCashflow && <button type="button" onClick={() => setShowGroupCashflow(value => !value)}>{showGroupCashflow ? 'Volver a la compañía' : 'Ver balance conjunto WOBA/eWorks'}</button>}
              </div>}
              {showPeriod && (
                <div style={{ display: "flex", gap: 6, marginTop: 14 }}>
                  {[
                    ["semana", "Semanal"],
                    ["mes", "Mensual"],
                  ].map(([valor, etiqueta]) => (
                    <button
                      key={valor}
                      onClick={() => setPeriodoCashflow(valor)}
                      style={{
                        background: periodoCashflow === valor ? C.amber : "none",
                        border: `1px solid ${C.amber}`,
                        color: periodoCashflow === valor ? C.ink : C.amberBright,
                        borderRadius: 6,
                        padding: "5px 12px",
                        fontFamily: C.mono,
                        fontSize: 10.5,
                        cursor: "pointer",
                      }}
                    >
                      {etiqueta}
                    </button>
                  ))}
                </div>
              )}

              {!footprintWithoutCashflow && failedModuleSources.length > 0 && (
                <div role="status" style={{ color: C.amberBright, marginTop: 12 }}>Lectura incompleta. {m.id === 'cashflow' ? 'Los indicadores afectados se ocultan' : 'Las cifras de este módulo se ocultan'} hasta verificar: {failedModuleSources.map(f => `${f.fuente}${f.ultimoExitoEn ? ` (último éxito ${timeAgo(f.ultimoExitoEn)})` : ' (sin éxito previo)'}`).join(", ")}.</div>
              )}
              {footprintWithoutCashflow ? null : hideUnverifiedModule ? (
                <div role="status" style={{ color: C.amberBright, marginTop: 14 }}>Datos no disponibles para tomar decisiones. WOBi reintentará la lectura automáticamente.</div>
              ) : liveData ? (
                <div style={{ marginTop: 16, borderTop: `1px solid ${C.line}`, paddingTop: 12 }}>
                  {rows.length > 0 && <div className="nv-metrics">{rows.map(([label, value], i) => (
                    <div key={i} className="nv-metric" style={{ "--metric-color": ["#65d9f2","#a99cff","#62d4ae","#e5bb7a"][i%4] }}>
                      <span className="nv-metric-label">{label}</span>
                      <span className="nv-metric-value">{value}</span>
                    </div>
                  ))}</div>}
                  {m.id === "cashflow" && (
                    <div style={{ marginTop: 6 }}>
                      <div
                        onClick={() => setVerPagosRecurrentes((v) => !v)}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "5px 0",
                          cursor: "pointer",
                        }}
                      >
                        <span style={{ fontFamily: C.sans, fontSize: 12, color: C.amberBright }}>
                          {verPagosRecurrentes ? "▾" : "▸"} Ver cuáles son los pagos recurrentes catalogados
                        </span>
                      </div>
                      {verPagosRecurrentes && (
                        <div style={{ paddingLeft: 8, borderLeft: `1px solid ${C.line}` }}>
                          {get(displayData, "cashflow.pagosRecurrentes", []).length === 0 ? (
                            <div style={{ fontFamily: C.sans, fontSize: 11.5, color: C.dim, padding: "4px 0" }}>
                              Ninguno catalogado en esta vista.
                            </div>
                          ) : (
                            get(displayData, "cashflow.pagosRecurrentes", []).map((p, i) => (
                              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 11.5 }}>
                                <span style={{ fontFamily: C.sans, color: C.dim }}>{p.concepto} · {p.empresa}</span>
                                <span style={{ fontFamily: C.mono, color: C.coreBright }}>{p.periodicidad}</span>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {m.id === "cashflow" && get(displayData, "cashflow.linkSheet") && (
                    <a
                      href={get(displayData, "cashflow.linkSheet")}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: "inline-block", marginTop: 10, fontFamily: C.mono, fontSize: 11, color: C.amberBright, textDecoration: "none", border: `1px solid ${C.amber}`, borderRadius: 6, padding: "6px 12px" }}
                    >
                      abrir el cashflow ↗
                    </a>
                  )}

                  {m.id === "conocimiento" && (
                    <>
                      <Desplegable
                        titulo={`Ver los ${get(liveData, "conocimiento.documentos", 0)} documentos de proceso`}
                        abierto={verDocumentos}
                        onToggle={() => setVerDocumentos((v) => !v)}
                      >
                        {get(liveData, "conocimiento.listaDocumentos", []).length === 0 ? (
                          <div style={{ fontFamily: C.sans, fontSize: 11.5, color: C.dim, padding: "4px 0" }}>Sin documentos.</div>
                        ) : (
                          get(liveData, "conocimiento.listaDocumentos", []).map((doc, i) => (
                            <div key={i} style={{ padding: "5px 0" }}>
                              <div style={{ fontFamily: C.mono, fontSize: 11, color: C.coreBright }}>{doc.nombre}</div>
                              {doc.resumen && (
                                <div style={{ fontFamily: C.sans, fontSize: 11, color: C.dim, marginTop: 1 }}>{doc.resumen}</div>
                              )}
                            </div>
                          ))
                        )}
                      </Desplegable>

                      <Desplegable
                        titulo="Ver las últimas capturas guardadas"
                        abierto={verCapturasRecientes}
                        onToggle={() => setVerCapturasRecientes((v) => !v)}
                      >
                        {get(liveData, "conocimiento.ultimasCapturas", []).length === 0 ? (
                          <div style={{ fontFamily: C.sans, fontSize: 11.5, color: C.dim, padding: "4px 0" }}>Ninguna todavía.</div>
                        ) : (
                          get(liveData, "conocimiento.ultimasCapturas", []).map((c, i) => (
                            <div key={i} style={{ padding: "5px 0" }}>
                              <div style={{ fontFamily: C.mono, fontSize: 10, color: C.dim }}>
                                {timeAgo(c.fecha)}{c.empresas ? ` · ${c.empresas}` : ""}{c.autor ? ` · ${c.autor}` : ""}
                              </div>
                              <div style={{ fontFamily: C.sans, fontSize: 11.5, color: C.cream, marginTop: 1 }}>{c.resumen}</div>
                            </div>
                          ))
                        )}
                      </Desplegable>

                      <Desplegable
                        titulo="Ver las últimas correcciones registradas"
                        abierto={verCorreccionesRecientes}
                        onToggle={() => setVerCorreccionesRecientes((v) => !v)}
                      >
                        {get(liveData, "conocimiento.ultimasCorrecciones", []).length === 0 ? (
                          <div style={{ fontFamily: C.sans, fontSize: 11.5, color: C.dim, padding: "4px 0" }}>Ninguna todavía.</div>
                        ) : (
                          get(liveData, "conocimiento.ultimasCorrecciones", []).map((c, i) => (
                            <div key={i} style={{ padding: "5px 0" }}>
                              <div style={{ fontFamily: C.mono, fontSize: 10, color: C.dim }}>{timeAgo(c.fecha)}</div>
                              <div style={{ fontFamily: C.sans, fontSize: 11.5, color: C.dim, marginTop: 1 }}>
                                Antes: <span style={{ color: "#B8899A" }}>{c.antes}</span>
                              </div>
                              <div style={{ fontFamily: C.sans, fontSize: 11.5, color: C.cream, marginTop: 1 }}>
                                Ahora: <span style={{ color: C.coreBright }}>{c.ahora}</span>
                              </div>
                            </div>
                          ))
                        )}
                      </Desplegable>
                    </>
                  )}

                  {auditContent}
                </div>
              ) : (
                <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.dim, marginTop: 14, letterSpacing: "0.03em" }}>
                  estado en vivo no disponible todavía
                </div>
              )}

    {m.id === 'seguros' && hideUnverifiedModule ? null : children}
  </div>;
}
