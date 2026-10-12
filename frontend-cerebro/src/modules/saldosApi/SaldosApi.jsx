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
  return <section aria-label="Saldos API" className="saldos-api">
    <h3>Saldos API · aviso de recarga</h3>
    <p>El saldo confirmado procede de la última consulta de facturación. La estimación descuenta solo el consumo registrado por WOBi; puede haber gastos externos. Verifica la lectura cada día y después de recargar.</p>
    {saldos.map(saldo => <article key={saldo.proveedor} className="control-metrica" role={saldo.estado === "normal" ? undefined : "alert"}>
      <h4>{saldo.proveedor === "openai" ? "OpenAI / GPT" : "Anthropic"}</h4>
      <strong>{{ normal: "Saldo sobre el umbral", bajo: "Aviso: saldo bajo", critico: "Urgente: saldo próximo a agotarse", verificar: "Pendiente de verificar saldo" }[saldo.estado]}</strong>
      <p>Confirmado: {saldo.saldoConfirmadoUSD === null ? "No disponible" : `$${saldo.saldoConfirmadoUSD.toFixed(2)} USD`} · {saldo.verificadoEn ? new Date(saldo.verificadoEn).toLocaleString("es") : "Sin fecha"}</p>
      <p>Estimación según WOBi: {saldo.estimadoUSD === null ? "No disponible" : `$${saldo.estimadoUSD.toFixed(2)} USD`} · Aviso a ${saldo.umbralUSD.toFixed(2)} USD</p>
      {saldo.lecturaAntigua && <p>Hace falta una lectura reciente para confirmar el saldo actual.</p>}
      <a href={saldo.fuente} target="_blank" rel="noopener noreferrer">Consultar facturación</a>
      {puedeEditar && <form onSubmit={event => guardar(event, saldo.proveedor)}>
        <label>Saldo confirmado USD <input name="saldo" type="number" min="0" step="0.01" required /></label>
        <label>Fecha de consulta <input name="fecha" type="datetime-local" required /></label>
        <label>Avisar por debajo de USD <input name="umbral" type="number" min="0.01" step="0.01" defaultValue={saldo.umbralUSD} required /></label>
        <button disabled={guardando} type="submit">Guardar lectura</button>
      </form>}
    </article>)}
    <p aria-live="polite">{mensaje}</p>
  </section>;
}
