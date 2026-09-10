import assert from "node:assert/strict";
import test from "node:test";
import {
  ejecutarSubidaDriveDurable,
  esArchivoLocalInexistente,
  identidadSubidaDrive,
  reconciliarSubidasDrivePendientes,
  SubidaDriveInciertaError,
  type EstadoSubidaDrive,
  type RegistroSubidaDrive,
  type RepositorioSubidasDrive,
  type ResultadoSubidaDrive,
  type TransporteSubidaDrive,
} from "./durableUpload";

class RepoMemoria implements RepositorioSubidasDrive {
  filas = new Map<string, RegistroSubidaDrive>();
  fallarCheckpoint = false;

  async reservar(registro: RegistroSubidaDrive) {
    const existente = this.filas.get(registro.clave);
    if (existente) return { registro: { ...existente }, nuevo: false };
    this.filas.set(registro.clave, { ...registro });
    return { registro: { ...registro }, nuevo: true };
  }
  async obtener(clave: string) { const r = this.filas.get(clave); return r ? { ...r } : undefined; }
  async marcarSubiendo(clave: string) { return this.cambiar(clave, ["preparada"], "subiendo"); }
  async marcarPreparada(clave: string) { this.cambiar(clave, ["subiendo"], "preparada"); }
  async marcarIncierta(clave: string) { this.cambiar(clave, ["subiendo"], "incierta"); }
  async marcarVerificada(clave: string, resultado: ResultadoSubidaDrive) {
    if (this.fallarCheckpoint) throw new Error("Sheets no responde");
    const actual = this.filas.get(clave);
    if (!actual || actual.estado === "verificada") return;
    this.filas.set(clave, {
      ...actual,
      estado: "verificada",
      driveFileId: resultado.fileId,
      webViewLink: resultado.webViewLink,
      verificadoEn: 999,
    });
  }
  async listarPendientes() {
    return [...this.filas.values()]
      .filter((r) => r.estado === "subiendo" || r.estado === "incierta")
      .map((r) => ({ ...r }));
  }
  private cambiar(clave: string, permitidos: EstadoSubidaDrive[], estado: EstadoSubidaDrive) {
    const actual = this.filas.get(clave);
    if (!actual || !permitidos.includes(actual.estado)) return undefined;
    const siguiente = { ...actual, estado, actualizadoEn: 500 };
    this.filas.set(clave, siguiente);
    return { ...siguiente };
  }
}

function transporte(opciones: {
  encontrado?: ResultadoSubidaDrive;
  errorSubida?: unknown;
} = {}): TransporteSubidaDrive & { subidas: string[]; busquedas: string[] } {
  const subidas: string[] = [];
  const busquedas: string[] = [];
  return {
    subidas,
    busquedas,
    async buscar(marcador, folderId) {
      busquedas.push(`${marcador}:${folderId}`);
      return opciones.encontrado;
    },
    async subir(marcador) {
      subidas.push(marcador);
      if (opciones.errorSubida) throw opciones.errorSubida;
      return { fileId: "drive-1", webViewLink: "https://drive/drive-1" };
    },
  };
}

test("una aprobación sube una sola vez y sus reintentos reutilizan el archivo", async () => {
  const repo = new RepoMemoria();
  const drive = transporte();
  const primero = await ejecutarSubidaDriveDurable("documento:abc", "folder-1", "aprobado", repo, drive, 1);
  const segundo = await ejecutarSubidaDriveDurable("documento:abc", "folder-1", "aprobado", repo, drive, 2);
  assert.equal(primero.reutilizado, false);
  assert.equal(segundo.reutilizado, true);
  assert.equal(drive.subidas.length, 1);
  assert.equal(drive.busquedas.length, 0);
});

test("una ejecución interrumpida solo consulta Drive y recupera el archivo marcado", async () => {
  const repo = new RepoMemoria();
  const registro = { ...identidadSubidaDrive("documento:abc", "folder-1", 1), estado: "subiendo" as const };
  repo.filas.set(registro.clave, registro);
  const drive = transporte({ encontrado: { fileId: "ya-subido", webViewLink: "https://drive/ya-subido" } });
  const resultado = await ejecutarSubidaDriveDurable("documento:abc", "folder-1", "aprobado", repo, drive, 2);
  assert.equal(resultado.resultado.fileId, "ya-subido");
  assert.equal(resultado.reutilizado, true);
  assert.equal(drive.subidas.length, 0);
  assert.equal(repo.filas.get(registro.clave)?.estado, "verificada");
});

