import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Live analyser drawn on a canvas rather than in the DOM: 48 bars at 60 fps is
 * 2880 style recalculations a second, which React would feel and canvas does
 * not even notice.
 */
export function Spectrum({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levels = useRef<number[]>([]);
  /** Slow-falling peak caps, the classic analyser detail. */
  const peaks = useRef<number[]>([]);

  useEffect(() => {
    const un = listen<number[]>("spectrum", (e) => {
      levels.current = e.payload;
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = () => {
      const { width: w, height: h } = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, w, h);

      const vals = levels.current;
      if (vals.length) {
        if (peaks.current.length !== vals.length) peaks.current = vals.slice();

        const gap = 2;
        const bw = (w - gap * (vals.length - 1)) / vals.length;

        const grad = ctx.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, "rgba(94, 234, 212, 0.55)");
        grad.addColorStop(0.55, "rgba(129, 140, 248, 0.42)");
        grad.addColorStop(1, "rgba(244, 63, 94, 0.40)");

        for (let i = 0; i < vals.length; i++) {
          const v = vals[i];
          // Peaks drop far slower than the bars, so transients stay legible.
          peaks.current[i] = Math.max(v, peaks.current[i] - (still ? 1 : 0.008));

          const x = i * (bw + gap);
          const bh = Math.max(1, v * h);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.roundRect(x, h - bh, bw, bh, Math.min(3, bw / 2));
          ctx.fill();

          const py = h - Math.max(2, peaks.current[i] * h);
          ctx.fillStyle = "rgba(226, 232, 240, 0.30)";
          ctx.fillRect(x, py, bw, 1.5);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
