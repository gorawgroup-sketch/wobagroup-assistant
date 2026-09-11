import assert from "node:assert/strict";
import test from "node:test";
import {
  ContactosHoldedAmbiguosError,
  CreacionContactoInciertaError,
  ejecutarCreacionContactoDurable,
  esRechazoDefinitivoSinContacto,
  identidadCreacionContacto,
  normalizarCodigoFiscalContacto,
  normalizarNombreContacto,
  reconciliarCreacionesContactoPendientes,
  type EstadoCreacionContacto,
  type InspeccionCreacionContacto,
  type RegistroCreacionContacto,
  type RepositorioCreacionesContacto,
  type ResultadoCreacionContacto,
  type TransporteCreacionContacto,
} from "./durableContact";
import { configuracionCreacionesContactoDurables } from "./write";

class RepoMemoria implements RepositorioCreacionesContacto {
  filas = new Map<string, RegistroCreacionContacto>();
  fallarCheckpoint = false;
  fallarCambioEstado = false;

  async reservar(registro: RegistroCreacionContacto) {
    const existente = this.filas.get(registro.clave);
    if (existente) return { registro: { ...existente }, nuevo: false };
    this.filas.set(registro.clave, { ...registro });
    return { registro: { ...registro }, nuevo: true };
  }
  async obtener(clave: string) {
    const registro = this.filas.get(clave);
    return registro ? { ...registro } : undefined;
  }
  async marcarCreando(clave: string) {
    if (this.fallarCambioEstado) return undefined;
    return this.cambiar(clave, ["preparada"], "creando");
  }
  async marcarPreparada(clave: string) { this.cambiar(clave, ["creando"], "preparada"); }
  async marcarIncierta(clave: string) { this.cambiar(clave, ["creando"], "incierta"); }
  async marcarVerificada(clave: string, resultado: ResultadoCreacionContacto) {
    if (this.fallarCheckpoint) throw new Error("Sheets no responde");
    const actual = this.filas.get(clave);
    if (!actual || actual.estado === "verificada") return;
    this.filas.set(clave, {
      ...actual,
      estado: "verificada",
      holdedContactId: resultado.id,
      actualizadoEn: 999,
      verificadoEn: 999,
    });
  }
  async listarPendientes() {
    return [...this.filas.values()]
      .filter((r) => r.estado === "creando" || r.estado === "incierta")
      .map((r) => ({ ...r }));
  }
  private cambiar(clave: string, permitidos: EstadoCreacionContacto[], estado: EstadoCreacionContacto) {
    const actual = this.filas.get(clave);
    if (!actual || !permitidos.includes(actual.estado)) return undefined;
    const siguiente = { ...actual, estado, actualizadoEn: 500 };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
}

function transporte(opciones: {
  inspecciones?: InspeccionCreacionContacto[];
  errorCreacion?: unknown;
  resultado?: ResultadoCreacionContacto;
} = {}) {
  const inspecciones = [...(opciones.inspecciones ?? [{ estado: "ausente" as const }])];
  const valor: TransporteCreacionContacto & { creaciones: number; lecturas: number } = {
    creaciones: 0,
    lecturas: 0,
    async inspeccionar() {
      valor.lecturas++;
      return inspecciones.shift() ?? inspecciones.at(-1) ?? { estado: "ausente" };
    },
    async crear(registro) {
      valor.creaciones++;
      if (opciones.errorCreacion) throw opciones.errorCreacion;
      return opciones.resultado ?? { id: "contact-1", name: registro.nombre };
    },
  };
  return valor;
}

function ejecutar(repo: RepoMemoria, holded: TransporteCreacionContacto, ahora = 1) {
  return ejecutarCreacionContactoDurable(
    identidadCreacionContacto("WOBA", "Café Pino, S.L.", undefined, "crear_contacto_proveedor", ahora),
    repo,
    holded
  );
}

test("crea un proveedor una sola vez y reutiliza el id durable", async () => {
  const repo = new RepoMemoria();
  const holded = transporte();
  const primero = await ejecutar(repo, holded, 1);
  const segundo = await ejecutar(repo, holded, 2);
  assert.equal(primero.reutilizado, false);
  assert.equal(segundo.reutilizado, true);
  assert.equal(segundo.resultado.id, "contact-1");
  assert.equal(holded.creaciones, 1);
  assert.equal(holded.lecturas, 1);
});

test("reutiliza una coincidencia exacta previa sin enviar POST", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ inspecciones: [{ estado: "unico", resultado: { id: "existente", name: "CAFÉ PINO SL" } }] });
  const resultado = await ejecutar(repo, holded);
  assert.equal(resultado.reutilizado, true);
  assert.equal(resultado.resultado.id, "existente");
  assert.equal(holded.creaciones, 0);
});

