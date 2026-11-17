// The stage's backdrop: a full-bleed canvas under everything. It draws the
// Hephaestus contour field in the brand's accent (Chronos's blue by default):
// closed topographic rings around a few peaks, at low opacity, fading away from
// the upper right into the ground of the mode on show (a port of contours() in
// Hephaestus's forge/pots/pot.mjs). It is drawn once, again on a resize, and
// again when the brand or the colour mode changes (redraw); nothing moves.
//
//   mountBackdrop(canvas, { seed?, rings? }) -> { redraw(), destroy() }

/** "37 99 235" from a custom property, or the fallback */
function rgbVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).map(Number);
  return v.length === 3 && v.every(Number.isFinite) ? v : fallback;
}

export function mountBackdrop(canvas, { seed = 7, rings = 11 } = {}) {
  const ctx = canvas.getContext("2d");
  let raf = 0;

  function draw() {
    raf = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = canvas.clientWidth || innerWidth;
    const H = canvas.clientHeight || innerHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const ACCENT = rgbVar("--red-rgb", [37, 99, 235]);
    const HOT = rgbVar("--hot-rgb", [96, 165, 250]);
    const G = rgbVar("--ground-rgb", [5, 7, 11]);
    const light = G[0] > 128;

    let s = seed;
    const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const scale = Math.max(0.75, Math.min(1.6, Math.max(W, H) / 900));
    const peaks = [0, 1, 2, 3].map((k) => ({
      x: W * (k === 3 ? 0.08 + rand() * 0.2 : 0.42 + rand() * 0.55),
      y: H * (k === 3 ? 0.62 + rand() * 0.3 : 0.08 + rand() * 0.55),
      k: (0.6 + rand() * 0.6) * scale,
      p: rand() * 6,
      dim: k === 3 ? 0.55 : 1,
    }));
    ctx.lineJoin = "round";
    for (const peak of peaks) {
      for (let i = 1; i <= rings; i++) {
        const r = i * 26 * peak.k;
        ctx.beginPath();
        for (let a = 0; a <= 72; a++) {
          const t = (a / 72) * Math.PI * 2;
          const wob = 1 + 0.14 * Math.sin(3 * t + peak.p + i * 0.35) + 0.07 * Math.sin(5 * t - peak.p);
          const x = peak.x + Math.cos(t) * r * wob * 1.25;
          const y = peak.y + Math.sin(t) * r * wob;
          if (a) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        ctx.closePath();
        const o = Math.max(0.02, 0.3 - i * 0.022) * peak.dim * (light ? 0.7 : 1);
        const c = i % 4 === 0 ? HOT : ACCENT;
        ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${o.toFixed(3)})`;
        ctx.lineWidth = i % 4 === 0 ? 1 : 0.6;
        ctx.stroke();
      }
    }
    // the field fades away from the upper right, as the pots' header does
    const fade = ctx.createRadialGradient(W * 0.74, H * 0.26, 0, W * 0.74, H * 0.26, Math.max(W, H) * 0.85);
    fade.addColorStop(0, `rgba(${G},0)`);
    fade.addColorStop(0.55, `rgba(${G},0.35)`);
    fade.addColorStop(1, `rgba(${G},0.92)`);
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, W, H);
  }

  const redraw = () => {
    if (!raf) raf = requestAnimationFrame(draw);
  };
  const ro = new ResizeObserver(redraw);
  ro.observe(canvas);
  draw();
  return {
    redraw,
    destroy() {
      ro.disconnect();
      cancelAnimationFrame(raf);
    },
  };
}
