// Respaldo local: no envía el texto a otro servicio ni cambia la voz habitual.
export function createBrowserWobiSpeech({synthesis=globalThis.speechSynthesis,Utterance=globalThis.SpeechSynthesisUtterance,onStateChange=()=>{}}={}) {
 let active;
 const supported=()=>Boolean(synthesis&&Utterance);
 const stop=()=>{const request=active;active=undefined;if(!request)return;request.cleanup();if(request.started)synthesis.cancel();request.resolve();};
 const voices=()=>synthesis.getVoices().filter(v=>v.localService===true&&/^es(?:-|_)/i.test(v.lang)).sort((a,b)=>Number(/^es-MX$/i.test(b.lang))-Number(/^es-MX$/i.test(a.lang)));
 async function speak(text,signal){
  if(!supported())throw Error('Este navegador no admite la voz de respaldo.');
  signal.throwIfAborted();stop();
  return new Promise((resolve,reject)=>{
   let timer;
   const request={started:false,resolve,cleanup:()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);synthesis.removeEventListener?.('voiceschanged',tryStart);if(request.utterance){request.utterance.onstart=null;request.utterance.onend=null;request.utterance.onerror=null;}}};
   active=request;
   const finish=error=>{if(active!==request)return;active=undefined;request.cleanup();if(error&&request.started)synthesis.cancel();error?reject(error):resolve();};
   const abort=()=>stop();
   const tryStart=()=>{
    if(active!==request||request.started||signal.aborted)return;
    const voice=voices()[0];if(!voice)return;
    const utterance=new Utterance(text.replace(/\bWOBI\b/gi,'Uóbi'));request.utterance=utterance;
    utterance.voice=voice;utterance.lang=voice.lang;utterance.rate=1;
    utterance.onstart=()=>{if(active===request){clearTimeout(timer);timer=setTimeout(()=>finish(Error('La voz de respaldo no terminó correctamente.')),Math.max(30000,text.length*150));onStateChange('fallback');}};
    utterance.onend=()=>finish();
    utterance.onerror=()=>finish(Error('No pude reproducir la voz de respaldo.'));
    request.started=true;clearTimeout(timer);timer=setTimeout(()=>finish(Error('El navegador no inició la voz de respaldo.')),5000);synthesis.removeEventListener?.('voiceschanged',tryStart);
    try{synthesis.speak(utterance);}catch{finish(Error('El navegador bloqueó la voz de respaldo.'));}
   };
   signal.addEventListener('abort',abort,{once:true});
   synthesis.addEventListener?.('voiceschanged',tryStart);
   timer=setTimeout(()=>finish(Error('No hay una voz española local disponible en este navegador.')),1500);
   tryStart();
  });
 }
 return {supported,speak,stop};
}
