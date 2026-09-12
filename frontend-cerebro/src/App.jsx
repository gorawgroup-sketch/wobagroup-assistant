import React, { useMemo, useState, useRef, useCallback, useEffect } from "react";
import WobiAvatar, { WOBI_IMAGE } from "./WobiAvatar.jsx";
import WobiVoice from "./WobiVoice.jsx";
import { createWobiSpeech } from "./wobiSpeech.js";
import { useCerebroRealtime } from "./useCerebroRealtime";

const C = {
  void: "#050B14",
  voidSoft: "#0C1620",
  panel: "#0F1B2A",
  line: "rgba(126, 193, 232, 0.14)",
  lineBright: "rgba(126, 193, 232, 0.5)",
  core: "#2E6DA4",
  coreBright: "#8FD2F5",
  cream: "#F5F0E4",
  ink: "#0F1B2B",
  dim: "#7C93AC",
  amber: "#E8A75C",
  amberBright: "#FFC98A",
  ok: "#6FCF97",
  danger: "#F07178",
  dangerBright: "#FF9AA0",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
  serif: "'Fraunces', Georgia, serif",
  sans: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
};

const WOBI_IMG = WOBI_IMAGE;

// El front y la API ya viven en el mismo dominio. Las rutas relativas evitan
// preflights CORS, funcionan igual en local/staging/Railway y no atan el
// navegador al dominio técnico de un servicio concreto.
const API_BASE = "/api/cerebro";
const CEREBRO_ENDPOINT = `${API_BASE}/estado`;
const SOLICITAR_ACCESO_ENDPOINT = `${API_BASE}/solicitar-acceso`;
const SOLICITUD_ENDPOINT_BASE = `${API_BASE}/solicitud`;
const ACCESOS_ACTIVOS_ENDPOINT = `${API_BASE}/accesos-activos`;
const ACCESOS_MAESTRO_OTORGADOS_ENDPOINT = `${API_BASE}/accesos-maestro-otorgados`;
const REVOCAR_ACCESO_ENDPOINT = `${API_BASE}/revocar-acceso`;
const USUARIOS_AUTORIZADOS_ENDPOINT = `${API_BASE}/usuarios-autorizados`;
const CAMBIAR_ROL_ENDPOINT = `${API_BASE}/cambiar-rol-usuario`;
const ELIMINAR_USUARIO_ENDPOINT = `${API_BASE}/eliminar-usuario`;
const CONEXIONES_ENDPOINT = `${API_BASE}/conexiones`;
const ARREGLAR_CONEXION_ENDPOINT = `${API_BASE}/conexiones/arreglar`;
const BUSQUEDA_WEB_ENDPOINT = `${API_BASE}/busqueda-web`;
const BUSCAR_ENDPOINT = `${API_BASE}/buscar`;
const ACCIONES_PROGRAMADAS_ENDPOINT = `${API_BASE}/acciones-programadas`;
const CHAT_ENDPOINT = `${API_BASE}/chat`;
const CHAT_VINCULAR_ENDPOINT = `${API_BASE}/chat/vincular`;
const CONEXIONES_POLL_MS = 60000;
const POLL_INTERVALO_MS = 3000;
// La sesión (key maestra o token temporal, lo que se haya aprobado) se
// guarda en localStorage para no tener que volver a pedir acceso en cada
// visita — dura hasta que el token deje de ser válido en el servidor
// (24h si es temporal, o hasta que un admin lo revoque).
const LOCALSTORAGE_TOKEN_KEY = "wobi_cerebro_token";
const LOCALSTORAGE_DEVICE_KEY = "wobi_cerebro_device";
const LOCALSTORAGE_VOZ_KEY = "wobi_cerebro_leer_respuestas";
// Username verificado en vivo contra getMe de la Bot API (no confiar en el nombre visible, que puede cambiar).
const TELEGRAM_BOT_URL = "https://t.me/Woba_asistente_bot";
// Ícono oficial de Telegram (recortado del asset provisto en el proyecto), fondo transparente.
const TELEGRAM_ICON = "data:image/png;base64,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";

function fmtMoney(n) {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n);
}

function fmtUSD(n) {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "USD", maximumFractionDigits: 3 }).format(n);
}

function timeAgo(iso) {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "hace instantes";
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  return `hace ${Math.round(hrs / 24)} d`;
}

function get(obj, path, fallback = null) {
  try {
    const val = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
    return val === undefined || val === null ? fallback : val;
  } catch {
    return fallback;
  }
}

const MODULES = [
  { id: "cashflow", name: "Cashflow", detail: "WOBA · EWORKS", note: "escritura con aprobación", desc: "Lee y consolida el cashflow semanal, detecta movimientos de Holded que faltan por registrar y solo escribe una fila nueva cuando apruebas la propuesta por Telegram." },
  { id: "holded", name: "Holded", detail: "Facturas · IVA · conciliación", note: "3 empresas", desc: "Lee facturas reales (PDF/imagen) con desglose de IVA por línea, empareja o propone gastos nuevos, y concilia contra el movimiento bancario solo cuando la coincidencia es inequívoca." },
  { id: "drive", name: "Drive", detail: "Búsqueda y archivo", note: "3 empresas", desc: "Busca documentos por nombre en las carpetas de las 3 empresas y clasifica archivos entrantes, proponiendo dónde archivarlos antes de subir nada." },
  { id: "correo", name: "Correo", detail: "asistente@wobagroup.com", note: "recepción y envío", desc: "Buzón dedicado que clasifica cada correo entrante (archivable, accionable, informativo) y redacta borradores de respuesta — nunca ejecuta instrucciones que vengan dentro de un correo." },
  { id: "fiscal", name: "Fiscal y Alertas", detail: "Calendario recurrente", note: "solo lectura", desc: "Avisa con antelación de domiciliaciones, impuestos y seguros recurrentes, leyendo el calendario fiscal del grupo — nunca escribe nada." },
  { id: "conocimiento", name: "Conocimiento", detail: "5 documentos · capturas · correcciones", note: "núcleo de memoria", desc: "La memoria compartida del sistema: documentos de proceso, capturas de conocimiento del equipo y correcciones, siempre con prioridad sobre cualquier otro dato." },
  { id: "accesos", name: "Accesos y Costos", detail: "Allowlist · gasto IA diario", note: "gobierno del sistema", desc: "Controla quién puede usar el bot y quién puede aprobar escrituras, y registra el gasto real de IA con alerta ante consumo inusual." },
  { id: "busqueda_web", name: "Búsqueda Web", detail: "Historial · costo · buscador", note: "complementa, no reemplaza", desc: "Complementa las respuestas con información pública real cuando el conocimiento interno no alcanza — cada búsqueda queda registrada con su costo. Trae un buscador propio, opcional, para lanzar una consulta directa sin pasar por el chat." },
  // Fusión pedida por Carlos: antes había dos nodos de calendario separados
  // (uno de actividades CRM de Holded, otro de acciones programadas) — ahora
  // es uno solo, con las dos cosas dentro (ver liveRowsForModule caso
  // "calendario" para las actividades CRM, y MiniCalendario para lo programado).
  { id: "calendario", name: "Calendario", detail: "Actividades Holded + acciones programadas", note: "programación asistida", desc: "Actividades del calendario CRM de Holded, y cualquier acción que Wobi tenga programada para más adelante (una fecha, o una condición todavía sin cumplir) — se dispara sola en su momento." },
  { id: "conexiones", name: "Conexiones", detail: "Estado de las integraciones", note: "monitoreo en vivo", desc: "El estado real de cada integración externa (Telegram, Google, Holded, Claude, Búsqueda web) — verificado en vivo, no solo si la variable de entorno existe." },
];

/**
 * Pedido explícito de Carlos: con 11 neuronas sueltas alrededor del núcleo
 * ya no se lee de un vistazo — "agrupemos... de tal forma que sea una gran
 * neurona que cuando se abra salgan las neuronas más pequeñas de cada
 * cosa". Tres grupos por función real (no por dónde vive el dato):
 * Administración (gobierno del sistema), Finanzas (dinero real), Operación
 * (trabajo diario). Cada grupo es un nodo grande de primer nivel; sus
 * `children` (ids de MODULES) solo se dibujan cuando ese grupo está
 * abierto — ver openGroups más abajo (varios grupos pueden estar
 * abiertos a la vez, cada uno sin ocultar a los demás).
 */
// Pedido explícito de Carlos: si abre las 3 células principales a la vez, quiere poder distinguir
// SIEMPRE a cuál pertenece cada célula pequeña — cada grupo tiene su propio color de rama y de
// "nanobot" viajero (ver el bloque "Grupo → sus módulos" más abajo), igual que el núcleo→grupo ya
// tenía su propia chispa ambar.
const GROUPS = [
  { id: "administracion", name: "Administración", note: "gobierno del sistema", children: ["conexiones", "accesos", "conocimiento", "calendario"], accent: "#FFC98A" },
  { id: "finanzas", name: "Finanzas", note: "dinero real", children: ["holded", "cashflow", "fiscal"], accent: "#7EE2C0" },
  { id: "operacion", name: "Operación", note: "trabajo diario", children: ["drive", "correo", "busqueda_web"], accent: "#B7A6FF" },
];

function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function buildField(seed, count, size) {
  const rnd = seeded(seed);
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: i,
    x: size * 0.06 + rnd() * size * 0.88,
    y: size * 0.06 + rnd() * size * 0.88,
    r: 1 + rnd() * 2,
    driftX: (rnd() - 0.5) * 10,
    driftY: (rnd() - 0.5) * 10,
    dur: 4 + rnd() * 5,
    delay: rnd() * 5,
    warm: rnd() > 0.8,
  }));
  const edges = [];
  nodes.forEach((a, i) => {
    let linked = 0;
    for (let j = i + 1; j < nodes.length && linked < 2; j++) {
      const b = nodes[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < size * 0.19 && rnd() > 0.45) {
        edges.push({ a, b, id: `${i}-${j}` });
        linked++;
      }
    }
  });
  const firingEdges = edges.filter((_, i) => i % 4 === 0).slice(0, 14);
  return { nodes, edges, firingEdges };
}

