import { useEffect, useRef } from 'react';

/** A live, bounded swarm, drawn locally. No image, video, network or perpetual hidden loop. */
export default function NanoField({ expanded = false, activeNode = null, nodes = [], compact = false }) {
  const ref = useRef(null);
  const config = useRef({ expanded, activeNode, nodes });
  const redraw = useRef(null);
  useEffect(() => { config.current = { expanded, activeNode, nodes }; redraw.current?.(); }, [expanded, activeNode, nodes]);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const count = compact ? 1000 : 2800;
    const particles = Array.from({ length: count }, (_, i) => {
      const y = 1 - 2 * (i + .5) / count;
      return { y, ring: Math.sqrt(1 - y * y), angle: i * 2.399963, seed: Math.sin(i * 127.1) * .5 + .5, amber: i % 7 === 0 };
    });
    const focusStrength = new Map();
    let frame = 0, width = 0, height = 0, last = 0, time = 0, spread = 0;
    const dot = (x, y, size, alpha, amber, glow = false) => {
      if (compact) size *= .65;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = amber ? '#ffc36d' : '#62d8ff';
      if (glow) { ctx.globalAlpha = alpha * .12; ctx.beginPath(); ctx.arc(x,y,size * 4,0,Math.PI * 2);ctx.fill();ctx.globalAlpha = alpha; }
      ctx.fillRect(x-size/2,y-size/2,size,size);
    };
    const draw = () => {
      const reduced = motion.matches;
      const t = reduced ? 0 : time;
      spread += ((config.current.expanded ? 1 : 0) - spread) * .075;
      const cx = width / 2, cy = height * .47;
      const radius = Math.min(width * .28, height * .31, 175) * (1 + spread * .08);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, width, height);
      const glow = ctx.createRadialGradient(cx,cy,0,cx,cy,radius * 1.3);
      glow.addColorStop(0,'#168dcc32');glow.addColorStop(.55,'#0c62b51c');glow.addColorStop(1,'#07385400');
      ctx.fillStyle=glow;ctx.fillRect(0,0,width,height);
      const rotation=t * .34, tilt=.28 + Math.sin(t*.18)*.13;
      // Multiple rotating ribbons form a volume; amber particles circulate through its inner layers.
      for (let i=0;i<count;i++) {
        const p=particles[i];
        const a=p.angle+rotation+Math.sin(p.y*4+t*.55)*.25;
        const breathing=1+Math.sin(a*3+p.y*5+t*.8)*.07;
        const layer=(i%4===0 ? .58+p.seed*.3 : .88+p.seed*.12)*breathing;
        const x=p.ring*Math.cos(a)*layer;
        const z=p.ring*Math.sin(a)*layer;
        const y=p.y*layer;
        const ry=y*Math.cos(tilt)-z*Math.sin(tilt);
        const rz=y*Math.sin(tilt)+z*Math.cos(tilt);
        const perspective=2.8/(2.8-rz*.45);
        const px=cx+x*radius*perspective, py=cy+ry*radius*perspective;
        const front=(rz+1)/2;
        const alpha=.3+front*.68;
        const size=(1+front*1.25)*(p.amber ? 1.2 : 1);
        dot(px,py,size,alpha,p.amber,i%17===0&&front>.4);
      }
      // Warm filaments circulate through the center, preserving WOBi's amber identity.
      const filamentCount = compact ? 190 : 520;
      for(let i=0;i<filamentCount;i++) {
        const u=i/filamentCount;
        const a=u*Math.PI*18-t*.9;
        const waist=.14+Math.sin(u*Math.PI)*.25;
        const depth=(Math.sin(a)+1)/2;
        const x=cx+Math.cos(a)*radius*waist;
        const y=cy+(u-.5)*radius*1.65+Math.sin(a)*radius*.12;
        dot(x,y,1.2+depth*1.3,.35+depth*.6,true,i%11===0);
      }
      // Orbiting nanobots travel outward to the same areas that the operator can open.
      for (const [index,node] of config.current.nodes.entries()) {
        const goal = config.current.activeNode === node.id ? (node.flow ?? 1) : 0;
        const strength=reduced ? goal : (focusStrength.get(node.id)||0)+(goal-(focusStrength.get(node.id)||0))*.1;
        focusStrength.set(node.id,strength);
        let nx=node.x;
        if(width<700 && (index===1 || index===5 || index===10)) nx=index===5 ? 85 : 82;
        const tx=width*nx/100, ty=height*node.y/100;
        const dx=tx-cx,dy=ty-cy,length=Math.hypot(dx,dy)||1;
        const sx=cx+dx/length*radius*.8, sy=cy+dy/length*radius*.8;
        const amount=30+Math.round(strength*45);
        for(let j=0;j<amount;j++) {
          const progress=reduced ? j/amount : (j/amount+t*(.16+strength*.17))%1;
          const curve=Math.sin(progress*Math.PI)*Math.sin(t*.8+index)*26;
          const curl=Math.sin(progress*16-t*2+j*.2)*(1-progress)*7;
          const x=sx+(tx-sx)*progress-dy/length*(curve+curl);
          const y=sy+(ty-sy)*progress+dx/length*(curve+curl);
          const alpha=(.1+strength*.65)*Math.sin(progress*Math.PI)*(node.flow ?? 1);
          dot(x,y,.9+strength*.9,alpha,j%6===0);
        }
        // A small halo assembles the destination instead of a static connector line.
        for(let j=0;j<18;j++) {
          const a=j*Math.PI/9-t*.6;
          dot(tx+Math.cos(a)*(17+strength*6),ty+Math.sin(a)*(17+strength*6),1,(.12+strength*.45)*(node.flow ?? 1),j%6===0);
        }
      }
      // Loose outer particles make the boundary breathe instead of looking like a rigid globe.
      for(let i=0;i<(compact ? 75 : 240);i++) {
        const a=i*2.399963-t*.12;
        const r=radius*(1.07+(Math.sin(i*29)*.5+.5)*.62);
        dot(cx+Math.cos(a)*r,cy+Math.sin(a)*r*.7+Math.sin(a*3+t)*9,.8,.15+(i%5)*.035,i%17===0);
      }
      ctx.globalAlpha=1;
    };
    const loop = now => {
      if(now-last>=32) { time+=Math.min(now-last,80)/1000;last=now;draw(); }
      frame=requestAnimationFrame(loop);
    };
    const resume = () => { cancelAnimationFrame(frame);last=performance.now();draw();if(!motion.matches&&!document.hidden)frame=requestAnimationFrame(loop); };
    redraw.current=()=>{ if(motion.matches)draw(); };
    const observer=new ResizeObserver(([entry])=>{
      width=entry.contentRect.width;height=entry.contentRect.height;
      const dpr=Math.min(window.devicePixelRatio||1,2);
      canvas.width=width*dpr;canvas.height=height*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);resume();
    });
    observer.observe(canvas);
    document.addEventListener('visibilitychange',resume);motion.addEventListener('change',resume);
    return ()=>{cancelAnimationFrame(frame);redraw.current=null;observer.disconnect();document.removeEventListener('visibilitychange',resume);motion.removeEventListener('change',resume);};
  }, [compact]);
  return <canvas ref={ref} className="nv-field" aria-hidden="true" />;
}
