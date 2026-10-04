import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { crearRouterDocumentos } from './router';
import { ROOT_FOLDERS } from '../../drive/rootFolders';

async function run(router: ReturnType<typeof crearRouterDocumentos>, scenario: (url: string) => Promise<void>) {
  const app = express(); app.use('/documentos', router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await scenario(`http://127.0.0.1:${address.port}/documentos`); }
  finally { server.closeAllConnections(); server.close(); }
}
const auth = async (req: express.Request, res: express.Response) => {
  if (req.get('X-Cerebro-Key') === 'sesion') return true;
  res.sendStatus(403); return false;
};
const headers = { 'X-Cerebro-Key': 'sesion' };
test('exige sesión y selecciona exclusivamente la raíz validada de la compañía', async () => {
  const calls: string[][] = [];
  await run(crearRouterDocumentos(auth, async (root, query) => { calls.push([root, query]); return []; }), async url => {
    assert.equal((await fetch(`${url}?empresa=WOBA&q=estatutos`)).status, 403);
    for (const q of ['empresa=otra&q=estatutos','empresa=__proto__&q=estatutos','empresa=WOBA&q=ab','empresa=WOBA&empresa=EWORKS&q=estatutos']) {
      assert.equal((await fetch(`${url}?${q}`, { headers })).status, 400);
    }
    assert.deepEqual(calls, []);
    for (const empresa of ['WOBA','EWORKS','Footprint']) {
      const res = await fetch(`${url}?empresa=${empresa}&q=estatutos`, { headers });
      assert.equal(res.status, 200); assert.equal(res.headers.get('Cache-Control'), 'no-store');
      assert.equal((await res.json() as { empresa: string }).empresa, empresa);
    }
    assert.deepEqual(calls, ['WOBA','EWORKS','Footprint'].map(id => [ROOT_FOLDERS[id], 'estatutos']));
  });
});
test('un fallo de Drive no se convierte en una lista vacía ni filtra detalles internos', async () => {
  await run(crearRouterDocumentos(auth, async () => { throw Error('credential secret'); }), async url => {
    const res = await fetch(`${url}?empresa=WOBA&q=estatutos`, { headers });
    assert.equal(res.status, 503);
    const data = await res.json() as { resultados?: unknown }; assert.equal(data.resultados, undefined); assert.doesNotMatch(JSON.stringify(data), /credential secret/);
  });
});
test('un timeout conserva el límite hasta que finaliza el trabajo subyacente', async () => {
  let resolve!: (value: []) => void;
  await run(crearRouterDocumentos(auth, () => new Promise(done => { resolve = done; }), 15), async url => {
    assert.equal((await fetch(`${url}?empresa=WOBA&q=estatutos`, { headers })).status, 503);
    assert.equal((await fetch(`${url}?empresa=EWORKS&q=estatutos`, { headers })).status, 429);
    resolve([]);
  });
});
