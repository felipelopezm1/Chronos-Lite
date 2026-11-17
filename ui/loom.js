// The rock Loom: the agents as stones on a canvas, earth-toned and abstract.
// Carried from Chronos's ui/loom.js; the one change is `words`, so a rebranded
// Lite draws its own names (the boulder's label, the tiers, the hint) and never
// the runtime's inner ones.
// Chronos, the Titan, is one faceted boulder that is always there, seamed with
// fissures whose glow carries the GPU's junction heat: dark blue when cool,
// amber when warm, red at 90 C and past (the line above which nothing new
// starts on the GPU), pulsing while a throttle.hold or a heat.cutoff stands.
// A quest's spawn breaks a stone off the Titan: it tumbles to its place with a
// little overshoot and settles, leaving a short pooled grit trail that fades.
// A Promethean is such a stone; an Offspring is a pebble that breaks off its
// parent. A stone that fell cracks; when the split comes the crack opens, the
// halves part and the Offspring burst out of it as shards. A stone that is
// done is set down solid; one that is blocked, stopped, or fell with no split
// to follow, crumbles to dust. Threads are thin grit lines parent to child.
// Hover shows id, tier, brain, quest and task; a click pins that tooltip.
//
// Events heard (the shapes runtime/quests.mjs and runtime/promethean.mjs emit):
//   agent.spawned {id, tier: titan|promethean|offspring, parent, brain, quest, task}
//   agent.split   {id, children: [id | {id, ...}], why}
//   agent.done    {id, status: done|partial|blocked|fell|stopped}
//   quest.started / quest.done                     the Titan at work, then idle
//   hardware.read {heat: {junctionC, hot}}         the fissures' glow
//   throttle.hold / heat.cutoff                    the fissures pulse
//   throttle.release / heat.clear                  the pulse stops
//   log           {id, text}                       the last line under a stone
// A spawned titan is Chronos itself: it updates the resident boulder, never a second one.
//
// The canvas works only while something moves: a requestAnimationFrame loop runs
// while a stone tumbles, a crack opens, grit lies about or the fissures pulse,
// and stops when all is still; anything else that changes the picture marks it
// dirty and draws once. Particles live in a fixed pool; nothing is allocated per
// frame but what the hover tooltip's text needs. prefers-reduced-motion: no
// tumble, no trails, no pulse: every stone is placed where it lands.

export const TITAN_ID = "chronos";
const PRUNE_MS = 120_000;
const FELL_GRACE_MS = 2400; // a stone that fell waits this long for its split before it crumbles
const HOT_C = 90;
const WARM_C = 70; // the fissures are amber here
const COOL_C = 50; // and blue up to here
const SIZE = { titan: 38, promethean: 17, offspring: 9 };
const VERTS = { titan: 13, promethean: 9, offspring: 7 };
const MONO = 'ui-monospace, "Geist Mono", "JetBrains Mono", Menlo, Consolas, monospace';

// earth tones: the lit face, the body, the shadow, the edge, and the grit a stone sheds
const TONES = {
  titan: { lit: [134, 108, 74], base: [60, 52, 45], dark: [22, 18, 16], edge: "rgba(196,170,128,0.5)" },
  promethean: { lit: [154, 136, 106], base: [78, 71, 64], dark: [28, 25, 22], edge: "rgba(210,196,170,0.45)" },
  offspring: { lit: [172, 162, 146], base: [96, 90, 83], dark: [36, 33, 30], edge: "rgba(224,216,204,0.45)" },
};
const GRIT_COLORS = ["#8a7452", "#9a8a6a", "#aaa090", "#c9b89a", "#6e6258"]; // titan, promethean, offspring grit; shards; dust
const GLOW_COOL = [56, 100, 196]; // dark blue, but enough of it to read on the dark stone
const GLOW_WARM = [226, 150, 46];
const GLOW_HOT = [214, 62, 52];
const RED = `rgb(${GLOW_HOT})`;
const LIGHT = [-0.55, -0.83]; // the light falls from the upper left
// where the Titan's stones go, in order: upper right, lower left, upper left, lower right, then the top and the lower sides
const SLOTS = [-0.55, 2.6, -2.6, 0.55, -1.5, 2.05, 1.1, -1.05, 3.1, 0];
const DASH_THREAD = [1.2, 3.4];
const DASH_PARTIAL = [3, 3];
const NO_DASH = [];

