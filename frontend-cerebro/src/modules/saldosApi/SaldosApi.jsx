import { useState } from "react";
import "./saldos.css";
export default function SaldosApi({ saldos, apiKey, puedeEditar, onRefresh }) {
  const [mensaje, setMensaje] = useState("");
  const [guardando, setGuardando] = useState(false);
  async function guardar(event, proveedor) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const saldo = String(form.get("saldo")).trim();
    if (!saldo) return;
    setGuardando(true); setMensaje("");
    try {
      const respuesta = await fetch("/api/cerebro/control-diario/saldos", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Cerebro-Key": apiKey },
        body: JSON.stringify({ proveedor, saldoUSD: Number(saldo), umbralUSD: Number(form.get("umbral")), verificadoEn: new Date(String(form.get("fecha"))).toISOString() }),
      });
      if (!respuesta.ok) throw new Error((await respuesta.json()).error || "No se pudo guardar.");
      setMensaje("Lectura guardada. No se ha realizado ninguna recarga."); await onRefresh?.("manual");
    } catch (error) { setMensaje(error.message); }
    finally { setGuardando(false); }
  }
  if (!saldos) return null;
  const nombre = saldo => saldo.proveedor === "openai" ? "OpenAI / GPT" : "Anthropic";
  const importe = valor => valor == null ? "Sin lectura" : `$${valor.toFixed(2)} USD`;
  const estados = { normal: "Saldo disponible", bajo: "Saldo bajo", critico: "Recargar pronto", verificar: "Verificar saldo" };
  return <details className="saldos-api">
    <summary className="saldos-api-resumen">
      <span className="saldos-api-titulo">Saldos API <span>· avisos de recarga</span></span>
      <span className="saldos-api-indicadores">
        {saldos.map(saldo => <span key={saldo.proveedor} className={`saldos-api-indicador saldos-api-${saldo.estado}`}>
          <span>{nombre(saldo)}</span>
          <strong>{saldo.estimadoUSD == null ? estados[saldo.estado] : importe(saldo.estimadoUSD)}</strong>
          {saldo.estimadoUSD != null && <small>{saldo.estado === "normal" ? "estimado" : estados[saldo.estado]}</small>}
        </span>)}
      </span>
      <span className="saldos-api-flecha" aria-hidden="true">⌄</span>
    </summary>
    <div className="saldos-api-contenido">
      <p className="saldos-api-nota">La estimación descuenta el consumo registrado por WOBi. Comprueba el saldo en facturación cada día y después de recargar.</p>
      <div className="saldos-api-proveedores">
        {saldos.map(saldo => <article key={saldo.proveedor} className={`saldos-api-proveedor saldos-api-${saldo.estado}`}>
          <header><h4>{nombre(saldo)}</h4><span>{estados[saldo.estado]}</span></header>
          <dl>
            <div><dt>Confirmado</dt><dd>{importe(saldo.saldoConfirmadoUSD)}</dd></div>
            <div><dt>Estimado por WOBi</dt><dd>{importe(saldo.estimadoUSD)}</dd></div>
            <div><dt>Umbral de aviso</dt><dd>{importe(saldo.umbralUSD)}</dd></div>
          </dl>
          <p className="saldos-api-fecha">{saldo.verificadoEn ? `Última lectura: ${new Date(saldo.verificadoEn).toLocaleString("es")}` : "Lectura pendiente"}{saldo.lecturaAntigua && " · Actualizar lectura"}</p>
          <a href={saldo.fuente} target="_blank" rel="noopener noreferrer">Consultar facturación ↗</a>
          {puedeEditar && <details className="saldos-api-edicion">
            <summary>Actualizar lectura</summary>
            <form onSubmit={event => guardar(event, saldo.proveedor)} aria-label={`Actualizar saldo de ${nombre(saldo)}`}>
              <label>Saldo confirmado (USD)<input name="saldo" type="number" min="0" step="0.01" required /></label>
              <label>Fecha de consulta<input name="fecha" type="datetime-local" required /></label>
              <label>Umbral de aviso (USD)<input name="umbral" type="number" min="0.01" step="0.01" defaultValue={saldo.umbralUSD} required /></label>
              <button disabled={guardando} type="submit">{guardando ? "Guardando…" : "Guardar lectura"}</button>
            </form>
          </details>}
        </article>)}
      </div>
      {mensaje && <p role="status" className="saldos-api-mensaje">{mensaje}</p>}
    </div>
  </details>;
}