test("varias coincidencias exactas bloquean la creación antes del POST", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({ inspecciones: [{ estado: "ambiguo", cantidad: 2 }] });
  await assert.rejects(ejecutar(repo, holded), (error) => {
    assert.ok(error instanceof ContactosHoldedAmbiguosError);
    assert.equal(error.despuesDeEscritura, false);
    return true;
  });
  assert.equal(holded.creaciones, 0);
  assert.equal([...repo.filas.values()][0]?.estado, "preparada");
});

test("si el POST da timeout pero aparece una coincidencia exacta, la recupera", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({
    inspecciones: [
      { estado: "ausente" },
      { estado: "unico", resultado: { id: "creada", name: "Café Pino, S.L." } },
    ],
    errorCreacion: new Error("timeout"),
  });
  const resultado = await ejecutar(repo, holded);
  assert.equal(resultado.resultado.id, "creada");
  assert.equal(resultado.reutilizado, true);
  assert.equal(holded.creaciones, 1);
  assert.equal(repo.filas.values().next().value?.estado, "verificada");
});

test("un timeout sin confirmación queda incierto y nunca repite POST", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({
    inspecciones: [{ estado: "ausente" }, { estado: "ausente" }, { estado: "ausente" }],
    errorCreacion: new Error("timeout"),
  });
  await assert.rejects(ejecutar(repo, holded, 1), CreacionContactoInciertaError);
  await assert.rejects(ejecutar(repo, holded, 2), CreacionContactoInciertaError);
  assert.equal(holded.creaciones, 1);
  assert.equal([...repo.filas.values()][0]?.estado, "incierta");
});

test("coincidencias ambiguas tras el POST bloquean toda repetición", async () => {
  const repo = new RepoMemoria();
  const holded = transporte({
    inspecciones: [{ estado: "ausente" }, { estado: "ambiguo", cantidad: 2 }],
    errorCreacion: new Error("timeout"),
  });
  await assert.rejects(ejecutar(repo, holded), (error) => {
    assert.ok(error instanceof ContactosHoldedAmbiguosError);
    assert.equal(error.despuesDeEscritura, true);
    return true;
  });
  await assert.rejects(ejecutar(repo, holded), CreacionContactoInciertaError);
  assert.equal(holded.creaciones, 1);
});

test("un 422 de validación vuelve a preparada y permite corregir/reintentar", async () => {
  const repo = new RepoMemoria();
  const error422 = Object.assign(new Error("validación"), { status: 422 });
  const fallido = transporte({ errorCreacion: error422 });
  await assert.rejects(ejecutar(repo, fallido), error422);
  assert.equal([...repo.filas.values()][0]?.estado, "preparada");
  const correcto = transporte();
  const resultado = await ejecutar(repo, correcto, 2);
  assert.equal(resultado.resultado.id, "contact-1");
  assert.equal(correcto.creaciones, 1);
});

test("429 y errores sin status son ambiguos; 400/403/422 son definitivos", () => {
  assert.equal(esRechazoDefinitivoSinContacto(Object.assign(new Error("bad"), { status: 400 })), true);
  assert.equal(esRechazoDefinitivoSinContacto(Object.assign(new Error("forbidden"), { status: 403 })), true);
  assert.equal(esRechazoDefinitivoSinContacto(Object.assign(new Error("validation"), { status: 422 })), true);
  assert.equal(esRechazoDefinitivoSinContacto(Object.assign(new Error("rate"), { status: 429 })), false);
  assert.equal(esRechazoDefinitivoSinContacto(new Error("timeout")), false);
});

test("una ejecución interrumpida solo consulta y recupera el proveedor", async () => {
  const repo = new RepoMemoria();
  const registro = {
    ...identidadCreacionContacto("WOBA", "Café Pino, S.L.", undefined, "crear_contacto_proveedor", 1),
    estado: "creando" as const,
  };
  repo.filas.set(registro.clave, registro);
  const holded = transporte({ inspecciones: [{ estado: "unico", resultado: { id: "recuperado", name: registro.nombre } }] });
  const resultado = await ejecutar(repo, holded, 2);
  assert.equal(resultado.resultado.id, "recuperado");
  assert.equal(holded.creaciones, 0);
});

