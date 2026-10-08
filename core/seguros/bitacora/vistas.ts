/**
 * La forma en que la bitácora, la programación y el calendario de pagos salen hacia Cerebro (parte del contrato de estadoCerebro.ts).
 * Puras: reciben lo ya leído y la hora, y devuelven datos listos para dibujar; el front no recalcula nada.
 */
import { eventoDePago, fechaDelEvento } from "../pagos/eventoCalendario";
import type { PagoSeguro } from "../pagos/tipos";
import { diasEntre } from "../vigilante/fechas";
import { PROGRAMACION_SEGUROS, estadoDeTarea, proximaOcurrencia, textoCuando, type EstadoTarea } from "./programacion";
import type { AvisoRegistrado, EntradaBitacora, EventoRegistrado, ResultadoTarea, TareaSeguros } from "./tipos";

export const ETIQUETAS_TAREA: Record<TareaSeguros, string> = {
  vigilante: "Vigilante", avisos: "Avisos del registro", pagos: "Calendario de pagos", semanal: "Resumen semanal", agente: "Especialista",
};

/** Cuántas entradas viajan en el contrato (la hoja guarda más) y cuánto texto de cada aviso: el panel se refresca cada minuto. */
export const MAX_ENTRADAS_EN_CONTRATO = 40;
/**
 * Cuántas se LEEN para calcular el estado de cada tarea (al día / retrasada): bastantes más que las que se enseñan, porque la constancia
 * de una tarea semanal tiene hasta 7 días y no puede quedar fuera de la ventana solo porque las demás tareas escriben más a menudo.
 */
export const ENTRADAS_A_LEER = 150;
const MAX_TEXTO_AVISO_EN_CONTRATO = 700;

export interface VistaBitacora {
  id: string;
  cuando: string;
  tarea: TareaSeguros;
  etiqueta: string;
  origen: string;
  resultado: ResultadoTarea;
  resumen: string;
  avisos: AvisoRegistrado[];
  eventos: EventoRegistrado[];
  cifras: Record<string, number>;
  notas: string[];
}

/** `entradas` undefined = no se pudo leer la bitácora (null en el contrato: «sin lectura», no «sin actividad»). */
export function vistaBitacora(entradas: EntradaBitacora[] | undefined): VistaBitacora[] | null {
  if (!entradas) return null;
  return [...entradas]
    .sort((a, b) => Date.parse(b.cuando) - Date.parse(a.cuando))
    .slice(0, MAX_ENTRADAS_EN_CONTRATO)
    .map((e) => ({
      id: e.id, cuando: e.cuando, tarea: e.tarea, etiqueta: ETIQUETAS_TAREA[e.tarea], origen: e.origen, resultado: e.resultado, resumen: e.resumen,
      avisos: (e.detalle.avisos ?? []).map((a) => ({ ...a, texto: a.texto.length > MAX_TEXTO_AVISO_EN_CONTRATO ? `${a.texto.slice(0, MAX_TEXTO_AVISO_EN_CONTRATO - 1).trimEnd()}…` : a.texto })),
      eventos: e.detalle.eventos ?? [], cifras: e.detalle.cifras ?? {}, notas: e.detalle.notas ?? [],
    }));
}

export interface VistaTareaProgramada {
  id: TareaSeguros;
  nombre: string;
  /** Frase lista para mostrar: «Todos los días a las 08:35 y 17:35 (hora de Madrid)». */
  cuando: string;
  dias: "diario" | "lunes" | "bajo_demanda";
  horas: string[];
  conIA: boolean;
  queHace: string;
  cuandoAvisa: string;
  /** Próxima cita (ISO UTC); null si se ejecuta cuando alguien le habla. */
  proxima: string | null;
  /** Su última constancia en la bitácora (cualquier origen); null si aún no hay o no se pudo leer. */
  ultima: { cuando: string; resultado: ResultadoTarea; resumen: string; origen: string } | null;
  estado: EstadoTarea;
}

