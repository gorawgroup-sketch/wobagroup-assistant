/** Una cola por identidad compartida entre web y Telegram; otras identidades no esperan. */
export class ColaTurnos {
  private readonly colas = new Map<number, Promise<unknown>>();

  ejecutar<T>(chatId: number, tarea: () => Promise<T>): Promise<T> {
    const anterior = this.colas.get(chatId) ?? Promise.resolve();
    const actual = anterior.then(tarea, tarea);
    const cola = actual.catch(() => undefined);
    this.colas.set(chatId, cola);
    void cola.finally(() => {
      if (this.colas.get(chatId) === cola) this.colas.delete(chatId);
    });
    return actual;
  }

  get identidadesActivas(): number { return this.colas.size; }
}
