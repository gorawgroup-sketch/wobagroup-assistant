import test from "node:test";
import assert from "node:assert/strict";
import { createStreamingWobiSpeech } from "./wobiRealtimeSpeech.js";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class Context extends EventTarget {
  state = "suspended"; currentTime = 0; sources = []; destination = {}; resumes = 0;
  async resume() { this.resumes++; this.state = "running"; this.dispatchEvent(new Event("statechange")); }
  async close() { this.state = "closed"; }
  createBuffer(_channels, samples, rate) { const data = new Float32Array(samples); return { duration: samples / rate, getChannelData: () => data, data }; }
  createBufferSource() {
    const source = { connect() {}, disconnect() {}, start(time) { this.startTime = time; }, stop() { this.stopped = true; }, finish() { this.onended?.(); } };
    this.sources.push(source); return source;
  }
}
const pcmHeaders = { "X-Audio-Format": "pcm-s16le", "X-Audio-Sample-Rate": "24000" };
const response = bytes => new Response(bytes, { headers: pcmHeaders });

test("enabling voice unlocks audio without transmitting chat text", async () => {
  const context = new Context(); let requests = 0;
  const player = createStreamingWobiSpeech({ makeContext: () => context, fetchAudio: async () => { requests++; } });
  await player.activate(); assert.equal(context.resumes, 1); assert.equal(requests, 0); player.dispose();
});

test("audio starts before the response stream finishes; muting aborts download and scheduled sound", async () => {
  const context = new Context(); const playing = deferred(); let stream; let requestSignal;
  const player = createStreamingWobiSpeech({ makeContext: () => context, onStateChange: state => { if (state === "playing") playing.resolve(); },
    fetchAudio: async (_url, {signal}) => {
      requestSignal = signal;
      return response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new Uint8Array(5760)); signal.addEventListener("abort", () => controller.error(signal.reason), { once:true }); } }));
    },
  });
  await player.activate(); const speaking = player.speak("Hola", {}); await playing.promise;
  assert.equal(context.sources.length, 1); assert.ok(stream); // Stream is deliberately still open.
  player.stop(); await speaking;
  assert.equal(requestSignal.aborted, true); assert.equal(context.sources[0].stopped, true);
});

test("prefetches following speech while playing and schedules contiguous audio across fragments", async () => {
  const context = new Context(); const second = deferred(); let requests = 0;
  const player = createStreamingWobiSpeech({ makeContext: () => context,
    fetchAudio: async () => { requests++; return response(new Uint8Array(5760)); },
    onStateChange: state => { if (state === "playing" && context.sources.length === 2) second.resolve(); },
  });
  await player.activate(); const speaking = player.speak("Una frase que mantiene una conversación natural. ".repeat(12), {});
  await second.promise;
  assert.equal(requests, 2);
  const [first, next] = context.sources;
  assert.equal(next.startTime, first.startTime + first.buffer.duration);
  for (const source of context.sources) source.finish();
  await speaking;
});

test("preserves PCM samples split at odd network byte boundaries", async () => {
  const context = new Context(); const playing = deferred();
  const player = createStreamingWobiSpeech({ makeContext: () => context,
    fetchAudio: async () => response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0])); c.enqueue(new Uint8Array([128, 255])); c.enqueue(new Uint8Array([127])); c.close(); } })),
    onStateChange: state => { if (state === "playing") playing.resolve(); },
  });
  await player.activate(); const speaking = player.speak("Hola", {}); await playing.promise;
  assert.deepEqual(Array.from(context.sources[0].buffer.data), [-1, 32767 / 32768]);
  context.sources[0].finish(); await speaking;
});

test("browser activation can resume once and later replies need no Play gesture", async () => {
  const context = new Context(); const blocked = deferred(); const playing = deferred();
  const player = createStreamingWobiSpeech({ makeContext: () => context, fetchAudio: async () => response(new Uint8Array(5760)),
    onStateChange: s => { if (s === "playing") playing.resolve(); },
  });
  const speaking = player.speak("Hola", {}, blocked.resolve); await blocked.promise;
  assert.equal(context.sources.length, 0); await player.activate(); await playing.promise;
  context.sources[0].finish(); await speaking;
  const playingAgain = deferred();
  // The context is reused; this reply starts with no additional activate().
  const second = player.speak("Otra respuesta", {});
  const poll = setInterval(() => { if (context.sources.length === 2) { clearInterval(poll); playingAgain.resolve(); } }, 1);
  await playingAgain.promise; context.sources[1].finish(); await second;
  assert.equal(context.resumes, 1);
});

test('swarm level follows analyser samples and resets when muted', async () => {
  const ctx=new Context();const levels=[];
  ctx.createAnalyser=()=>({fftSize:256,connect(){},disconnect(){},getByteTimeDomainData(data){data.fill(160);}});
  const speaker=createStreamingWobiSpeech({makeContext:()=>ctx,onAudioLevel:value=>levels.push(value),fetchAudio:async()=>new Response(new Uint8Array(6000),{headers:{'X-Audio-Format':'pcm-s16le','X-Audio-Sample-Rate':'24000'}})});
  await speaker.activate();const speaking=speaker.speak('Aquí está',{});
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.ok(levels.some(value=>value>0));speaker.stop();await speaking;
  assert.equal(levels.at(-1),0);speaker.dispose();
});

