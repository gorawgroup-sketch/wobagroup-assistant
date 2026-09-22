import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Regresión de producción: append desplazó A:K a J:T; el vigilante no veía la pendiente.
test('crear y restaurar pendientes usan escritura explícita verificada, nunca append', async () => {
  const source = await readFile(join(process.cwd(), 'core/gastos/gastoPendienteDatosStore.ts'), 'utf8');
  assert.doesNotMatch(source, /values\.append/);
  assert.equal(source.match(/await agregarFila\(TAB_NAME, HEADERS.length, HEADERS, pendienteToRow\(pendiente\)\)/g)?.length, 2);
  assert.match(source, /leerFilas\(TAB_NAME, HEADERS.length, HEADERS\)/);
  assert.match(source, /eliminarFilaKV\(TAB_NAME, rowIndex, HEADERS\)/);
});