/** a seed in [0,1) from an id, stable across frames */
function seedOf(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

/** mulberry32: a small seeded random, for a stone's outline */
function rng(seed) {
  let a = Math.floor(seed * 4294967296) || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tierOf(ev) {
  const t = String(ev?.tier ?? "").toLowerCase();
  if (t in SIZE) return t;
  if (ev?.parent && ev.parent !== TITAN_ID) return "offspring";
  return "promethean";
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;

// ---- a stone's shape, built once ----------------------------------------------
/**
 * The outline, the facets with their shades, the fissures (the Titan) and the
 * crack a split opens: flat arrays of local coordinates, read every frame and
 * never rebuilt.
 */
function buildShape(tier, seed) {
  const rand = rng(seed);
  const r = SIZE[tier];
  const n = VERTS[tier];
  const tone = TONES[tier];
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.3;
    const rr = r * (tier === "offspring" ? 0.84 + rand() * 0.24 : 0.72 + rand() * 0.42);
    pts.push(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  // the ridges inside: three for the Titan, one off-centre point for the rest
  const inner = tier === "titan" ? 3 : 1;
  const ins = [];
  for (let k = 0; k < inner; k++) {
    const a = rand() * Math.PI * 2;
    const d = inner === 1 ? r * 0.25 * rand() : r * (0.3 + rand() * 0.14);
    ins.push(Math.cos(a) * d, Math.sin(a) * d);
  }
  const nearest = (x, y) => {
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < inner; k++) {
      const d = (ins[k * 2] - x) ** 2 + (ins[k * 2 + 1] - y) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  };
  // the facets: each rim segment fans to its nearest ridge, with a filler where neighbours differ
  const tris = []; // 6 numbers each
  const segIn = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    segIn[i] = nearest((pts[i * 2] + pts[j * 2]) / 2, (pts[i * 2 + 1] + pts[j * 2 + 1]) / 2);
    tris.push(pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1], ins[segIn[i] * 2], ins[segIn[i] * 2 + 1]);
  }
  for (let i = 0; i < n; i++) {
    const prev = segIn[(i + n - 1) % n];
    if (prev !== segIn[i]) tris.push(pts[i * 2], pts[i * 2 + 1], ins[prev * 2], ins[prev * 2 + 1], ins[segIn[i] * 2], ins[segIn[i] * 2 + 1]);
  }
  if (inner === 3) tris.push(ins[0], ins[1], ins[2], ins[3], ins[4], ins[5]);
  // the shade of each facet: its slope against the light, with a little grain
  const cols = [];
  for (let t = 0; t < tris.length; t += 6) {
    const cx = (tris[t] + tris[t + 2] + tris[t + 4]) / 3;
    const cy = (tris[t + 1] + tris[t + 3] + tris[t + 5]) / 3;
    const d = Math.hypot(cx, cy) || 1;
    const slope = Math.min(1, d / r); // 0 at the crown, 1 at the rim
    let light = ((cx / d) * LIGHT[0] + (cy / d) * LIGHT[1]) * slope + (1 - slope) * 0.55 + (rand() - 0.5) * 0.5;
    light = clamp(light, -1, 1);
    const u = (light + 1) / 2;
    const c = u < 0.5 ? mix(tone.dark, tone.base, u * 2) : mix(tone.base, tone.lit, (u - 0.5) * 2);
    const warm = Math.round((rand() - 0.5) * 16); // some facets lean ochre, some slate
    cols.push(`rgb(${clamp(c[0] + warm, 0, 255)},${c[1]},${clamp(c[2] - warm, 0, 255)})`);
  }
  // the fissures of the Titan: jagged lines from the rim inward
  const fissures = [];
  if (tier === "titan") {
    for (let f = 0; f < 4; f++) {
      const i0 = Math.floor(rand() * n);
      const i1 = (i0 + Math.floor(n / 2) + Math.floor(rand() * 3) - 1) % n;
      const sx = pts[i0 * 2] * 0.98;
      const sy = pts[i0 * 2 + 1] * 0.98;
      const ex = pts[i1 * 2];
      const ey = pts[i1 * 2 + 1];
      const reach = 0.45 + rand() * 0.45;
      const steps = 5;
      const line = [sx, sy];
      for (let s = 1; s <= steps; s++) {
        const t = (s / steps) * reach;
        line.push(sx + (ex - sx) * t + (rand() - 0.5) * r * 0.2, sy + (ey - sy) * t + (rand() - 0.5) * r * 0.2);
      }
      fissures.push(line);
    }
  }
  // the crack a split opens: rim to rim through the middle, and its normal
  const c0 = Math.floor(rand() * n);
  const c1 = (c0 + Math.floor(n / 2)) % n;
  const ax = pts[c0 * 2] * 1.05;
  const ay = pts[c0 * 2 + 1] * 1.05;
  const bx = pts[c1 * 2] * 1.05;
  const by = pts[c1 * 2 + 1] * 1.05;
  const crack = [ax, ay];
  for (let s = 1; s < 5; s++) {
    const t = s / 5;
    crack.push(ax + (bx - ax) * t + (rand() - 0.5) * r * 0.3, ay + (by - ay) * t + (rand() - 0.5) * r * 0.3);
  }
  crack.push(bx, by);
  const cl = Math.hypot(bx - ax, by - ay) || 1;
  return { r, pts, tris, cols, fissures, crack, crackNx: -(by - ay) / cl, crackNy: (bx - ax) / cl };
}

// ---- the particle pool ---------------------------------------------------------
const PMAX = 1400;
const KIND_GRIT = 0;
const KIND_SHARD = 1;
const KIND_DUST = 2;

/** count and demo: the count line and the demo link; left out, they are #loom-count and #loom-demo when the page has them */
export function mountLoom(canvas, { on, count: countIn = null, demo: demoIn = null, words = null }) {
  // the words it draws, the brand's (Lite's white label); Chronos's own when none are given
  const DEF = { name: "Chronos", titan: "the Titan", tier: (t) => t, quest: "quest", workers: "Prometheans", brain: (id) => id ?? "", text: (t) => t };
  const say = new Proxy(DEF, { get: (d, k) => (words && words[k] !== undefined ? words[k] : d[k]) });
  const ctx = canvas.getContext("2d");
  const nodes = new Map(); // id -> stone
  const order = []; // ids in arrival order (drawn parents first)
  const aliases = new Map(); // a spawned titan's id -> TITAN_ID
  const countEl = countIn ?? document.getElementById("loom-count");
  const demoEl = demoIn ?? document.getElementById("loom-demo");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let heat = { junctionC: null, hot: false };
  let held = false; // a throttle.hold or heat.cutoff stands
  let hover = null;
  let pinned = null;
  let W = 0;
  let H = 0;
  let dpr = 1;

  // the heat's colours, rebuilt when the heat changes, never per frame
  let glowRgb = GLOW_COOL;
  let glowCore = rgba(GLOW_COOL, 0.95);
  let glowSoft = rgba(GLOW_COOL, 0.4);
  let glowStrength = 0.35;
  let underGlow = null;
  let heatLabel = "";
  let heatKey = "fissures: the junction heat";

  const P = {
    x: new Float32Array(PMAX),
    y: new Float32Array(PMAX),
    vx: new Float32Array(PMAX),
    vy: new Float32Array(PMAX),
    life: new Float32Array(PMAX),
    max: new Float32Array(PMAX),
    size: new Float32Array(PMAX),
    floor: new Float32Array(PMAX),
    rot: new Float32Array(PMAX),
    vrot: new Float32Array(PMAX),
    kind: new Uint8Array(PMAX),
    col: new Uint8Array(PMAX),
  };
  let pCursor = 0;
  let pAlive = 0;

  function emit(kind, x, y, vx, vy, life, size, col, floor = 0) {
    if (reduce) return;
    const i = pCursor;
    pCursor = (pCursor + 1) % PMAX;
    P.x[i] = x;
    P.y[i] = y;
    P.vx[i] = vx;
    P.vy[i] = vy;
    P.life[i] = life;
    P.max[i] = life;
    P.size[i] = size;
    P.floor[i] = floor;
    P.rot[i] = Math.random() * Math.PI * 2;
    P.vrot[i] = (Math.random() - 0.5) * 0.4;
    P.kind[i] = kind;
    P.col[i] = col;
    pAlive++;
  }

  const idOf = (id) => aliases.get(id) ?? id;
  const colOf = (tier) => (tier === "titan" ? 0 : tier === "promethean" ? 1 : 2);

  function makeStone(id, ev = {}) {
    const tier = id === TITAN_ID ? "titan" : tierOf(ev);
    const seed = seedOf(id);
    const shape = buildShape(tier, seed);
    const parentId = ev.parent ? idOf(ev.parent) : tier === "titan" ? null : TITAN_ID;
    return {
      id,
      tier,
      brain: ev.brain ?? null,
      quest: ev.quest ?? null,
      task: ev.task ?? "",
      parent: parentId,
      status: tier === "titan" ? "idle" : "running",
      resident: tier === "titan",
      children: [],
      log: null,
      seed,
      shape,
      r: shape.r,
      x: 0,
      y: 0,
      tx: 0,
      ty: 0,
      vx: 0,
      vy: 0,
      rot: 0,
      vrot: 0,
      scale: 1,
      alpha: 1,
      phase: "rest", // fly | rest | fell | crumble | dust
      flinch: 0, // a parent's shiver when a stone breaks off it
      squash: 0, // the set-down of a done stone, 1 -> 0
      crackOpen: 0, // the crack across a fell stone, 0 -> 1
      gap: 0, // the halves apart, px
      gapTo: 0,
      born: performance.now(),
      fellAt: null,
      crumbleAt: null,
      doneAt: null,
    };
  }

  function unlink(n) {
    const p = n.parent ? nodes.get(n.parent) : null;
    if (p) p.children = p.children.filter((c) => c !== n.id);
  }

  function ensure(id, ev = {}) {
    id = idOf(id);
    let n = nodes.get(id);
    if (!n) {
      n = makeStone(id, ev);
      nodes.set(id, n);
      order.push(id);
      const p = n.parent ? nodes.get(n.parent) : null;
      if (p) p.children.push(id);
      layout();
      launch(n, p);
    } else {
      // a placeholder from agent.split filled in by its agent.spawned
      if (ev.tier && !n.resident && n.tier !== tierOf(ev)) {
        n.tier = tierOf(ev);
        n.shape = buildShape(n.tier, n.seed);
        n.r = n.shape.r;
      }
      if (ev.brain) n.brain = ev.brain;
      if (ev.quest) n.quest = ev.quest;
      if (ev.task) n.task = ev.task;
      if (ev.parent && !n.resident) {
        const p = idOf(ev.parent);
        if (n.parent !== p) {
          unlink(n);
          n.parent = p;
          nodes.get(p)?.children.push(id);
          layout();
        }
      }
    }
    return n;
  }

  // ---- where each stone belongs -----------------------------------------------------
  /** the Titan in the upper middle, its stones on a ring around it, pebbles out past their parent */
  function layout() {
    const titan = nodes.get(TITAN_ID);
    if (!titan) return;
    titan.tx = titan.x = W / 2;
    titan.ty = titan.y = H * 0.44;
    for (const id of order) {
      const n = nodes.get(id);
      if (!n || n.resident) continue;
      const p = n.parent ? nodes.get(n.parent) : titan;
      if (!p) continue;
      const i = Math.max(0, p.children.indexOf(id));
      const m = p.children.length;
      if (p.resident) {
        // the first slots take the sides, where a wide panel has room; none sits on the Titan's label below it
        const ring = clamp(Math.max(p.r + 74, (m * 64) / (Math.PI * 2)), p.r + 40, Math.min(W, H) / 2 - 24);
        const a = i < SLOTS.length ? SLOTS[i] : -1.1 + i * 2.39996;
        // the ring stretches sideways on a wide panel and stays round on a phone, so pebbles past it stay in frame
        const stretch = clamp((W - 200) / 330, 0.9, 1.25);
        n.tx = p.x + Math.cos(a) * ring * stretch;
        n.ty = p.y + Math.sin(a) * ring * (Math.sin(a) > 0 ? 0.95 : 0.78);
      } else {
        // pebbles go out past their parent, away from the Titan, leaning sideways where the panel is short
        const gp = p.parent ? nodes.get(p.parent) : null;
        const dy = p.ty - (gp?.ty ?? titan.y);
        const dx = p.tx - (gp?.tx ?? titan.x);
        const away = Math.atan2(dy * 0.35, dx || (dy < 0 ? -1 : 1));
        const a = away + (i - (m - 1) / 2) * 0.85;
        const d = p.r + n.r + 30;
        n.tx = p.tx + Math.cos(a) * d;
        n.ty = p.ty + Math.sin(a) * d;
      }
      n.tx = clamp(n.tx, n.r + 6, W - n.r - 6);
      n.ty = clamp(n.ty, n.r + 6, H - n.r - 30);
      if (n.phase === "fly") continue;
      if (n.phase === "rest" && !reduce && !resizing && Math.hypot(n.tx - n.x, n.ty - n.y) > 1) {
        // a resting stone whose slot moved (the ring grew) slides there, no break
        n.phase = "fly";
        wake();
      } else {
        n.x = n.tx;
        n.y = n.ty;
      }
    }
  }
  let resizing = false; // a resize snaps every stone to its slot; only a new arrival makes one slide

  /** a stone breaks off its parent and tumbles to its place */
  function launch(n, p) {
    if (!p || reduce) {
      n.x = n.tx;
      n.y = n.ty;
      n.phase = "rest";
      redraw();
      return;
    }
    const a = Math.atan2(n.ty - p.y, n.tx - p.x);
    const bx = p.x + Math.cos(a) * p.r * 0.85;
    const by = p.y + Math.sin(a) * p.r * 0.85;
    n.x = bx;
    n.y = by;
    const d = Math.hypot(n.tx - bx, n.ty - by);
    const speed = 2.5 + d * 0.05;
    n.vx = Math.cos(a) * speed + (Math.random() - 0.5) * 1.2;
    n.vy = Math.sin(a) * speed - 1.2;
    n.vrot = (Math.random() < 0.5 ? -1 : 1) * (0.18 + Math.random() * 0.2);
    n.rot = Math.random() * Math.PI * 2;
    n.phase = "fly";
    p.flinch = 1;
    // the chips of the break
    const col = colOf(n.tier);
    for (let i = 0; i < 9; i++) {
      const sa = a + (Math.random() - 0.5) * 1.6;
      const sp = 1 + Math.random() * 3;
      emit(KIND_SHARD, bx, by, Math.cos(sa) * sp, Math.sin(sa) * sp - 1.5, 500 + Math.random() * 400, 1.6 + Math.random() * 2.2, 3);
    }
    for (let i = 0; i < 6; i++) emit(KIND_GRIT, bx + (Math.random() - 0.5) * 8, by + (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 0.6, 0, 1200 + Math.random() * 800, 1 + Math.random() * 1.4, col, by + 4 + Math.random() * 6);
    wake();
  }

  /** a stone fell: it cracks and waits for its split; none within the grace, and it crumbles */
  function fracture(n, now) {
    n.phase = "fell";
    n.fellAt = now;
    n.crackOpen = reduce ? 1 : 0;
    wake();
  }

  /** the split: the halves part and the children burst out of the crack as shards */
  function split(n, kids, now) {
    if (n.phase !== "fell") fracture(n, now);
    n.status = "split";
    n.fellAt = null; // no crumble follows a split
    n.gapTo = Math.max(4, n.r * 0.3);
    if (reduce) n.gap = n.gapTo;
    n.alpha = 0.8;
    const col = colOf(n.tier);
    for (let i = 0; i < 14; i++) {
      const sa = Math.random() * Math.PI * 2;
      const sp = 0.8 + Math.random() * 3.2;
      emit(KIND_SHARD, n.x + (Math.random() - 0.5) * n.r, n.y + (Math.random() - 0.5) * n.r * 0.6, Math.cos(sa) * sp, Math.sin(sa) * sp - 1, 500 + Math.random() * 500, 1.4 + Math.random() * 2.4, 3);
    }
    for (let i = 0; i < 10; i++) emit(KIND_GRIT, n.x + (Math.random() - 0.5) * n.r * 1.6, n.y + n.r * 0.4, (Math.random() - 0.5) * 0.8, 0, 1400 + Math.random() * 900, 1 + Math.random() * 1.4, col, n.y + n.r * 0.5 + Math.random() * 8);
    kids.forEach((cid) => {
      const id = typeof cid === "string" ? cid : cid?.id;
      if (!id) return;
      const extra = typeof cid === "object" && cid ? cid : {};
      ensure(id, { tier: n.resident ? "promethean" : "offspring", ...extra, parent: n.id });
    });
    wake();
  }

  /** a stone crumbles to dust */
  function crumble(n, now) {
    if (n.phase === "crumble" || n.phase === "dust") return;
    n.phase = "crumble";
    n.crumbleAt = now;
    if (reduce) {
      n.alpha = 0.14;
      n.scale = 0.86;
      n.phase = "dust";
    }
    wake();
  }

  /** a stone is set down solid */
  function setDown(n) {
    n.phase = "rest";
    n.x = n.tx;
    n.y = n.ty;
    n.vx = n.vy = n.vrot = 0;
    n.squash = reduce ? 0 : 1;
    const col = colOf(n.tier);
    for (let i = 0; i < 7; i++) emit(KIND_GRIT, n.x + (Math.random() - 0.5) * n.r * 1.8, n.y + n.r * 0.6, (Math.random() - 0.5) * 1.2, 0, 1000 + Math.random() * 600, 1 + Math.random() * 1.2, col, n.y + n.r * 0.7 + Math.random() * 6);
    wake();
  }

  // ---- the events ---------------------------------------------------------------------
  function handle(ev) {
    const now = performance.now();
    switch (ev?.type) {
      case "agent.spawned": {
        if (!ev.id) return;
        if (String(ev.tier).toLowerCase() === "titan" && ev.id !== TITAN_ID) aliases.set(ev.id, TITAN_ID);
        const n = ensure(ev.id, ev);
        if (n.resident) {
          n.status = "running";
          n.doneAt = null;
        }
        count();
        break;
      }
      case "agent.split": {
        if (!ev.id) return;
        const p = ensure(ev.id, ev);
        const kids = Array.isArray(ev.children) ? ev.children : [];
        if (p.resident) kids.forEach((cid) => ensure(typeof cid === "string" ? cid : cid?.id, { tier: "promethean", parent: p.id }));
        else split(p, kids, now);
        count();
        break;
      }
      case "agent.done": {
        const n = nodes.get(idOf(ev.id));
        if (!n) return;
        const status = ev.status ?? "done";
        n.doneAt = now;
        if (n.resident) n.status = "idle";
        else if (n.status !== "split") {
          n.status = status;
          if (status === "fell") fracture(n, now);
          else if (status === "blocked" || status === "stopped") crumble(n, now);
          else setDown(n);
        }
        count();
        break;
      }
      case "quest.started": {
        const t = nodes.get(TITAN_ID);
        t.status = "running";
        t.doneAt = null;
        count();
        wake();
        break;
      }
      case "quest.done": {
        const t = nodes.get(TITAN_ID);
        t.status = "idle";
        t.doneAt = now;
        count();
        break;
      }
      case "hardware.read":
        if (ev?.heat) setHeat(ev.heat);
        break;
      case "throttle.hold":
      case "heat.cutoff":
        held = true;
        setHeat(heat);
        wake();
        break;
      case "throttle.release":
      case "heat.clear":
        held = false;
        setHeat(heat);
        break;
      case "log": {
        if (!ev.id) return;
        const n = nodes.get(idOf(ev.id));
        if (n) n.log = String(ev.text ?? "");
        if (n && (hover === n.id || pinned === n.id)) redraw();
        break;
      }
    }
  }

  let demoHeat = null; // while the demo plays, the heat it scripts wins
  const hear = (type) => on(type, (ev) => handle(type === "hardware.read" && demoHeat ? { ...ev, heat: demoHeat } : ev));
  for (const t of ["agent.spawned", "agent.split", "agent.done", "quest.started", "quest.done", "hardware.read", "throttle.hold", "throttle.release", "heat.cutoff", "heat.clear", "log"]) hear(t);

  function count() {
    const titan = nodes.get(TITAN_ID);
    let running = 0;
    let done = 0;
    for (const n of nodes.values()) {
      if (n.resident) continue;
      if (n.status === "running") running++;
      else done++;
    }
    if (countEl) countEl.textContent = nodes.size <= 1 ? (titan.status === "running" ? `${say.titan} at work` : `${say.titan} alone`) : `${running} running · ${done} done`;
    redraw();
  }

  /** the fissures' colour from the junction: blue to 50, amber at 70, red at 90 */
  function setHeat(h) {
    heat = h ?? heat;
    const j = heat?.junctionC;
    let rgb = GLOW_COOL;
    let strength = 0.38;
    if (j != null) {
      rgb = mix(GLOW_COOL, GLOW_WARM, clamp((j - COOL_C) / (WARM_C - COOL_C), 0, 1));
      rgb = mix(rgb, GLOW_HOT, clamp((j - (HOT_C - 3)) / 3, 0, 1));
      strength = 0.38 + 0.47 * clamp((j - COOL_C) / (HOT_C - COOL_C), 0, 1);
    }
    if (heat?.hot || held) strength = Math.max(strength, 0.85);
    glowRgb = rgb;
    glowCore = rgba(rgb, 0.95);
    glowSoft = rgba(rgb, 0.45);
    glowStrength = strength;
    const titan = nodes.get(TITAN_ID);
    const tr = titan?.r ?? SIZE.titan;
    underGlow = ctx.createRadialGradient(0, 0, tr * 0.5, 0, 0, tr * 2.6);
    underGlow.addColorStop(0, rgba(rgb, 0.1 + strength * 0.4));
    underGlow.addColorStop(1, rgba(rgb, 0));
    heatLabel = j == null ? "" : `${j} C${heat?.hot ? " · HOT" : held ? " · HELD" : ""}`;
    heatKey = j == null ? "fissures: the junction heat" : `fissures: junction ${j} C · amber past ${WARM_C} · red past ${HOT_C}${held ? " · held" : ""}`;
    redraw();
  }

  /** a done stone whose children are gone is cleared after a while */
  function prune(now) {
    let changed = false;
    for (let i = order.length - 1; i >= 0; i--) {
      const n = nodes.get(order[i]);
      if (!n || n.resident || n.status === "running" || n.doneAt == null) continue;
      if (now - n.doneAt < PRUNE_MS) continue;
      if (n.children.some((c) => nodes.has(c))) continue;
      nodes.delete(n.id);
      order.splice(i, 1);
      unlink(n);
      if (pinned === n.id) pinned = null;
      if (hover === n.id) hover = null;
      changed = true;
    }
    if (changed) {
      layout();
      count();
    }
  }

  // ---- motion -----------------------------------------------------------------------
  /** advance everything by dt ms; returns true while anything still moves */
  function step(dt, now) {
    const k = Math.min(dt / 16.7, 3);
    let busy = false;
    for (const n of nodes.values()) {
      if (n.flinch > 0) {
        n.flinch = Math.max(0, n.flinch - 0.08 * k);
        busy = true;
      }
      if (n.phase === "fly") {
        // a damped spring to its place: ease, one overshoot, settle
        const ax = (n.tx - n.x) * 0.045;
        const ay = (n.ty - n.y) * 0.045;
        const damp = Math.pow(0.86, k);
        n.vx = (n.vx + ax * k) * damp;
        n.vy = (n.vy + ay * k) * damp;
        n.x += n.vx * k;
        n.y += n.vy * k;
        n.rot += n.vrot * k;
        n.vrot *= Math.pow(0.95, k);
        const speed = Math.hypot(n.vx, n.vy);
        const col = colOf(n.tier);
        if (speed > 0.5) {
          const spread = n.r * 0.5;
          emit(KIND_GRIT, n.x + (Math.random() - 0.5) * spread, n.y + (Math.random() - 0.3) * spread, -n.vx * 0.08 + (Math.random() - 0.5) * 0.4, 0, 900 + Math.random() * 900, 0.8 + Math.random() * 1.4, col, n.y + n.r * 0.5 + Math.random() * 7);
          if (speed > 2) emit(KIND_GRIT, n.x + (Math.random() - 0.5) * spread, n.y + (Math.random() - 0.3) * spread, (Math.random() - 0.5) * 0.4, 0, 700 + Math.random() * 700, 0.8 + Math.random() * 1.2, col, n.y + n.r * 0.5 + Math.random() * 7);
        }
        if (speed < 0.05 && Math.hypot(n.tx - n.x, n.ty - n.y) < 0.4 && Math.abs(n.vrot) < 0.002) {
          n.x = n.tx;
          n.y = n.ty;
          n.vx = n.vy = n.vrot = 0;
          n.phase = "rest";
          for (let i = 0; i < 4; i++) emit(KIND_GRIT, n.x + (Math.random() - 0.5) * n.r * 1.4, n.y + n.r * 0.6, (Math.random() - 0.5) * 0.8, 0, 900 + Math.random() * 500, 1 + Math.random(), col, n.y + n.r * 0.65 + Math.random() * 5);
        }
        busy = true;
      }
      if (n.squash > 0) {
        n.squash = Math.max(0, n.squash - 0.07 * k);
        busy = true;
      }
      if ((n.phase === "fell" || n.status === "split") && n.crackOpen < 1) {
        n.crackOpen = Math.min(1, n.crackOpen + 0.05 * k);
        busy = true;
      }
      if (n.gap < n.gapTo) {
        n.gap = Math.min(n.gapTo, n.gap + 0.12 * k);
        busy = true;
      }
      if (n.phase === "fell" && n.fellAt != null) {
        if (now - n.fellAt > FELL_GRACE_MS) crumble(n, now);
        busy = true; // keep watching the grace
      }
      if (n.phase === "crumble") {
        const t = Math.min(1, (now - n.crumbleAt) / 900);
        n.alpha = 1 - 0.86 * t;
        n.scale = 1 - 0.14 * t;
        if (t < 0.75 && Math.random() < 0.9) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.random() * n.r * 0.9;
          emit(KIND_DUST, n.x + Math.cos(a) * d, n.y + Math.sin(a) * d, (Math.random() - 0.5) * 0.5, 0.2 + Math.random() * 0.5, 900 + Math.random() * 700, 1 + Math.random() * 2, 4);
        }
        if (t >= 1) n.phase = "dust";
        busy = true;
      }
      if (n.resident && n.status === "running" && !reduce) busy = true; // the fissures breathe
    }
    if (held && !reduce) busy = true;
    // the particles
    pAlive = 0;
    for (let i = 0; i < PMAX; i++) {
      if (P.life[i] <= 0) continue;
      P.life[i] -= dt;
      if (P.life[i] <= 0) continue;
      pAlive++;
      const kind = P.kind[i];
      if (kind === KIND_GRIT) {
        if (P.y[i] < P.floor[i]) {
          P.vy[i] += 0.06 * k;
          P.y[i] += P.vy[i] * k;
          if (P.y[i] >= P.floor[i]) {
            P.y[i] = P.floor[i];
            P.vy[i] = 0;
          }
        }
        P.vx[i] *= Math.pow(0.9, k);
        P.x[i] += P.vx[i] * k;
      } else if (kind === KIND_SHARD) {
        P.vy[i] += 0.14 * k;
        P.x[i] += P.vx[i] * k;
        P.y[i] += P.vy[i] * k;
        P.rot[i] += P.vrot[i] * k;
      } else {
        P.vy[i] += 0.012 * k;
        P.vx[i] *= Math.pow(0.97, k);
        P.x[i] += P.vx[i] * k;
        P.y[i] += P.vy[i] * k;
      }
    }
    return busy || pAlive > 0;
  }

  // ---- drawing -----------------------------------------------------------------------
  function outline(shape) {
    const pts = shape.pts;
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath();
  }

  function facets(shape) {
    const tris = shape.tris;
    for (let t = 0, c = 0; t < tris.length; t += 6, c++) {
      ctx.fillStyle = shape.cols[c];
      ctx.beginPath();
      ctx.moveTo(tris[t], tris[t + 1]);
      ctx.lineTo(tris[t + 2], tris[t + 3]);
      ctx.lineTo(tris[t + 4], tris[t + 5]);
      ctx.closePath();
      ctx.fill();
    }
  }

  function body(n, lit) {
    const shape = n.shape;
    outline(shape);
    ctx.fillStyle = `rgb(${TONES[n.tier].base})`;
    ctx.fill();
    facets(shape);
    outline(shape);
    ctx.lineJoin = "round";
    ctx.lineWidth = lit ? 1.4 : n.resident ? 1.1 : 0.9;
    let edge = TONES[n.tier].edge;
    if (lit) edge = "#ffffff";
    else if (n.status === "done") edge = "rgba(255,255,255,0.55)";
    else if (n.status === "fell" || n.status === "blocked" || n.status === "stopped") edge = "rgba(214,62,52,0.55)";
    else if (n.status === "partial") edge = "rgba(255,255,255,0.4)";
    ctx.strokeStyle = edge;
    if (n.status === "partial") ctx.setLineDash(DASH_PARTIAL);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
  }

  /** the crack across a fell stone, opening from one rim to the other */
  function crackLine(n) {
    const c = n.shape.crack;
    const steps = (c.length / 2 - 1) * n.crackOpen;
    ctx.beginPath();
    ctx.moveTo(c[0], c[1]);
    for (let i = 1; i <= steps; i++) ctx.lineTo(c[i * 2], c[i * 2 + 1]);
    const f = steps - Math.floor(steps);
    if (f > 0) {
      const i = Math.floor(steps);
      ctx.lineTo(c[i * 2] + (c[i * 2 + 2] - c[i * 2]) * f, c[i * 2 + 1] + (c[i * 2 + 3] - c[i * 2 + 1]) * f);
    }
  }

  /** the two halves of a split stone, parted along the crack */
  function halves(n, lit) {
    const s = n.shape;
    const c = s.crack;
    const big = n.r * 4;
    const last = c.length - 2;
    for (let side = -1; side <= 1; side += 2) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(c[0], c[1]);
      for (let i = 2; i < c.length; i += 2) ctx.lineTo(c[i], c[i + 1]);
      ctx.lineTo(c[last] + s.crackNx * side * big, c[last + 1] + s.crackNy * side * big);
      ctx.lineTo(c[0] + s.crackNx * side * big, c[1] + s.crackNy * side * big);
      ctx.closePath();
      ctx.clip();
      ctx.translate(s.crackNx * side * n.gap, s.crackNy * side * n.gap);
      ctx.rotate(side * n.gap * 0.015);
      body(n, lit);
      ctx.restore();
    }
  }

  function fissures(n, now) {
    const s = n.shape;
    let strength = glowStrength;
    if (held && !reduce) strength *= 0.55 + 0.45 * Math.sin(now / 150);
    else if (n.status === "running" && !reduce) strength *= 0.86 + 0.14 * Math.sin(now / 650);
    for (const line of s.fissures) {
      ctx.beginPath();
      ctx.moveTo(line[0], line[1]);
      for (let i = 2; i < line.length; i += 2) ctx.lineTo(line[i], line[i + 1]);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = "rgba(0,0,0,0.75)";
      ctx.stroke();
      ctx.globalAlpha = n.alpha * strength * 0.55;
      ctx.lineWidth = 4.2;
      ctx.strokeStyle = glowSoft;
      ctx.stroke();
      ctx.globalAlpha = n.alpha * Math.min(1, 0.25 + strength);
      ctx.lineWidth = 1.1;
      ctx.strokeStyle = glowCore;
      ctx.stroke();
      ctx.globalAlpha = n.alpha;
    }
  }

  function drawStone(n, now, lit) {
    const grow = reduce ? 1 : Math.min(1, (now - n.born) / 300);
    const squash = n.squash > 0 ? 1 - 0.12 * Math.sin(n.squash * Math.PI) : 1;
    const flinch = n.flinch > 0 ? 1 + 0.03 * Math.sin(n.flinch * Math.PI) : 1;
    ctx.save();
    ctx.translate(n.x, n.y);
    ctx.globalAlpha = n.alpha;
    if (n.resident) {
      // the heat under the boulder, and a ring past the hot line so it reads without colour
      if (underGlow) {
        const breathe = held && !reduce ? 1 + 0.08 * Math.sin(now / 150) : 1;
        ctx.save();
        ctx.scale(breathe, breathe);
        ctx.fillStyle = underGlow;
        ctx.beginPath();
        ctx.arc(0, 0, n.r * 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      if (heat?.hot || held) {
        ctx.strokeStyle = rgba(glowRgb, reduce ? 0.7 : 0.45 + 0.35 * Math.sin(now / 300));
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(0, 0, n.r * 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.rotate(n.rot);
    const s = grow * n.scale * flinch * (lit ? 1.08 : 1);
    ctx.scale(s * (2 - squash), s * squash);
    if (n.status === "split") halves(n, lit);
    else {
      body(n, lit);
      if (n.phase === "fell" && n.crackOpen > 0) {
        crackLine(n);
        ctx.lineCap = "round";
        ctx.lineWidth = Math.max(1, n.r * 0.09);
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.stroke();
        ctx.lineWidth = 0.6;
        ctx.strokeStyle = "rgba(255,255,255,0.3)";
        ctx.stroke();
      }
      if (n.resident) {
        fissures(n, now);
        ctx.fillStyle = n.status === "running" ? "#ffffff" : "rgba(255,255,255,0.6)";
        ctx.beginPath();
        ctx.arc(n.shape.pts[0] * 0.1, n.shape.pts[1] * 0.1, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    if (n.resident) {
      ctx.save();
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillText(say.name, n.x, n.y + n.r + 16);
      ctx.fillStyle = heat?.hot ? RED : held ? glowCore : "rgba(255,255,255,0.38)";
      ctx.fillText(heatLabel || (n.status === "running" ? "at work" : "idle"), n.x, n.y + n.r + 29);
      ctx.restore();
    }
  }

  /** a thin grit line parent to child, rim to rim */
  function drawThread(n, p, lit) {
    const dx = n.x - p.x;
    const dy = n.y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d < n.r + p.r + 4) return;
    ctx.save();
    ctx.globalAlpha = Math.min(n.alpha, p.alpha) * (lit ? 0.95 : n.status === "running" ? 0.6 : 0.28);
    ctx.strokeStyle = lit ? "#ffffff" : GRIT_COLORS[colOf(n.tier)];
    ctx.lineWidth = lit ? 1.2 : 1;
    ctx.setLineDash(DASH_THREAD);
    ctx.beginPath();
    ctx.moveTo(p.x + (dx / d) * (p.r * 0.9), p.y + (dy / d) * (p.r * 0.9));
    ctx.lineTo(n.x - (dx / d) * (n.r * 0.9), n.y - (dy / d) * (n.r * 0.9));
    ctx.stroke();
    ctx.restore();
  }

  function drawParticles() {
    ctx.save();
    for (let i = 0; i < PMAX; i++) {
      const life = P.life[i];
      if (life <= 0) continue;
      const u = life / P.max[i];
      const kind = P.kind[i];
      const s = P.size[i];
      ctx.fillStyle = GRIT_COLORS[P.col[i]];
      if (kind === KIND_GRIT) {
        ctx.globalAlpha = Math.min(1, u * 1.6) * 0.8;
        ctx.fillRect(P.x[i] - s / 2, P.y[i] - s / 2, s, s);
      } else if (kind === KIND_SHARD) {
        ctx.globalAlpha = Math.min(1, u * 2);
        const r = P.rot[i];
        const c = Math.cos(r) * s;
        const si = Math.sin(r) * s;
        ctx.beginPath();
        ctx.moveTo(P.x[i] + c, P.y[i] + si);
        ctx.lineTo(P.x[i] - si * 0.8, P.y[i] + c * 0.8);
        ctx.lineTo(P.x[i] - c * 0.7, P.y[i] - si * 0.7);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.globalAlpha = u * 0.55;
        ctx.fillRect(P.x[i] - s / 2, P.y[i] - s / 2, s, s);
      }
    }
    ctx.restore();
  }

  function wrap(text, max) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      if ((line + " " + w).trim().length > max) {
        if (line) lines.push(line);
        line = w;
      } else line = (line + " " + w).trim();
    }
    if (line) lines.push(line);
    return lines;
  }

  function drawTooltip(n, isPinned) {
    const lines = [
      [n.resident ? `${say.name} · ${say.titan}` : n.id, "#ffffff"],
      [`${say.tier(n.tier)}${n.brain ? " · " + say.brain(n.brain) : ""} · ${n.status}${n.phase === "dust" ? " · dust" : ""}`, "rgba(255,255,255,0.6)"],
    ];
    if (n.quest) lines.push([`${say.quest} ${n.quest}`, "rgba(255,255,255,0.6)"]);
    if (n.resident && heat?.junctionC != null) lines.push([`junction ${heat.junctionC} C${heat.hot ? " · nothing new starts on the GPU" : held ? " · held until it cools" : ""}`, heat.hot || held ? glowCore : "rgba(255,255,255,0.6)"]);
    if (n.task) for (const l of wrap(say.text(n.task), 44).slice(0, 3)) lines.push([l, "rgba(255,255,255,0.85)"]);
    if (n.log) lines.push([`› ${say.text(n.log).slice(0, 44)}`, "rgba(255,255,255,0.45)"]);
    if (isPinned) lines.push(["pinned · click to release", "rgba(255,255,255,0.3)"]);
    ctx.save();
    ctx.font = `10.5px ${MONO}`;
    ctx.textAlign = "left";
    const pad = 8;
    const lh = 14;
    const w = Math.max(...lines.map(([t]) => ctx.measureText(t).width)) + pad * 2;
    const h = lines.length * lh + pad * 2 - 3;
    // to the right of the stone, else its left, else under it; never over it
    let x = n.x + n.r + 12;
    let y = n.y - h / 2;
    if (x + w > W - 6) x = n.x - n.r - 12 - w;
    if (x < 6) {
      x = clamp(n.x - w / 2, 6, Math.max(6, W - w - 6));
      y = n.y + n.r + (n.resident ? 36 : 12);
      if (y + h > H - 6) y = n.y - n.r - 12 - h;
    }
    y = clamp(y, 6, Math.max(6, H - h - 6));
    ctx.fillStyle = "rgba(5,5,5,0.92)";
    ctx.strokeStyle = isPinned ? "#ffffff" : "rgba(255,255,255,0.35)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.rect(x + 0.5, y + 0.5, w, h);
    ctx.fill();
    ctx.stroke();
    lines.forEach(([t, c], i) => {
      ctx.fillStyle = c;
      ctx.fillText(t, x + pad, y + pad + 9 + i * lh);
    });
    ctx.restore();
  }

  const LEGEND = [
    ["titan", 6],
    ["promethean", 4],
    ["offspring", 2.5],
  ];
  function drawLegend() {
    ctx.save();
    ctx.font = `9.5px ${MONO}`;
    ctx.textAlign = "left";
    let x = 14;
    const y = H - 14;
    for (const [name, r] of LEGEND) {
      const tone = TONES[name];
      ctx.fillStyle = `rgb(${tone.base})`;
      ctx.strokeStyle = tone.edge;
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const rr = r * (0.8 + (0.3 * ((i * 7) % 3)) / 2);
        ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = `rgb(${tone.lit})`;
      ctx.fillRect(x - r * 0.4, y - r * 0.5, r * 0.5, r * 0.5);
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      const label = say.tier(name);
      ctx.fillText(label, x + 12, y + 3.5);
      x += 12 + ctx.measureText(label).width + 18;
    }
    ctx.textAlign = "right";
    ctx.fillStyle = heat?.hot ? RED : held ? glowCore : "rgba(255,255,255,0.3)";
    if (W > 460) ctx.fillText(heatKey, W - 12, y + 3.5);
    ctx.restore();
  }

  function drawHint() {
    const titan = nodes.get(TITAN_ID);
    if (nodes.size > 1 || titan.status === "running") return;
    ctx.save();
    ctx.font = `9.5px ${MONO}`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.fillText(`no ${say.workers} out · a ${say.quest} breaks them off ${say.titan}`, W / 2, titan.y + titan.r + 48);
    ctx.restore();
  }

  function draw(now) {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const focus = hover ?? pinned;
    for (const id of order) {
      const n = nodes.get(id);
      const p = n.parent ? nodes.get(n.parent) : null;
      if (p) drawThread(n, p, focus === id || focus === p.id);
    }
    drawParticles();
    for (const id of order) drawStone(nodes.get(id), now, focus === id);
    drawHint();
    if (focus && nodes.has(focus)) drawTooltip(nodes.get(focus), pinned === focus);
    drawLegend();
    ctx.restore();
  }

  // ---- the loop: only while something moves --------------------------------------------
  let raf = 0;
  let last = 0;
  let dirty = true;
  let paused = false; // pause(): no frame is asked for until resume(); events still change the picture
  function wake() {
    if (raf || paused) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function redraw() {
    dirty = true;
    wake();
  }
  function frame(now) {
    raf = 0;
    const dt = Math.min(64, Math.max(0, now - last));
    last = now;
    if (W && H) {
      prune(now);
      const moving = step(dt, now);
      draw(now);
      dirty = false;
      if (moving) raf = requestAnimationFrame(frame);
    }
    // a canvas with no size (hidden) draws nothing and waits for its resize, which redraws
  }

  // ---- size and pointer -------------------------------------------------------------
  function resize() {
    const box = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, Math.round(box.width));
    H = Math.max(1, Math.round(box.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    resizing = true;
    layout();
    resizing = false;
    redraw();
  }
  resize();
  // the resident Titan, before anything else arrives
  const titan = ensure(TITAN_ID, { tier: "titan" });
  layout();
  setHeat(heat);
  new ResizeObserver(resize).observe(canvas);

  function hit(x, y) {
    let best = null;
    let bd = Infinity;
    for (const n of nodes.values()) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < n.r + 6 && d < bd) {
        bd = d;
        best = n.id;
      }
    }
    return best;
  }
  canvas.addEventListener("pointermove", (e) => {
    const box = canvas.getBoundingClientRect();
    const h = hit(e.clientX - box.left, e.clientY - box.top);
    if (h !== hover) {
      hover = h;
      canvas.classList.toggle("hover", !!hover);
      redraw();
    }
  });
  canvas.addEventListener("pointerleave", () => {
    if (hover == null) return;
    hover = null;
    canvas.classList.remove("hover");
    redraw();
  });
  canvas.addEventListener("click", (e) => {
    const box = canvas.getBoundingClientRect();
    const id = hit(e.clientX - box.left, e.clientY - box.top);
    pinned = id && pinned !== id ? id : null;
    redraw();
  });

  // ---- the demo: a scripted quest, so the look can be checked without a brain ------------
  let demoRun = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, reduce ? Math.min(ms, 120) : ms));
  /** two Prometheans break off, one falls and splits into two Offspring, all finish, the junction climbs to 95 and back */
  async function demo() {
    if (demoRun) return demoRun;
    const q = `demo-${Date.now().toString(36).slice(-4)}`;
    const p1 = `${q}-p1`;
    const p2 = `${q}-p2`;
    const o1 = `${q}-o1`;
    const o2 = `${q}-o2`;
    const realHeat = heat;
    if (demoEl) {
      demoEl.textContent = "playing";
      demoEl.setAttribute("aria-disabled", "true");
    }
    demoRun = (async () => {
      try {
        handle({ type: "quest.started", id: q, task: "count the stars over the forge" });
        handle({ type: "agent.spawned", id: `${q}-ck`, tier: "titan", brain: "qwen3.5-9b", quest: q, task: "count the stars over the forge" });
        await sleep(500);
        handle({ type: "agent.spawned", id: p1, tier: "promethean", parent: TITAN_ID, brain: "qwen3.5-4b", quest: q, task: "count the stars east of the forge" });
        await sleep(700);
        handle({ type: "agent.spawned", id: p2, tier: "promethean", parent: TITAN_ID, brain: "qwen3.5-4b", quest: q, task: "count the stars west of the forge" });
        await sleep(1600);
        handle({ type: "log", id: p1, text: "too many stars for one pass" });
        handle({ type: "agent.done", id: p1, status: "fell", quest: q });
        await sleep(900);
        handle({ type: "agent.split", id: p1, children: [o1, o2], quest: q, why: "the task was two tasks" });
        handle({ type: "agent.spawned", id: o1, tier: "offspring", parent: p1, brain: "qwen3.5-0.8b", quest: q, task: "the stars north-east" });
        await sleep(350);
        handle({ type: "agent.spawned", id: o2, tier: "offspring", parent: p1, brain: "qwen3.5-0.8b", quest: q, task: "the stars south-east" });
        // the junction climbs: amber past 70, red past 90, a hold at 92
        for (const j of [62, 71, 78, 84, 88]) {
          await sleep(300);
          demoHeat = { junctionC: j, hot: j >= HOT_C };
          handle({ type: "hardware.read", heat: demoHeat });
        }
        await sleep(400);
        demoHeat = { junctionC: 92, hot: true };
        handle({ type: "hardware.read", heat: demoHeat });
        handle({ type: "throttle.hold", id: p2, junctionC: 92 });
        await sleep(600);
        demoHeat = { junctionC: 95, hot: true };
        handle({ type: "hardware.read", heat: demoHeat });
        await sleep(1400);
        for (const j of [91, 87, 80, 72, 64, 58]) {
          await sleep(300);
          demoHeat = { junctionC: j, hot: j >= HOT_C };
          handle({ type: "hardware.read", heat: demoHeat });
          if (j === 80) handle({ type: "throttle.release", id: p2, junctionC: j });
        }
        await sleep(300);
        handle({ type: "agent.done", id: o1, status: "done", quest: q });
        await sleep(500);
        handle({ type: "agent.done", id: o2, status: "blocked", quest: q });
        await sleep(700);
        handle({ type: "agent.done", id: p2, status: "done", quest: q });
        await sleep(500);
        handle({ type: "agent.done", id: `${q}-ck`, status: "done", tier: "titan", quest: q });
        handle({ type: "quest.done", id: q, status: "done" });
      } finally {
        demoHeat = null;
        held = false;
        setHeat(realHeat);
        demoRun = null;
        if (demoEl) {
          demoEl.textContent = "demo";
          demoEl.removeAttribute("aria-disabled");
        }
      }
    })();
    return demoRun;
  }
  demoEl?.addEventListener("click", (e) => {
    e.preventDefault();
    demo();
  });

  return {
    nodes,
    titan,
    handle,
    demo,
    heat: () => heat,
    /** true while the frame loop runs (something moves) */
    animating: () => !!raf,
    /** stop drawing: the frame loop ends and no new frame is asked for */
    pause() {
      paused = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    /** draw again: the canvas is measured anew and the loop runs while something moves */
    resume() {
      if (!paused) return;
      paused = false;
      resize();
    },
    paused: () => paused,
    pin: (id) => {
      pinned = id;
      redraw();
    },
    /** the words changed (the brand was read): the count line and the picture say them again */
    relabel() {
      count();
      redraw();
    },
    /** every stone but the Titan goes; the Titan sits idle again */
    clear() {
      for (const id of [...nodes.keys()]) if (id !== TITAN_ID) nodes.delete(id);
      order.length = 0;
      order.push(TITAN_ID);
      aliases.clear();
      titan.children = [];
      titan.status = "idle";
      pinned = hover = null;
      P.life.fill(0);
      pAlive = 0;
      count();
    },
  };
}
