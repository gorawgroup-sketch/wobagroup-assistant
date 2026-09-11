import { useLayoutEffect, useRef, useState } from "react";

export const WOBI_IMAGE = `${import.meta.env.BASE_URL}brand/wobi.png`;
const WOBI_TRANSPARENT_IMAGE = `${import.meta.env.BASE_URL}brand/wobi-transparent.png`;

/** The selected artwork remains the source of both the portrait and its assembly particles. */
export default function WobiAvatar({ className = "", energized = false, speaking = false, assemble = false, transparent = false }) {
  const canvasRef = useRef(null);
  const [assembling, setAssembling] = useState(false);
  const image = transparent ? WOBI_TRANSPARENT_IMAGE : WOBI_IMAGE;

  useLayoutEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!assemble || motion.matches) { setAssembling(false); return; }
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
    // Hide the finished portrait before paint, including while its source loads.
    canvas.parentElement.style.setProperty("--wobi-reveal", "0");
    setAssembling(true);
    const onMotionChange = () => { if (motion.matches) stop(); };
    motion.addEventListener("change", onMotionChange);
    const source = new Image();
    source.onload = () => {
      if (disposed || motion.matches) return;
      try {
        const sample = document.createElement("canvas");
        sample.width = sample.height = 160;
        const sampleCtx = sample.getContext("2d");
        if (!sampleCtx) { stop(); return; }
        sampleCtx.drawImage(source, 0, 0, 160, 160);
        const { data } = sampleCtx.getImageData(0, 0, 160, 160);
        const particles = [];
        for (let y = 0; y < 160; y += 2) {
          for (let x = 0; x < 160; x += 2) {
            const i = (y * 160 + x) * 4;
            if (data[i + 3] < 40 || Math.max(data[i], data[i + 1], data[i + 2]) < 90) continue;
            const angle = (x * 13 + y * 7) * 0.17;
            particles.push({ x: x * 2, y: y * 2, dx: Math.cos(angle) * 190, dy: Math.sin(angle) * 190,
              color: `rgba(${data[i]}, ${data[i + 1]}, ${data[i + 2]}, ${data[i + 3] / 255})` });
          }
        }
        setAssembling(true);
        const start = performance.now();
        const draw = (now) => {
          if (disposed) return;
          const progress = Math.min(1, (now - start) / 1800);
          const dispersion = (1 - progress) ** 3;
          const reveal = Math.max(0, Math.min(1, (progress - 0.65) / 0.35));
          canvas.parentElement.style.setProperty("--wobi-reveal", String(reveal));
          ctx.clearRect(0, 0, 320, 320);
          ctx.globalAlpha = Math.min(1, progress * 6) * (1 - reveal);
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
    source.onerror = stop;
    source.src = image;
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      source.onload = null;
      source.onerror = null;
      motion.removeEventListener("change", onMotionChange);
    };
  }, [assemble, image]);

  return (
    <div className={`wobi-portrait ${className}`} data-transparent={transparent} data-energized={energized} data-speaking={speaking} data-assembling={assembling}>
      <img src={image} alt="WOBi, rostro humanoide formado por nanobots azules y ámbar" width="1254" height="1254" draggable="false" />
      {assemble && <canvas ref={canvasRef} width="320" height="320" aria-hidden="true" />}
    </div>
  );
}
