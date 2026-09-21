import test from 'node:test';
import assert from 'node:assert/strict';
import { etiquetasEdicionCompra } from './write';

test('reparar viajero elimina la etiqueta anterior también de las líneas que Holded agrega al documento', () => {
  const original = [{name:'Vuelo Alejandro',price:192.28,account:'travel',taxes:[],tags:['avion','simon','transporte']}];
  const tags = ['avion','alejandroflorez','transporte'];
  const items = etiquetasEdicionCompra(original,tags);
  const visibles = new Set([...tags,...items.flatMap(item=>item.tags)]);
  assert.deepEqual([...visibles].sort(),tags.sort());
  assert.equal(items[0].price,192.28);
  assert.equal(items[0].account,'travel');
  assert.deepEqual(items[0].taxes,[]);
  assert.deepEqual(original[0].tags,['avion','simon','transporte']);
});

test('una edición sin etiquetas conserva la clasificación particular de cada línea', () => {
  const items=[{tags:['alimentacion']},{tags:['transporte']}];
  assert.deepEqual(etiquetasEdicionCompra(items),items);
});

test('borrar etiquetas explícitamente limpia todas las líneas sin alterar sus importes', () => {
  const items=[{price:10,tags:['simon']},{price:20,tags:['simon']}];
  assert.deepEqual(etiquetasEdicionCompra(items,[]),[{price:10,tags:[]},{price:20,tags:[]}]);
});
