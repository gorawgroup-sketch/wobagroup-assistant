import test from 'node:test';import assert from 'node:assert/strict';
import {createBrowserWobiSpeech} from './wobiBrowserSpeech.js';
import {createResilientWobiSpeech} from './wobiResilientSpeech.js';
class Synth extends EventTarget{voices=[{lang:'es-MX',localService:false},{lang:'es-ES',localService:true}];utterances=[];cancels=0;getVoices(){return this.voices;}speak(u){this.utterances.push(u);u.onstart?.();}cancel(){this.cancels++;}}
class Utterance{constructor(text){this.text=text;}}
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
test('respaldo usa una voz española local y confirma inicio real',async()=>{
 const synthesis=new Synth(),states=[];const player=createBrowserWobiSpeech({synthesis,Utterance,onStateChange:s=>states.push(s)});
 const p=player.speak('Soy WOBi',new AbortController().signal);assert.equal(synthesis.utterances[0].text,'Soy Uóbi');assert.equal(synthesis.utterances[0].voice.localService,true);assert.deepEqual(states,['fallback']);synthesis.utterances[0].onend();await p;player.stop();assert.equal(synthesis.cancels,0);
});
test('silenciar cancela reproducción local y evita audio tardío mientras cargan voces',async()=>{
 const synthesis=new Synth(),player=createBrowserWobiSpeech({synthesis,Utterance});const controller=new AbortController();const p=player.speak('Hola',controller.signal);controller.abort();await p;assert.equal(synthesis.cancels,1);assert.equal(synthesis.utterances[0].onend,null);
 synthesis.voices=[];const p2=player.speak('No debe sonar',new AbortController().signal);player.stop();await p2;synthesis.voices=[{lang:'es-ES',localService:true}];synthesis.dispatchEvent(new Event('voiceschanged'));assert.equal(synthesis.utterances.length,1);
});
test('no usa voces remotas como respaldo sin avisar',async()=>{
 const synthesis=new Synth();synthesis.voices=[{lang:'es-MX',localService:false}];const player=createBrowserWobiSpeech({synthesis,Utterance});await assert.rejects(player.speak('Texto privado',new AbortController().signal),/voz española local/);assert.equal(synthesis.utterances.length,0);
});
const stream=speak=>({speak,activate:async()=>{},stop(){},dispose(){}});
test('503 de síntesis reproduce la misma respuesta con respaldo; el éxito normal no lo usa',async()=>{
 const texts=[],states=[];const player=createResilientWobiSpeech({makeStreaming:()=>stream(async()=>{throw Error('503');}),makeBrowser:()=>({supported:()=>true,speak:async t=>texts.push(t),stop(){}}),onStateChange:s=>states.push(s)});await player.speak('El costo es 10 USD',{});assert.deepEqual(texts,['El costo es 10 USD']);assert.deepEqual(states,['idle','loading','idle']);player.dispose();
 const ok=createResilientWobiSpeech({makeStreaming:()=>stream(async()=>{}),makeBrowser:()=>({supported:()=>true,speak:async()=>assert.fail('no debe usar respaldo'),stop(){}})});await ok.speak('Hola',{});ok.dispose();
});
test('una respuesta cancelada no comienza a hablar tras un fallo tardío',async()=>{
 const pending=deferred();let fallback=0;const player=createResilientWobiSpeech({makeStreaming:()=>stream(()=>pending.promise),makeBrowser:()=>({supported:()=>true,speak:async()=>fallback++,stop(){}})});const p=player.speak('Antigua',{});player.stop();pending.reject(Error('503 tardío'));await p;assert.equal(fallback,0);player.dispose();
});
test('silenciar también aborta el respaldo activo',async()=>{
 const began=deferred();let signal;const player=createResilientWobiSpeech({makeStreaming:()=>stream(async()=>{throw Error('503');}),makeBrowser:()=>({supported:()=>true,stop(){},speak:(_t,s)=>{signal=s;began.resolve();return new Promise(resolve=>s.addEventListener('abort',resolve,{once:true}));}})});const p=player.speak('Hola',{});await began.promise;player.stop();await p;assert.ok(signal.aborted);player.dispose();
});
