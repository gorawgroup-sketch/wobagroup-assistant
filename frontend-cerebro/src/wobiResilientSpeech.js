import {createStreamingWobiSpeech} from './wobiRealtimeSpeech.js';
import {createBrowserWobiSpeech} from './wobiBrowserSpeech.js';
export function createResilientWobiSpeech({onStateChange=()=>{},makeStreaming=createStreamingWobiSpeech,makeBrowser=createBrowserWobiSpeech,...options}={}){
 let generation=0,local,disposed=false;
 const stream=makeStreaming({...options,onStateChange:state=>{if(state!=='error')onStateChange(state);}});
 const browser=makeBrowser({onStateChange});
 const stop=()=>{generation++;local?.abort();local=undefined;browser.stop();stream.stop();onStateChange('idle');};
 const activate=async()=>{try{await stream.activate();}catch(error){if(!browser.supported())throw error;}};
 const speak=async(text,headers,onBlocked)=>{
  stop();const version=generation;
  try{await stream.speak(text,headers,onBlocked);}
  catch(error){
   if(disposed||version!==generation)return;
   if(!browser.supported()){onStateChange('error');throw error;}
   const controller=new AbortController();local=controller;
   onStateChange('loading');
   try{await browser.speak(text,controller.signal);}
   catch(fallbackError){if(!controller.signal.aborted){onStateChange('error');throw fallbackError;}}
   finally{if(local===controller)local=undefined;if(version===generation&&!disposed)onStateChange('idle');}
  }
 };
 const dispose=()=>{disposed=true;stop();stream.dispose();};
 return {speak,activate,stop,dispose};
}
