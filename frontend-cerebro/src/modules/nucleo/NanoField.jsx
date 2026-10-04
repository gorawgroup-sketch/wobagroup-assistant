import { useEffect, useRef } from 'react';

/** Decorative field: no timers while hidden, bounded DPR, respects motion preference. */
export default function NanoField() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let width = 0;
    let height = 0;
    let last = 0;
    const draw = (now = 0) => {
      const t = motion.matches ? 0 : now / 18000;
      ctx.clearRect(0, 0, width, height);
      for (let ring = 0; ring < 4; ring++) {
        const radius = Math.min(width, height) * (.22 + ring * .075);
        for (let i = 0; i < 85; i++) {
          const a = i * 2.399963 + t * (ring % 2 ? -1 : 1);
          const wave = Math.sin(a * 3 + t * 2 + ring) * 10;
          const x = width / 2 + Math.cos(a) * (radius + wave);
          const y = height / 2 + Math.sin(a) * (radius * .66 + wave);
          ctx.fillStyle = i % 19 === 0 ? 'rgba(255,201,138,.6)' : `rgba(120,201,238,${.12 + (i % 7) / 22})`;
          ctx.beginPath(); ctx.arc(x, y, i % 19 === 0 ? 1.6 : .8, 0, Math.PI * 2); ctx.fill();
        }
      }
    };
    const loop = now => {
      if (now - last > 40) { draw(now); last = now; }
      frame = requestAnimationFrame(loop);
    };
    const resume = () => {
      cancelAnimationFrame(frame);
      draw();
      if (!motion.matches && !document.hidden) frame = requestAnimationFrame(loop);
    };
    const observer = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width; height = entry.contentRect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * dpr; canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); resume();
    });
    observer.observe(canvas);
    document.addEventListener('visibilitychange', resume);
    motion.addEventListener('change', resume);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('visibilitychange', resume); motion.removeEventListener('change', resume); };
  }, []);
  return <canvas ref={ref} className="nv-field" aria-hidden="true" />;
}
