export interface EventoCerebro {
  revision: number;
  tipo: string;
  en: string;
}

type Suscriptor = (evento: EventoCerebro) => void;

const suscriptores = new Set<Suscriptor>();
let revision = 0;

/**
 * Bus de eventos liviano para el panel /cerebro. No contiene datos de
 * negocio ni secretos: solo avisa a los navegadores de que deben volver a
 * leer el snapshot autenticado. El polling del cliente sigue siendo el
 * respaldo ante reinicios, varias réplicas o proxies que corten el stream.
 */
export function publicarCambioCerebro(tipo: string): EventoCerebro {
  const evento = { revision: ++revision, tipo, en: new Date().toISOString() };
  for (const suscriptor of suscriptores) {
    try {
      suscriptor(evento);
    } catch (error) {
      console.error("[cerebro/realtime] Error notificando suscriptor:", error);
    }
  }
  return evento;
}

export function suscribirCambiosCerebro(suscriptor: Suscriptor): () => void {
  suscriptores.add(suscriptor);
  return () => suscriptores.delete(suscriptor);
}

export function obtenerRevisionCerebro(): number {
  return revision;
}

export function contarSuscriptoresCerebro(): number {
  return suscriptores.size;
}