/** `ahora` null = sin hora de referencia (forma de reserva cuando falla la lectura): no se calcula la próxima cita ni si va al día. */
export function vistaProgramacion(entradas: EntradaBitacora[] | undefined, ahora: Date | null): VistaTareaProgramada[] {
  const ahoraMs = ahora ? ahora.getTime() : null;
  return PROGRAMACION_SEGUROS.map((t) => {
    const propias = (entradas ?? []).filter((e) => e.tarea === t.id).sort((a, b) => Date.parse(b.cuando) - Date.parse(a.cuando));
    const proxima = ahoraMs == null ? null : proximaOcurrencia(t, ahoraMs);
    return {
      id: t.id, nombre: t.nombre, cuando: textoCuando(t), dias: t.dias, horas: [...t.horas], conIA: t.conIA, queHace: t.queHace, cuandoAvisa: t.cuandoAvisa,
      proxima: proxima == null ? null : new Date(proxima).toISOString(),
      ultima: propias[0] ? { cuando: propias[0].cuando, resultado: propias[0].resultado, resumen: propias[0].resumen, origen: propias[0].origen } : null,
      estado: ahoraMs == null ? estadoDeTarea(t, null, 0) : estadoDeTarea(t, entradas ?? null, ahoraMs),
    };
  });
}

export interface VistaPagoCalendario {
  id: string;
  polizaId: string;
  empresa: string;
  fecha: string;
  diasRestantes: number;
  importe: number;
  moneda: string;
  estimado: boolean;
  concepto: string;
  cuentaDeCargo: string;
  forma: string;
  estado: PagoSeguro["estado"];
  /** creado = ya está en el calendario; pendiente = se creará en la próxima pasada de las 8:55; no_aplica = pago ya cerrado o evento ya pasado. */
  evento: { estado: "creado" | "pendiente" | "no_aplica"; titulo: string; inicio: string };
  avisosEnviados: string[];
}

const ETIQUETA_AVISO: Record<string, string> = { d3: "aviso a 3 días", d1: "aviso del día antes" };
/** Los pagos ya cerrados se enseñan unos meses (historia reciente); los previstos, todos. */
const DIAS_HISTORIA_PAGOS = 90;

/** `pagos` undefined = no se pudo leer el calendario (null en el contrato). */
export function vistaCalendarioPagos(pagos: PagoSeguro[] | undefined, hoyIso: string): VistaPagoCalendario[] | null {
  if (!pagos) return null;
  return pagos
    .filter((p) => p.estado === "previsto" || diasEntre(p.fecha, hoyIso) <= DIAS_HISTORIA_PAGOS)
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .map((p) => {
      const evento = eventoDePago(p);
      const estadoEvento = p.estado !== "previsto" ? "no_aplica" : p.eventoCalendarId ? "creado" : diasEntre(hoyIso, fechaDelEvento(p)) >= 0 ? "pendiente" : "no_aplica";
      return {
        id: p.id, polizaId: p.polizaId, empresa: p.empresa, fecha: p.fecha, diasRestantes: diasEntre(hoyIso, p.fecha), importe: p.importe, moneda: p.moneda,
        estimado: p.estimado, concepto: p.concepto, cuentaDeCargo: p.cuentaDeCargo, forma: p.forma, estado: p.estado,
        evento: { estado: estadoEvento, titulo: evento.resumen, inicio: evento.fechaHoraInicioISO },
        avisosEnviados: p.avisos.split(",").map((s) => s.trim()).filter(Boolean).map((s) => ETIQUETA_AVISO[s] ?? s),
      } satisfies VistaPagoCalendario;
    });
}

export interface VistaCalendario {
  /** Cuenta propietaria del calendario donde se crean los eventos (la del asistente); null si no está configurada. */
  cuenta: string | null;
  invitaACarlos: boolean;
  texto: string;
}

export function vistaCalendario(cuenta: string | undefined, invita: boolean): VistaCalendario {
  return {
    cuenta: cuenta?.trim() || null,
    invitaACarlos: invita,
    texto: invita
      ? "Los eventos se crean en el calendario principal de la cuenta del asistente y se te invita desde ahí: te aparecen en tu propio Google Calendar, con aviso 30 minutos antes y un correo 1 hora antes."
      : "Los eventos se crean en el calendario principal de la cuenta del asistente. No hay un correo de invitado configurado, así que no te aparecen en tu calendario.",
  };
}
