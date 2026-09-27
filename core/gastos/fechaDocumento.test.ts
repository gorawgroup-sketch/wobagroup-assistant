import {test} from 'node:test';
import assert from 'node:assert/strict';
import {esFechaDocumentoValida} from './fechaDocumento';
test('sin fecha documental no se permite sustituir por la fecha de procesamiento',()=>{
 for(const fecha of [undefined,'',' ','2026-02-30','2026-13-01','09/09/2026'])assert.equal(esFechaDocumentoValida(fecha),false);
 assert.equal(esFechaDocumentoValida('2026-09-09'),true);
 assert.equal(esFechaDocumentoValida('2024-02-29'),true);
});
