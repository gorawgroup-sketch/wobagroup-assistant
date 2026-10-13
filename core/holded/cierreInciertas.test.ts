import assert from "node:assert/strict";
import test from "node:test";
import { cerrarInciertasAntiguas, mismoProveedor, type CompraPosterior, type DepsCierreInciertas } from "./cierreInciertas";
import type { RegistroCreacionContacto } from "./durableContact";
import type { RegistroCreacionCompra } from "./durablePurchase";

/**
 * Cierre automático de inciertos antiguos: solo se cierra lo que la lectura de Holded demuestra; lo dudoso avisa una vez, sin botones;
 * nada se cierra con una lectura fallida, ni con registros jóvenes, ni en simulación.
 */
const AHORA = Date.UTC(2026, 9, 13, 9, 0, 0);
const DIA = 24 * 60 * 60_000;

const contacto = (o: Partial<RegistroCreacionContacto> = {}): RegistroCreacionContacto => ({
  clave: "c1", proceso: "p", estado: "incierta", empresa: "Footprint", nombre: "Albert Heijn 1653 Schiphol", nombreNormalizado: "albert heijn 1653 schiphol",
  huellaSolicitud: "h", creadoEn: AHORA - 22 * DIA, actualizadoEn: AHORA - 22 * DIA, ...o,
});
const compra = (o: Partial<RegistroCreacionCompra> = {}): RegistroCreacionCompra => ({
  clave: "k1", proceso: "p", estado: "incierta", marcador: "[wobi:4d821d79aaaaaaaaaaaaaaaa]", empresa: "Footprint", contactId: "660e", fecha: "2026-09-11",
  huellaSolicitud: "h", creadoEn: AHORA - 22 * DIA, actualizadoEn: AHORA - 22 * DIA, ...o,
});
const posterior = (o: Partial<CompraPosterior> = {}): CompraPosterior => ({ id: "6ab1", fecha: "2026-09-11", contactId: "661c", contactoNombre: "Albert Heijn (Albert Heijn)", notas: "[wobi:ebc00351bbbb]", ...o });

function deps(o: Partial<DepsCierreInciertas> & { cerrados?: string[]; avisos?: string[] } = {}): DepsCierreInciertas {
  const cerrados = o.cerrados ?? [], avisos = o.avisos ?? [];
  return {
    contactosInciertos: async () => [], inspeccionarContacto: async () => ({ estado: "ausente" }), cerrarContacto: async (c) => { cerrados.push(c); return true; },
    comprasInciertas: async () => [], nombreDeContacto: async () => "ALBERT HEIJN", comprasPropiasPosteriores: async () => [],
    cerrarCompra: async (c) => { cerrados.push(c); return true; }, avisar: async (t) => { avisos.push(t); }, ahora: () => AHORA, ...o,
  };
}

test("mismoProveedor tolera el nombre repetido entre paréntesis pero no mezcla marcas", () => {
  assert.equal(mismoProveedor("ALBERT HEIJN", "Albert Heijn (Albert Heijn)"), true);
  assert.equal(mismoProveedor("Uber", "Uber Eats"), false);
  assert.equal(mismoProveedor("Uber", "uber"), true);
  assert.equal(mismoProveedor("", "Uber"), false);
  assert.equal(mismoProveedor("Booking", "Airbnb"), false);
});

test("contacto ausente en Holded → se cierra", async () => {
  const cerrados: string[] = [];
  const r = await cerrarInciertasAntiguas(deps({ cerrados, contactosInciertos: async () => [contacto()] }));
  assert.deepEqual(cerrados, ["c1"]);
  assert.equal(r.cerrados.length, 1);
});

test("contacto único: no se cierra (lo verifica el reconciliador); ambiguo: dudoso con un aviso", async () => {
  const cerrados: string[] = [], avisos: string[] = [];
  const unico = await cerrarInciertasAntiguas(deps({ cerrados, avisos, contactosInciertos: async () => [contacto()], inspeccionarContacto: async () => ({ estado: "unico", resultado: { id: "x" } as never }) }));
  assert.equal(unico.cerrados.length, 0); assert.equal(cerrados.length, 0); assert.equal(avisos.length, 0);
  const amb = await cerrarInciertasAntiguas(deps({ cerrados, avisos, contactosInciertos: async () => [contacto({ actualizadoEn: AHORA - 2 * DIA })], inspeccionarContacto: async () => ({ estado: "ambiguo", cantidad: 2 }) }));
  assert.equal(amb.dudosos.length, 1); assert.equal(cerrados.length, 0); assert.equal(avisos.length, 1);
  assert.doesNotMatch(avisos[0], /botón|✅|❌/);
});

