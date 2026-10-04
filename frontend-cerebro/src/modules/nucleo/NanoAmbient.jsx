import { useEffect, useRef } from 'react';

/** Decorative, local nanobot currents shared by every tool and disclosure. */
export default function NanoAmbient() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    const scope = canvas.parentElement;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let width = 0, height = 0, frame = 0, last = 0, time = 0, target = null, burst = 0;
    const controls = 'button,a,summary,input,select,textarea,.nv-metric,.nv-policy';
    const select = event => { target = event.target.closest?.(controls) || null; if (reduced.matches) draw(); };
    const clear = event => { if (!scope.contains(event.relatedTarget)) target = null; };
    const activate = event => { select(event); burst = 1; if (reduced.matches) draw(); };
    const draw = () => {
      ctx.clearRect(0,0,width,height);
      const t = reduced.matches ? 0 : time;
      // Coherent wisps: irregular density and shared velocity, never a dotted frame.
      const wisp = (cx,cy,rx,ry,phase,opacity,count) => {
        for (let i=0;i<count;i++) {
          const seed = Math.sin(i*127.1+phase)*43758.5453;
          const noise = seed-Math.floor(seed);
          const u = ((i*.618034+t*.075+phase)%1);
          const envelope = Math.sin(u*Math.PI);
          const lane = (noise-.5)*envelope;
          const x = cx+(u-.5)*rx;
          const y = cy+Math.sin(u*5.2+t*.32+phase)*ry*.3+lane*ry*.6;
          const alpha = envelope*opacity*(.25+noise*.65);
          const length = 1+noise*1.8;
          ctx.strokeStyle = i%29===0 ? '#dfb77b' : '#79d2ea';
          ctx.globalAlpha = alpha;
          ctx.lineWidth = .55;
          ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+length,y+Math.cos(u*5.2+t*.32+phase)*.5); ctx.stroke();
        }
      };
      // Sparse flowing material occupies empty margins, never the reading column.
      wisp(width*.78,16,Math.min(width*.35,260),48,0,.7,430);
      wisp(width*.20,height-16,Math.min(width*.35,260),48,2,.6,350);
      const origin = canvas.getBoundingClientRect();
      const source = scope.querySelector('.nv-module-glyph,.nv-area-emblem');
      const focused = target?.isConnected && scope.contains(target) ? target : null;
      const destinations = focused ? [focused] : [...scope.querySelectorAll('.nv-metric,.nv-tool-entry')].slice(0,3);
      if (source) {
        const sourceRect = source.getBoundingClientRect();
        const surfaceRect = scope.querySelector('.nv-module-surface')?.getBoundingClientRect();
        const sourceX = sourceRect.left-origin.left+sourceRect.width*.5;
        const sourceY = Math.max(20,sourceRect.bottom-origin.top-12);
        const gutterX = surfaceRect ? surfaceRect.left-origin.left+14 : width-14;
        for (const [index,destination] of destinations.entries()) {
          const rect = destination.getBoundingClientRect();
          if (rect.bottom<0 || rect.top>innerHeight) continue;
          const tx = rect.left-origin.left+rect.width*.5;
          const ty = rect.top-origin.top-9;
          // Route through the spaces outside the reading surfaces, then into their upper seam.
          const sourceSeam = sourceRect.bottom-origin.top+8;
          const points = [[sourceX,sourceY],[sourceX,sourceSeam],[gutterX,sourceSeam],[gutterX,ty],[tx,ty]];
          const lengths = points.slice(1).map((p,i)=>Math.hypot(p[0]-points[i][0],p[1]-points[i][1]));
          const total = lengths.reduce((a,b)=>a+b,0)||1;
          const count = focused ? 240 : 100;
          for (let i=0;i<count;i++) {
            const n = (Math.sin(i*127.1+index)*43758.5453)%1;
            const seed = Math.abs(n);
            const p = (i*.618034+t*(focused ? .22 : .12)+index*.31)%1;
            let distance = p*total, segment=0;
            while (segment<lengths.length-1 && distance>lengths[segment]) distance-=lengths[segment++];
            const a = points[segment], b = points[segment+1];
            const u = distance/(lengths[segment]||1);
            const dx=b[0]-a[0],dy=b[1]-a[1],len=lengths[segment]||1;
            const curl = Math.sin(p*24-t*2+seed*4)*(2+seed*3)*(focused ? 1 : .55);
            const x = a[0]+dx*u-dy/len*curl;
            const y = a[1]+dy*u+dx/len*curl;
            const parcel = .22+.78*Math.sin(p*10-t*.4+index)**6;
            ctx.globalAlpha = (focused ? .8 : .42)*parcel*(.4+seed*.6);
            ctx.fillStyle = i%13===0 ? '#edbb72' : '#65d6f2';
            const size = .7+seed*.65;
            ctx.fillRect(x,y,size,size);
          }
          if (focused) wisp(tx,ty,95+burst*70,14+burst*9,1,.75,150);
        }
      } else if (focused) {
        const rect = focused.getBoundingClientRect();
        wisp(rect.right-origin.left-12,rect.bottom-origin.top+9,100+burst*45,14+burst*6,1,.78,190);
      }
      burst *= .92;
      ctx.globalAlpha = 1;
    };
    const loop = now => {
      if (now-last >= 40) { time += Math.min(now-last,80)/1000; last = now; draw(); }
      frame = requestAnimationFrame(loop);
    };
    const resume = () => { cancelAnimationFrame(frame); last = performance.now(); draw(); if (!reduced.matches && !document.hidden) frame = requestAnimationFrame(loop); };
    const resize = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width; height = entry.contentRect.height;
      const dpr = Math.min(devicePixelRatio || 1,2);
      canvas.width = width*dpr; canvas.height = height*dpr; ctx.setTransform(dpr,0,0,dpr,0,0); resume();
    });
    resize.observe(canvas);
    scope.addEventListener('pointerover',select); scope.addEventListener('focusin',select);
    scope.addEventListener('pointerout',clear); scope.addEventListener('focusout',clear);
    scope.addEventListener('click',activate);
    document.addEventListener('visibilitychange',resume); reduced.addEventListener('change',resume);
    return () => {
      cancelAnimationFrame(frame); resize.disconnect();
      scope.removeEventListener('pointerover',select); scope.removeEventListener('focusin',select);
      scope.removeEventListener('pointerout',clear); scope.removeEventListener('focusout',clear);
      scope.removeEventListener('click',activate);
      document.removeEventListener('visibilitychange',resume); reduced.removeEventListener('change',resume);
    };
  }, []);
  return <canvas ref={ref} className="nv-nano-ambient" aria-hidden="true" />;
}
