import test from 'node:test';
import assert from 'node:assert/strict';
import {movimientoCompatibleConGasto, inferirTagsCategoria, combinarTagsGastoAprendidos, nivelCompatibilidadMovimiento, candidatoUtilizableParaGasto, proveedorPareceEnDescripcion, compatibleSoloPorCategoria, motivoDescarteCargoPorNombre} from './write';
test('el importe exacto no permite cruzar proveedor ni categoría',()=>{
 assert.equal(movimientoCompatibleConGasto('Bolt','Taxi aeropuerto','Osteria Del Lovo'),false);
 assert.equal(movimientoCompatibleConGasto('Uber','Traslado taxi','Uber Eats'),false);
 assert.equal(movimientoCompatibleConGasto('Uber Eats','Comida','Uber trip'),false);
 assert.equal(movimientoCompatibleConGasto('Bolt','Taxi aeropuerto','Bolt.eu/o/2610011234'),true);
 assert.equal(movimientoCompatibleConGasto('UBER COLOMBIA','Traslado taxi','Payu*uber'),true);
 assert.equal(movimientoCompatibleConGasto('Uber Eats','Comida','UBER EATS'),true);
 assert.equal(movimientoCompatibleConGasto('Bolt','Taxi aeropuerto',''),false);
 assert.equal(movimientoCompatibleConGasto('Bolt','Taxi aeropuerto','Cabify Madrid'),true);
 assert.equal(movimientoCompatibleConGasto('Restaurante A','Comida','Restaurante B'),true);
 assert.equal(movimientoCompatibleConGasto('Bolt','Taxi aeropuerto','Hotel Orly'),false);
});

test('un desayuno independiente no hereda hospedaje del hotel', () => {
  assert.deepEqual(inferirTagsCategoria('Desayuno en Hotel Central', 'Hotel Central'), ['alimentacion']);
  assert.deepEqual(inferirTagsCategoria('Hospedaje con desayuno incluido', 'Hotel Central'), ['hospedaje']);
  assert.deepEqual(combinarTagsGastoAprendidos('Desayuno — Alejandro Florez', 'Hotel Central', undefined, ['kelly','hospedaje']), ['alejandroflorez','alimentacion']);
});

const CONCEPTO_CAFE = 'Café — JUST B CUZ PLM, San Juan, Puerto Rico — Simon Talloen — pagado con Revolut (comprobante visual generado desde el cuerpo del correo, sin adjunto original)';

test('caso real 2026-09-28: «JUST B CUZ PLM» y «Par*just B Cuz Luxury» comparten el núcleo de marca', () => {
  assert.equal(proveedorPareceEnDescripcion('JUST B CUZ PLM', 'Par*just B Cuz Luxury', { nucleoDeMarca: true }), true);
  assert.equal(movimientoCompatibleConGasto('JUST B CUZ PLM', CONCEPTO_CAFE, 'Par*just B Cuz Luxury', { nucleoDeMarca: true }), true);
  // Un solo término compartido, o palabras genéricas, no bastan.
  assert.equal(proveedorPareceEnDescripcion('Cafe Central', 'Cafe Mayor', { nucleoDeMarca: true }), false);
  assert.equal(proveedorPareceEnDescripcion('Just Eat', 'Sq *Just Paid', { nucleoDeMarca: true }), false);
  // Medido sobre datos reales de Holded (87 proveedores × 600 descriptores): el único par nuevo era este falso positivo.
  assert.equal(proveedorPareceEnDescripcion('SIXT RENT A CAR SL', 'Go Rent A Car', { nucleoDeMarca: true }), false);
  assert.equal(proveedorPareceEnDescripcion('Hotel Central Madrid', 'Hotel Central Lima', { nucleoDeMarca: true }), true, 'dos términos distintivos; lo decide además el importe y la fecha');
});

test('nivel «por_confirmar»: categoría desconocida + importe, moneda y fecha exactos; nunca con categorías contradictorias', () => {
  const evidencia = { importeYFechaExactos: true };
  assert.equal(nivelCompatibilidadMovimiento('Mi Cafetería', 'Café', 'SQ *XYZ 88', evidencia), 'por_confirmar');
  // Sin la evidencia de importe y fecha, un nombre irreconocible sigue siendo incompatible.
  assert.equal(nivelCompatibilidadMovimiento('Mi Cafetería', 'Café', 'SQ *XYZ 88'), 'incompatible');
  // Categorías contradictorias impiden la asociación incluso con importe y fecha exactos (política #204).
  assert.equal(nivelCompatibilidadMovimiento('Bolt', 'Taxi aeropuerto', 'Osteria Del Lovo', evidencia), 'incompatible');
  assert.equal(nivelCompatibilidadMovimiento('Uber', 'Traslado taxi', 'Uber Eats', evidencia), 'incompatible');
  // Sin descripción no hay nada que confirmar.
  assert.equal(nivelCompatibilidadMovimiento('Mi Cafetería', 'Café', '', evidencia), 'incompatible');
  // Lo ya compatible por nombre no necesita evidencia adicional.
  assert.equal(nivelCompatibilidadMovimiento('Bolt', 'Taxi aeropuerto', 'Bolt.eu/o/2610011234'), 'compatible');
});

test('un candidato marcado por_confirmar es utilizable; uno sin marca depende de nombre/categoría', () => {
  assert.equal(candidatoUtilizableParaGasto('Mi Cafetería', 'Café', { descripcion: 'SQ *XYZ 88', compatibilidad: 'por_confirmar' }), true);
  assert.equal(candidatoUtilizableParaGasto('Mi Cafetería', 'Café', { descripcion: 'SQ *XYZ 88' }), false);
  assert.equal(candidatoUtilizableParaGasto('Bolt', 'Taxi', { descripcion: 'Bolt.eu/o/1' }), true);
});