test("una inspección fallida no cierra ni avisa", async () => {
  const cerrados: string[] = [], avisos: string[] = [];
  const r = await cerrarInciertasAntiguas(deps({ cerrados, avisos, contactosInciertos: async () => [contacto()], inspeccionarContacto: async () => { throw new Error("502"); } }));
  assert.equal(cerrados.length, 0); assert.equal(avisos.length, 0); assert.equal(r.omitidos, 1);
});

test("registros de menos de 24 h no se tocan", async () => {
  const cerrados: string[] = [];
  const r = await cerrarInciertasAntiguas(deps({ cerrados, contactosInciertos: async () => [contacto({ actualizadoEn: AHORA - 3_600_000 })], comprasInciertas: async () => [compra({ actualizadoEn: AHORA - 3_600_000 })], comprasPropiasPosteriores: async () => [posterior()] }));
  assert.equal(cerrados.length, 0); assert.equal(r.omitidos, 2);
});

test("compra sustituida por otra posterior del mismo proveedor y fecha → se cierra", async () => {
  const cerrados: string[] = [];
  const r = await cerrarInciertasAntiguas(deps({ cerrados, comprasInciertas: async () => [compra()], comprasPropiasPosteriores: async () => [posterior()] }));
  assert.deepEqual(cerrados, ["k1"]);
  assert.match(r.cerrados[0].motivo, /6ab1/);
});

test("compra: otra fecha u otro proveedor NO es prueba → dudoso", async () => {
  for (const p of [posterior({ fecha: "2026-09-12" }), posterior({ contactoNombre: "Mercadona", contactId: "zzz" })]) {
    const cerrados: string[] = [];
    const r = await cerrarInciertasAntiguas(deps({ cerrados, comprasInciertas: async () => [compra()], comprasPropiasPosteriores: async () => [p] }));
    assert.equal(cerrados.length, 0); assert.equal(r.dudosos.length, 1);
  }
});

test("compra con una posterior que lleva SU marca: el intento sí se hizo → no se cierra", async () => {
  const cerrados: string[] = [];
  const r = await cerrarInciertasAntiguas(deps({ cerrados, comprasInciertas: async () => [compra()], comprasPropiasPosteriores: async () => [posterior({ notas: "x [wobi:4d821d79aaaaaaaaaaaaaaaa]" })] }));
  assert.equal(cerrados.length, 0); assert.equal(r.dudosos.length, 0); assert.equal(r.omitidos, 1);
});

test("compra: si no se puede leer Holded no se cierra ni se avisa", async () => {
  const cerrados: string[] = [], avisos: string[] = [];
  await cerrarInciertasAntiguas(deps({ cerrados, avisos, comprasInciertas: async () => [compra()], nombreDeContacto: async () => { throw new Error("503"); } }));
  assert.equal(cerrados.length, 0); assert.equal(avisos.length, 0);
});

test("simulación: cuenta pero no cierra ni avisa", async () => {
  const cerrados: string[] = [], avisos: string[] = [];
  const r = await cerrarInciertasAntiguas(deps({ cerrados, avisos, simular: true, contactosInciertos: async () => [contacto()], comprasInciertas: async () => [compra({ actualizadoEn: AHORA - 2 * DIA })], comprasPropiasPosteriores: async () => [] }));
  assert.equal(r.cerrados.length, 1); assert.equal(r.dudosos.length, 1); assert.equal(cerrados.length, 0); assert.equal(avisos.length, 0); assert.equal(r.simulado, true);
});

test("dudoso: un único aviso mientras tiene entre 1 y 3 días; después, silencio", async () => {
  const avisos: string[] = [];
  const base = { avisos, comprasInciertas: async () => [compra({ actualizadoEn: AHORA - 2 * DIA })] };
  await cerrarInciertasAntiguas(deps(base)); assert.equal(avisos.length, 1);
  await cerrarInciertasAntiguas(deps({ avisos, comprasInciertas: async () => [compra({ actualizadoEn: AHORA - 10 * DIA })] })); assert.equal(avisos.length, 1);
});

test("si otro proceso ya resolvió el registro (cerrar devuelve false) no cuenta como cierre", async () => {
  const r = await cerrarInciertasAntiguas(deps({ contactosInciertos: async () => [contacto()], cerrarContacto: async () => false }));
  assert.equal(r.cerrados.length, 0); assert.equal(r.omitidos, 1);
});