/** Campo neuronal reactivo: las partículas cerca del cursor se agrandan y brillan más. */
function NeuralField({ seed, count, size, dense = false }) {
  const { nodes, edges, firingEdges } = useMemo(() => buildField(seed, count, size), [seed, count, size]);
  const [mouse, setMouse] = useState(null);
  const svgRef = useRef(null);

  const handleMove = useCallback((e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * size;
    const y = ((e.clientY - rect.top) / rect.height) * size;
    setMouse({ x, y });
  }, [size]);

  const handleLeave = useCallback(() => setMouse(null), []);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${size} ${size}`}
      onPointerMove={handleMove}
      onPointerLeave={handleLeave}
      style={{ width: "100%", height: "100%", display: "block", position: "absolute", inset: 0 }}
    >
      {edges.map((e) => (
        <line key={e.id} x1={e.a.x} y1={e.a.y} x2={e.b.x} y2={e.b.y} stroke={C.line} strokeWidth="0.6" />
      ))}
      {nodes.map((n) => {
        const dist = mouse ? Math.hypot(n.x - mouse.x, n.y - mouse.y) : Infinity;
        const proximity = Math.max(0, 1 - dist / (size * 0.16));
        const boostR = n.r + proximity * 3.2;
        return (
          <g key={n.id}>
            <circle
              cx={n.x}
              cy={n.y}
              r={n.r}
              fill={n.warm ? C.amber : C.coreBright}
              style={{
                animation: `twinkle ${Math.max(0.6, n.dur - proximity * 3)}s ease-in-out ${n.delay}s infinite, drift ${n.dur * 1.6}s ease-in-out ${n.delay}s infinite`,
                ["--dx"]: `${n.driftX}px`,
                ["--dy"]: `${n.driftY}px`,
              }}
            />
            {proximity > 0.05 && (
              <circle cx={n.x} cy={n.y} r={boostR} fill={C.amberBright} opacity={proximity * 0.55} style={{ filter: "blur(1.5px)" }} />
            )}
          </g>
        );
      })}
      {firingEdges.map((e, i) => (
        <circle key={`spark-${e.id}`} r={dense ? 2.6 : 2.2} fill={i % 2 === 0 ? C.amberBright : C.coreBright}>
          <animateMotion path={`M ${e.a.x} ${e.a.y} L ${e.b.x} ${e.b.y}`} dur={`${1.8 + (i % 5) * 0.4}s`} begin={`${(i * 0.35) % 3}s`} repeatCount="indefinite" />
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.85;1" dur={`${1.8 + (i % 5) * 0.4}s`} begin={`${(i * 0.35) % 3}s`} repeatCount="indefinite" />
        </circle>
      ))}
    </svg>
  );
}

/** Filas de datos reales por módulo, a partir de la respuesta del endpoint. Cada fila es [etiqueta, valor]. */
function liveRowsForModule(id, d, periodoCashflow = "semana") {
  if (!d) return [];
  switch (id) {
    case "cashflow": {
      const bal =
        periodoCashflow === "mes"
          ? get(d, "cashflow.balanceUltimoMes")
          : get(d, "cashflow.balanceUltimaSemana");
      const props = get(d, "cashflow.propuestasPendientes", []);
      const recurrentes = get(d, "cashflow.pagosRecurrentes", []);
      const alertas = get(d, "cashflow.alertasPagosRecurrentesProximas", []);
      const rows = [];
      if (bal && periodoCashflow === "mes") {
        rows.push([`Balance ${bal.mesLabel}`, fmtMoney(bal.balanceFinal)]);
        rows.push([`Ingresos de ${bal.mesLabel}`, fmtMoney(bal.ingresos)]);
        rows.push([`Gastos de ${bal.mesLabel}`, fmtMoney(bal.gastos)]);
      } else if (bal) {
        rows.push([`Balance ${bal.semana}`, fmtMoney(bal.balanceFinal)]);
      }
      rows.push(["Propuestas pendientes", String(props.length)]);
      rows.push(["Pagos recurrentes catalogados", String(recurrentes.length)]);
      const ultDeteccion = get(d, "cashflow.ultimaDeteccionHolded");
      if (ultDeteccion) rows.push(["Última revisión de Holded", timeAgo(ultDeteccion)]);

      // Lo que Wobi ya está generando internamente (el cron diario de alertas
      // fiscales) aunque todavía no exista ningún movimiento real en
      // Holded/cashflow — antes era invisible en este panel.
      if (alertas.length === 0) {
        rows.push(["Próximas alertas de pagos recurrentes", "ninguna en ventana"]);
      } else {
        alertas.forEach((a) => {
          rows.push([`⏰ ${a.concepto} (${a.empresa})`, a.diasRestantes === 0 ? "vence HOY" : `en ${a.diasRestantes} día(s)`]);
        });
      }

      return rows;
    }
    case "holded": {
      const porEmpresa = get(d, "holded.porEmpresa", {});
      const empresas = ["WOBA", "EWORKS", "Footprint"].filter((e) => porEmpresa[e]);
      if (empresas.length === 0) {
        return [
          ["Facturas procesadas (7 días)", String(get(d, "holded.facturasProcesadasUltimos7dias", "—"))],
          ["Gastos sin comprobante", String(get(d, "holded.gastosSinComprobante", "—"))],
          ["Movimientos sin conciliar", String(get(d, "holded.movimientosSinConciliar", "—"))],
        ];
      }
      return empresas.map((empresa) => {
        const e = porEmpresa[empresa];
        return [
          empresa,
          `${e.facturasUltimos7dias ?? "—"} facturas · ${e.gastosSinComprobante ?? "—"} sin comprobante · ${e.movimientosSinConciliar ?? "—"} sin conciliar`,
        ];
      });
    }
    case "calendario": {
      const acts = get(d, "crm.actividadesProgramadas", []);
      if (!acts || acts.length === 0) return [["Actividades programadas", "0"]];
      const porEmpresa = {};
      acts.forEach((a) => {
        const empresa = a.empresa || "(sin empresa)";
        porEmpresa[empresa] = (porEmpresa[empresa] || 0) + 1;
      });
      return Object.entries(porEmpresa).map(([empresa, n]) => [empresa, `${n} actividad(es) programada(s)`]);
    }
    case "drive": {
      const porEmpresa = get(d, "drive.porEmpresa", {});
      const empresas = ["WOBA", "EWORKS", "Footprint"].filter((e) => porEmpresa[e]);
      const rows = empresas.length
        ? empresas.map((empresa) => [empresa, `${porEmpresa[empresa].archivosUltimos7dias ?? "—"} archivo(s) (7 días)`])
        : [["Archivos en las 3 empresas (7 días)", String(get(d, "drive.archivosSubidosUltimos7dias", "—"))]];
      const ult = get(d, "drive.ultimoArchivo");
      if (ult) rows.push(["Último archivo", `${ult.nombre || "—"} (${ult.empresa || "—"})`]);
      return rows;
    }
    case "correo": {
      return [
        ["Correos sin leer", String(get(d, "correo.correosNoLeidos", "—"))],
        ["Borradores por aprobar", String(get(d, "correo.borradoresPendientesDeAprobacion", "—"))],
        ["Último procesado", timeAgo(get(d, "correo.ultimoProcesado")) || "—"],
      ];
    }
    case "fiscal": {
      const alertas = get(d, "fiscal.proximasAlertas", []);
      const catalogo = get(d, "fiscal.catalogoPagosRecurrentes", []);
      const rows = [];

      rows.push([
        "Próximas alertas (dentro de ventana de aviso)",
        alertas.length ? `${alertas.length}` : "ninguna ahora mismo",
      ]);
      alertas.slice(0, 4).forEach((a) => rows.push([`  ⏰ ${a.concepto} · ${a.empresa}`, `en ${a.diasRestantes} día(s)`]));

      // El catálogo completo — sin esto, en un día sin alertas inminentes
      // parecía que no había NINGÚN pago recurrente registrado, cuando en
      // realidad solo es que ninguno vence pronto. Incluye Footprint (que no
      // aparece en el catálogo del nodo Cashflow, porque ese es solo
      // WOBA/EWORKS).
      rows.push(["Catálogo completo de pagos recurrentes", `${catalogo.length}`]);
      catalogo.forEach((c) => rows.push([`  ${c.concepto} · ${c.empresa}`, `próx. ${c.proximaFecha} (${c.periodicidad})`]));

      return rows;
    }
    case "conocimiento": {
      return [
        ["Documentos de proceso", String(get(d, "conocimiento.documentos", "—"))],
        ["Cómo se consultan", get(d, "conocimiento.explicacionModo", "—")],
        ["Capturas guardadas (total)", String(get(d, "conocimiento.totalCapturas", "—"))],
        ["Última captura", timeAgo(get(d, "conocimiento.ultimaCaptura")) || "sin registro"],
        ["Correcciones registradas (total)", String(get(d, "conocimiento.totalCorrecciones", "—"))],
        ["Última corrección", timeAgo(get(d, "conocimiento.ultimaCorreccion")) || "sin registro"],
      ];
    }
    case "accesos": {
      return [
        ["Superadmin / admins / colaboradores", `${get(d, "accesos.usuariosAutorizados.superadmins", "—")} / ${get(d, "accesos.usuariosAutorizados.admins", "—")} / ${get(d, "accesos.usuariosAutorizados.colaboradores", "—")}`],
        ["Costo real de API hoy", fmtUSD(get(d, "accesos.costoIaHoy"))],
        ["Costo real de API esta semana", fmtUSD(get(d, "accesos.costoIaEstaSemana"))],
      ];
    }
    default:
      return [];
  }
}

/** Resumen operativo determinista: usa solo el snapshot ya cargado. */
function AtencionAhora({ data, onAbrir }) {
  if (!data) return null;

  const costoHoy = Number(get(data, "accesos.costoIaHoy", 0)) || 0;
  const umbralCosto = Number(get(data, "accesos.umbraLAlertaCosto", 0)) || 0;
  const items = [
    { id: "cashflow", texto: "Propuestas de cashflow", cantidad: get(data, "cashflow.propuestasPendientes", []).length },
    { id: "correo", texto: "Borradores por aprobar", cantidad: Number(get(data, "correo.borradoresPendientesDeAprobacion", 0)) || 0 },
    { id: "holded", texto: "Gastos sin comprobante", cantidad: Number(get(data, "holded.gastosSinComprobante", 0)) || 0 },
    { id: "holded", texto: "Movimientos sin conciliar", cantidad: Number(get(data, "holded.movimientosSinConciliar", 0)) || 0 },
    { id: "fiscal", texto: "Alertas fiscales próximas", cantidad: get(data, "fiscal.proximasAlertas", []).length },
    {
      id: "accesos",
      texto: "Costo de API sobre el umbral",
      cantidad: umbralCosto > 0 && costoHoy >= umbralCosto ? 1 : 0,
      detalle: umbralCosto > 0 && costoHoy >= umbralCosto ? fmtUSD(costoHoy) : null,
    },
  ].filter((item) => item.cantidad > 0);
  const totalPendientes = items.reduce((total, item) => total + item.cantidad, 0);

  return (
    <section
      aria-labelledby="atencion-ahora-titulo"
      className={`atencion-rail${items.length > 0 ? " atencion-rail--activa" : " atencion-rail--estable"}`}
    >
      <div className="atencion-rail-cabecera">
        <div id="atencion-ahora-titulo" className="atencion-rail-titulo">
          <span className="atencion-rail-pulso" aria-hidden="true" />
          <span>{items.length > 0 ? "Prioridades de hoy" : "Todo bajo control"}</span>
          {items.length > 0 && <strong>{totalPendientes}</strong>}
        </div>
        <div className="atencion-rail-fuente">
          Datos en vivo · {timeAgo(get(data, "cacheadoEn")) || "actualizados"}
        </div>
      </div>

      {items.length > 0 && (
        <div className="atencion-flujo">
          {items.map((item, i) => (
            <button
              type="button"
              key={`${item.id}-${i}`}
              onClick={() => onAbrir(item.id)}
              className="atencion-item"
            >
              <span className="atencion-item-numero">{item.detalle || item.cantidad}</span>
              <span className="atencion-item-texto">
                <strong>{item.texto}</strong>
                <small>Abrir módulo</small>
              </span>
              <span className="atencion-item-flecha" aria-hidden="true">↗</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function etiquetaProceso(proceso) {
  const nombres = {
    extraer_factura: "Extracción de facturas",
    chat_conversacional: "Chat conversacional",
    clasificar_correo: "Clasificación de correo",
    extraer_gasto_correo: "Gastos desde correo",
    accion_gasto: "Acciones de gasto",
    autorrevision_codigo: "Autorrevisión de código",
    sin_atribuir: "Sin atribuir",
  };
  return nombres[proceso] || String(proceso || "Proceso").replaceAll("_", " ");
}

function fechaCorta(fecha) {
  const partes = String(fecha || "").split("-");
  return partes.length === 3 ? `${partes[2]}/${partes[1]}` : fecha;
}

/**
 * Pequeño motor de control operativo. El backend genera el diagnóstico con
 * reglas deterministas; este componente solo lo convierte en indicadores,
 * gráfico, tabla y acciones. Abrirlo no invoca ningún modelo.
 */
function ControlDiarioPanel({ data, apiKey, actualizacionId, onAbrir }) {
  const control = get(data, "controlDiario");
  const [abierto, setAbierto] = useState(false);
  const [conexiones, setConexiones] = useState(null);
  const [cargandoConexiones, setCargandoConexiones] = useState(false);
  const [errorConexiones, setErrorConexiones] = useState(false);

  const cargarConexiones = useCallback(async () => {
    if (!apiKey) return;
    setCargandoConexiones(true);
    try {
      const res = await fetch(CONEXIONES_ENDPOINT, {
        headers: { "X-Cerebro-Key": apiKey },
        cache: "no-store",
      });
      if (res.ok) {
        const json = await res.json();
        setConexiones(json?.conexiones || []);
        setErrorConexiones(false);
      } else {
        setErrorConexiones(true);
      }
    } catch {
      // Se conserva la última lectura buena; el estado en vivo reintentará.
      setErrorConexiones(true);
    } finally {
      setCargandoConexiones(false);
    }
  }, [apiKey]);

  useEffect(() => {
    if (abierto) cargarConexiones();
  }, [abierto, cargarConexiones, actualizacionId]);

  if (!control) return null;

  const costos = control.costos;
  const recomendaciones = Array.isArray(control.recomendaciones) ? control.recomendaciones : [];
  const conexionesCaidas = Array.isArray(conexiones) ? conexiones.filter((conexion) => !conexion.ok) : [];
  const estado = (conexionesCaidas.length > 0 || errorConexiones) && control.estado === "estable" ? "atencion" : control.estado;
  const visual = {
    estable: { texto: "Estable", color: C.ok, fondo: "rgba(111, 207, 151, 0.06)" },
    atencion: { texto: "Requiere atención", color: C.amberBright, fondo: "rgba(232, 167, 92, 0.07)" },
    critico: { texto: "Incidencia crítica", color: C.dangerBright, fondo: "rgba(240, 113, 120, 0.08)" },
  }[estado] || { texto: "Analizando", color: C.dim, fondo: C.voidSoft };
  const serie = costos?.ultimos7Dias || [];
  const maximoSerie = Math.max(0.01, ...serie.map((punto) => Number(punto.gastoRealApiUSD) || 0));
  const procesos = costos?.porProcesoAyer?.slice(0, 5) || [];
  const totalAyer = Number(costos?.ayer?.gastoRealApiUSD) || 0;
  const prioridadColor = {
    critica: C.dangerBright,
    alta: C.amberBright,
    media: C.coreBright,
    informativa: C.dim,
  };

  return (
    <section
      aria-labelledby="control-diario-titulo"
      className={`control-diario control-diario--${abierto ? "abierto" : "cerrado"}`}
      style={{ "--control-color": visual.color, "--control-fondo": visual.fondo }}
    >
      <button
        type="button"
        onClick={() => setAbierto((valor) => !valor)}
        aria-expanded={abierto}
        className="control-diario-resumen"
      >
        <span className="control-diario-senal" aria-hidden="true">
          <span />
        </span>
        <span className="control-diario-copy">
          <span id="control-diario-titulo" className="control-diario-etiqueta">
            Diagnóstico diario
          </span>
          <span className="control-diario-estado">{visual.texto}</span>
          <span className="control-diario-descripcion">
            {control.resumen}
          </span>
        </span>
        <span className="control-diario-accion">
          {abierto ? "Cerrar análisis" : "Abrir análisis"}
          <span aria-hidden="true">{abierto ? "↑" : "↓"}</span>
        </span>
      </button>

      {abierto && (
        <div className="control-diario-contenido">
          <div className="control-metricas">
            {[
              ["API hoy", control.costosDisponibles ? fmtUSD(costos?.hoy?.gastoRealApiUSD) : "No disponible"],
              ["API ayer", control.costosDisponibles ? fmtUSD(costos?.ayer?.gastoRealApiUSD) : "No disponible"],
              ["Proyección mensual", control.costosDisponibles ? fmtUSD(costos?.proyeccionMensualUSD) : "No disponible"],
              ["Memoria", control.memoria?.ok ? `${control.memoria.filas} conversaciones · íntegra` : "Requiere revisión"],
            ].map(([titulo, valor]) => (
              <div key={titulo} style={{ padding: "11px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.voidSoft }}>
                <div style={{ fontFamily: C.mono, fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: "0.06em" }}>{titulo}</div>
                <div style={{ fontFamily: C.sans, fontSize: 15, color: C.cream, marginTop: 6 }}>{valor}</div>
              </div>
            ))}
          </div>

          <div className="control-detalle-grid">
            <div style={{ padding: 12, borderRadius: 9, border: `1px solid ${C.line}`, background: C.voidSoft }}>
              <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.dim, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                Gasto real · últimos 7 días
              </div>
              {serie.length > 0 ? (
                <div role="img" aria-label="Gráfico del gasto real de API durante los últimos siete días" style={{ display: "grid", gridTemplateColumns: `repeat(${serie.length}, minmax(24px, 1fr))`, gap: 7, height: 132, alignItems: "end", marginTop: 10 }}>
                  {serie.map((punto) => {
                    const costo = Number(punto.gastoRealApiUSD) || 0;
                    const altura = costo === 0 ? 3 : Math.max(8, (costo / maximoSerie) * 88);
                    return (
                      <div key={punto.fecha} title={`${punto.fecha}: ${fmtUSD(costo)} · ${punto.llamadas} llamada(s)`} style={{ minWidth: 0, textAlign: "center" }}>
                        <div style={{ fontFamily: C.mono, fontSize: 8.5, color: costo === maximoSerie ? C.amberBright : C.dim, overflow: "hidden" }}>
                          {costo > 0 ? costo.toFixed(1) : "0"}
                        </div>
                        <div style={{ height: 92, display: "flex", alignItems: "flex-end", justifyContent: "center", margin: "3px 0" }}>
                          <div style={{ width: "68%", maxWidth: 32, height: altura, minHeight: 3, borderRadius: "4px 4px 2px 2px", background: costo === maximoSerie ? C.amberBright : C.coreBright, opacity: costo === 0 ? 0.35 : 0.82 }} />
                        </div>
                        <div style={{ fontFamily: C.mono, fontSize: 8, color: C.dim }}>{fechaCorta(punto.fecha)}</div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontFamily: C.sans, fontSize: 11.5, color: C.dim, padding: "20px 0" }}>Sin serie disponible.</div>
              )}
            </div>

            <div style={{ padding: 12, borderRadius: 9, border: `1px solid ${C.line}`, background: C.voidSoft, overflowX: "auto" }}>
              <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.dim, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 9 }}>
                Qué generó el gasto de ayer
              </div>
              {procesos.length > 0 ? (
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: C.sans, fontSize: 10.5 }}>
                  <thead>
                    <tr style={{ color: C.dim, textAlign: "left" }}>
                      <th style={{ padding: "4px 5px", fontWeight: 500 }}>Proceso</th>
                      <th style={{ padding: "4px 5px", fontWeight: 500, textAlign: "right" }}>Llamadas</th>
                      <th style={{ padding: "4px 5px", fontWeight: 500, textAlign: "right" }}>Coste</th>
                    </tr>
                  </thead>
                  <tbody>
                    {procesos.map((proceso) => (
                      <tr key={proceso.proceso} style={{ borderTop: `1px solid ${C.line}` }}>
                        <td style={{ padding: "7px 5px", color: C.cream }}>
                          {etiquetaProceso(proceso.proceso)}
                          {totalAyer > 0 && <span style={{ color: C.dim }}> · {Math.round((proceso.gastoRealApiUSD / totalAyer) * 100)}%</span>}
                        </td>
                        <td style={{ padding: "7px 5px", color: C.dim, textAlign: "right", fontFamily: C.mono }}>{proceso.llamadas}</td>
                        <td style={{ padding: "7px 5px", color: C.amberBright, textAlign: "right", fontFamily: C.mono }}>{fmtUSD(proceso.gastoRealApiUSD)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ fontFamily: C.sans, fontSize: 11.5, color: C.dim, padding: "20px 0" }}>Ayer no hubo consumo atribuible.</div>
              )}
            </div>
          </div>

          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.dim, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                Recomendaciones priorizadas
              </div>
              <div style={{ fontFamily: C.mono, fontSize: 9, color: C.dim }}>
                política {control.politica?.killSwitch ? "kill switch" : control.politica?.modo} · {control.politica?.procesosPermitidos || 0} proceso(s) permitidos
              </div>
            </div>
            {recomendaciones.length === 0 ? (
              <div style={{ padding: "10px 12px", borderRadius: 8, border: `1px solid ${C.line}`, color: C.ok, fontFamily: C.sans, fontSize: 11.5 }}>
                No hay acciones urgentes. El control seguirá evaluando cada nuevo snapshot.
              </div>
            ) : (
              recomendaciones.map((recomendacion) => (
                <div key={recomendacion.id} className="control-recomendacion" style={{ alignItems: "start", gap: 10, padding: "10px 11px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.voidSoft }}>
                  <span style={{ marginTop: 2, padding: "3px 6px", borderRadius: 999, border: `1px solid ${prioridadColor[recomendacion.prioridad] || C.dim}`, color: prioridadColor[recomendacion.prioridad] || C.dim, fontFamily: C.mono, fontSize: 8, textTransform: "uppercase" }}>
                    {recomendacion.prioridad}
                  </span>
                  <span>
                    <span style={{ display: "block", color: C.cream, fontFamily: C.sans, fontSize: 12, fontWeight: 600 }}>{recomendacion.titulo}</span>
                    <span style={{ display: "block", color: C.dim, fontFamily: C.sans, fontSize: 10.5, marginTop: 3 }}>{recomendacion.detalle}</span>
                    <span style={{ display: "block", color: C.coreBright, fontFamily: C.sans, fontSize: 10.5, marginTop: 4 }}>{recomendacion.siguientePaso}</span>
                  </span>
                  <button type="button" onClick={() => onAbrir(recomendacion.modulo)} style={{ border: "none", background: "none", color: C.amberBright, fontFamily: C.mono, fontSize: 9.5, cursor: "pointer", padding: 3 }}>
                    Abrir →
                  </button>
                </div>
              ))
            )}
          </div>

          <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontFamily: C.mono, fontSize: 9, color: C.dim }}>Servicios:</span>
              {cargandoConexiones && !conexiones && <span style={{ fontFamily: C.sans, fontSize: 10.5, color: C.dim }}>comprobando…</span>}
              {errorConexiones && !conexiones && (
                <button type="button" onClick={() => onAbrir("conexiones")} style={{ border: "none", background: "none", padding: 0, color: C.dangerBright, fontFamily: C.sans, fontSize: 10, cursor: "pointer", textDecoration: "underline" }}>
                  estado no disponible · revisar conexiones
                </button>
              )}
              {Array.isArray(conexiones) && conexiones.map((conexion) => (
                <span key={conexion.id} title={conexion.ok ? `${conexion.nombre}: activo` : conexion.detalle} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: C.sans, fontSize: 9.5, color: conexion.ok ? C.dim : C.dangerBright }}>
                  <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: "50%", background: conexion.ok ? C.ok : C.dangerBright }} />
                  {conexion.nombre}
                </span>
              ))}
            </div>
            <span style={{ fontFamily: C.mono, fontSize: 8.5, color: C.dim }}>
              análisis determinista · 0 llamadas de IA · {timeAgo(control.generadoEn) || "ahora"}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

function useRadialLayout(count, radius) {
  return useMemo(() => {
    const rnd = seeded(7);
    return Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      const jitter = (rnd() - 0.5) * 18;
      return { x: 300 + (radius + jitter) * Math.cos(angle), y: 300 + (radius + jitter) * Math.sin(angle) };
    });
  }, [count, radius]);
}

/**
 * Posiciones de los módulos de UN grupo, en abanico alrededor del propio
 * ángulo del grupo (más lejos del núcleo que el grupo mismo) — pedido
 * explícito de Carlos: "necesito que todo se maneje en una sola pantalla...
 * si necesito que despliegue las tres, las tres deberían desplegar". Antes,
 * abrir un grupo REEMPLAZABA la vista de los 3 grupos por sus módulos (un
 * cambio de "pantalla" real, aunque técnicamente siguiera siendo el mismo
 * componente) — ahora los 3 grupos son SIEMPRE visibles y cada uno puede
 * abrir sus propios módulos como ramas adicionales, sin tapar a los demás.
 * Cada grupo tiene su propio sector angular (360°/3 = 120°) — un abanico de
 * 100° centrado en el ángulo del grupo dentro deja margen de sobra a los
 * grupos vecinos, así que los 3 pueden estar abiertos a la vez sin que sus
 * ramas se crucen.
 */
function useGroupBranchPositions(groupIndex, totalGroups, moduleCount) {
  return useMemo(() => {
    if (moduleCount === 0) return [];
    const baseAngle = (groupIndex / totalGroups) * Math.PI * 2 - Math.PI / 2;
    const outerRadius = 252;
    const fanRad = (100 * Math.PI) / 180;
    const rnd = seeded(11 + groupIndex);
    return Array.from({ length: moduleCount }, (_, i) => {
      const t = moduleCount === 1 ? 0 : i / (moduleCount - 1) - 0.5;
      const jitter = (rnd() - 0.5) * 8;
      const angle = baseAngle + t * fanRad;
      return { x: 300 + (outerRadius + jitter) * Math.cos(angle), y: 300 + (outerRadius + jitter) * Math.sin(angle) };
    });
  }, [groupIndex, totalGroups, moduleCount]);
}

/** Pantalla de acceso: pide la key directo al usuario, nunca queda guardada en el código. */
/**
 * Pantalla de acceso: en vez de pedir una clave directo, pide el nombre de
 * quien entra, manda la solicitud, y espera (por polling) a que un admin la
 * apruebe desde Telegram — con acceso temporal (24h) o la key maestra,
 * según decida el admin. Nunca guarda ninguna clave en el código del front.
 */
function KeyGate({ onUnlocked }) {
  const [nombre, setNombre] = useState("");
  const [fase, setFase] = useState("idle"); // idle | enviando | esperando | rechazado | vencido | error
  const [errMsg, setErrMsg] = useState("");
  const pollRef = useRef(null);

  const detenerPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => detenerPolling, []);

  const consultarSolicitud = useCallback(
    async (id) => {
      try {
        const res = await fetch(`${SOLICITUD_ENDPOINT_BASE}/${id}`);
        if (res.status === 404) {
          detenerPolling();
          setFase("vencido");
          return;
        }
        if (!res.ok) return; // error puntual — se reintenta en el próximo tick
        const json = await res.json();
        if (json.estado === "pendiente") return;

        detenerPolling();

        if (json.estado === "rechazado") {
          setFase("rechazado");
          return;
        }

        const resEstado = await fetch(CEREBRO_ENDPOINT, { headers: { "X-Cerebro-Key": json.token } });
        if (!resEstado.ok) {
          setFase("error");
          setErrMsg("Tu acceso fue aprobado pero hubo un error conectando. Recarga la página.");
          return;
        }
        const dataEstado = await resEstado.json();
        onUnlocked(dataEstado, json.token, nombre.trim());
      } catch {
        // error de red puntual — se reintenta en el próximo tick, no cambia de fase
      }
    },
    [onUnlocked, nombre]
  );

  const solicitarAcceso = async () => {
    if (!nombre.trim()) return;
    setFase("enviando");
    setErrMsg("");
    try {
      const res = await fetch(SOLICITAR_ACCESO_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre: nombre.trim() }),
      });
      if (!res.ok) {
        const detalle = await res.json().catch(() => null);
        setFase("error");
        setErrMsg(detalle?.error || "No se pudo enviar la solicitud. Intenta de nuevo.");
        return;
      }
      const { id } = await res.json();
      setFase("esperando");
      consultarSolicitud(id);
      pollRef.current = setInterval(() => consultarSolicitud(id), POLL_INTERVALO_MS);
    } catch {
      setFase("error");
      setErrMsg("No se pudo conectar al sistema. Revisa tu conexión e inténtalo de nuevo.");
    }
  };

  const reintentar = () => {
    detenerPolling();
    setFase("idle");
    setErrMsg("");
  };

  return (
    <div
      style={{
        position: "relative",
        maxWidth: 360,
        margin: "40px auto 0",
        textAlign: "center",
        animation: "panelIn 0.3s ease-out",
      }}
    >
      <WobiAvatar className="wobi-portrait--gate" />
      <div style={{ fontSize: 24, color: C.cream, marginBottom: 20 }}>WOBi</div>
      {(fase === "idle" || fase === "enviando" || fase === "error") && (
        <>
          <div style={{ fontFamily: C.mono, fontSize: 10.5, letterSpacing: "0.1em", color: C.dim, textTransform: "uppercase", marginBottom: 10 }}>
            acceso al estado en vivo
          </div>
          <input
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && solicitarAcceso()}
            placeholder="¿quién eres?"
            style={{
              width: "100%",
              background: C.voidSoft,
              border: `1px solid ${fase === "error" ? C.amber : C.line}`,
              borderRadius: 8,
              padding: "11px 14px",
              color: C.cream,
              fontFamily: C.mono,
              fontSize: 13,
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          <button
            onClick={solicitarAcceso}
            disabled={fase === "enviando"}
            style={{
              marginTop: 12,
              width: "100%",
              background: fase === "enviando" ? C.voidSoft : C.core,
              color: C.cream,
              border: "none",
              borderRadius: 8,
              padding: "11px 14px",
              fontFamily: C.sans,
              fontWeight: 600,
              fontSize: 13,
              cursor: fase === "enviando" ? "default" : "pointer",
            }}
          >
            {fase === "enviando" ? "Enviando solicitud…" : "Solicitar acceso"}
          </button>
          {fase === "error" && (
            <div style={{ marginTop: 10, fontFamily: C.sans, fontSize: 12, color: C.amberBright }}>{errMsg}</div>
          )}
        </>
      )}

      {fase === "esperando" && (
        <>
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: C.amberBright,
              margin: "0 auto 14px",
              animation: "ctaPulse 1.4s ease-in-out infinite",
            }}
          />
          <div style={{ fontFamily: C.sans, fontSize: 13, color: C.cream }}>
            Esperando aprobación de un administrador…
          </div>
          <div style={{ fontFamily: C.mono, fontSize: 10.5, color: C.dim, marginTop: 8 }}>
            Avisamos a los administradores por Telegram para que revisen el acceso de {nombre.trim()}.
          </div>
        </>
      )}

      {fase === "rechazado" && (
        <>
          <div style={{ fontFamily: C.sans, fontSize: 13, color: C.cream }}>Tu solicitud fue rechazada.</div>
          <button
            onClick={reintentar}
            style={{
              marginTop: 14,
              background: "none",
              color: C.amberBright,
              border: `1px solid ${C.amber}`,
              borderRadius: 8,
              padding: "9px 16px",
              fontFamily: C.mono,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Intentar de nuevo
          </button>
        </>
      )}

      {fase === "vencido" && (
        <>
          <div style={{ fontFamily: C.sans, fontSize: 13, color: C.cream }}>
            Tu solicitud venció sin respuesta.
          </div>
          <button
            onClick={reintentar}
            style={{
              marginTop: 14,
              background: "none",
              color: C.amberBright,
              border: `1px solid ${C.amber}`,
              borderRadius: 8,
              padding: "9px 16px",
              fontFamily: C.mono,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Solicitar de nuevo
          </button>
        </>
      )}
    </div>
  );
}

function EntryScreen({ onEnter, diving }) {
  const [speaking, setSpeaking] = useState(false);
  return (
    <section className="wobi-entry" aria-label="Bienvenida de WOBi"
      style={{ animation: diving ? "diveIn 1.15s cubic-bezier(.55,0,.85,.35) forwards" : undefined }}>
      <div className="wobi-entry__layout" inert={diving}>
        <WobiAvatar className="wobi-entry__portrait" speaking={speaking} assemble />
        <div className="wobi-entry__copy">
          <div className="wobi-entry__eyebrow">WOBA Group</div>
          <h1>WOBi</h1>
          <p className="wobi-entry__intro">Tu asistente de inteligencia artificial.<br />Listo para trabajar contigo.</p>
          <button type="button" className="wobi-button" onClick={onEnter} disabled={diving}>
            {diving ? "Entrando…" : "Entrar al espacio de trabajo"}
          </button>
          <WobiVoice onSpeakingChange={setSpeaking} />
        </div>
      </div>
    </section>
  );
}

function formatoRestante(expiraEnMs) {
  const diffMs = expiraEnMs - Date.now();
  if (diffMs <= 0) return "vencido";
  const horas = Math.floor(diffMs / 3600000);
  const mins = Math.round((diffMs % 3600000) / 60000);
  if (horas < 1) return `vence en ${mins} min`;
  return `vence en ${horas}h ${mins}min`;
}

/** Bloque clicable simple para expandir/colapsar una lista de detalle dentro de un panel. */
function Desplegable({ titulo, abierto, onToggle, children }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div onClick={onToggle} style={{ display: "flex", alignItems: "center", padding: "5px 0", cursor: "pointer" }}>
        <span style={{ fontFamily: C.sans, fontSize: 12, color: C.amberBright }}>
          {abierto ? "▾" : "▸"} {titulo}
        </span>
      </div>
      {abierto && <div style={{ paddingLeft: 8, borderLeft: `1px solid ${C.line}` }}>{children}</div>}
    </div>
  );
}

/**
 * Solo se muestra si el token con el que se entró es la key maestra (ver
 * el probe en CerebroWoba) — lista los accesos temporales vigentes y deja
 * revocarlos. La key maestra en sí no aparece aquí: es un secreto
 * compartido, no hay una fila por titular que revocar individualmente.
 */
function AdminPanel({ apiKey, actualizacionId }) {
  const [activos, setActivos] = useState(null);
  const [otorgados, setOtorgados] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [revocandoId, setRevocandoId] = useState(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const [resActivos, resOtorgados] = await Promise.all([
        fetch(ACCESOS_ACTIVOS_ENDPOINT, { headers: { "X-Cerebro-Key": apiKey } }),
        fetch(ACCESOS_MAESTRO_OTORGADOS_ENDPOINT, { headers: { "X-Cerebro-Key": apiKey } }),
      ]);
      if (resActivos.ok) setActivos((await resActivos.json()).activos || []);
      if (resOtorgados.ok) setOtorgados((await resOtorgados.json()).otorgados || []);
    } catch {
      // silencioso — se reintenta al pulsar "actualizar"
    } finally {
      setCargando(false);
    }
  }, [apiKey]);

  useEffect(() => {
    cargar();
  }, [cargar, actualizacionId]);

  const revocar = async (id) => {
    setRevocandoId(id);
    try {
      await fetch(REVOCAR_ACCESO_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cerebro-Key": apiKey },
        body: JSON.stringify({ id }),
      });
      await cargar();
    } catch {
      // silencioso — el usuario puede reintentar
    } finally {
      setRevocandoId(null);
    }
  };

  return (
    <div
      style={{
        maxWidth: 560,
        margin: "20px auto 0",
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 10,
        padding: "16px 18px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontFamily: C.mono, fontSize: 10.5, letterSpacing: "0.08em", color: C.coreBright, textTransform: "uppercase" }}>
          🔐 Accesos activos
        </div>
        <span
          onClick={cargando ? undefined : cargar}
          style={{ fontFamily: C.mono, fontSize: 10.5, color: C.dim, cursor: cargando ? "default" : "pointer", textDecoration: "underline" }}
        >
          {cargando ? "actualizando…" : "actualizar"}
        </span>
      </div>

      {activos === null && <div style={{ fontFamily: C.sans, fontSize: 12, color: C.dim, marginTop: 10 }}>Cargando…</div>}

      {activos !== null && activos.length === 0 && (
        <div style={{ fontFamily: C.sans, fontSize: 12, color: C.dim, marginTop: 10 }}>
          Nadie tiene un acceso temporal vigente ahora mismo.
        </div>
      )}

      {activos !== null && activos.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {activos.map((a) => (
            <div
              key={a.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 0",
                borderTop: `1px solid ${C.line}`,
              }}
            >
              <div>
                <div style={{ fontFamily: C.sans, fontSize: 12.5, color: C.cream }}>{a.nombre}</div>
                <div style={{ fontFamily: C.mono, fontSize: 10, color: C.dim, marginTop: 2 }}>{formatoRestante(a.expiraEn)}</div>
              </div>
              <button
                onClick={() => revocar(a.id)}
                disabled={revocandoId === a.id}
                style={{
                  background: "none",
                  border: `1px solid ${C.amber}`,
                  color: C.amberBright,
                  borderRadius: 6,
                  padding: "5px 10px",
                  fontFamily: C.mono,
                  fontSize: 10.5,
                  cursor: revocandoId === a.id ? "default" : "pointer",
                }}
              >
                {revocandoId === a.id ? "revocando…" : "revocar"}
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 18, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
        <div style={{ fontFamily: C.mono, fontSize: 10.5, letterSpacing: "0.08em", color: C.coreBright, textTransform: "uppercase" }}>
          🔑 Con la key maestra (histórico)
        </div>
        <div style={{ fontFamily: C.sans, fontSize: 11, color: C.dim, marginTop: 4 }}>
          Acceso permanente, no un token de 24h — no se puede revocar a una persona individual, solo rotando toda la key.
        </div>

        {otorgados === null && <div style={{ fontFamily: C.sans, fontSize: 12, color: C.dim, marginTop: 10 }}>Cargando…</div>}

        {otorgados !== null && otorgados.length === 0 && (
          <div style={{ fontFamily: C.sans, fontSize: 12, color: C.dim, marginTop: 10 }}>
            Nadie ha recibido la key maestra por este flujo todavía.
          </div>
        )}

        {otorgados !== null && otorgados.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {otorgados.map((o, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: `1px solid ${C.line}` }}>
                <span style={{ fontFamily: C.sans, fontSize: 12.5, color: C.cream }}>{o.nombre}</span>
                <span style={{ fontFamily: C.mono, fontSize: 10, color: C.dim }}>{timeAgo(o.otorgadoEn)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Gestión de admins/colaboradores — cambiar rol o quitar acceso, desde
 * /cerebro con la key maestra. Antes solo se podía dar de alta desde los
 * botones que llegan a Telegram al escribirle el bot por primera vez; no
 * había forma de reasignar rol ni quitar acceso ya dado sin entrar al
 * Sheet a mano.
 */
function UsuariosPanel({ apiKey, actualizacionId }) {
  const [usuarios, setUsuarios] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [ocupadoId, setOcupadoId] = useState(null);
  const [error, setError] = useState(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await fetch(USUARIOS_AUTORIZADOS_ENDPOINT, { headers: { "X-Cerebro-Key": apiKey } });
      if (res.ok) {
        const json = await res.json();
        setUsuarios(json.usuarios || []);
      } else {
        setError("No se pudo cargar la lista.");
      }
    } catch {
      setError("No se pudo cargar la lista.");
    } finally {
      setCargando(false);
    }
  }, [apiKey]);

  useEffect(() => {
    cargar();
  }, [cargar, actualizacionId]);

  const cambiarRol = async (userId, rol) => {
    setOcupadoId(userId);
    try {
      const res = await fetch(CAMBIAR_ROL_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cerebro-Key": apiKey },
        body: JSON.stringify({ userId, rol }),
      });
      if (res.ok) await cargar();
      else setError("No se pudo cambiar el rol.");
    } catch {
      setError("No se pudo cambiar el rol.");
    } finally {
      setOcupadoId(null);
    }
  };

  const eliminar = async (userId, nombre) => {
    if (!window.confirm(`¿Quitar el acceso de ${nombre || "esta persona"}? Va a dejar de poder usar el asistente.`)) return;
    setOcupadoId(userId);
    try {
      const res = await fetch(ELIMINAR_USUARIO_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cerebro-Key": apiKey },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) await cargar();
      else setError("No se pudo quitar el acceso.");
    } catch {
      setError("No se pudo quitar el acceso.");
    } finally {
      setOcupadoId(null);
    }
  };

  return (
    <div
      style={{
        maxWidth: 560,
        margin: "20px auto 0",
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 10,
        padding: "16px 18px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontFamily: C.mono, fontSize: 10.5, letterSpacing: "0.08em", color: C.coreBright, textTransform: "uppercase" }}>
          👥 Admins / colaboradores
        </div>
        <span
          onClick={cargando ? undefined : cargar}
          style={{ fontFamily: C.mono, fontSize: 10.5, color: C.dim, cursor: cargando ? "default" : "pointer", textDecoration: "underline" }}
        >
          {cargando ? "actualizando…" : "actualizar"}
        </span>
      </div>

      {error && <div style={{ fontFamily: C.sans, fontSize: 12, color: C.amberBright, marginTop: 10 }}>{error}</div>}

      {usuarios === null && !error && <div style={{ fontFamily: C.sans, fontSize: 12, color: C.dim, marginTop: 10 }}>Cargando…</div>}

      {usuarios !== null && usuarios.length === 0 && (
        <div style={{ fontFamily: C.sans, fontSize: 12, color: C.dim, marginTop: 10 }}>Nadie autorizado todavía.</div>
      )}

      {usuarios !== null && usuarios.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {usuarios.map((u) => (
            <div
              key={u.userId}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 0",
                borderTop: `1px solid ${C.line}`,
                gap: 8,
              }}
            >
              <div>
                <div style={{ fontFamily: C.sans, fontSize: 12.5, color: C.cream }}>{u.nombre || "(sin nombre)"}</div>
                <div style={{ fontFamily: C.mono, fontSize: 10, color: C.dim, marginTop: 2 }}>
                  autorizado {u.autorizadoEn ? new Date(u.autorizadoEn).toLocaleDateString("es-ES") : "—"}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <select
                  value={u.rol}
                  disabled={ocupadoId === u.userId}
                  onChange={(e) => cambiarRol(u.userId, e.target.value)}
                  style={{
                    background: C.void,
                    color: C.cream,
                    border: `1px solid ${C.line}`,
                    borderRadius: 6,
                    padding: "5px 6px",
                    fontFamily: C.mono,
                    fontSize: 10.5,
                  }}
                >
                  <option value="superadmin">superadmin</option>
                  <option value="admin">admin</option>
                  <option value="colaborador">colaborador</option>
                </select>
                <button
                  onClick={() => eliminar(u.userId, u.nombre)}
                  disabled={ocupadoId === u.userId}
                  style={{
                    background: "none",
                    border: `1px solid ${C.amber}`,
                    color: C.amberBright,
                    borderRadius: 6,
                    padding: "5px 10px",
                    fontFamily: C.mono,
                    fontSize: 10.5,
                    cursor: ocupadoId === u.userId ? "default" : "pointer",
                  }}
                >
                  {ocupadoId === u.userId ? "…" : "quitar"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Estado en vivo de las conexiones externas (Telegram, Claude, Google
 * Sheets/Drive/Gmail, Holded x3) — lo primero visible del panel, para que
 * una conexión caída se note de inmediato en vez de descubrirse cuando algo
 * falla a mitad de una tarea. Cada conexión rota trae su propio botón de
 * "arreglar": el usuario solo pulsa, el sistema hace lo necesario detrás
 * (reintentar, o para Telegram, re-registrar el webhook) — nunca requiere
 * que el usuario sepa qué es un webhook o una API key.
 */
/**
 * Contenido del nodo "Conexiones" — antes vivía como una barra propia,
 * siempre visible, encima de la constelación. Pedido explícito de Carlos:
 * "el tema de conexiones activas que se ven arriba debería ser una bola o
 * un botón de estos... que no creemos un menú adicional, sino que todo
 * sean las neuronas". Ahora solo existe DENTRO del panel de detalle del
 * nodo — se monta (y sondea) únicamente mientras ese nodo está abierto.
 */
function ConexionesContenido({ apiKey, puedeArreglar }) {
  const [conexiones, setConexiones] = useState(null);
  const [arreglandoId, setArreglandoId] = useState(null);

  const cargar = useCallback(() => {
    if (!apiKey) return;
    fetch(CONEXIONES_ENDPOINT, { headers: { "X-Cerebro-Key": apiKey } })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json?.conexiones) setConexiones(json.conexiones);
      })
      .catch(() => {
        // silencioso: si falla el chequeo del chequeo, se sigue mostrando el último dato bueno
      });
  }, [apiKey]);

  useEffect(() => {
    cargar();
    const id = setInterval(cargar, CONEXIONES_POLL_MS);
    return () => clearInterval(id);
  }, [cargar]);

  const arreglar = async (id) => {
    if (!apiKey || arreglandoId) return;
    setArreglandoId(id);
    try {
      const res = await fetch(ARREGLAR_CONEXION_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cerebro-Key": apiKey },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        const json = await res.json();
        if (json?.conexion) {
          setConexiones((prev) => (prev ? prev.map((c) => (c.id === id ? json.conexion : c)) : prev));
        }
      }
    } catch {
      // silencioso: el chip se queda en rojo, el usuario puede volver a intentar
    } finally {
      setArreglandoId(null);
    }
  };

  if (!conexiones) {
    return <div style={{ fontFamily: C.mono, fontSize: 10.5, color: C.dim, marginTop: 14 }}>cargando estado…</div>;
  }

  const caidas = conexiones.filter((c) => !c.ok);
  const todoBien = caidas.length === 0;

  return (
    <div style={{ marginTop: 16, borderTop: `1px solid ${C.line}`, paddingTop: 12 }}>
      <div style={{ fontFamily: C.mono, fontSize: 10.5, color: todoBien ? C.ok : C.dangerBright, marginBottom: 8 }}>
        {todoBien ? `Todo activo (${conexiones.length}/${conexiones.length})` : `${caidas.length} con problemas`}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {conexiones.map((c) => (
          <div
            key={c.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              padding: "6px 10px",
              background: C.voidSoft,
              borderRadius: 6,
              border: `1px solid ${c.ok ? C.line : C.danger}`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: c.ok ? C.ok : C.dangerBright,
                  flexShrink: 0,
                }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: C.sans, fontSize: 12, color: C.cream }}>{c.nombre}</div>
                {!c.ok && c.detalle && (
                  <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.dim, marginTop: 2, wordBreak: "break-word" }}>
                    {c.detalle}
                  </div>
                )}
              </div>
            </div>
            {!c.ok && c.accionLabel && puedeArreglar && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  arreglar(c.id);
                }}
                disabled={arreglandoId === c.id}
                style={{
                  flexShrink: 0,
                  background: "none",
                  border: `1px solid ${C.dangerBright}`,
                  color: C.dangerBright,
                  borderRadius: 6,
                  padding: "5px 10px",
                  fontFamily: C.mono,
                  fontSize: 10.5,
                  cursor: arreglandoId === c.id ? "default" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {arreglandoId === c.id ? "arreglando…" : c.accionLabel}
              </button>
            )}
            {!c.ok && c.accionLabel && !puedeArreglar && (
              <span style={{ flexShrink: 0, fontFamily: C.mono, fontSize: 9.5, color: C.dim }}>requiere admin</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Contenido del nodo "Búsqueda Web" — mismo motivo que ConexionesContenido: deja de ser una barra propia, ahora vive dentro del panel de detalle de su nodo. */
function BusquedaWebContenido({ apiKey }) {
  const [resumen, setResumen] = useState(null);
  const [recientes, setRecientes] = useState(null);
  const [query, setQuery] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [error, setError] = useState(null);

  const cargar = useCallback(() => {
    if (!apiKey) return;
    fetch(BUSQUEDA_WEB_ENDPOINT, { headers: { "X-Cerebro-Key": apiKey } })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json?.resumen) setResumen(json.resumen);
        if (json?.recientes) setRecientes(json.recientes);
      })
      .catch(() => {
        // silencioso: si falla el refresco, se sigue mostrando el último dato bueno
      });
  }, [apiKey]);

  useEffect(() => {
    cargar();
    const id = setInterval(cargar, CONEXIONES_POLL_MS);
    return () => clearInterval(id);
  }, [cargar]);

  const buscar = async () => {
    const q = query.trim();
    if (!apiKey || !q || buscando) return;
    setBuscando(true);
    setError(null);
    setResultado(null);
    try {
      const res = await fetch(BUSCAR_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cerebro-Key": apiKey },
        body: JSON.stringify({ query: q }),
      });
      if (res.ok) {
        const json = await res.json();
        setResultado(json);
        setQuery("");
        cargar();
      } else {
        const json = await res.json().catch(() => null);
        setError(json?.error || "No se pudo completar la búsqueda.");
      }
    } catch {
      setError("No se pudo conectar con el servidor.");
    } finally {
      setBuscando(false);
    }
  };

  if (!resumen || !recientes) {
    return <div style={{ fontFamily: C.mono, fontSize: 10.5, color: C.dim, marginTop: 14 }}>cargando historial…</div>;
  }

  return (
    <div style={{ marginTop: 16, borderTop: `1px solid ${C.line}`, paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontFamily: C.mono, fontSize: 10.5, color: C.dim }}>
        {resumen.totalBusquedas} búsqueda{resumen.totalBusquedas === 1 ? "" : "s"} · {fmtUSD(resumen.costoTotalUSD)}
        {resumen.busquedasHoy > 0 ? ` · hoy: ${resumen.busquedasHoy}` : ""}
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") buscar();
          }}
          placeholder="Buscar en internet…"
          disabled={buscando}
          style={{
            flex: 1,
            minWidth: 0,
            background: C.voidSoft,
            border: `1px solid ${C.line}`,
            borderRadius: 6,
            padding: "7px 10px",
            color: C.cream,
            fontFamily: C.sans,
            fontSize: 12,
            outline: "none",
          }}
        />
        <button
          onClick={buscar}
          disabled={buscando || !query.trim()}
          style={{
            flexShrink: 0,
            background: "none",
            border: `1px solid ${C.amber}`,
            color: C.amberBright,
            borderRadius: 6,
            padding: "7px 14px",
            fontFamily: C.mono,
            fontSize: 10.5,
            cursor: buscando || !query.trim() ? "default" : "pointer",
            opacity: buscando || !query.trim() ? 0.5 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {buscando ? "buscando…" : "buscar"}
        </button>
      </div>

      {error && <div style={{ fontFamily: C.mono, fontSize: 10.5, color: C.dangerBright }}>{error}</div>}

      {resultado && (
        <div
          style={{
            background: C.voidSoft,
            border: `1px solid ${C.line}`,
            borderRadius: 6,
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ fontFamily: C.sans, fontSize: 12.5, color: C.cream, whiteSpace: "pre-wrap" }}>
            {resultado.respuesta}
          </div>
          {resultado.citas?.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {resultado.citas.map((cita, i) => (
                <a
                  key={i}
                  href={cita.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontFamily: C.mono, fontSize: 10, color: C.coreBright, wordBreak: "break-word" }}
                >
                  {cita.title || cita.url}
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {recientes.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.dim, letterSpacing: "0.04em" }}>RECIENTES</div>
          {recientes.map((r, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "5px 10px",
                background: C.voidSoft,
                borderRadius: 6,
                border: `1px solid ${C.line}`,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: C.sans, fontSize: 11.5, color: C.cream, wordBreak: "break-word" }}>{r.query}</div>
                <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.dim, marginTop: 2 }}>
                  {timeAgo(r.fecha)} · {r.origen === "panel" ? "desde el panel" : "desde el chat"}
                </div>
              </div>
              <div style={{ flexShrink: 0, fontFamily: C.mono, fontSize: 10, color: C.dim }}>{fmtUSD(r.costoUSD)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Contenido del nodo "Calendario" — pedido explícito de Carlos: "me
 * muestre un pequeño calendario en donde vea si hay cosas programadas".
 * Mes actual, con un punto en cada día que tiene una acción programada por
 * fecha; debajo, las de tipo condición (sin fecha fija) por separado.
 */
function MiniCalendario({ apiKey, actualizacionId }) {
  const [pendientes, setPendientes] = useState(null);
  const [mesOffset, setMesOffset] = useState(0);

  useEffect(() => {
    if (!apiKey) return;
    fetch(ACCIONES_PROGRAMADAS_ENDPOINT, { headers: { "X-Cerebro-Key": apiKey } })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json?.pendientes) setPendientes(json.pendientes);
      })
      .catch(() => {
        // silencioso: si falla, se sigue mostrando el último dato bueno (o el estado de carga)
      });
  }, [apiKey, actualizacionId]);

  if (!pendientes) {
    return <div style={{ fontFamily: C.mono, fontSize: 10.5, color: C.dim, marginTop: 14 }}>cargando cola…</div>;
  }

  const porFecha = pendientes.filter((a) => a.tipo === "fecha" && a.fechaObjetivo);
  const porCondicion = pendientes.filter((a) => a.tipo === "condicion");

  const hoy = new Date();
  const base = new Date(hoy.getFullYear(), hoy.getMonth() + mesOffset, 1);
  const anio = base.getFullYear();
  const mes = base.getMonth();
  const nombreMesCrudo = base.toLocaleDateString("es-ES", { month: "long" });
  const nombreMes = `${nombreMesCrudo.charAt(0).toUpperCase()}${nombreMesCrudo.slice(1)} ${anio}`;
  const primerDiaSemana = (new Date(anio, mes, 1).getDay() + 6) % 7; // lunes=0
  const diasEnMes = new Date(anio, mes + 1, 0).getDate();

  const itemsPorDia = {};
  porFecha.forEach((a) => {
    const f = new Date(a.fechaObjetivo);
    if (f.getFullYear() === anio && f.getMonth() === mes) {
      const dia = f.getDate();
      (itemsPorDia[dia] = itemsPorDia[dia] || []).push(a);
    }
  });

  const celdas = [];
  for (let i = 0; i < primerDiaSemana; i++) celdas.push(null);
  for (let d = 1; d <= diasEnMes; d++) celdas.push(d);

  const esHoy = (d) => d === hoy.getDate() && mes === hoy.getMonth() && anio === hoy.getFullYear();

  return (
    <div style={{ marginTop: 16, borderTop: `1px solid ${C.line}`, paddingTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <button
          onClick={() => setMesOffset((v) => v - 1)}
          style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 13, padding: 4 }}
        >
          ‹
        </button>
        <div style={{ fontFamily: C.mono, fontSize: 11, color: C.cream }}>{nombreMes}</div>
        <button
          onClick={() => setMesOffset((v) => v + 1)}
          style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 13, padding: 4 }}
        >
          ›
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 4 }}>
        {["L", "M", "X", "J", "V", "S", "D"].map((d, i) => (
          <div key={i} style={{ textAlign: "center", fontFamily: C.mono, fontSize: 9.5, color: C.dim }}>
            {d}
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
        {celdas.map((d, i) => (
          <div
            key={i}
            style={{
              aspectRatio: "1",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 5,
              background: d && esHoy(d) ? "rgba(232, 167, 92, 0.18)" : "transparent",
              border: d && esHoy(d) ? `1px solid ${C.amber}` : "1px solid transparent",
            }}
          >
            {d && (
              <>
                <span style={{ fontFamily: C.sans, fontSize: 10.5, color: itemsPorDia[d] ? C.cream : C.dim }}>{d}</span>
                {itemsPorDia[d] && (
                  <span
                    style={{
                      width: 4,
                      height: 4,
                      borderRadius: "50%",
                      background: C.amberBright,
                      boxShadow: `0 0 4px ${C.amberBright}`,
                      marginTop: 1,
                    }}
                  />
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {porFecha.length === 0 && porCondicion.length === 0 ? (
        <div style={{ fontFamily: C.sans, fontSize: 11.5, color: C.dim, marginTop: 12 }}>Nada programado por ahora.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 12 }}>
          {porFecha.length > 0 && (
            <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.dim, letterSpacing: "0.04em" }}>CON FECHA</div>
          )}
          {porFecha
            .sort((a, b) => (a.fechaObjetivo > b.fechaObjetivo ? 1 : -1))
            .map((a) => (
              <div key={a.id} style={{ padding: "5px 10px", background: C.voidSoft, borderRadius: 6, border: `1px solid ${C.line}` }}>
                <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.amberBright }}>{a.fechaObjetivo.replace("T", " ")}</div>
                <div style={{ fontFamily: C.sans, fontSize: 11.5, color: C.cream, marginTop: 1 }}>{a.contexto}</div>
              </div>
            ))}
          {porCondicion.length > 0 && (
            <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.dim, letterSpacing: "0.04em", marginTop: 4 }}>
              A LA ESPERA DE UNA CONDICIÓN
            </div>
          )}
          {porCondicion.map((a) => (
            <div key={a.id} style={{ padding: "5px 10px", background: C.voidSoft, borderRadius: 6, border: `1px solid ${C.line}` }}>
              <div style={{ fontFamily: C.sans, fontSize: 11.5, color: C.cream }}>{a.contexto}</div>
              <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.dim, marginTop: 1 }}>{a.condicion}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function obtenerDeviceIdChat() {
  const guardado = localStorage.getItem(LOCALSTORAGE_DEVICE_KEY);
  if (guardado && /^[a-zA-Z0-9_-]{16,128}$/.test(guardado)) return guardado;
  const nuevo = window.crypto?.randomUUID?.().replaceAll("-", "") || `device_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(LOCALSTORAGE_DEVICE_KEY, nuevo);
  return nuevo;
}

