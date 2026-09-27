import React, { useEffect, useState } from "react";

const MARCAR_PAGO_ENDPOINT = "/api/cerebro/seguros/marcar-pago";
const EMPRESAS = ["WOBA", "EWORKS", "Footprint"];

const ESTADO_PAGO_LABEL = {
  pagado: "Pagado",
  pendiente: "Pendiente",
  sin_confirmar: "Sin confirmar",
  no_aplica: "No aplica",
};

function get(obj, path, fallback) {
  const value = path.split(".").reduce((current, key) => current?.[key], obj);
  return value ?? fallback;
}

/**
 * Módulo de Seguros de Cerebro. Recibe los tokens visuales y el desplegable
 * compartido desde App para no duplicar el sistema de diseño ni crear una
 * dependencia circular. La escritura exige dos clics y credencial maestra.
 */
export default function SegurosContenido({
  apiKey,
  puedeArreglar,
  estado,
  onRefresh,
  tokens: C,
  DesplegableComponent: Desplegable,
}) {
  const [empresaAbierta, setEmpresaAbierta] = useState(null);
  const [polizasLocal, setPolizasLocal] = useState(null);
  const [confirmandoId, setConfirmandoId] = useState(null);
  const [marcandoId, setMarcandoId] = useState(null);
  const [errorSeguros, setErrorSeguros] = useState("");

  useEffect(() => {
    setPolizasLocal(null);
    setConfirmandoId(null);
  }, [estado]);

  if (!estado) {
    return <div style={{ fontFamily: C.mono, fontSize: 10.5, color: C.dim, marginTop: 14 }}>cargando registro…</div>;
  }

  const polizas = polizasLocal || get(estado, "polizas", []);
  const colorEstadoPago = {
    pagado: C.ok,
    pendiente: C.amberBright,
    sin_confirmar: C.amberBright,
    no_aplica: C.dim,
  };

  const marcarPagado = async (id) => {
    if (!apiKey || marcandoId) return;
    if (confirmandoId !== id) {
      setConfirmandoId(id);
      return;
    }

    setMarcandoId(id);
    setErrorSeguros("");
    try {
      const res = await fetch(MARCAR_PAGO_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cerebro-Key": apiKey },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error("No se pudo marcar la póliza como pagada.");
      const json = await res.json();
      if (json?.poliza) {
        setPolizasLocal((prev) => (prev || get(estado, "polizas", [])).map((p) => (p.id === id ? json.poliza : p)));
      }
      setConfirmandoId(null);
      await onRefresh("manual");
    } catch {
      setErrorSeguros("No se pudo marcar la póliza como pagada. No se cambió el registro; vuelve a intentarlo.");
    } finally {
      setMarcandoId(null);
    }
  };

  return (
    <div style={{ marginTop: 16, borderTop: `1px solid ${C.line}`, paddingTop: 12 }}>
      {errorSeguros && <div role="status" style={{ fontFamily: C.sans, fontSize: 11, color: C.dangerBright, marginBottom: 8 }}>{errorSeguros}</div>}
      {EMPRESAS.map((empresa) => {
        const deEstaEmpresa = polizas.filter((p) => p.empresa === empresa);
        if (deEstaEmpresa.length === 0) return null;
        return (
          <Desplegable
            key={empresa}
            titulo={`${empresa} — ${deEstaEmpresa.length} póliza(s)`}
            abierto={empresaAbierta === empresa}
            onToggle={() => setEmpresaAbierta((actual) => (actual === empresa ? null : empresa))}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 4 }}>
              {deEstaEmpresa.map((poliza) => {
                const requiereConfirmarPago = poliza.estadoPago === "pendiente" || poliza.estadoPago === "sin_confirmar";
                const colorPago = colorEstadoPago[poliza.estadoPago] || C.dim;
                return (
                  <div key={poliza.id} style={{ padding: "8px 10px", background: C.voidSoft, borderRadius: 6, border: `1px solid ${C.line}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontFamily: C.sans, fontSize: 12, color: C.cream }}>{poliza.tipoCobertura}</div>
                        <div style={{ fontFamily: C.mono, fontSize: 10, color: C.dim, marginTop: 2 }}>
                          {poliza.aseguradora || "aseguradora sin confirmar"}
                          {poliza.numeroPoliza ? ` · ${poliza.numeroPoliza}` : ""}
                        </div>
                      </div>
                      <span style={{ flexShrink: 0, fontFamily: C.mono, fontSize: 9.5, color: colorPago, border: `1px solid ${colorPago}`, borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>
                        {poliza.estado === "no_contratada" ? "No contratada" : ESTADO_PAGO_LABEL[poliza.estadoPago] || poliza.estadoPago}
                      </span>
                    </div>
                    {(poliza.prima || poliza.fechaVencimiento) && (
                      <div style={{ fontFamily: C.mono, fontSize: 10, color: C.dim, marginTop: 6 }}>
                        {poliza.prima ? `${poliza.prima}${poliza.moneda ? ` ${poliza.moneda}` : ""}` : ""}
                        {poliza.fechaVencimiento ? ` · vence ${poliza.fechaVencimiento}` : ""}
                      </div>
                    )}
                    {poliza.notas && (
                      <div style={{ fontFamily: C.sans, fontSize: 10.5, color: C.dim, marginTop: 6, lineHeight: 1.5 }}>{poliza.notas}</div>
                    )}
                    {requiereConfirmarPago && puedeArreglar && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                        <button
                          onClick={() => marcarPagado(poliza.id)}
                          disabled={marcandoId === poliza.id}
                          style={{ background: "none", border: `1px solid ${C.amberBright}`, color: C.amberBright, borderRadius: 6, padding: "5px 10px", fontFamily: C.mono, fontSize: 10.5, cursor: marcandoId === poliza.id ? "default" : "pointer" }}
                        >
                          {marcandoId === poliza.id ? "marcando…" : confirmandoId === poliza.id ? "confirmar pago" : "marcar como pagado"}
                        </button>
                        {confirmandoId === poliza.id && marcandoId !== poliza.id && (
                          <button
                            onClick={() => setConfirmandoId(null)}
                            style={{ background: "none", border: "none", color: C.dim, padding: "5px 2px", fontFamily: C.mono, fontSize: 10, cursor: "pointer" }}
                          >
                            cancelar
                          </button>
                        )}
                      </div>
                    )}
                    {requiereConfirmarPago && !puedeArreglar && (
                      <div style={{ marginTop: 8, fontFamily: C.mono, fontSize: 9.5, color: C.dim }}>requiere admin para confirmar pago</div>
                    )}
                  </div>
                );
              })}
            </div>
          </Desplegable>
        );
      })}
      {get(estado, "linkRegistro") && (
        <a href={get(estado, "linkRegistro")} target="_blank" rel="noreferrer" style={{ display: "inline-block", marginTop: 10, fontFamily: C.mono, fontSize: 11, color: C.amberBright, textDecoration: "none", border: `1px solid ${C.amber}`, borderRadius: 6, padding: "6px 12px" }}>
          abrir el registro ↗
        </a>
      )}
    </div>
  );
}