test('mobile buffers a complete phrase before playback despite delayed and odd network chunks', async () => {
 const ctx=new Context(), playing=deferred();let stream;const states=[];
 const player=createStreamingWobiSpeech({makeContext:()=>ctx,bufferBeforePlayback:()=>true,onStateChange:s=>{states.push(s);if(s==='playing')playing.resolve();},fetchAudio:async()=>response(new ReadableStream({start(c){stream=c;c.enqueue(new Uint8Array(5761));}}))});
 await player.activate();const speaking=player.speak('Marin completa la frase',{});
 await new Promise(r=>setTimeout(r,30));assert.equal(ctx.sources.length,0);assert.equal(states.at(-1),'loading');
 ctx.currentTime=2;stream.enqueue(new Uint8Array(5759));stream.close();await playing.promise;
 assert.equal(ctx.sources.length,1);assert.equal(ctx.sources[0].buffer.duration,0.24);
 ctx.sources[0].finish();await speaking;player.dispose();
});

test('an unlocked iPhone context interrupted by microphone recovers before the reply without a new synthesis', async()=>{
 const ctx=new Context(),playing=deferred();let requests=0;
 const player=createStreamingWobiSpeech({makeContext:()=>ctx,bufferBeforePlayback:()=>true,fetchAudio:async()=>{requests++;return response(new Uint8Array(5760));},onStateChange:s=>{if(s==='playing')playing.resolve();}});
 await player.activate();ctx.state='interrupted';
 const speaking=player.speak('Respuesta después de hablar',{});await playing.promise;
 assert.equal(ctx.state,'running');assert.equal(ctx.resumes,2);assert.equal(requests,1);
 ctx.sources[0].finish();await speaking;player.dispose();
});

test('interruption during playback resumes the same buffer and stop prevents later recovery',async()=>{
 const ctx=new Context(),playing=deferred(),recovered=deferred();let requests=0;const states=[];
 const player=createStreamingWobiSpeech({makeContext:()=>ctx,fetchAudio:async()=>{requests++;return response(new Uint8Array(5760));},onStateChange:s=>{states.push(s);if(s==='playing'){playing.resolve();if(states.includes('blocked'))recovered.resolve();}}});
 await player.activate();const speaking=player.speak('No cortar la respuesta',{});await playing.promise;
 ctx.state='interrupted';ctx.dispatchEvent(new Event('statechange'));await recovered.promise;
 assert.equal(requests,1);assert.equal(ctx.sources.length,1);assert.notEqual(ctx.sources[0].stopped,true);assert.equal(ctx.resumes,2);
 player.stop();await speaking;ctx.state='interrupted';ctx.dispatchEvent(new Event('statechange'));await Promise.resolve();assert.equal(ctx.resumes,2);player.dispose();
});

test('when automatic resume is denied the prepared reply waits for the user tap without refetching',async()=>{
 const ctx=new Context(),playing=deferred(),blocked=deferred();let deny=false,requests=0;const normal=ctx.resume.bind(ctx);
 ctx.resume=async()=>{if(deny)throw new Error('NotAllowedError');return normal();};
 const player=createStreamingWobiSpeech({makeContext:()=>ctx,fetchAudio:async()=>{requests++;return response(new Uint8Array(5760));},onStateChange:s=>{if(s==='playing')playing.resolve();if(s==='blocked')blocked.resolve();}});
 await player.activate();const speaking=player.speak('Mantener la frase',{});await playing.promise;deny=true;ctx.state='interrupted';ctx.dispatchEvent(new Event('statechange'));await blocked.promise;await new Promise(r=>setTimeout(r,10));
 assert.equal(ctx.state,'interrupted');deny=false;await player.activate();assert.equal(ctx.state,'running');assert.equal(requests,1);assert.equal(ctx.sources.length,1);ctx.sources[0].finish();await speaking;player.dispose();
});

test('delayed microphone release recovers automatically without requesting voice until audio is running',async()=>{
 const ctx=new Context(),playing=deferred();let released=false,requests=0;const normal=ctx.resume.bind(ctx);
 ctx.resume=async()=>{if(!released&&ctx.state==='interrupted'){ctx.resumes++;return;}return normal();};
 const player=createStreamingWobiSpeech({makeContext:()=>ctx,fetchAudio:async()=>{assert.equal(ctx.state,'running');requests++;return response(new Uint8Array(5760));},onStateChange:s=>{if(s==='playing')playing.resolve();}});
 await player.activate();ctx.state='interrupted';const speaking=player.speak('Respuesta tras liberar el micrófono',{});setTimeout(()=>{released=true},40);await playing.promise;assert.equal(requests,1);assert.equal(ctx.resumes,3);ctx.sources[0].finish();await speaking;player.dispose();
});