function parsearNumeroVisual(valor) {
  let limpio = String(valor || "").replace(/[^0-9,.-]/g, "");
  if (!limpio || limpio === "-") return null;
  if (limpio.includes(",") && limpio.includes(".")) {
    limpio = limpio.lastIndexOf(",") > limpio.lastIndexOf(".")
      ? limpio.replaceAll(".", "").replace(",", ".")
      : limpio.replaceAll(",", "");
  } else if (limpio.includes(",")) {
    limpio = limpio.replace(",", ".");
  }
  const numero = Number(limpio);
  return Number.isFinite(numero) ? numero : null;
}

function separarCeldaTabla(linea) {
  return linea.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((celda) => celda.trim());
}

function bloquesRespuesta(texto) {
  const lineas = String(texto || "").split("\n");
  const bloques = [];
  let textoActual = [];
  const vaciarTexto = () => {
    const contenido = textoActual.join("\n").trim();
    if (contenido) bloques.push({ tipo: "texto", contenido });
    textoActual = [];
  };

  for (let i = 0; i < lineas.length; i++) {
    const pareceTabla = lineas[i].trim().startsWith("|") && /^\s*\|?\s*:?-{3,}/.test(lineas[i + 1] || "");
    if (!pareceTabla) {
      textoActual.push(lineas[i]);
      continue;
    }
    vaciarTexto();
    const cabeceras = separarCeldaTabla(lineas[i]);
    i += 2;
    const filas = [];
    while (i < lineas.length && lineas[i].trim().startsWith("|")) {
      filas.push(separarCeldaTabla(lineas[i]));
      i++;
    }
    i--;
    bloques.push({ tipo: "tabla", cabeceras, filas });
  }
  vaciarTexto();
  return bloques;
}