test("una ejecución interrumpida sin confirmación queda incierta y nunca vuelve a subir", async () => {
  const repo = new RepoMemoria();
  const registro = { ...identidadSubidaDrive("documento:abc", "folder-1", 1), estado: "subiendo" as const };
  repo.filas.set(registro.clave, registro);
  const drive = transporte();
  await assert.rejects(
    ejecutarSubidaDriveDurable("documento:abc", "folder-1", "aprobado", repo, drive, 2),
    SubidaDriveInciertaError
  );
  assert.equal(drive.subidas.length, 0);
  assert.equal(repo.filas.get(registro.clave)?.estado, "incierta");
});

test("si la subida da timeout pero Drive encuentra el marcador, se confirma sin duplicar", async () => {
  const repo = new RepoMemoria();
  const drive = transporte({
    errorSubida: new Error("timeout"),
    encontrado: { fileId: "aceptado", webViewLink: "https://drive/aceptado" },
  });
  const resultado = await ejecutarSubidaDriveDurable("documento:abc", "folder-1", "aprobado", repo, drive, 1);
  assert.equal(resultado.resultado.fileId, "aceptado");
  assert.equal(resultado.reutilizado, true);
  assert.equal(drive.subidas.length, 1);
  assert.equal(drive.busquedas.length, 1);
});

test("un timeout sin confirmación queda incierto; ENOENT y 403 permiten reintento", async () => {
  const repoTimeout = new RepoMemoria();
  await assert.rejects(
    ejecutarSubidaDriveDurable("doc:timeout", "folder-1", "aprobado", repoTimeout, transporte({ errorSubida: new Error("timeout") }), 1),
    SubidaDriveInciertaError
  );
  assert.equal([...repoTimeout.filas.values()][0]?.estado, "incierta");

  for (const error of [
    Object.assign(new Error("no existe local"), { code: "ENOENT" }),
    Object.assign(new Error("sin permiso"), { response: { status: 403 } }),
  ]) {
    const repo = new RepoMemoria();
    await assert.rejects(
      ejecutarSubidaDriveDurable(`doc:${String((error as { code?: string }).code ?? "403")}`, "folder-1", "aprobado", repo, transporte({ errorSubida: error }), 1),
      error
    );
    assert.equal([...repo.filas.values()][0]?.estado, "preparada");
  }
});

test("reconoce ENOENT directo o envuelto sin confundir otros errores", () => {
  const enoent = Object.assign(new Error("falta"), { code: "ENOENT" });
  assert.equal(esArchivoLocalInexistente(enoent), true);
  assert.equal(esArchivoLocalInexistente(new Error("timeout", { cause: enoent })), true);
  assert.equal(esArchivoLocalInexistente(new Error("timeout")), false);
});

test("la identidad es estable, opaca y distingue la carpeta de destino", () => {
  const a = identidadSubidaDrive("documento:nombre-confidencial", "folder-1", 1);
  const b = identidadSubidaDrive("documento:nombre-confidencial", "folder-1", 2);
  const c = identidadSubidaDrive("documento:nombre-confidencial", "folder-2", 1);
  assert.equal(a.clave, b.clave);
  assert.notEqual(a.clave, c.clave);
  assert.equal(a.marcador.includes("confidencial"), false);
  assert.throws(() => identidadSubidaDrive("", "folder-1"), /obligatoria/);
});

test("la reconciliación confirma encontrados y conserva inciertos sin subir", async () => {
  const repo = new RepoMemoria();
  const a = { ...identidadSubidaDrive("a", "folder-1", 1), estado: "subiendo" as const };
  const b = { ...identidadSubidaDrive("b", "folder-1", 1), estado: "incierta" as const };
  repo.filas.set(a.clave, a);
  repo.filas.set(b.clave, b);
  const resumen = await reconciliarSubidasDrivePendientes(repo, async (marcador) =>
    marcador === a.marcador ? { fileId: "encontrado", webViewLink: "https://drive/encontrado" } : undefined
  );
  assert.deepEqual(resumen, { revisadas: 2, verificadas: 1, inciertas: 1, errores: 0 });
  assert.equal(repo.filas.get(a.clave)?.estado, "verificada");
  assert.equal(repo.filas.get(b.clave)?.estado, "incierta");
});

test("si falla el checkpoint posterior a files.create, nunca se ejecuta una segunda subida", async () => {
  const repo = new RepoMemoria();
  repo.fallarCheckpoint = true;
  const drive = transporte();
  await assert.rejects(
    ejecutarSubidaDriveDurable("doc:checkpoint", "folder-1", "aprobado", repo, drive, 1),
    SubidaDriveInciertaError
  );
  await assert.rejects(
    ejecutarSubidaDriveDurable("doc:checkpoint", "folder-1", "aprobado", repo, drive, 2),
    SubidaDriveInciertaError
  );
  assert.equal(drive.subidas.length, 1);
});
