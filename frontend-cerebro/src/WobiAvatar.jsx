import { useEffect, useRef, useState } from "react";

export const WOBI_IMAGE = `${import.meta.env.BASE_URL}brand/wobi.png`;

/** The selected artwork remains the source of both the portrait and its assembly particles. */
export default function WobiAvatar({ className = "", energized = false, speaking = false, assemble = false }) {
  const canvasRef = useRef(null);
  const [assembling, setAssembling] = useState(false);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!assemble || motion.matches) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    let disposed = false;
    let frame;
    const stop = () => {
      cancelAnimationFrame(frame);
      ctx.clearRect(0, 0, 320, 320);
      if (!disposed) setAssembling(false);
    };
    const onMotionChange = () => { if (motion.matches) stop(); };
    motion.addEventListener("change", onMotionChange);
    const source = new Image();
    source.onload = () => {
      if (disposed || motion.matches) return;
      try {
        const sample = document.createElement("canvas");
        sample.width = sample.height = 100;
        const sampleCtx = sample.getContext("2d");
        if (!sampleCtx) return;
        sampleCtx.drawImage(source, 0, 0, 100, 100);
        const { data } = sampleCtx.getImageData(0, 0, 100, 100);
        const particles = [];
        for (let y = 0; y < 100; y += 2) {
          for (let x = 0; x < 100; x += 2) {
            const i = (y * 100 + x) * 4;
            if (Math.max(data[i], data[i + 1], data[i + 2]) < 90) continue;
            const angle = (x * 13 + y * 7) * 0.17;
            particles.push({ x: x * 3.2, y: y * 3.2, dx: Math.cos(angle) * 150, dy: Math.sin(angle) * 150,
              color: `rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]})` });
          }
        }
        setAssembling(true);
        const start = performance.now();
        const draw = (now) => {
          if (disposed) return;
          const progress = Math.min(1, (now - start) / 1500);
          const dispersion = (1 - progress) ** 3;
          ctx.clearRect(0, 0, 320, 320);
          ctx.globalAlpha = Math.min(1, progress * 5) * Math.min(1, (1 - progress) * 4);
          for (const p of particles) {
            ctx.fillStyle = p.color;
            ctx.fillRect(p.x + p.dx * dispersion, p.y + p.dy * dispersion, 1.4, 1.4);
          }
          if (progress < 1) frame = requestAnimationFrame(draw);
          else stop();
        };
        frame = requestAnimationFrame(draw);
      } catch { stop(); }
    };
    source.src = WOBI_IMAGE;
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      source.onload = null;
      motion.removeEventListener("change", onMotionChange);
    };
  }, [assemble]);

  return (
    <div className={`wobi-portrait ${className}`} data-energized={energized} data-speaking={speaking} data-assembling={assembling}>
      <img src={WOBI_IMAGE} alt="WOBi, rostro humanoide formado por nanobots azules y ámbar" width="1254" height="1254" draggable="false" />
      {assemble && <canvas ref={canvasRef} width="320" height="320" aria-hidden="true" />}
    </div>
  );
}
