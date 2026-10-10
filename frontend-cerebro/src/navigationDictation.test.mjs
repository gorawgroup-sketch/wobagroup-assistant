import test from 'node:test';
import assert from 'node:assert/strict';
import { startDictation } from './modules/navegador/dictation.mjs';
function setup() {
  let rec; const submitted=[], errors=[], transcripts=[], listening=[];
  class Recognition {
    constructor(){rec=this;} start(){this.onstart();} stop(){this.onend();} abort(){this.onend();}
  }
  const control=startDictation(Recognition,{onListening:v=>listening.push(v),onTranscript:v=>transcripts.push(v),onSubmit:v=>submitted.push(v),onError:v=>errors.push(v)});
  const result=(text,final=true)=>{const r=[{transcript:text}];r.isFinal=final;rec.onresult({results:[r]});};
  return {rec,control,result,submitted,errors,transcripts,listening};
}
test('envía una frase final al terminar, sin Enter y sin duplicaciones',()=>{
 const s=setup();s.result('hola Wobi');assert.deepEqual(s.submitted,[]);s.rec.onend();s.rec.onend();s.result('otro');assert.deepEqual(s.submitted,['hola Wobi']);assert.deepEqual(s.listening,[true,false]);
});
test('terminar y enviar procesa el texto, cancelar nunca lo envía',()=>{
 const s=setup();s.result('abre seguros');s.control.stop();assert.deepEqual(s.submitted,['abre seguros']);
 const c=setup();c.result('abre seguros');c.control.abort();c.rec.onend();assert.deepEqual(c.submitted,[]);
});
test('errores, resultados provisionales, silencio y frases largas no envían órdenes parciales',()=>{
 const denied=setup();denied.result('abre seguros');denied.rec.onerror({error:'not-allowed'});denied.rec.onend();assert.deepEqual(denied.submitted,[]);assert.match(denied.errors[0],/permiso/);
 for(const [text,final] of [['provisional',false],['',true],['a'.repeat(201),true]]){const s=setup();s.result(text,final);s.rec.onend();assert.deepEqual(s.submitted,[]);assert.equal(s.errors.length,1);}
});
test('cancelación ignora resultados y errores tardíos',()=>{
 const s=setup();s.control.abort();s.result('abre seguros');s.rec.onerror({error:'network'});assert.deepEqual(s.transcripts,[]);assert.deepEqual(s.errors,[]);assert.deepEqual(s.submitted,[]);
});