test('compatible solo por categoría: el nombre no se reconoce y solo coinciden los rubros', () => {
  const manual = { nucleoDeMarca: true };
  // Caso real: un ticket sin proveedor identificado (café) frente al cargo de un restaurante: solo la categoría (alimentación).
  assert.equal(compatibleSoloPorCategoria('Sin identificar (ticket sin nombre de establecimiento visible)', 'Consumo cafetería (Croissant + Chemex)', 'La Ultima Cena', manual), true);
  // Cuando el nombre sí se reconoce, no es «solo por categoría».
  assert.equal(compatibleSoloPorCategoria('LA ULTIMA CENA', 'Cena restaurante', 'La Ultima Cena', manual), false);
  assert.equal(compatibleSoloPorCategoria('UBER COLOMBIA', 'Traslado Uber', 'Uber Pending', manual), false);
  // Incompatible (categorías contradictorias) no es compatible por categoría.
  assert.equal(compatibleSoloPorCategoria('Bolt', 'Taxi aeropuerto', 'Osteria Del Lovo', manual), false);
});

test('caso real 2026-10-12: «Bk» (2 letras) con importe y fecha exactos es POR CONFIRMAR, no «no encontré nada»; sin esa evidencia sigue incompatible', () => {
  const proveedor = 'Burger King Isolatorweg (Amsterdam)';
  const concepto = 'Comida Burger King — Isolatorweg 25, Ámsterdam (AMS) — Nuria Ortiz — 9 oct 2026 — evento Avistic/APECS Noruega';
  for (const descripcion of ['Bk', 'BK', 'bk']) {
    assert.equal(nivelCompatibilidadMovimiento(proveedor, concepto, descripcion, { importeYFechaExactos: true }), 'por_confirmar', descripcion);
    assert.equal(nivelCompatibilidadMovimiento(proveedor, concepto, descripcion), 'incompatible', `${descripcion}: sin evidencia exacta no se ofrece`);
  }
  // Una descripción vacía o sin letras/números no es evidencia de nada; una categoría conocida distinta tampoco.
  for (const descripcion of ['', ' ', '*', '--']) assert.equal(nivelCompatibilidadMovimiento(proveedor, concepto, descripcion, { importeYFechaExactos: true }), 'incompatible', JSON.stringify(descripcion));
  assert.equal(nivelCompatibilidadMovimiento(proveedor, concepto, 'Uber', { importeYFechaExactos: true }), 'incompatible');
});

test('la explicación de un cargo descartado dice la causa REAL (antes mezclaba fecha y categoría aunque fallara otra cosa)', () => {
  const p = 'Burger King Isolatorweg (Amsterdam)', c = 'Comida Burger King';
  assert.match(motivoDescarteCargoPorNombre(c, p, 'Bk', { importeExacto: true, diasDeDiferencia: 3 }), /no coinciden la fecha \(±1 día\) \(3 días de diferencia\)/);
  assert.doesNotMatch(motivoDescarteCargoPorNombre(c, p, 'Bk', { importeExacto: true, diasDeDiferencia: 3 }), /categor/);
  assert.match(motivoDescarteCargoPorNombre(c, p, 'Uber', { importeExacto: true, diasDeDiferencia: 0 }), /la categoría del cargo ya es conocida \(.+\)/);
  assert.match(motivoDescarteCargoPorNombre(c, p, 'Bk', { importeExacto: false, diasDeDiferencia: 0 }), /el importe no es exacto/);
  assert.match(motivoDescarteCargoPorNombre(c, p, '*', { importeExacto: true, diasDeDiferencia: 0 }), /descripción del cargo está vacía/);
  assert.match(motivoDescarteCargoPorNombre(c, p, 'Bk', { importeExacto: true, diasDeDiferencia: Number.NaN }), /no coinciden la fecha/);
});

test('INVARIANTE: un cargo de importe y día exactos con categoría desconocida NUNCA queda «incompatible» por el aspecto de su descripción (longitud, mayúsculas, signos, cifras)', () => {
  const proveedor = 'Proveedor Inventado Uno SL', concepto = 'Servicio varios';
  let semilla = 20261012; // generador determinista: la misma tanda en cada ejecución
  const azar = (n: number) => { semilla = (semilla * 1103515245 + 12345) & 0x7fffffff; return semilla % n; };
  const alfabeto = 'abcdefghijklmnopqrstuvwxyz0123456789 *.-/';
  let probadas = 0;
  for (let i = 0; i < 600; i++) {
    const largo = 2 + azar(28);
    let d = ''; for (let j = 0; j < largo; j++) d += alfabeto[azar(alfabeto.length)];
    if (azar(2)) d = d.toUpperCase();
    // Solo descripciones con al menos 2 letras/números y sin categoría conocida (las demás tienen su propia regla, probada aparte).
    if (d.replace(/[^a-z0-9]/gi, '').length < 2 || inferirTagsCategoria(d, '').length > 0) continue;
    probadas++;
    assert.notEqual(nivelCompatibilidadMovimiento(proveedor, concepto, d, { importeYFechaExactos: true }), 'incompatible', `«${d}» se descartaría con importe y día exactos`);
  }
  assert.ok(probadas > 300, `solo se probaron ${probadas} descripciones`);
});