test("si falla la lectura previa no crea a ciegas", async () => {
  const repo = new RepoMemoria();
  const holded: TransporteCreacionContacto & { creaciones: number } = {
    creaciones: 0,
    async inspeccionar() { throw new Error("lectura no disponible"); },
    async crear() { holded.creaciones++; return { id: "nunca", name: "nunca" }; },
  };
  await assert.rejects(ejecutar(repo, holded), /lectura no disponible/);
  assert.equal(holded.creaciones, 0);
  assert.equal([...repo.filas.values()][0]?.estado, "preparada");
});

test("si no puede guardar el checkpoint previo tampoco ejecuta POST", async () => {
  const repo = new RepoMemoria();
  repo.fallarCambioEstado = true;
  const holded = transporte();
  await assert.rejects(ejecutar(repo, holded), CreacionContactoInciertaError);
  assert.equal(holded.creaciones, 0);
});

test("si falla el checkpoint posterior al POST nunca crea por segunda vez", async () => {
  const repo = new RepoMemoria();
  repo.fallarCheckpoint = true;
  const holded = transporte({ inspecciones: [{ estado: "ausente" }, { estado: "ausente" }, { estado: "ausente" }] });
  await assert.rejects(ejecutar(repo, holded, 1), CreacionContactoInciertaError);
  await assert.rejects(ejecutar(repo, holded, 2), CreacionContactoInciertaError);
  assert.equal(holded.creaciones, 1);
});

test("la reconciliación de arranque solo lee y clasifica verificados, inciertos y ambiguos", async () => {
  const repo = new RepoMemoria();
  const a = { ...identidadCreacionContacto("WOBA", "A Uno", undefined, "contacto", 1), estado: "creando" as const };
  const b = { ...identidadCreacionContacto("WOBA", "B Dos", undefined, "contacto", 1), estado: "incierta" as const };
  const c = { ...identidadCreacionContacto("WOBA", "C Tres", undefined, "contacto", 1), estado: "incierta" as const };
  repo.filas.set(a.clave, a);
  repo.filas.set(b.clave, b);
  repo.filas.set(c.clave, c);
  const resumen = await reconciliarCreacionesContactoPendientes(repo, async (registro) => {
    if (registro.clave === a.clave) return { estado: "unico", resultado: { id: "contact-a", name: registro.nombre } };
    if (registro.clave === c.clave) return { estado: "ambiguo", cantidad: 2 };
    return { estado: "ausente" };
  });
  assert.deepEqual(resumen, { revisadas: 3, verificadas: 1, inciertas: 2, ambiguas: 1, errores: 0 });
  assert.equal(repo.filas.get(a.clave)?.estado, "verificada");
  assert.equal(repo.filas.get(b.clave)?.estado, "incierta");
});

test("la identidad normaliza formato, es opaca y distingue empresa o código fiscal", () => {
  const a = identidadCreacionContacto("WOBA", "  Café Pino, S.L. ", " B-123 456 ", "contacto", 1);
  const b = identidadCreacionContacto("WOBA", "cafe pino sl", "B123456", "contacto", 2);
  const c = identidadCreacionContacto("EWORKS", "cafe pino sl", "B123456", "contacto", 1);
  const d = identidadCreacionContacto("WOBA", "cafe pino sl", "B999", "contacto", 1);
  assert.equal(a.clave, b.clave);
  assert.notEqual(a.clave, c.clave);
  assert.notEqual(a.clave, d.clave);
  assert.equal(a.clave.includes("cafe"), false);
  assert.equal(normalizarNombreContacto("CAFÉ, Pino S.L."), "cafe pino sl");
  assert.equal(normalizarCodigoFiscalContacto(" b-123 456 "), "B123456");
  assert.throws(() => identidadCreacionContacto("WOBA", "", undefined, "contacto"), /obligatorio/);
});

test("la protección de contactos solo se desactiva con false explícito", () => {
  assert.equal(configuracionCreacionesContactoDurables({} as NodeJS.ProcessEnv).habilitado, true);
  assert.equal(
    configuracionCreacionesContactoDurables({ WOBI_HOLDED_CONTACT_DURABLE_ENABLED: "false" } as NodeJS.ProcessEnv).habilitado,
    false
  );
  assert.equal(
    configuracionCreacionesContactoDurables({ WOBI_HOLDED_CONTACT_DURABLE_ENABLED: "falso" } as NodeJS.ProcessEnv).habilitado,
    true
  );
});