function TablaRespuesta({ bloque }) {
  const serie = bloque.filas
    .map((fila) => ({ etiqueta: fila[0], valor: parsearNumeroVisual(fila[fila.length - 1]) }))
    .filter((item) => item.etiqueta && item.valor !== null);
  const maximo = Math.max(0, ...serie.map((item) => Math.abs(item.valor)));
  const mostrarGrafico = serie.length >= 2 && serie.length <= 10 && maximo > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: C.sans, fontSize: 11.5 }}>
          <thead>
            <tr style={{ background: "rgba(143,210,245,.08)", color: C.coreBright }}>
              {bloque.cabeceras.map((cabecera, i) => (
                <th key={i} style={{ padding: "7px 8px", textAlign: i === 0 ? "left" : "right", fontWeight: 600 }}>{cabecera}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bloque.filas.map((fila, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${C.line}`, color: C.cream }}>
                {fila.map((celda, j) => (
                  <td key={j} style={{ padding: "7px 8px", textAlign: j === 0 ? "left" : "right" }}>{celda}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mostrarGrafico && (
        <div aria-label="Gráfico generado a partir de la tabla" style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {serie.map((item) => (
            <div key={item.etiqueta} style={{ display: "grid", gridTemplateColumns: "minmax(70px, .8fr) 2fr auto", gap: 7, alignItems: "center" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: C.sans, fontSize: 10.5, color: C.dim }}>{item.etiqueta}</span>
              <span style={{ height: 7, borderRadius: 5, background: "rgba(143,210,245,.1)", overflow: "hidden" }}>
                <span style={{ display: "block", width: `${Math.max(2, Math.abs(item.valor) / maximo * 100)}%`, height: "100%", background: C.coreBright, borderRadius: 5 }} />
              </span>
              <span style={{ fontFamily: C.mono, fontSize: 9.5, color: C.cream }}>{item.valor.toLocaleString("es-ES")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ContenidoRespuesta({ texto }) {
  return bloquesRespuesta(texto).map((bloque, i) =>
    bloque.tipo === "tabla" ? (
      <TablaRespuesta key={i} bloque={bloque} />
    ) : (
      <div key={i} style={{ whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{bloque.contenido}</div>
    )
  );
}

export function WobiChat({ apiKey, nombreUsuario, revisionTiempoReal }) {
  const [abierto, setAbierto] = useState(false);
  const [mensajes, setMensajes] = useState([]);
  const [identidad, setIdentidad] = useState(null);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState("");
  const [codigoVinculo, setCodigoVinculo] = useState(null);
  const [escuchando, setEscuchando] = useState(false);
  const [leerRespuestas, setLeerRespuestas] = useState(() => localStorage.getItem(LOCALSTORAGE_VOZ_KEY) === "1");
  const [vozPendiente, setVozPendiente] = useState(false);
  const [estadoVoz, setEstadoVoz] = useState("idle");
  const audioChatRef = useRef(null);
  const ultimaLocucionRef = useRef("");
  const lectorVoz = useMemo(() => createWobiSpeech({
    makeAudio: () => audioChatRef.current,
    onStateChange: setEstadoVoz,
  }), []);
  const vozActivaRef = useRef(false);
  vozActivaRef.current = leerRespuestas && abierto;
  const [deviceId] = useState(obtenerDeviceIdChat);
  const mensajesRef = useRef(null);
  const recognitionRef = useRef(null);
  const enviandoRef = useRef(false);
  const SpeechRecognition = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

  const headers = useMemo(() => ({
    "X-Cerebro-Key": apiKey,
    "X-Cerebro-Nombre": encodeURIComponent(nombreUsuario || ""),
    "X-Cerebro-Device": deviceId,
  }), [apiKey, nombreUsuario, deviceId]);

  const cargarChat = useCallback(async () => {
    if (!apiKey) return;
    try {
      const res = await fetch(CHAT_ENDPOINT, { headers, cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      setMensajes(Array.isArray(json.mensajes) ? json.mensajes : []);
      setIdentidad(json.identidad || null);
      if (json.identidad?.vinculadaTelegram) setCodigoVinculo(null);
    } catch {
      // El último historial bueno continúa visible durante una reconexión.
    }
  }, [apiKey, headers]);

  useEffect(() => {
    // La misma señal SSE que refresca el cerebro también actualiza el
    // historial abierto. Así un mensaje enviado por Telegram aparece aquí
    // sin recargar el navegador ni mantener un segundo stream.
    if (abierto) cargarChat();
  }, [abierto, cargarChat, revisionTiempoReal]);

  useEffect(() => {
    if (!codigoVinculo) return undefined;
    const id = setInterval(cargarChat, 3000);
    return () => clearInterval(id);
  }, [codigoVinculo, cargarChat]);

  useEffect(() => {
    const nodo = mensajesRef.current;
    if (nodo) nodo.scrollTop = nodo.scrollHeight;
  }, [mensajes, enviando]);

  useEffect(() => () => {
    recognitionRef.current?.stop?.();
    lectorVoz.stop();
  }, [lectorVoz]);

  useEffect(() => {
    if (leerRespuestas && abierto) return;
    lectorVoz.stop();
    setVozPendiente(false);
  }, [leerRespuestas, abierto, lectorVoz]);

  useEffect(() => {
    const onHidden = () => {
      if (document.hidden) { lectorVoz.stop(); setVozPendiente(false); }
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [lectorVoz]);

  useEffect(() => { if (estadoVoz === "playing") setVozPendiente(false); }, [estadoVoz]);

  const hablar = useCallback((respuesta, manual = false) => {
    if ((!manual && !vozActivaRef.current) || document.hidden || !respuesta) return;
    ultimaLocucionRef.current = respuesta;
    setError("");
    setVozPendiente(false);
    lectorVoz.speak(respuesta, headers, () => setVozPendiente(true))
      .catch(() => { setVozPendiente(false); setError("No se pudo reproducir la voz de WOBi. La respuesta sigue disponible por escrito."); });
  }, [headers, lectorVoz]);

  const enviarConReintento = useCallback(async (messageId, contenido) => {
    let ultimoError;
    for (let intento = 0; intento < 3; intento++) {
      try {
        const res = await fetch(CHAT_ENDPOINT, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ messageId, texto: contenido }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.status === 202) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        if (!res.ok) throw new Error(json.error || "No se pudo completar el mensaje.");
        return json;
      } catch (err) {
        ultimoError = err;
        if (intento < 2) await new Promise((resolve) => setTimeout(resolve, 800 * (intento + 1)));
      }
    }
    throw ultimoError || new Error("No se pudo conectar con Wobi.");
  }, [headers]);

  const enviar = async () => {
    const contenido = texto.trim();
    if (!contenido || enviandoRef.current) return;
    enviandoRef.current = true;
    setEnviando(true);
    setError("");
    setTexto("");
    setMensajes((actuales) => [...actuales, { rol: "usuario", texto: contenido, local: true }]);
    const messageId = window.crypto?.randomUUID?.().replaceAll("-", "") || `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    try {
      const json = await enviarConReintento(messageId, contenido);
      const respuesta = json.respuesta || "Wobi terminó sin devolver texto.";
      setMensajes((actuales) => [...actuales, { rol: "wobi", texto: respuesta, local: true }]);
      if (json.identidad) setIdentidad(json.identidad);
      hablar(respuesta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo conectar con Wobi.");
    } finally {
      enviandoRef.current = false;
      setEnviando(false);
    }
  };

  const iniciarDictado = () => {
    if (!SpeechRecognition) return;
    if (escuchando) {
      recognitionRef.current?.stop?.();
      return;
    }
    const reconocimiento = new SpeechRecognition();
    recognitionRef.current = reconocimiento;
    reconocimiento.lang = "es-ES";
    reconocimiento.interimResults = true;
    reconocimiento.continuous = false;
    reconocimiento.onstart = () => setEscuchando(true);
    reconocimiento.onend = () => setEscuchando(false);
    reconocimiento.onerror = () => {
      setEscuchando(false);
      setError("El navegador no pudo iniciar el dictado. Puedes seguir escribiendo.");
    };
    reconocimiento.onresult = (evento) => {
      const transcripcion = Array.from(evento.results).map((resultado) => resultado[0]?.transcript || "").join(" ");
      setTexto(transcripcion.trim());
    };
    reconocimiento.start();
  };

  const vincular = async () => {
    setError("");
    try {
      const res = await fetch(CHAT_VINCULAR_ENDPOINT, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "No se pudo crear el código.");
      if (json.estado === "vinculado") {
        await cargarChat();
        return;
      }
      setCodigoVinculo(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el código.");
    }
  };

  const toggleLectura = () => {
    const nuevo = !leerRespuestas;
    setLeerRespuestas(nuevo);
    localStorage.setItem(LOCALSTORAGE_VOZ_KEY, nuevo ? "1" : "0");
    if (!nuevo) { lectorVoz.stop(); setVozPendiente(false); return; }
    const ultima = mensajes.findLast(mensaje => mensaje.rol === "wobi");
    if (ultima) hablar(ultima.texto, true);
  };

  return (
    <div className={`wobi-contacto ${abierto ? "wobi-contacto--abierto" : "wobi-contacto--destacado"}`}>
      {abierto ? (
        <section className="wobi-chat-panel" aria-label="Centro de conversación con Wobi">
          <header className="wobi-chat-cabecera">
            <div className="wobi-identidad">
              <span className="wobi-avatar wobi-avatar--grande" aria-hidden="true">
                <img src={WOBI_IMG} alt="" />
                <span className="wobi-presencia" />
              </span>
              <div>
                <div className="wobi-chat-nombre">Wobi</div>
                <div className="wobi-chat-estado">
                  <span className="wobi-punto-estado" />
                  {identidad?.vinculadaTelegram ? "Una conversación · dos canales" : "Disponible en este panel"}
                </div>
              </div>
            </div>
            <div className="wobi-chat-controles">
              <button
                type="button"
                onClick={toggleLectura}
                aria-pressed={leerRespuestas}
                aria-label={leerRespuestas ? "Desactivar lectura de respuestas" : "Leer las respuestas en voz alta"}
                title={leerRespuestas ? "Desactivar lectura de respuestas" : "Leer las respuestas en voz alta"}
                style={{ width: "auto", padding: "0 10px", fontSize: 12 }}
                className={`wobi-control-icono${leerRespuestas ? " wobi-control-icono--activo" : ""}`}
              >
                <span>{leerRespuestas ? "Voz activada" : "Activar voz"}</span>
              </button>
              <button type="button" onClick={() => setAbierto(false)} aria-label="Cerrar chat" className="wobi-control-icono">
                <span aria-hidden="true">×</span>
              </button>
            </div>
          </header>

          <div className="wobi-reproductor" hidden={estadoVoz === "idle"}>
            <div role="status">{({ loading: "Preparando la voz de WOBi…", playing: "WOBi está hablando", paused: "Audio en pausa", blocked: "Pulsa Reproducir para escuchar la respuesta", error: "No se pudo reproducir el audio. Puedes reintentarlo." })[estadoVoz]}</div>
            <audio ref={audioChatRef} controls preload="auto" aria-label="Audio de la respuesta de WOBi" />
            <div className="wobi-reproductor-acciones">
              {vozPendiente && <button type="button" onClick={() => {
                lectorVoz.resume().then(() => setVozPendiente(false))
                  .catch(() => setError("Pulsa el botón de reproducción del audio para escuchar la respuesta."));
              }}>Reproducir respuesta</button>}
              {estadoVoz === "error" && <button type="button" onClick={() => hablar(ultimaLocucionRef.current, true)}>Reintentar audio</button>}
              <button type="button" onClick={() => { lectorVoz.stop(); setVozPendiente(false); setEstadoVoz("idle"); }}>Detener audio</button>
            </div>
          </div>

          <div className="wobi-canales" aria-label="Canales disponibles">
            <div className="wobi-canal wobi-canal--activo">
              <span className="wobi-canal-icono" aria-hidden="true">✦</span>
              <span><strong>Chat web</strong><small>Estás aquí</small></span>
            </div>
            <a className="wobi-canal" href={TELEGRAM_BOT_URL} target="_blank" rel="noreferrer">
              <img src={TELEGRAM_ICON} alt="" width={24} height={24} />
              <span><strong>Telegram</strong><small>{identidad?.vinculadaTelegram ? "Contexto compartido" : "Canal alternativo"}</small></span>
              <span className="wobi-canal-flecha" aria-hidden="true">↗</span>
            </a>
          </div>

          {!identidad?.vinculadaTelegram && (
            <div className="wobi-vinculo">
              {codigoVinculo?.codigo ? (
                <>
                  <div className="wobi-vinculo-codigo-info">
                    <span className="wobi-vinculo-etiqueta">Vinculación pendiente</span>
                    <span>En Telegram envía este código. Wobi lo detectará automáticamente.</span>
                  </div>
                  <strong className="wobi-vinculo-codigo">VINCULAR {codigoVinculo.codigo}</strong>
                </>
              ) : (
                <>
                  <div>
                    <strong>Continúa la misma conversación en ambos canales.</strong>
                    <span>Vincula este dispositivo una sola vez para compartir contexto y confirmaciones.</span>
                  </div>
                  <button type="button" onClick={vincular}>Vincular Telegram</button>
                </>
              )}
            </div>
          )}

          <div ref={mensajesRef} aria-live="polite" className="wobi-mensajes">
            {mensajes.length === 0 && (
              <div className="wobi-chat-vacio">
                <span className="wobi-avatar wobi-avatar--vacio" aria-hidden="true"><img src={WOBI_IMG} alt="" /></span>
                <strong>¿En qué trabajamos?</strong>
                <span>Pregúntame por correo, documentos, cashflow, Holded o cualquier asunto operativo.</span>
              </div>
            )}
            {mensajes.map((mensaje, i) => {
              const esWobi = mensaje.rol === "wobi";
              return (
                <div key={`${mensaje.rol}-${i}-${mensaje.texto.slice(0, 12)}`} className={`wobi-mensaje-fila ${esWobi ? "wobi-mensaje-fila--wobi" : "wobi-mensaje-fila--usuario"}`}>
                  {esWobi && <span className="wobi-avatar wobi-avatar--mensaje" aria-hidden="true"><img src={WOBI_IMG} alt="" /></span>}
                  <div className={`wobi-burbuja ${esWobi ? "wobi-burbuja--wobi" : "wobi-burbuja--usuario"}`}>
                    {esWobi ? <><ContenidoRespuesta texto={mensaje.texto} /><button type="button" className="wobi-escuchar-respuesta" onClick={() => hablar(mensaje.texto, true)}>Escuchar respuesta</button></> : <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{mensaje.texto}</div>}
                  </div>
                </div>
              );
            })}
            {enviando && (
              <div className="wobi-escribiendo">
                <span className="wobi-avatar wobi-avatar--mensaje" aria-hidden="true"><img src={WOBI_IMG} alt="" /></span>
                <span><i /><i /><i /></span>
              </div>
            )}
          </div>

          {error && <div role="alert" className="wobi-chat-error">{error}</div>}
          <div className="wobi-compositor">
            <textarea value={texto} onChange={(e) => setTexto(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } }} disabled={enviando} rows={2} maxLength={4000} placeholder="Escribe o dicta una pregunta…" />
            <button type="button" onClick={iniciarDictado} disabled={!SpeechRecognition || enviando} aria-pressed={escuchando} aria-label={SpeechRecognition ? (escuchando ? "Detener dictado" : "Dictar con el micrófono") : "El dictado no está disponible en este navegador"} title={SpeechRecognition ? (escuchando ? "Detener dictado" : "Dictar con el micrófono") : "El dictado no está disponible en este navegador"} className={`wobi-boton-micro${escuchando ? " wobi-boton-micro--activo" : ""}`}>
              <span aria-hidden="true">🎙</span>
            </button>
            <button type="button" onClick={enviar} disabled={!texto.trim() || enviando} className="wobi-boton-enviar">
              Enviar <span aria-hidden="true">↑</span>
            </button>
          </div>
          <div className="wobi-chat-seguridad">
            <span aria-hidden="true">↻</span> Reintentos protegidos · sin llamadas duplicadas
          </div>
        </section>
      ) : (
        <div className="wobi-contacto-dock" aria-label="Canales para hablar con Wobi">
          <button type="button" onClick={() => setAbierto(true)} aria-expanded="false" className="wobi-contacto-principal">
            <span className="wobi-avatar wobi-avatar--dock" aria-hidden="true">
              <img src={WOBI_IMG} alt="" />
              <span className="wobi-presencia" />
            </span>
            <span className="wobi-contacto-texto">
              <span className="wobi-contacto-disponible"><i aria-hidden="true" /> Wobi está disponible</span>
              <strong>Comunícate con Wobi</strong>
              <small>Escribe, dicta o continúa en Telegram con el mismo contexto.</small>
            </span>
            <span className="wobi-contacto-accion">
              Abrir conversación <i aria-hidden="true">→</i>
            </span>
          </button>
          <a href={TELEGRAM_BOT_URL} target="_blank" rel="noreferrer" className="wobi-contacto-telegram" aria-label="Hablar con Wobi en Telegram">
            <img src={TELEGRAM_ICON} alt="" width={22} height={22} />
            <span><strong>Telegram</strong><small>Canal alternativo</small></span>
            <i aria-hidden="true">↗</i>
          </a>
        </div>
      )}
    </div>
  );
}

export default function CerebroWoba() {
  const [active, setActive] = useState(null);
  // Pedido explícito de Carlos: poder tener varios módulos abiertos a la vez
  // (antes un solo valor `open`) — ver el comentario de "cerebro-layout" más
  // abajo para el porqué.
  const [openIds, setOpenIds] = useState([]);

  // Pedido explícito de Carlos, tras ver que abrir un grupo REEMPLAZABA la
  // vista de los 3 grupos por sus módulos (sentía que "cambiaba de
  // pantalla" y perdía de vista el resto): "necesito que todo se maneje en
  // una sola pantalla... si necesito que despliegue las tres, las tres
  // deberían desplegar". Los 3 grupos son ahora SIEMPRE visibles, en
  // posiciones fijas — abrir uno (o los tres a la vez) solo AGREGA sus
  // módulos como ramas más lejos del núcleo (ver useGroupBranchPositions),
  // nunca oculta ni reemplaza nada. Antes `openGroup` era un solo valor (un
  // grupo abierto a la vez, con toda la vista reemplazada); ahora
  // `openGroups` es un array — cada grupo se abre/cierra de forma
  // independiente tocándolo de nuevo (ya no hace falta un botón "volver").
  const [openGroups, setOpenGroups] = useState([]);

  // Pedido explícito de Carlos: al cerrar una célula principal, las tarjetas de detalle de SUS
  // módulos deben cerrarse con ella (antes quedaban huérfanas: sus openIds seguían activos aunque
  // ya no hubiera módulo visible que las abriera, y el gráfico no volvía a su tamaño/centro
  // original porque `.cerebro-panels` seguía renderizando por esos ids sueltos). Un solo toggle
  // atómico para los dos onClick (círculo SVG y etiqueta HTML) evita que se desincronicen.
  const toggleGroup = useCallback((groupId) => {
    setOpenGroups((cur) => {
      if (cur.includes(groupId)) {
        const grupo = GROUPS.find((g) => g.id === groupId);
        if (grupo) {
          setOpenIds((curIds) => curIds.filter((id) => !grupo.children.includes(id)));
        }
        return cur.filter((id) => id !== groupId);
      }
      return [...cur, groupId];
    });
  }, []);

  const groupPositions = useRadialLayout(GROUPS.length, 175);
  // Hooks con llamadas fijas (siempre 3, GROUPS.length es constante) — nunca
  // condicionales ni en un .map(), para no romper las reglas de hooks de
  // React. Cuáles de estas posiciones se USAN de verdad depende de
  // openGroups, pero se calculan las 3 siempre (memoizado, barato).
  const modulePositionsGroup0 = useGroupBranchPositions(0, GROUPS.length, GROUPS[0].children.length);
  const modulePositionsGroup1 = useGroupBranchPositions(1, GROUPS.length, GROUPS[1].children.length);
  const modulePositionsGroup2 = useGroupBranchPositions(2, GROUPS.length, GROUPS[2].children.length);
  const modulePositionsByGroup = [modulePositionsGroup0, modulePositionsGroup1, modulePositionsGroup2];

  const [entered, setEntered] = useState(false);
  const [diving, setDiving] = useState(false);
  const [liveData, setLiveData] = useState(null);
  const [apiKey, setApiKey] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [estadoTiempoReal, setEstadoTiempoReal] = useState("desconectado");
  const [ultimoContactoEn, setUltimoContactoEn] = useState(null);
  const [errorSincronizacion, setErrorSincronizacion] = useState("");
  const refreshEnCursoRef = useRef(null);
  const [verificandoSesion, setVerificandoSesion] = useState(true);
  const [esAdmin, setEsAdmin] = useState(false);
  const [nombreUsuario, setNombreUsuario] = useState("");
  const [periodoCashflow, setPeriodoCashflow] = useState("semana");
  const [verPagosRecurrentes, setVerPagosRecurrentes] = useState(false);
  const [verDocumentos, setVerDocumentos] = useState(false);
  const [verCapturasRecientes, setVerCapturasRecientes] = useState(false);
  const [verCorreccionesRecientes, setVerCorreccionesRecientes] = useState(false);

  const handleEnter = () => {
    setDiving(true);
    setTimeout(() => setEntered(true), 1100);
  };

  const handleUnlocked = useCallback((json, key, nombre) => {
    setLiveData(json);
    setApiKey(key);
    setNombreUsuario(nombre || "");
    setUltimoContactoEn(new Date().toISOString());
    setErrorSincronizacion("");
    try {
      localStorage.setItem(LOCALSTORAGE_TOKEN_KEY, JSON.stringify({ token: key, nombre: nombre || "" }));
    } catch {
      // localStorage puede fallar (modo privado, storage bloqueado) — no es crítico, solo no persiste
    }
  }, []);

  // Al cargar, intenta retomar la sesión guardada (token + nombre) — así
  // nunca vuelve a pedir acceso ni a preguntar quién eres mientras el token
  // siga siendo válido en el servidor (key maestra indefinida, temporal
  // hasta que expire o un admin lo revoque).
  useEffect(() => {
    let cancelado = false;
    (async () => {
      let sesionGuardada = null;
      try {
        const crudo = localStorage.getItem(LOCALSTORAGE_TOKEN_KEY);
        sesionGuardada = crudo ? JSON.parse(crudo) : null;
      } catch {
        // sin acceso a localStorage, o dato corrupto — sigue al flujo normal de solicitud
      }

      if (!sesionGuardada?.token) {
        setVerificandoSesion(false);
        return;
      }

      try {
        const res = await fetch(CEREBRO_ENDPOINT, { headers: { "X-Cerebro-Key": sesionGuardada.token } });
        if (cancelado) return;

        if (res.ok) {
          const json = await res.json();
          setLiveData(json);
          setApiKey(sesionGuardada.token);
          setNombreUsuario(sesionGuardada.nombre || "");
          setUltimoContactoEn(new Date().toISOString());
          // Una sesión válida no vuelve a obligar a pasar por la animación de
          // bienvenida en cada visita.
          setEntered(true);
        } else {
          // token vencido o revocado — se limpia para no reintentar con uno inválido
          try {
            localStorage.removeItem(LOCALSTORAGE_TOKEN_KEY);
          } catch {
            // no crítico
          }
        }
      } catch {
        // red caída al cargar — no borra la sesión guardada, se reintenta la próxima visita
      } finally {
        if (!cancelado) setVerificandoSesion(false);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, []);

  // Si el token vigente es la key maestra, este endpoint responde 200 (solo
  // ella puede verlo) — así el front sabe si mostrar el panel de admin sin
  // necesitar un flag aparte.
  useEffect(() => {
    if (!apiKey) {
      setEsAdmin(false);
      return;
    }
    let cancelado = false;
    fetch(ACCESOS_ACTIVOS_ENDPOINT, { headers: { "X-Cerebro-Key": apiKey } })
      .then((res) => {
        if (!cancelado) setEsAdmin(res.ok);
      })
      .catch(() => {
        if (!cancelado) setEsAdmin(false);
      });
    return () => {
      cancelado = true;
    };
  }, [apiKey]);

  const refreshLiveData = useCallback(
    (motivo = "manual") => {
      if (!apiKey) return Promise.resolve(false);
      if (refreshEnCursoRef.current) return refreshEnCursoRef.current;

      const tarea = (async () => {
        setRefreshing(true);
        setEstadoTiempoReal("actualizando");
        try {
          const res = await fetch(CEREBRO_ENDPOINT, {
            headers: { "X-Cerebro-Key": apiKey },
            cache: "no-store",
          });
          if (res.status === 403) {
            try {
              localStorage.removeItem(LOCALSTORAGE_TOKEN_KEY);
            } catch {
              // no crítico
            }
            setApiKey(null);
            setLiveData(null);
            setEsAdmin(false);
            setErrorSincronizacion("La sesión venció o fue revocada. Solicita acceso nuevamente.");
            return false;
          }
          if (!res.ok) throw new Error(`estado_${res.status}`);

          setLiveData(await res.json());
          setUltimoContactoEn(new Date().toISOString());
          setErrorSincronizacion("");
          setEstadoTiempoReal("en_vivo");
          return true;
        } catch {
          // Se conserva el último snapshot bueno; la conexión y el polling
          // reintentan solos sin dejar el panel en blanco.
          setErrorSincronizacion(
            motivo === "online"
              ? "La red volvió, pero Wobi aún no pudo sincronizar. Reintentará automáticamente."
              : "No se pudo sincronizar. Mostrando el último estado disponible."
          );
          setEstadoTiempoReal(navigator.onLine ? "reconectando" : "sin_conexion");
          return false;
        } finally {
          setRefreshing(false);
          refreshEnCursoRef.current = null;
        }
      })();

      refreshEnCursoRef.current = tarea;
      return tarea;
    },
    [apiKey]
  );

  useCerebroRealtime({ apiKey, onRefresh: refreshLiveData, onStatus: setEstadoTiempoReal });

  const cerrarSesion = useCallback(() => {
    try {
      localStorage.removeItem(LOCALSTORAGE_TOKEN_KEY);
    } catch {
      // no crítico
    }
    setApiKey(null);
    setLiveData(null);
    setEsAdmin(false);
    setNombreUsuario("");
    setUltimoContactoEn(null);
    setEstadoTiempoReal("desconectado");
    setOpenIds([]);
    setOpenGroups([]);
  }, []);

  const abrirModuloDesdeResumen = useCallback((moduleId) => {
    const grupo = GROUPS.find((g) => g.children.includes(moduleId));
    if (grupo) setOpenGroups((actuales) => (actuales.includes(grupo.id) ? actuales : [...actuales, grupo.id]));
    setOpenIds((actuales) => (actuales.includes(moduleId) ? actuales : [...actuales, moduleId]));

    window.setTimeout(() => {
      const panel = document.getElementById(`panel-${moduleId}`);
      if (panel) {
        const reduceMovimiento = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        panel.scrollIntoView({ behavior: reduceMovimiento ? "auto" : "smooth", block: "start" });
      }
    }, 80);
  }, []);

  // Indicadores operativos calculados solo desde datos reales. Se retiraron
  // los antiguos conteos fijos de tools/crons porque podían parecer "en vivo"
  // aun cuando ya no coincidían con el sistema desplegado.
  const liveStats = [
    { n: String(get(liveData, "cashflow.propuestasPendientes", []).length), l: "propuestas cashflow" },
    { n: String(get(liveData, "correo.borradoresPendientesDeAprobacion", 0)), l: "borradores pendientes" },
    { n: String(get(liveData, "conocimiento.documentos", 0)), l: "documentos de memoria" },
    { n: fmtUSD(get(liveData, "accesos.costoIaHoy", 0)), l: "API hoy" },
  ];

  const estadoVisual = {
    en_vivo: { texto: "En vivo", color: C.ok },
    actualizando: { texto: "Actualizando…", color: C.amberBright },
    conectando: { texto: "Conectando…", color: C.amberBright },
    reconectando: { texto: "Reconectando…", color: C.amberBright },
    sin_conexion: { texto: "Sin conexión", color: C.dangerBright },
    desconectado: { texto: "Desconectado", color: C.dim },
  }[estadoTiempoReal] || { texto: "Sincronizando…", color: C.dim };

  return (
    <div
      style={{
        background: `radial-gradient(ellipse at 50% 32%, #10233A 0%, ${C.void} 66%)`,
        minHeight: "100svh",
        padding: "36px 20px 48px",
        fontFamily: C.sans,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {!entered && <EntryScreen onEnter={handleEnter} diving={diving} />}
      {entered && !liveData && !verificandoSesion && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 9,
            background: `radial-gradient(ellipse at 50% 32%, #10233A 0%, ${C.void} 66%)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <KeyGate onUnlocked={handleUnlocked} />
        </div>
      )}
      <style>{`
        @keyframes twinkle { 0%,100% { opacity: .25; } 50% { opacity: .95; } }
        @keyframes drift { 0%,100% { transform: translate(0,0); } 50% { transform: translate(var(--dx), var(--dy)); } }
        @keyframes nodeGlow { 0%,100% { filter: drop-shadow(0 0 2px rgba(126,193,232,.4)); } 50% { filter: drop-shadow(0 0 9px rgba(126,193,232,.8)); } }
        @keyframes floatSlow { 0%,100% { transform: translateY(0px); } 50% { transform: translateY(-4px); } }
        @keyframes panelIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes diveIn {
          0% { transform: scale(1); opacity: 1; filter: blur(0px); }
          55% { filter: blur(2px); }
          100% { transform: scale(7.5); opacity: 0; filter: blur(14px); }
        }
        @keyframes ctaPulse { 0%,100% { opacity: 0.75; } 50% { opacity: 1; } }
        /* Al aparecer un grupo o módulo nuevo — pedido explícito de Carlos: "un efecto de
           deconstrucción y construcción de nanobots" en vez de un corte seco. Solo anima opacity
           (nunca transform/filter) porque los nodos ya tienen nodeGlow+floatSlow corriendo sobre
           esas mismas propiedades — dos animaciones distintas tocando la misma propiedad se pisan
           entre sí, opacity queda libre. */
        @keyframes nodeAssemble { from { opacity: 0; } to { opacity: 1; } }
        @keyframes brainLanding {
          from { opacity: 0; transform: scale(1.08); filter: blur(6px); }
          to { opacity: 1; transform: scale(1); filter: blur(0px); }
        }
        @keyframes wobiDockIn {
          from { opacity: 0; transform: translateY(12px) scale(.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes wobiTyping {
          0%, 60%, 100% { opacity: .32; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-3px); }
        }

        .atencion-rail {
          width: min(980px, calc(100% - 32px));
          margin: 20px auto 0;
          position: relative;
          z-index: 2;
          color: ${C.cream};
        }
        .atencion-rail::before {
          content: "";
          position: absolute;
          top: 34px;
          left: 0;
          right: 0;
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(232,167,92,.7) 12%, rgba(143,210,245,.18) 72%, transparent);
        }
        .atencion-rail--estable::before {
          background: linear-gradient(90deg, transparent, rgba(111,207,151,.62) 20%, transparent);
        }
        .atencion-rail-cabecera {
          min-height: 26px;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          padding: 0 4px;
        }
        .atencion-rail-titulo {
          display: flex;
          align-items: center;
          gap: 8px;
          color: ${C.amberBright};
          font-family: ${C.mono};
          font-size: 12px;
          letter-spacing: .1em;
          text-transform: uppercase;
        }
        .atencion-rail--estable .atencion-rail-titulo { color: ${C.ok}; }
        .atencion-rail-titulo strong {
          color: ${C.cream};
          font-size: 16px;
          font-weight: 500;
          letter-spacing: 0;
        }
        .atencion-rail-pulso {
          width: 7px;
          height: 7px;
          flex: 0 0 auto;
          border-radius: 50%;
          background: ${C.amberBright};
          box-shadow: 0 0 0 4px rgba(232,167,92,.1), 0 0 14px rgba(232,167,92,.6);
        }
        .atencion-rail--estable .atencion-rail-pulso { background: ${C.ok}; box-shadow: 0 0 12px rgba(111,207,151,.5); }
        .atencion-rail-fuente {
          color: ${C.dim};
          font-family: ${C.mono};
          font-size: 12px;
        }
        .atencion-flujo {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
          padding-top: 10px;
          border-bottom: 1px solid rgba(143,210,245,.12);
        }
        .atencion-item {
          min-width: 0;
          min-height: 76px;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: center;
          gap: 11px;
          padding: 12px 14px;
          border: 0;
          border-right: 1px solid rgba(143,210,245,.13);
          color: ${C.cream};
          background: transparent;
          text-align: left;
          cursor: pointer;
          transition: background .2s ease, transform .2s ease;
        }
        .atencion-item:last-child { border-right: 0; }
        .atencion-item:hover { background: linear-gradient(180deg, rgba(232,167,92,.06), rgba(46,109,164,.04)); transform: translateY(-1px); }
        .atencion-item:focus-visible { outline: 2px solid ${C.amberBright}; outline-offset: -2px; }
        .atencion-item-numero {
          color: ${C.amberBright};
          font-family: ${C.serif};
          font-size: 27px;
          line-height: 1;
          font-variant-numeric: tabular-nums;
        }
        .atencion-item-texto { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
        .atencion-item-texto strong { font-size: 14px; font-weight: 500; line-height: 1.25; }
        .atencion-item-texto small { color: ${C.dim}; font-size: 12px; }
        .atencion-item-flecha { color: ${C.coreBright}; font-size: 14px; opacity: .62; }

        .control-diario {
          width: min(980px, calc(100% - 32px));
          margin: 8px auto 0;
          position: relative;
          z-index: 2;
          overflow: hidden;
          border-bottom: 1px solid rgba(143,210,245,.12);
          color: ${C.cream};
          background: transparent;
          transition: background .2s ease, border-color .2s ease;
        }
        .control-diario--abierto {
          border: 1px solid color-mix(in srgb, var(--control-color) 48%, transparent);
          border-radius: 14px;
          background: var(--control-fondo);
        }
        .control-diario-resumen {
          width: 100%;
          min-height: 74px;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: center;
          gap: 14px;
          padding: 11px 4px;
          border: 0;
          color: ${C.cream};
          background: transparent;
          text-align: left;
          cursor: pointer;
        }
        .control-diario--abierto .control-diario-resumen { padding-inline: 15px; }
        .control-diario-resumen:focus-visible { outline: 2px solid var(--control-color); outline-offset: -2px; }
        .control-diario-senal {
          width: 38px;
          height: 38px;
          display: grid;
          place-items: center;
          border: 1px solid color-mix(in srgb, var(--control-color) 38%, transparent);
          border-radius: 50%;
          background: color-mix(in srgb, var(--control-color) 7%, transparent);
        }
        .control-diario-senal span {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: var(--control-color);
          box-shadow: 0 0 13px var(--control-color);
        }
        .control-diario-copy {
          min-width: 0;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          align-items: baseline;
          column-gap: 10px;
          row-gap: 3px;
        }
        .control-diario-etiqueta {
          color: ${C.dim};
          font-family: ${C.mono};
          font-size: 12px;
          letter-spacing: .08em;
          text-transform: uppercase;
        }
        .control-diario-estado { color: var(--control-color); font-size: 14px; font-weight: 600; }
        .control-diario-descripcion { grid-column: 1 / -1; color: ${C.dim}; font-size: 13px; line-height: 1.4; }
        .control-diario-accion {
          display: inline-flex;
          align-items: center;
          gap: 9px;
          color: ${C.amberBright};
          font-family: ${C.mono};
          font-size: 12px;
          white-space: nowrap;
        }
        .control-diario-accion span {
          width: 28px;
          height: 28px;
          display: grid;
          place-items: center;
          border: 1px solid ${C.line};
          border-radius: 50%;
          color: ${C.coreBright};
        }
        .control-diario-contenido { padding: 14px 16px 16px; border-top: 1px solid ${C.line}; }

        .wobi-contacto {
          font-family: ${C.sans};
        }
        .wobi-contacto--destacado {
          width: min(980px, calc(100% - 32px));
          margin: 20px auto 4px;
          position: relative;
          z-index: 3;
        }
        .wobi-contacto--abierto {
          position: fixed;
          right: 20px;
          bottom: 20px;
          z-index: 40;
        }
        .wobi-contacto button,
        .wobi-contacto a,
        .wobi-contacto textarea {
          font: inherit;
        }
        .wobi-contacto button:focus-visible,
        .wobi-contacto a:focus-visible,
        .wobi-contacto textarea:focus-visible {
          outline: 2px solid ${C.amberBright};
          outline-offset: 2px;
        }
        .wobi-contacto-dock {
          position: relative;
          display: flex;
          align-items: stretch;
          width: 100%;
          min-width: 0;
          overflow: hidden;
          border: 1px solid rgba(143,210,245,.24);
          border-radius: 28px 8px 28px 8px;
          background: radial-gradient(circle at 9% 50%, rgba(46,109,164,.3), transparent 31%), linear-gradient(100deg, rgba(13,27,43,.96), rgba(7,16,27,.91) 68%, rgba(15,27,42,.8));
          box-shadow: 0 18px 46px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.025), 0 0 48px rgba(46,109,164,.08);
          animation: wobiDockIn .3s ease-out;
          backdrop-filter: blur(18px);
        }
        .wobi-contacto-dock::before {
          content: "";
          position: absolute;
          left: 84px;
          right: 18%;
          top: 0;
          height: 1px;
          background: linear-gradient(90deg, ${C.coreBright}, rgba(143,210,245,0));
          opacity: .7;
          pointer-events: none;
        }
        .wobi-contacto-principal {
          flex: 1;
          min-width: 0;
          min-height: 104px;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: center;
          gap: 16px;
          padding: 12px 22px 12px 14px;
          border: 0;
          color: ${C.cream};
          background: transparent;
          text-align: left;
          cursor: pointer;
          transition: background .18s ease;
        }
        .wobi-contacto-principal:hover { background: rgba(143,210,245,.07); }
        .wobi-contacto-texto { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
        .wobi-contacto-disponible {
          display: flex;
          align-items: center;
          gap: 7px;
          margin-bottom: 1px;
          color: ${C.ok};
          font-family: ${C.mono};
          font-size: 12px;
          letter-spacing: .08em;
          text-transform: uppercase;
        }
        .wobi-contacto-disponible i { width: 6px; height: 6px; border-radius: 50%; background: ${C.ok}; box-shadow: 0 0 10px ${C.ok}; }
        .wobi-contacto-texto strong { font-family: ${C.serif}; font-size: 25px; line-height: 1.1; font-weight: 500; letter-spacing: .01em; }
        .wobi-contacto-texto small { color: ${C.dim}; font-size: 14px; line-height: 1.35; }
        .wobi-contacto-accion {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 10px 13px;
          border: 1px solid rgba(143,210,245,.3);
          border-radius: 11px;
          color: ${C.coreBright};
          background: rgba(143,210,245,.055);
          font-size: 13px;
          white-space: nowrap;
        }
        .wobi-contacto-accion i { font-style: normal; font-size: 17px; }
        .wobi-contacto-principal:hover .wobi-contacto-accion {
          border-color: rgba(143,210,245,.55);
          background: rgba(143,210,245,.09);
        }
        .wobi-contacto-telegram {
          min-width: 150px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          padding: 12px 16px;
          border-left: 1px solid ${C.line};
          color: #86d8ff;
          text-decoration: none;
          font-size: 13px;
          transition: background .18s ease;
        }
        .wobi-contacto-telegram > span { display: flex; flex-direction: column; gap: 2px; }
        .wobi-contacto-telegram strong { color: ${C.cream}; font-size: 13px; font-weight: 600; }
        .wobi-contacto-telegram small { color: ${C.dim}; font-size: 11px; white-space: nowrap; }
        .wobi-contacto-telegram > i { margin-left: auto; color: #86d8ff; font-style: normal; }
        .wobi-contacto-telegram:hover { background: rgba(42,171,238,.09); }
        .wobi-avatar {
          position: relative;
          flex: 0 0 auto;
          display: block;
          overflow: visible;
          border-radius: 50%;
          background: radial-gradient(circle at 50% 35%, #274863, ${C.void} 72%);
          box-shadow: inset 0 0 0 1px rgba(143,210,245,.3), 0 0 22px rgba(46,109,164,.2);
        }
        .wobi-avatar > img {
          width: 100%;
          height: 100%;
          display: block;
          border-radius: inherit;
          object-fit: cover;
          filter: contrast(1.04);
        }
        .wobi-avatar--dock { width: 74px; height: 74px; }
        .wobi-avatar--grande { width: 52px; height: 52px; }
        .wobi-avatar--mensaje { width: 28px; height: 28px; margin-top: 2px; }
        .wobi-avatar--vacio { width: 70px; height: 70px; margin-bottom: 5px; }
        .wobi-presencia {
          position: absolute;
          right: 1px;
          bottom: 2px;
          width: 11px;
          height: 11px;
          box-sizing: border-box;
          border: 2px solid ${C.panel};
          border-radius: 50%;
          background: ${C.ok};
          box-shadow: 0 0 9px ${C.ok};
        }
        .wobi-chat-panel {
          width: min(470px, calc(100vw - 40px));
          height: min(740px, calc(100vh - 40px));
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border: 1px solid rgba(143,210,245,.36);
          border-radius: 22px;
          background: linear-gradient(180deg, rgba(9,19,31,.995), rgba(4,10,18,.995));
          box-shadow: 0 28px 90px rgba(0,0,0,.66), 0 0 50px rgba(46,109,164,.1);
          animation: wobiDockIn .26s ease-out;
        }
        .wobi-chat-cabecera {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 14px 16px;
          border-bottom: 1px solid ${C.line};
          background: radial-gradient(circle at 12% 0%, rgba(46,109,164,.2), transparent 48%);
        }
        .wobi-identidad { display: flex; align-items: center; gap: 12px; min-width: 0; }
        .wobi-chat-nombre { font-family: ${C.serif}; color: ${C.cream}; font-size: 22px; line-height: 1.1; }
        .wobi-chat-estado { display: flex; align-items: center; gap: 6px; margin-top: 5px; color: ${C.dim}; font-size: 12px; }
        .wobi-punto-estado { width: 6px; height: 6px; border-radius: 50%; background: ${C.ok}; box-shadow: 0 0 7px ${C.ok}; }
        .wobi-chat-controles { display: flex; gap: 7px; }
        .wobi-reproductor { margin: 0 16px 12px; padding: 12px; border: 1px solid ${C.line}; border-radius: 12px; color: ${C.cream}; font-size: 12px; }
        .wobi-reproductor audio { display: block; width: 100%; height: 36px; margin-top: 8px; }
        .wobi-reproductor-acciones { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
        .wobi-reproductor button, .wobi-escuchar-respuesta { color: ${C.coreBright}; background: transparent; border: 1px solid ${C.lineBright}; border-radius: 8px; padding: 7px 10px; cursor: pointer; font: inherit; }
        .wobi-escuchar-respuesta { margin-top: 12px; font-size: 12px; }
        .wobi-control-icono {
          width: 42px;
          height: 42px;
          display: grid;
          place-items: center;
          padding: 0;
          border: 1px solid ${C.line};
          border-radius: 11px;
          background: rgba(5,11,20,.4);
          color: ${C.dim};
          cursor: pointer;
          transition: border-color .18s ease, color .18s ease, background .18s ease;
        }
        .wobi-control-icono:hover,
        .wobi-control-icono--activo { color: ${C.coreBright}; border-color: ${C.lineBright}; background: rgba(143,210,245,.07); }
        .wobi-canales {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          padding: 10px 12px;
          border-bottom: 1px solid ${C.line};
          background: rgba(5,11,20,.38);
        }
        .wobi-canal {
          min-height: 48px;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          box-sizing: border-box;
          border: 1px solid ${C.line};
          border-radius: 11px;
          color: ${C.cream};
          text-decoration: none;
          background: rgba(12,22,32,.7);
        }
        .wobi-canal--activo { border-color: rgba(111,207,151,.4); background: rgba(111,207,151,.06); }
        .wobi-canal-icono { width: 24px; text-align: center; color: ${C.ok}; font-size: 18px; }
        .wobi-canal > span:not(.wobi-canal-icono):not(.wobi-canal-flecha) { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .wobi-canal strong { font-size: 13px; font-weight: 600; }
        .wobi-canal small { color: ${C.dim}; font-size: 11px; white-space: nowrap; }
        .wobi-canal-flecha { margin-left: auto; color: #86d8ff; }
        a.wobi-canal:hover { border-color: rgba(42,171,238,.48); background: rgba(42,171,238,.08); }
        .wobi-vinculo {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 11px 14px;
          border-bottom: 1px solid rgba(232,167,92,.22);
          color: ${C.dim};
          background: rgba(232,167,92,.065);
          font-size: 12px;
          line-height: 1.45;
        }
        .wobi-vinculo > div { display: flex; flex-direction: column; gap: 2px; }
        .wobi-vinculo strong { color: ${C.cream}; font-weight: 600; }
        .wobi-vinculo-codigo-info { min-width: 0; }
        .wobi-vinculo-codigo {
          flex: 0 0 auto;
          padding: 8px 10px;
          border: 1px solid rgba(232,167,92,.42);
          border-radius: 9px;
          color: ${C.amberBright} !important;
          background: rgba(232,167,92,.08);
          font-family: ${C.mono};
          font-size: 12px;
          letter-spacing: .025em;
          white-space: nowrap;
        }
        .wobi-vinculo > button {
          flex: 0 0 auto;
          min-height: 38px;
          padding: 7px 11px;
          border: 1px solid rgba(232,167,92,.48);
          border-radius: 9px;
          color: ${C.amberBright};
          background: rgba(232,167,92,.08);
          cursor: pointer;
          font-size: 12px;
        }
        .wobi-vinculo-etiqueta { color: ${C.amberBright}; font-family: ${C.mono}; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
        .wobi-mensajes {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 13px;
          overflow-y: auto;
          padding: 18px 15px;
          scrollbar-color: rgba(143,210,245,.22) transparent;
        }
        .wobi-chat-vacio {
          max-width: 290px;
          margin: auto;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          color: ${C.dim};
          text-align: center;
          font-size: 14px;
          line-height: 1.55;
        }
        .wobi-chat-vacio strong { color: ${C.cream}; font-family: ${C.serif}; font-size: 22px; font-weight: 500; }
        .wobi-mensaje-fila { display: flex; gap: 8px; width: 100%; align-items: flex-start; }
        .wobi-mensaje-fila--usuario { justify-content: flex-end; }
        .wobi-burbuja {
          max-width: calc(100% - 38px);
          box-sizing: border-box;
          padding: 11px 13px;
          color: ${C.cream};
          font-size: 14px;
          line-height: 1.55;
        }
        .wobi-burbuja--wobi {
          width: 100%;
          border: 1px solid ${C.line};
          border-radius: 4px 14px 14px 14px;
          background: linear-gradient(145deg, rgba(15,27,42,.9), rgba(10,19,29,.86));
        }
        .wobi-burbuja--usuario {
          max-width: 84%;
          border: 1px solid rgba(143,210,245,.34);
          border-radius: 14px 14px 4px 14px;
          background: linear-gradient(145deg, rgba(46,109,164,.3), rgba(31,72,110,.23));
        }
        .wobi-escribiendo { display: flex; align-items: center; gap: 8px; }
        .wobi-escribiendo > span:last-child { display: flex; gap: 4px; padding: 11px 13px; border: 1px solid ${C.line}; border-radius: 4px 14px 14px 14px; background: ${C.voidSoft}; }
        .wobi-escribiendo i { width: 5px; height: 5px; border-radius: 50%; background: ${C.amberBright}; animation: wobiTyping 1.2s infinite; }
        .wobi-escribiendo i:nth-child(2) { animation-delay: .14s; }
        .wobi-escribiendo i:nth-child(3) { animation-delay: .28s; }
        .wobi-chat-error { padding: 9px 14px; border-top: 1px solid rgba(240,113,120,.28); color: ${C.dangerBright}; background: rgba(240,113,120,.06); font-size: 13px; }
        .wobi-compositor {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto auto;
          gap: 8px;
          align-items: end;
          padding: 11px 12px 8px;
          border-top: 1px solid ${C.line};
          background: rgba(5,11,20,.72);
        }
        .wobi-compositor textarea {
          min-width: 0;
          min-height: 46px;
          max-height: 130px;
          resize: vertical;
          box-sizing: border-box;
          padding: 11px 12px;
          border: 1px solid ${C.line};
          border-radius: 12px;
          outline: 0;
          color: ${C.cream};
          background: rgba(15,27,42,.86);
          font-size: 14px;
          line-height: 1.45;
        }
        .wobi-compositor textarea::placeholder { color: #6f849a; }
        .wobi-boton-micro,
        .wobi-boton-enviar {
          min-height: 46px;
          border-radius: 12px;
          cursor: pointer;
        }
        .wobi-boton-micro {
          width: 46px;
          padding: 0;
          border: 1px solid ${C.line};
          color: ${C.dim};
          background: rgba(15,27,42,.7);
        }
        .wobi-boton-micro--activo { border-color: ${C.amberBright}; color: ${C.amberBright}; background: rgba(232,167,92,.13); }
        .wobi-boton-micro:disabled { cursor: not-allowed; opacity: .4; }
        .wobi-boton-enviar {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 0 14px;
          border: 1px solid ${C.coreBright};
          color: ${C.cream};
          background: linear-gradient(145deg, #2e6da4, #234f76);
          font-size: 13px;
          font-weight: 600;
        }
        .wobi-boton-enviar span { font-size: 16px; }
        .wobi-boton-enviar:disabled { cursor: default; opacity: .38; filter: saturate(.3); }
        .wobi-chat-seguridad {
          display: flex;
          justify-content: center;
          gap: 5px;
          padding: 0 12px 10px;
          color: #657c91;
          background: rgba(5,11,20,.72);
          font-family: ${C.mono};
          font-size: 10px;
        }

        @media (max-width: 780px) {
          .atencion-flujo { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .atencion-item:nth-child(2n) { border-right: 0; }
          .atencion-item:nth-child(n+3) { border-top: 1px solid rgba(143,210,245,.1); }
          .control-diario-copy { grid-template-columns: minmax(0, 1fr); }
          .control-diario-estado { grid-column: 1; }
          .control-diario-descripcion { grid-column: 1; }
          .wobi-contacto-principal { grid-template-columns: auto minmax(0, 1fr); }
          .wobi-contacto-accion { grid-column: 2; justify-self: start; padding: 7px 10px; }
        }

        @media (max-width: 600px) {
          .atencion-rail,
          .control-diario,
          .wobi-contacto--destacado { width: calc(100% - 20px); }
          .atencion-rail { margin-top: 16px; }
          .atencion-rail::before { top: 50px; }
          .atencion-rail-cabecera { min-height: 42px; }
          .atencion-rail-fuente { max-width: 130px; text-align: right; line-height: 1.35; }
          .atencion-flujo { grid-template-columns: minmax(0, 1fr); padding-top: 8px; }
          .atencion-item,
          .atencion-item:nth-child(2n) { min-height: 66px; border-right: 0; border-top: 1px solid rgba(143,210,245,.1); }
          .atencion-item:first-child { border-top: 0; }
          .atencion-item-numero { min-width: 42px; font-size: 25px; }
          .control-diario-resumen { grid-template-columns: auto minmax(0, 1fr); gap: 11px; padding-block: 13px; }
          .control-diario-accion { grid-column: 2; justify-self: start; margin-top: 2px; }
          .control-diario-accion span { width: 25px; height: 25px; }
          .wobi-contacto--destacado { margin-top: 16px; }
          .wobi-contacto--abierto { left: 10px; right: 10px; bottom: 10px; }
          .wobi-contacto-dock { display: grid; grid-template-columns: minmax(0, 1fr); border-radius: 22px 7px 22px 7px; }
          .wobi-contacto-dock::before { left: 66px; right: 18px; }
          .wobi-contacto-principal { min-height: 94px; padding: 11px 13px; gap: 11px; }
          .wobi-avatar--dock { width: 60px; height: 60px; }
          .wobi-contacto-accion { display: none; }
          .wobi-contacto-telegram { min-width: 0; justify-content: flex-start; padding: 10px 15px; border-top: 1px solid ${C.line}; border-left: 0; }
          .wobi-contacto-telegram > i { margin-left: auto; }
          .wobi-contacto-texto strong { font-size: 21px; }
          .wobi-contacto-texto small { font-size: 12px; }
          .wobi-contacto-disponible { font-size: 10px; }
          .wobi-chat-panel { width: 100%; height: calc(100dvh - 20px); border-radius: 18px; }
          .wobi-chat-cabecera { padding: 12px; }
          .wobi-avatar--grande { width: 46px; height: 46px; }
          .wobi-chat-nombre { font-size: 20px; }
          .wobi-chat-estado { font-size: 11px; }
          .wobi-canales { padding: 8px 10px; gap: 6px; }
          .wobi-canal { min-height: 45px; padding: 7px 8px; gap: 7px; }
          .wobi-canal strong { font-size: 12px; }
          .wobi-canal small { font-size: 10px; }
          .wobi-vinculo { align-items: flex-start; padding: 10px 12px; }
          .wobi-vinculo > button { min-height: 42px; }
          .wobi-mensajes { padding: 14px 11px; }
          .wobi-burbuja { font-size: 13.5px; }
          .wobi-compositor { grid-template-columns: minmax(0, 1fr) 46px; }
          .wobi-boton-enviar { grid-column: 1 / -1; justify-content: center; min-height: 42px; }
          .wobi-chat-seguridad { padding-bottom: 7px; }
        }

        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            scroll-behavior: auto !important;
          }
        }

        /* Pedido explícito de Carlos: el universo y los paneles de detalle van LADO A LADO
           (todo el ancho disponible), nunca uno debajo del otro obligando a hacer scroll — salvo
           en celular, donde no entran de costado y toca apilarlos ("para despliegue en celular
           vas a tener que adaptarlo", pedido explícito). 900px alcanza para el universo (620px)
           + un panel angosto sin apretarse; por debajo de eso se apila en columna. */
        .cerebro-layout {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 24px;
          width: 100%;
          max-width: 1400px;
          margin: 10px auto 0;
        }
        @media (min-width: 900px) {
          .cerebro-layout {
            flex-direction: row;
            align-items: flex-start;
            justify-content: center;
          }
        }
        /* Grid, no flex — pedido explícito de Carlos: "redimensionar cada célula para que quepa
           perfectamente" cuando hay varios módulos abiertos a la vez (1, 2 o los 3), sin que se
           superpongan y con espacio suficiente. auto-fit + minmax hace exactamente eso solo: con
           un panel abierto ocupa el ancho disponible completo, con varios se reparte entre ellos. */
        .cerebro-panels {
          flex: 1 1 380px;
          min-width: 0;
          width: 100%;
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 16px;
          align-content: start;
        }
        .control-metricas {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 8px;
        }
        .control-detalle-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          gap: 10px;
          margin-top: 10px;
        }
        .control-recomendacion {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
        }
        @media (max-width: 720px) {
          .control-metricas {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .control-detalle-grid {
            grid-template-columns: minmax(0, 1fr);
          }
          .control-recomendacion {
            grid-template-columns: auto minmax(0, 1fr);
          }
          .control-recomendacion > button {
            grid-column: 2;
            justify-self: start;
          }
        }
      `}</style>

      <div inert={!entered || !liveData} aria-hidden={!entered || !liveData}>
      <div
        style={{
          textAlign: "center",
          marginBottom: 6,
          position: "relative",
          zIndex: 2,
          animation: entered ? "brainLanding 0.7s ease-out" : undefined,
        }}
      >
        <div style={{ fontFamily: C.mono, fontSize: 11, letterSpacing: "0.18em", color: C.coreBright, textTransform: "uppercase", marginBottom: 8 }}>
          WOBA Group · WOBi
        </div>
        <div style={{ fontFamily: C.serif, fontSize: 32, color: C.cream, fontWeight: 500 }}>El cerebro del asistente</div>
        {nombreUsuario && (
          <div style={{ fontFamily: C.sans, fontSize: 14, color: C.amberBright, marginTop: 8 }}>
            Hola, {nombreUsuario} — soy WOBi, tu asistente. Aquí tienes todo lo que necesites.
          </div>
        )}
        <div style={{ fontFamily: C.sans, fontSize: 13, color: C.dim, marginTop: 6, maxWidth: 520, marginLeft: "auto", marginRight: "auto" }}>
          {openGroups.length > 0
            ? "Toca un módulo para abrir su detalle, o toca el grupo de nuevo para cerrarlo."
            : "Toca un grupo para abrir sus módulos y ver la información en vivo."}
        </div>

        {apiKey && (
          <div
            aria-live="polite"
            style={{
              marginTop: 12,
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              fontFamily: C.mono,
              fontSize: 10.5,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: estadoVisual.color }}>
              <span
                aria-hidden="true"
                style={{ width: 7, height: 7, borderRadius: "50%", background: estadoVisual.color, boxShadow: `0 0 8px ${estadoVisual.color}` }}
              />
              {estadoVisual.texto}
              {ultimoContactoEn ? ` · contacto ${timeAgo(ultimoContactoEn)}` : ""}
            </span>
            <button
              type="button"
              onClick={() => refreshLiveData("manual")}
              disabled={refreshing}
              style={{ background: "none", border: "none", padding: 3, color: C.amberBright, fontFamily: C.mono, fontSize: 10.5, cursor: refreshing ? "default" : "pointer", textDecoration: "underline" }}
            >
              {refreshing ? "actualizando…" : "actualizar ahora"}
            </button>
            <button
              type="button"
              onClick={cerrarSesion}
              style={{ background: "none", border: "none", padding: 3, color: C.dim, fontFamily: C.mono, fontSize: 10.5, cursor: "pointer", textDecoration: "underline" }}
            >
              cerrar sesión
            </button>
          </div>
        )}

        {apiKey && errorSincronizacion && (
          <div
            role="status"
            style={{ maxWidth: 560, margin: "10px auto 0", padding: "8px 12px", borderRadius: 7, border: `1px solid ${C.danger}`, color: C.dangerBright, background: "rgba(240, 113, 120, 0.08)", fontFamily: C.sans, fontSize: 11.5 }}
          >
            {errorSincronizacion}
          </div>
        )}

      </div>

      {entered && apiKey && (
        <WobiChat
          apiKey={apiKey}
          nombreUsuario={nombreUsuario}
          revisionTiempoReal={ultimoContactoEn}
        />
      )}

      {liveData && <AtencionAhora data={liveData} onAbrir={abrirModuloDesdeResumen} />}
      {liveData && apiKey && (
        <ControlDiarioPanel
          data={liveData}
          apiKey={apiKey}
          actualizacionId={get(liveData, "cacheadoEn")}
          onAbrir={abrirModuloDesdeResumen}
        />
      )}


      {/* Pedido explícito de Carlos, tras ver un ejemplo de referencia (conducting.ai) y luego
          insistir en que ni el panel de módulo NI los 3 grupos principales pueden "cambiar de
          pantalla": "necesito que todo se maneje en una sola pantalla... si necesito que despliegue
          las tres, las tres deberían desplegar... sin perder de vista el todo". "cerebro-layout"
          pone el universo y los paneles de detalle LADO A LADO (todo el ancho disponible) en
          pantallas anchas, apilados en columna en celular (pedido explícito: "para despliegue en
          celular vas a tener que adaptarlo"). Se pueden tener VARIOS módulos abiertos a la vez
          (openIds) — "cerebro-panels" es un grid que los redimensiona solo para que quepan sin
          superponerse. Los 3 grupos (neuronas) son SIEMPRE visibles (ya no se reemplazan entre sí,
          ver openGroups y useGroupBranchPositions más abajo) — se pueden abrir los 3 a la vez, cada
          uno agregando sus módulos como ramas propias sin tapar a los demás. */}
      <div className="cerebro-layout">
      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 620,
          flexShrink: 0,
          margin: "10px 0 0",
          aspectRatio: "1 / 1",
          animation: entered ? "brainLanding 0.85s ease-out 0.05s both" : undefined,
        }}
      >
        <NeuralField seed={42} count={46} size={600} />

        <svg viewBox="0 0 600 600" style={{ width: "100%", height: "100%", display: "block", position: "relative", pointerEvents: "none" }}>
          <defs>
            <radialGradient id="nodeGrad" cx="35%" cy="35%" r="70%">
              <stop offset="0%" stopColor={C.cream} />
              <stop offset="100%" stopColor={C.coreBright} />
            </radialGradient>
          </defs>

          {/* Núcleo → cada grupo — los 3 grupos son siempre visibles, en posiciones fijas. */}
          {groupPositions.map((p, gi) => (
            <line key={`core-${GROUPS[gi].id}`} x1="300" y1="300" x2={p.x} y2={p.y} stroke={C.lineBright} strokeWidth="1.1" strokeDasharray="1 7" />
          ))}
          {groupPositions.map((p, gi) => (
            <circle key={`core-spark-${GROUPS[gi].id}`} r="2.6" fill={C.amberBright}>
              <animateMotion path={`M 300 300 L ${p.x} ${p.y}`} dur="2.4s" begin={`${gi * 0.55}s`} repeatCount="indefinite" />
              <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.8;1" dur="2.4s" begin={`${gi * 0.55}s`} repeatCount="indefinite" />
            </circle>
          ))}

          {/* Grupo → sus módulos — solo para los grupos que están abiertos (puede ser 1, 2 o los 3). Cada
              rama usa el color propio del grupo (g.accent) para que, con las 3 células abiertas a la
              vez, siempre se vea a simple vista de cuál célula principal cuelga cada módulo. */}
          {GROUPS.map((g, gi) =>
            openGroups.includes(g.id)
              ? modulePositionsByGroup[gi].map((p, mi) => (
                  <line
                    key={`branch-${g.id}-${g.children[mi]}`}
                    x1={groupPositions[gi].x}
                    y1={groupPositions[gi].y}
                    x2={p.x}
                    y2={p.y}
                    stroke={g.accent}
                    strokeWidth="1.2"
                    strokeOpacity="0.8"
                    strokeDasharray="1 6"
                  />
                ))
              : null
          )}

          {/* "Nanobots" — chispas que viajan por cada rama grupo→módulo, mismo tratamiento que ya
              tenía núcleo→grupo (core-spark) pero con el color propio del grupo, para reforzar
              visualmente el vínculo cuando hay varios grupos abiertos a la vez. */}
          {GROUPS.map((g, gi) =>
            openGroups.includes(g.id)
              ? modulePositionsByGroup[gi].map((p, mi) => (
                  <circle key={`branch-spark-${g.id}-${g.children[mi]}`} r="2.6" fill={g.accent}>
                    <animateMotion
                      path={`M ${groupPositions[gi].x} ${groupPositions[gi].y} L ${p.x} ${p.y}`}
                      dur="2s"
                      begin={`${mi * 0.4}s`}
                      repeatCount="indefinite"
                    />
                    <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.8;1" dur="2s" begin={`${mi * 0.4}s`} repeatCount="indefinite" />
                  </circle>
                ))
              : null
          )}

          {/* Nodos de los 3 grupos, siempre. */}
          {groupPositions.map((p, gi) => {
            const g = GROUPS[gi];
            const isActive = active === g.id || openGroups.includes(g.id);
            return (
              <circle
                key={g.id}
                cx={p.x}
                cy={p.y}
                r={isActive ? 22 : 18}
                fill="url(#nodeGrad)"
                onMouseEnter={() => setActive(g.id)}
                onMouseLeave={() => setActive(null)}
                onClick={() => toggleGroup(g.id)}
                style={{
                  cursor: "pointer",
                  pointerEvents: "auto",
                  animation: `nodeGlow 3s ease-in-out infinite, floatSlow ${4 + gi * 0.3}s ease-in-out infinite, nodeAssemble 520ms ease-out`,
                  transition: "r .15s",
                }}
              />
            );
          })}

          {/* Nodos de módulos — solo para los grupos abiertos. */}
          {GROUPS.map((g, gi) =>
            openGroups.includes(g.id)
              ? modulePositionsByGroup[gi].map((p, mi) => {
                  const m = MODULES.find((x) => x.id === g.children[mi]);
                  const isActive = active === m.id || openIds.includes(m.id);
                  return (
                    <circle
                      key={m.id}
                      cx={p.x}
                      cy={p.y}
                      r={isActive ? 15 : 11}
                      fill="url(#nodeGrad)"
                      onMouseEnter={() => setActive(m.id)}
                      onMouseLeave={() => setActive(null)}
                      onClick={() => setOpenIds((cur) => (cur.includes(m.id) ? cur.filter((id) => id !== m.id) : [...cur, m.id]))}
                      style={{
                        cursor: "pointer",
                        pointerEvents: "auto",
                        animation: `nodeGlow 3s ease-in-out infinite, floatSlow ${4 + mi * 0.3}s ease-in-out infinite, nodeAssemble 420ms ease-out`,
                        transition: "r .15s",
                      }}
                    />
                  );
                })
              : null
          )}
        </svg>

        <WobiAvatar className="wobi-portrait--core" transparent headOnly energized={Boolean(active || openIds.length > 0 || openGroups.length > 0)} assemble={entered} />

        {/* Etiquetas de los 3 grupos, siempre. */}
        {groupPositions.map((p, gi) => {
          const g = GROUPS[gi];
          const isActive = active === g.id || openGroups.includes(g.id);
          return (
            <div
              key={g.id}
              onMouseEnter={() => setActive(g.id)}
              onMouseLeave={() => setActive(null)}
              onClick={() => toggleGroup(g.id)}
              style={{
                position: "absolute",
                left: `${(p.x / 600) * 100}%`,
                top: `${(p.y / 600) * 100}%`,
                transform: "translate(-50%, 20px)",
                textAlign: "center",
                cursor: "pointer",
                width: 140,
                pointerEvents: "auto",
                animation: "nodeAssemble 520ms ease-out",
              }}
            >
              <div style={{ fontFamily: C.serif, fontSize: 15, fontWeight: 600, color: isActive ? C.amberBright : C.cream }}>{g.name}</div>
              {isActive && (
                <div style={{ fontFamily: C.mono, fontSize: 10, color: C.dim, marginTop: 2, lineHeight: 1.4 }}>
                  <span style={{ color: C.amber }}>{g.note}</span>
                </div>
              )}
            </div>
          );
        })}

        {/* Etiquetas de módulos — solo para los grupos abiertos. */}
        {GROUPS.map((g, gi) =>
          openGroups.includes(g.id)
            ? modulePositionsByGroup[gi].map((p, mi) => {
                const m = MODULES.find((x) => x.id === g.children[mi]);
                const isActive = active === m.id || openIds.includes(m.id);
                return (
                  <div
                    key={m.id}
                    onMouseEnter={() => setActive(m.id)}
                    onMouseLeave={() => setActive(null)}
                    onClick={() => setOpenIds((cur) => (cur.includes(m.id) ? cur.filter((id) => id !== m.id) : [...cur, m.id]))}
                    style={{
                      position: "absolute",
                      left: `${(p.x / 600) * 100}%`,
                      top: `${(p.y / 600) * 100}%`,
                      transform: "translate(-50%, 14px)",
                      textAlign: "center",
                      cursor: "pointer",
                      width: 128,
                      pointerEvents: "auto",
                      animation: "nodeAssemble 420ms ease-out",
                    }}
                  >
                    <div style={{ fontFamily: C.sans, fontSize: 12.5, fontWeight: 600, color: isActive ? C.amberBright : C.cream }}>{m.name}</div>
                    {active === m.id && (
                      <div style={{ fontFamily: C.mono, fontSize: 10, color: C.dim, marginTop: 2, lineHeight: 1.4 }}>
                        {m.detail && (
                          <>
                            {m.detail}
                            <br />
                          </>
                        )}
                        <span style={{ color: C.amber }}>{m.note}</span>
                      </div>
                    )}
                  </div>
                );
              })
            : null
        )}
      </div>

      {/* Paneles de detalle de los módulos abiertos — uno por cada id en openIds
          (antes un solo panel para `open`), cada uno con su propio campo neuronal.
          "cerebro-panels" (grid, ver <style> más abajo) los redimensiona solo para
          que quepan todos sin superponerse, sea que haya 1, 2 o los 3 abiertos. */}
      {openIds.length > 0 && (
        <div className="cerebro-panels">
          {openIds.map((open) => {
            const m = MODULES.find((x) => x.id === open);
            return (
              <div
                key={open}
                id={`panel-${open}`}
                style={{
                  width: "100%",
                  position: "relative",
                  borderRadius: 12,
                  overflow: "hidden",
                  border: `1px solid ${C.line}`,
                  animation: "panelIn 0.25s ease-out",
                }}
              >
            <div style={{ position: "absolute", inset: 0, background: C.panel }}>
              <NeuralField seed={open.length * 13 + open.charCodeAt(0)} count={18} size={300} dense />
            </div>
            <div style={{ position: "relative", padding: "20px 22px", background: "linear-gradient(180deg, rgba(5,11,20,0.35), rgba(5,11,20,0.75))" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontFamily: C.mono, fontSize: 10, color: C.amber, letterSpacing: "0.06em", textTransform: "uppercase" }}>{m.note}</div>
                  <div style={{ fontFamily: C.serif, fontSize: 22, color: C.cream, marginTop: 2 }}>{m.name}</div>
                  <div style={{ fontFamily: C.mono, fontSize: 11, color: C.coreBright, marginTop: 2 }}>{m.detail}</div>
                </div>
                <button
                  onClick={() => setOpenIds((cur) => cur.filter((id) => id !== open))}
                  style={{ background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 6, width: 26, height: 26, cursor: "pointer", fontSize: 14, lineHeight: 1 }}
                >
                  ×
                </button>
              </div>
              <p style={{ fontFamily: C.sans, fontSize: 13, color: "#CBD8E6", lineHeight: 1.6, marginTop: 14, marginBottom: 0 }}>{m.desc}</p>

              {m.id === "cashflow" && (
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

              {liveData ? (
                <div style={{ marginTop: 16, borderTop: `1px solid ${C.line}`, paddingTop: 12 }}>
                  {liveRowsForModule(m.id, liveData, periodoCashflow).map(([label, value], i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 12.5 }}>
                      <span style={{ fontFamily: C.sans, color: C.dim }}>{label}</span>
                      <span style={{ fontFamily: C.mono, color: C.coreBright, textAlign: "right", maxWidth: "60%" }}>{value}</span>
                    </div>
                  ))}
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
                          {get(liveData, "cashflow.pagosRecurrentes", []).length === 0 ? (
                            <div style={{ fontFamily: C.sans, fontSize: 11.5, color: C.dim, padding: "4px 0" }}>
                              Ninguno catalogado para WOBA/EWORKS.
                            </div>
                          ) : (
                            get(liveData, "cashflow.pagosRecurrentes", []).map((p, i) => (
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
                  {m.id === "cashflow" && get(liveData, "cashflow.linkSheet") && (
                    <a
                      href={get(liveData, "cashflow.linkSheet")}
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
                </div>
              ) : (
                <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.dim, marginTop: 14, letterSpacing: "0.03em" }}>
                  estado en vivo no disponible todavía
                </div>
              )}

              {/* Estos tres módulos no dependen del bloque agregado (2 min de caché) — tienen su propio
                  endpoint, así que se montan (y sondean) solo mientras su nodo está abierto. */}
              {m.id === "busqueda_web" && apiKey && <BusquedaWebContenido apiKey={apiKey} />}
              {m.id === "calendario" && apiKey && <MiniCalendario apiKey={apiKey} actualizacionId={get(liveData, "cacheadoEn")} />}
              {m.id === "conexiones" && apiKey && <ConexionesContenido apiKey={apiKey} puedeArreglar={esAdmin} />}
            </div>
              </div>
            );
          })}
        </div>
      )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: 1,
          background: C.line,
          border: `1px solid ${C.line}`,
          borderRadius: 10,
          overflow: "hidden",
          maxWidth: 560,
          margin: "24px auto 0",
          position: "relative",
          zIndex: 2,
          animation: entered ? "brainLanding 1s ease-out 0.15s both" : undefined,
        }}
      >
        {liveStats.map((s) => (
          <div key={s.l} style={{ background: C.voidSoft, padding: "14px 12px", textAlign: "center" }}>
            <div style={{ fontFamily: C.mono, fontSize: 22, color: C.coreBright, fontWeight: 500 }}>{s.n}</div>
            <div style={{ fontFamily: C.sans, fontSize: 10.5, color: C.dim, marginTop: 3 }}>{s.l}</div>
          </div>
        ))}
      </div>

      <div style={{ textAlign: "center", marginTop: 18, fontFamily: C.mono, fontSize: 10, color: C.dim, letterSpacing: "0.04em" }}>
        {liveData ? (
          <>
            toca cualquier nodo para abrir su detalle · actualizado {timeAgo(get(liveData, "cacheadoEn") || get(liveData, "generadoEn"))}
            {"  "}
            <button
              type="button"
              onClick={() => refreshLiveData("manual")}
              disabled={refreshing}
              style={{ color: C.amberBright, cursor: refreshing ? "default" : "pointer", textDecoration: "underline", border: "none", background: "none", padding: 0, font: "inherit" }}
            >
              {refreshing ? "actualizando…" : "refrescar"}
            </button>
          </>
        ) : (
          "toca cualquier nodo para abrir su detalle · aún con datos de referencia, pendiente de conectar al endpoint en vivo"
        )}
      </div>

      {esAdmin && <AdminPanel apiKey={apiKey} actualizacionId={get(liveData, "cacheadoEn")} />}
      {esAdmin && <UsuariosPanel apiKey={apiKey} actualizacionId={get(liveData, "cacheadoEn")} />}
      </div>
    </div>
  );
}
