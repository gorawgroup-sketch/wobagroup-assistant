interface Acuse {
  respondido: boolean;
  mensajes: Set<string>;
  cola: Promise<void>;
  aviso: (texto: string) => Promise<unknown>;
  timer: ReturnType<typeof setTimeout>;
  caducidad: ReturnType<typeof setTimeout>;
}

/** Acuse de transporte solamente: nunca autoriza ni ejecuta una acción. */
export class AcusesCallback {
  private readonly estados = new Map<string, Acuse>();
  constructor(
    private readonly responder: (id: string, texto?: string) => Promise<void>,
    private readonly registrarFallo: () => void,
    private readonly demoraMs = 1_000,
    private readonly retencionMs = 15 * 60_000
  ) {}

  preparar(id: string, aviso: (texto: string) => Promise<unknown>): void {
    if (this.estados.has(id)) return;
    const timer = setTimeout(() => {
      void this.contestar(id).catch(this.registrarFallo);
    }, this.demoraMs);
    const caducidad = setTimeout(() => this.estados.delete(id), this.retencionMs);
    timer.unref();
    caducidad.unref();
    this.estados.set(id, { respondido: false, mensajes: new Set(), cola: Promise.resolve(), aviso, timer, caducidad });
  }

  contestar(id: string, texto?: string): Promise<void> {
    const estado = this.estados.get(id);
    if (!estado) return this.responder(id, texto);
    clearTimeout(estado.timer);
    const tarea = estado.cola.then(async () => {
      if (!estado.respondido) {
        await this.responder(id, texto);
        estado.respondido = true;
      } else if (texto && !estado.mensajes.has(texto)) {
        // No perder un rechazo de permisos o una propuesta caducada tras el acuse temprano.
        await estado.aviso(texto);
      }
      if (texto) estado.mensajes.add(texto);
    });
    estado.cola = tarea.catch(() => undefined);
    return tarea;
  }

  cerrar(): void {
    for (const estado of this.estados.values()) {
      clearTimeout(estado.timer);
      clearTimeout(estado.caducidad);
    }
    this.estados.clear();
  }
}
