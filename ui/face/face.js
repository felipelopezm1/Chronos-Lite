// Chronos's face: a girl with a bob, goggles on her forehead and clockwork
// around her head, drawn live as a grid of monospace glyphs on one canvas.
//
//   const face = mountFace(el, { state: "idle" });   // el: a <canvas> to draw on, or a container to fill
//   await face.ready;                                 // true once she is drawn; false when she cannot draw
//   face.setState("thinking");            // idle listening thinking speaking working held done sleep
//   face.pulse();                         // once per streamed chunk while speaking: her mouth follows
//   await face.say("The junction is at 71 C.");   // the whole text: she turns to stone while she speaks
//   face.glitch(0.8);                     // one burst; glitch(0.3, true) holds a level
//   face.displace();                      // tear into slices, re-form somewhere else
//   face.skip(); face.seek(1.2); face.text(); face.destroy();
//   face.stats();                         // { renderer: "glyphs" | "none", fps, cols, rows, state, crop, glitch, mouth, eyes, boxes, ... }
//
// How she is drawn. Seven small frames (ui/face/frames, made by
// scripts/face-frames.py: four of the anime girl, three of her as a cracked
// statue) are read in the browser at mount, at about the frames' own pixels.
// Both materials are drawn as a cel: each flat tone is one quiet glyph on a wash
// of the tone's colour, the thin dark lines of the drawing (lashes, brows, the
// mouth, the jaw, strands of the fringe) are ink cells with a line glyph along
// the stroke (/ \ | _ - ( )), and her outline against the black ground follows
// a Sobel edge the same way. The anime cel is the Chronos blues with eyes of
// their own (iris, pupil, one highlight); the stone cel is the same drawing
// with the colour drained, a grain of mixed glyphs, and its cracks lit.
// The closed mouth is the one feature drawn by hand: the cel has it as a faint
// broken line, so it is found in the rest frame and drawn again as one unbroken
// bar with the small shadow under the lower lip (see fixMouth).
// Only the cells inside the mouth mask and the eye mask (where the frames
// differ) ever take another frame's values; every other cell comes from the
// rest frame of its material, so nothing flickers. The cells are stamped by
// hand into one pixel buffer (see buildGlyphs), which costs a millisecond or two.
//
// One clock (S.t) and one state object (S) drive every effect. Each state is a
// row of PLAN (her lids, gaze, glitch, drift, light, nod, breath), and every
// change of state is eased on that clock (see pose); opts.seed makes a run
// repeatable and seek(t) steps the clock to a moment and holds her there.
// Under prefers-reduced-motion nothing of her own moves (no drift, blinks,
// bursts or displacing) and a change of state cross-fades.

const NAMES = ["a-rest", "a-blink", "a-half", "a-open", "s-rest", "s-half", "s-open", "s-cracks"];
const FRAME_W = 360; // the frames' size
const FRAME_H = 480;
// the part of a frame she is made from, in parts of the frame. "head" is her head and all its clockwork,
// down to the collar (the shoulders run off the frame, so the neck fades away instead). "face" is tighter,
// for a small stage: her face, fringe and goggles, the gears let go, so her eyes keep their cells. "close" is
// for a stage smaller still (a strip, an avatar): her brows to her chin.
const CROPS = {
  head: { x0: 0.02, x1: 0.98, y0: 0.05, y1: 0.87, tight: false },
  face: { x0: 0.15, x1: 0.85, y0: 0.2, y1: 0.8, tight: true },
  close: { x0: 0.22, x1: 0.78, y0: 0.35, y1: 0.76, tight: true },
};
const aspectOf = (k) => ((k.x1 - k.x0) * FRAME_W) / ((k.y1 - k.y0) * FRAME_H);
// her eyes in the frames, in pixels (the middle of each iris), and the lens that enlarges them
const EYE_AT = [
  [135, 231],
  [226, 231],
];
const LENS_RX = 45;
const LENS_RY = 40;
const LENS_CORE = 0.3; // the part of the lens, from its middle, that is magnified in full
const CELLS_ACROSS = 124; // the cells across her head a large stage aims for
const TIGHT_UNDER = 86; // with fewer cells than this across the head, the stage shows the face
const CLOSE_UNDER = 44; // and with fewer than this across the face, her brows to her chin

// ---- glyphs ----------------------------------------------------------------

const LINES = "|/\\-_()+"; // an edge cell: which one follows from the edge's direction
const GRIT = ".,':*";
const STREAK = ".:-~=+%#@"; // a pixel-sort smear, from its tail to its head
const BLOCKS = "░▒▓█"; // light, medium, dark shade and the full block: drawn by hand, not from the font
const BAR = "─"; // a thin bar the whole width of the cell, drawn by hand: a run of them is one unbroken line

const GLYPHS = [" "];
const INDEX = new Map([[" ", 0]]);
function gi(ch) {
  if (!INDEX.has(ch)) {
    INDEX.set(ch, GLYPHS.length);
    GLYPHS.push(ch);
  }
  return INDEX.get(ch);
}
const G_LINE = Array.from(LINES, gi);
const G_GRIT = Array.from(GRIT, gi);
const G_STREAK = Array.from(STREAK, gi);
const G_DRIP = Array.from(".:!|", gi); // the same falling down a column, from its tail to its head
const G_FILL = Array.from("#%=01", gi); // what a corrupt tile may be filled with
const G_SLASH = gi("/"); // a modulated scan line: rising, falling, level
const G_BACK = gi("\\");
const G_UNDER = gi("_");
const G_BLOCK = Array.from(BLOCKS, gi);
const G_HASH = gi("#");
const G_STAR = gi("*");
const G_CRUMB = [gi("%"), gi("#"), G_BLOCK[1], G_BLOCK[0]];
const G_BLOT = gi("v"); // a blot of ink with no direction: the nose mark
const G_KNOT = gi("%"); // the same in the thick of other strokes
const G_BAR = gi(BAR);
const G_DASH = gi("-");
const G_SWEEP = gi("=");

// ---- colours ---------------------------------------------------------------
// one row a colour (each becomes a pixel table). The anime rows are the Chronos blues, dark to light;
// the stone rows a cool grey with the colour drained; the crack rows ice blue.
const PAL_ANIME = ["#0c1838", "#16295a", "#1f3a6e", "#2f4f8c", "#3b5a95", "#4a70b4", "#5f8fda", "#8cb6ee", "#bcdcfc", "#f4faff"];
const PAL_STONE = ["#0f1012", "#1d1f22", "#2d3034", "#3e4247", "#51555b", "#656a71", "#7d8289", "#969ba2", "#b4b9bf", "#dee1e5"];
// the art is flat: a few tones, each a large area. These breakpoints put every flat tone well inside one
// tier of the ramp and one colour, so a fill is one texture and one blue. (ground, navy shadow 0.12, dark
// blue 0.26, the hair 0.46, its lights 0.6, the skin 0.86, the whites)
const ROW_AT_A = [0.04, 0.085, 0.19, 0.24, 0.34, 0.42, 0.56, 0.72, 0.93];
/** how many breakpoints a tone has passed */
function stepOf(at, tone) {
  let k = 0;
  while (k < at.length && tone >= at[k]) k++;
  return k;
}
const PAL_CRACK = ["#3f82cc", "#5aa0e6", "#7cbcf6", "#a4d6ff", "#d2eeff", "#ffffff"];
const CRACK_WASH = ["#1a5bbd", "#2170d6", "#2a85ee", "#3d9bff", "#5cb2ff"].map((h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)));
const CRACK_LINE = ["#8cc8ff", "#a8d8ff", "#c6e8ff", "#e4f4ff", "#ffffff"].map((h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)));
const TONES = 10;
const ROW_A = 0;
const ROW_S = ROW_A + TONES;
const ROW_C = ROW_S + TONES;
const ROW_GHOST = ROW_C + PAL_CRACK.length; // where she was, after a displace
const ROW_ECHO = ROW_GHOST + 1; // the offset copy inside a glitch
const ROW_CYAN = ROW_ECHO + 1; // a rare cool cell inside a glitch
const ROW_VIOLET = ROW_CYAN + 1;
const ROW_SL = ROW_VIOLET + 1; // the stone beside a lit crack: the stone rows again, washed in its light
const hexRgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
const CRACK_LIGHT = hexRgb("#6fb6f6");
const PAL_STONE_LIT = PAL_STONE.map((h, k) => hexRgb(PAL_STONE[Math.min(TONES - 1, k + 1)]).map((v, q) => Math.round(v + (CRACK_LIGHT[q] - v) * 0.3)));
const RGB = [...[...PAL_ANIME, ...PAL_STONE, ...PAL_CRACK, "#3b5a95", "#2b63b4", "#63d2ee", "#8f86ff"].map(hexRgb), ...PAL_STONE_LIT];
const INK_STRENGTH = [1, 0.62, 0.38, 0.2];

// ---- the cel: both materials at rest -------------------------------------------
// One quiet glyph a flat tone, on a wash of the tone's colour that carries it; the skin is the quietest.
// [the tier's glyphs, the glyph's colour, the wash's colour, how solid the wash is]
const CEL_AT = [0.085, 0.19, 0.4, 0.56, 0.72, 0.93]; // deep, navy shadow, hair shade, hair, its lights, skin, white
const CEL = [
  [".", "#2f4f8c", "#0f1c3e", 0.5],
  ["=", "#3f62a3", "#1a2f60", 0.62],
  ["x", "#6c9ae2", "#2f5194", 0.64],
  ["+", "#9cc2f4", "#4c79c6", 0.68],
  [";", "#c0dafa", "#7ba3dc", 0.66],
  [":", "#e6f1ff", "#add2ff", 0.68],
  ["'", "#ffffff", "#e6f1ff", 0.7],
];
// the statue is the same cel with the colour drained. Its tones (the frames have them at: line 0.19, shadow
// and gears 0.37, the half tones 0.53 and 0.63, the lit stone 0.74 to 0.82, the lights 0.86) each take a
// few glyphs, mixed cell by cell: the grain of the stone.
const CEL_AT_S = [0.09, 0.27, 0.47, 0.69, 0.838];
const CEL_S = [
  [".", "#363a3f", "#111315", 0.5],
  [":;", "#555a60", "#24272a", 0.62],
  ["%x#", "#7f848b", "#45494e", 0.66],
  ["x+*", "#a7abb1", "#6b6f75", 0.68],
  [".,:'", "#ced1d5", "#8f949b", 0.68],
  ["'`.", "#ffffff", "#c3c7cc", 0.7],
];
// the ink lines: a dark cell, the stroke's glyph in a colour that shows on it
const INK = [
  ["#6f9be0", "#0d1a3c", 0.92], // across skin
  ["#4168b4", "#0b1634", 0.92], // across hair
  ["#8d939a", "#0d0e10", 0.92], // across lit stone
  ["#565a61", "#0a0b0c", 0.92], // across its shadow
];
// the eyes: the white, the iris and its darker upper half, the pupil, the one highlight
const E_WHITE = 1;
const E_IRIS = 2;
const E_IRIS_DARK = 3;
const E_PUPIL = 4;
const E_LIGHT = 5;
const EYES = [
  null,
  [".", "#ffffff", "#eef6ff", 0.86],
  ["O", "#aee4ff", "#1f8cf4", 0.9],
  ["0", "#62bcff", "#1263cc", 0.9],
  ["@", "#27478a", "#050a18", 0.95],
  ["@", "#ffffff", "#ffffff", 0.96],
];
const K_CEL = RGB.length; // the first cel row: rows from here on carry their own wash
const K_CELS = K_CEL + CEL.length; // the stone cel
const K_CELS_LIT = K_CELS + CEL_S.length; // the stone cel beside a lit crack, washed in its light
const K_INK_SKIN = K_CELS_LIT + CEL_S.length;
const K_INK_HAIR = K_INK_SKIN + 1;
const K_INK_STONE = K_INK_HAIR + 1; // and + 1 across its shadow
const K_EYE = K_INK_STONE + 2; // + E_*
// the closed mouth, drawn by hand (see fixMouth): the line on the skin, and the small shadow under the lower lip
const MOUTH = [
  ["#14244f", "#add2ff", 0.68], // the line, anime
  ["#3d5fa6", "#add2ff", 0.68], // the shadow, anime
  ["#1e2124", "#8f949b", 0.68], // the line, stone
  ["#45494e", "#8f949b", 0.68], // the shadow, stone
];
const K_MOUTH = K_EYE + EYES.length;
// line modulation: scan lines, ice on a deep navy, three strengths by the tone under them (anime, then stone)
const MOD = [
  ["#5f8fda", "#0a1638", 0.62],
  ["#9fcaff", "#0d1c46", 0.62],
  ["#e2f2ff", "#12255a", 0.62],
  ["#7d8289", "#101114", 0.62],
  ["#b4b9bf", "#16181c", 0.62],
  ["#eef0f3", "#1d2024", 0.62],
];
const K_MOD = K_MOUTH + MOUTH.length;
const CEL_GLYPH = CEL.map((k) => Array.from(k[0], gi));
const CELS_GLYPH = CEL_S.map((k) => Array.from(k[0], gi));
const EYE_GLYPH = EYES.map((k) => (k ? gi(k[0]) : 0));
const EYE_ROW = EYES.map((k, e) => K_EYE + e);
const toLight = (c, by) => c.map((v, q) => Math.round(v + (CRACK_LIGHT[q] - v) * by));
/** every row as [glyph colour, wash colour, wash strength or null for the engine's own] */
const STYLES = [
  ...RGB.map((c, row) => [c, c, row < ROW_C || row >= ROW_SL ? null : 0]),
  ...CEL.map((k) => [hexRgb(k[1]), hexRgb(k[2]), k[3]]),
  ...CEL_S.map((k) => [hexRgb(k[1]), hexRgb(k[2]), k[3]]),
  ...CEL_S.map((k) => [toLight(hexRgb(k[1]), 0.45), toLight(hexRgb(k[2]), 0.38), k[3]]),
  ...INK.map((k) => [hexRgb(k[0]), hexRgb(k[1]), k[2]]),
  ...EYES.map((k) => (k ? [hexRgb(k[1]), hexRgb(k[2]), k[3]] : [[0, 0, 0], [0, 0, 0], 0])),
  ...MOUTH.map((k) => [hexRgb(k[0]), hexRgb(k[1]), k[2]]),
  ...MOD.map((k) => [hexRgb(k[0]), hexRgb(k[1]), k[2]]),
];

// ---- the states ----------------------------------------------------------------
// What each state asks of her. eyes: her lids, 0 open, 0.5 half closed, 1 closed. gaze: where she looks,
// [across, down], each -1, 0 or 1 (the iris a cell or two aside). level: the glitch it holds, and mix: what
// that glitch is made of. bursts: [shortest, longest gap, weakest, strongest] of the bursts she starts
// herself. roam: how much she drifts. dim: her light. nod: how far her head sinks, in rows. tilt: how far
// it leans. breath: seconds a breath (0: none), and deep: how deep. blink, glance and displace: whether she
// does so by herself. stone: she is the statue. sweep: a slow clean line passes down her, again and again.
// fps: a slower loop. ease: how many times slower than usual she settles into it. then: [state, seconds] to move on by herself. Every number here is eased on her
// clock when the state changes (see pose): nothing jumps.
const MIX_NONE = { tear: 0, streak: 0, tile: 0, mod: 0, scr: 0, echo: 0, sticky: 0 };
const mixOf = (m) => ({ ...MIX_NONE, ...m });
const MIX_ALL = mixOf({ tear: 1, streak: 1, tile: 1, mod: 0.5, scr: 1, echo: 1 });
const PLAN = {
  idle: { eyes: 0, gaze: [0, 0], level: 0, roam: 1, dim: 1, nod: 0, tilt: 0, breath: 4.4, blink: true, glance: true, displace: true, bursts: [4, 10, 0.3, 0.55] },
  listening: { eyes: 0, gaze: [0, -1], level: 0, roam: 0.15, dim: 1, nod: 0.8, tilt: 0.25, breath: 3.4, blink: true },
  thinking: { eyes: 0, gaze: [1, -1], level: 0.2, roam: 0.5, dim: 0.95, nod: 0.3, tilt: -0.18, breath: 4.4, blink: true, bursts: [0.7, 1.8, 0.5, 0.85], mix: mixOf({ tear: 0.4, streak: 0.6, tile: 0.4, mod: 0.4, scr: 1, echo: 1 }) },
  speaking: { eyes: 0, gaze: [0, 0], level: 0, roam: 0.6, dim: 1, nod: 0, tilt: 0, breath: 0, stone: true },
  working: { eyes: 0.5, gaze: [0, 1], level: 0.13, roam: 0.3, dim: 1, nod: 0.5, tilt: 0, breath: 4.4, blink: true, sweep: true, mix: mixOf({ streak: 1, mod: 0.3, scr: 0.6 }) },
  held: { eyes: 0.5, gaze: [0, 0], level: 0.3, roam: 0, dim: 0.78, nod: 0.25, tilt: 0, breath: 0, fps: 30, mix: mixOf({ tear: 0.15, tile: 0.25, mod: 0.25, scr: 0.5, sticky: 1 }) },
  done: { eyes: 0, gaze: [0, 0], level: 0, roam: 0.5, dim: 1, nod: 0, tilt: 0, breath: 4.4, blink: true, then: ["idle", 1.4] },
  sleep: { eyes: 1, gaze: [0, 0], level: 0, roam: 0.08, dim: 0.5, nod: 1.4, tilt: -0.3, breath: 7.5, deep: 1.5, fps: 20, ease: 3 },
};
const STATES = Object.keys(PLAN);
const ALIAS = { talking: "speaking" };
// what a burst she starts herself is made of: one of the family at a time, so each reads as itself
const FLAVOURS = [
  mixOf({ tear: 1, streak: 0.1, scr: 0.5, echo: 1 }), // a torn signal
  mixOf({ tear: 0.08, streak: 1, scr: 0.15 }), // pixel sort
  mixOf({ tear: 0.08, tile: 1, scr: 0.3 }), // corrupt tiles
  mixOf({ mod: 1, scr: 0.1 }), // line modulation
];
const FLAVOUR_NAMES = ["tear", "pixelsort", "tiles", "modulation"];
// where she may look, as [across, down]: the gaze frames are made in this order
const GAZES = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
const gazeIndex = (x, y) => {
  const ix = x > 0.5 ? 1 : x < -0.5 ? -1 : 0;
  const iy = y > 0.5 ? 1 : y < -0.5 ? -1 : 0;
  return GAZES.findIndex(([a, b]) => a === ix && b === iy);
};
const GLANCES = [[-1, 0], [1, 0], [0, 1], [-1, 1], [1, 1]]; // where a glance of her own goes

const FONT = 'ui-monospace, "Geist Mono", "JetBrains Mono", "DejaVu Sans Mono", "SF Mono", Menlo, Consolas, monospace';

// ---- reading a frame -------------------------------------------------------
const EDGE = 0.1; // how strong a Sobel edge must be for a cell to take a line glyph ...
const GROUND = 0.05; // ... with the black ground on its dark side ...
const LIT_MOST = 0.55; // ... and its lighter tone filling no more of the cell than this
const INK_UNDER = 0.66; // a sample this far under the lightest tone around it is dark: a line, when the dark is thin
const INK_SURE = 0.42; // a cell with this share of ink samples is an ink cell ...
const INK_FAINT = 0.16; // ... and one with this share is, where no neighbour across the stroke has more

// ---- timings (seconds) -----------------------------------------------------
const PETRIFY = 0.5; // the stone front, mouth to the last gear
const CRUMBLE = 0.7; // the stone falling off again
const MOUTH_TICK = 0.07; // the mouth moves one shape (closed, half, open) at most this often
const PULSE_QUEUE = 2; // chunks that arrive faster than the mouth can follow wait, at most this many
const FADE = 0.45; // under reduced motion: a change of state cross-fades over this long
const D_CUT = 0.3; // a displace: tearing apart until here ...
const D_DUR = 0.82; // ... re-formed by here
const GHOST_LIFE = 1.15;
const EASE = 0.42; // a change of state: how long her pose, her light and her drift take to follow
const BLINK = { close: 0.06, hold: 0.07, open: 0.11 };
const SWEEP_DONE = 0.62; // the one clean line that passes down her when a piece of work is done
const SWEEP_WORK = 1.9; // the steady line while she works ...
const SWEEP_GAP = 0.7; // ... and the rest between two of them

// ---- small tools -----------------------------------------------------------

function mulberry(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** an integer to a number in [0, 1), the same every time */
function hash(n) {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeOut = (u) => 1 - (1 - u) ** 3;
const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

const VOWELS = /[aeiouyà-æè-ïò-öù-ý]/i;
const LIPS = /[bmp]/i; // the lips meet
const LETTER = /[\p{L}\p{N}]/u;
const PAUSE = /[.,;:!?\n…]/;
/** the mouth a character asks for: 0 closed, 1 half, 2 open */
function mouthFor(ch) {
  if (!ch || !LETTER.test(ch)) return 0;
  if (VOWELS.test(ch)) return 2;
  if (LIPS.test(ch)) return 0;
  return 1;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`cannot load ${src}`));
    img.src = src;
  });
}

// ---- the face --------------------------------------------------------------

/**
 * Mount her. el is a <canvas> to draw on (it keeps the CSS size its page gives
 * it) or a container to fill (she adds her own canvas; the stage should be
 * black). Returns the face at once; face.ready resolves when she is drawn.
 * Options: state (the state she starts in, "idle"), base (the frames' folder,
 * beside this module by default), seed, autoRoam, autoDisplace, autoGlitch
 * (false switches each motion off, for stills), fit (how much of the stage she
 * fills: the rest is her room to roam; 0.78 on a large stage, more on a small
 * one), crop ("head", "face" or "close"; by the stage's size otherwise),
 * backing (the wash of colour behind each glyph, 0..1, 0.45), cell (a cell's
 * width in CSS pixels, chosen for the stage otherwise), eyes (how much larger
 * her eyes are drawn than the cel has them, 2), maxFps (60), reducedMotion
 * (default: what the system asks, followed when it changes), label (the
 * canvas's aria-label), pulseRate (chunks a second she hears by herself while
 * speaking: for stills and demos).
 */
export function mountFace(el, opts = {}) {
  const base = String(opts.base ?? new URL("./frames/", import.meta.url).href).replace(/\/*$/, "/");
  const seed = (Number(opts.seed) || 1) >>> 0;
  const rand = mulberry(seed * 2654435761);
  const backing = clamp(opts.backing ?? 0.45, 0, 1);
  const cellWant = Number(opts.cell) || 0; // a cell's width in CSS pixels, when the page wants to choose it
  const eyeZoom = clamp(Number(opts.eyes ?? 2) || 1, 1, 2.4); // how much larger her eyes are drawn than the cel has them
  const cropWant = CROPS[opts.crop] ? opts.crop : null; // else by the stage's size
  const fitWant = Number(opts.fit) ? clamp(Number(opts.fit), 0.3, 1) : 0; // else by the stage's size
  const maxFps = clamp(Number(opts.maxFps) || 60, 5, 240);
  const pulseRate = Math.max(0, Number(opts.pulseRate) || 0);
  const motionQuery = opts.reducedMotion == null && typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  let reduced = opts.reducedMotion ?? !!motionQuery?.matches;
  const auto = { roam: opts.autoRoam !== false, displace: opts.autoDisplace !== false, glitch: opts.autoGlitch !== false };

  // her canvas: the one given, or one of her own filling the container given
  const own = !(typeof HTMLCanvasElement === "function" && el instanceof HTMLCanvasElement);
  const stage = el;
  const canvas = own ? document.createElement("canvas") : el;
  const label = opts.label ?? (own || !canvas.getAttribute("aria-label") ? "Chronos's face, drawn in glyphs" : null); // null: the page's own label stays
  if (own) {
    canvas.className = "face-canvas";
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    if (getComputedStyle(stage).position === "static") stage.style.position = "relative";
    stage.append(canvas);
  }
  if (!canvas.getAttribute("role")) canvas.setAttribute("role", "img");
  const opacityWas = canvas.style.opacity;
  let ctx = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null; // a canvas that already has another kind of context
  }

  // the layout: all in device pixels
  let W = 0;
  let H = 0;
  let dpr = 1;
  let cols = 0;
  let rows = 0;
  let cw = 0; // a cell's width
  let chh = 0; // a cell's height
  let figW = 0;
  let figH = 0;
  let n = 0;
  let fit = 0.78;
  let crop = CROPS.head; // the part of the frames she is made from, chosen in layout
  let cropName = "head";
  let SX = 3; // samples across a cell when a frame is read
  let SY = 6; // and down it (a cell is twice as tall as wide)
  let lens = null; // where each sample reads the frame: her eyes magnified (see lensOf)

  // the glyphs as coverage masks, the pixel tables of every colour, and the buffer she is stamped into
  let masks = new Uint8Array(0);
  let cellPx = 0;
  let cellLut = [];
  let inkLut = [];
  let crackLut = [];
  let image = null;
  let buf = new Uint32Array(0);
  const box = { x0: 0, y0: 0, x1: 0, y1: 0 }; // what this frame stamped
  const was = { x0: 0, y0: 0, x1: 0, y1: 0 }; // what the last one did

  let images = null; // name -> Image, once loaded
  let failed = false; // the frames did not arrive, or there is no 2D canvas: she cannot draw
  let G = null; // the grids of the current layout (see analyse)
  let mat = new Uint8Array(0); // per cell: 0 anime, 1 stone
  let shown = new Uint8Array(0); // per cell: the glyph the last frame drew (see text)
  let rowDx = new Int32Array(0); // per row: sideways shift this frame
  let rowHide = new Uint8Array(0);
  let rowMod = new Float32Array(0); // per row: how far the line modulation has it, 0..1

  // ---- the state: one object, one clock ------------------------------------
  const first = PLAN[ALIAS[opts.state] ?? opts.state] ? (ALIAS[opts.state] ?? opts.state) : "idle";
  const S = {
    t: 0,
    state: first,
    stateT0: 0,
    thenAt: Infinity, // when a state that moves on by itself does so
    floor: 0, // the glitch level that is held by glitch(level, true)
    burst: null, // a burst: { level, t0, hold, mix }, eased in, held, eased out
    level: 0, // the glitch level this frame
    mix: MIX_ALL, // and what it is made of
    nextBurst: 2 + rand() * 4,
    flavour: (rand() * FLAVOURS.length) | 0,
    acc: { tear: 0, streak: 0, tile: 0, mod: 0 },
    tears: [],
    streaks: [],
    tiles: [],
    mods: [], // bands of line modulation
    sticky: [], // the tiles a held glitch keeps
    sweeps: [],
    nextSweep: 0,
    grit: [],
    ghosts: [],
    fade: null, // under reduced motion: { from: the last frame's pixels, t0 } while a change of state cross-fades
    glitchCells: 0, // cells the glitch drew this frame
    // eyes and mouth
    nextBlink: 1.4 + rand() * 2.5,
    blinkT0: -9,
    lid: 0, // 0 open, 1 closed: the state's lid and a blink, this frame
    eyes: 0, // what is drawn: 0 open, 1 half, 2 closed
    gazeK: 0, // which way she looks: an index into GAZES
    glance: { x: 0, y: 0, until: 0, next: 3 + rand() * 5 },
    mouth: 0, // 0 closed, 1 half, 2 open
    mouthNext: 0,
    mouthHeld: 0,
    pulseQ: 0, // chunks heard that the mouth has not followed yet (see pulse)
    pulseN: 0,
    pulses: 0, // every chunk heard
    pulseAcc: 0,
    energy: 0, // how hard she is speaking, eased: the cracks pulse with it
    bob: 0, // her nod and her breath, in pixels down
    // stone
    stone: "off", // off | petrify | on | crumble
    stoneT0: 0,
    afterCrumble: null,
    speech: null,
    // where she is
    anchor: { x: 0, y: 0 }, // -1..1 of the room she has
    px: 0,
    py: 0,
    vx: 0,
    sway: 0,
    swayY: 0,
    lean: 0,
    breath: rand(), // the phase of her breathing, in breaths
    qx: 0,
    qy: 0,
    jolt: { x: 0, y: 0, t: -1 },
    pointer: { x: 0, y: 0, on: false },
    disp: null,
    wantDisplace: false,
    nextDisplace: 6 + rand() * 8,
    phase: [rand() * 6.28, rand() * 6.28, rand() * 6.28, rand() * 6.28, rand() * 6.28, rand() * 6.28, rand() * 6.28],
  };

  // ---- eased values: each runs from where it is to its target, on her clock ----
  const tw = {};
  const val = (key) => {
    const a = tw[key];
    if (!a) return 0;
    if (a.dur <= 0 || S.t >= a.t0 + a.dur) return a.to;
    return a.from + (a.to - a.from) * easeInOut((S.t - a.t0) / a.dur);
  };
  const aim = (key, to, dur = EASE) => {
    tw[key] = { from: dur > 0 ? val(key) : to, to, t0: S.t, dur };
  };
  /** aim everything a state asks for; at once when dur is 0 */
  function pose(name, dur = EASE) {
    const P = PLAN[name];
    aim("level", P.level, dur * 0.6);
    aim("roam", P.roam, dur * 1.6);
    aim("dim", P.dim, dur * 1.8);
    aim("nod", P.nod, dur * 1.3);
    aim("tilt", P.tilt, dur * 1.3);
    aim("breathe", P.breath > 0 ? (P.deep ?? 1) : 0, dur * 1.5);
    aim("pace", P.breath > 0 ? 1 / P.breath : 0, dur * 2);
    aim("lid", P.eyes, dur * (P.eyes > 0.75 ? 2 : 0.8)); // falling asleep, the lids close slowly
    aim("gx", P.gaze[0], dur * 0.5);
    aim("gy", P.gaze[1], dur * 0.5);
  }
  pose(first, 0);
  if (PLAN[first].stone) S.stone = "on";
  if (PLAN[first].then) S.thenAt = PLAN[first].then[1];

  // ---- layout and analysis -------------------------------------------------

  /** Size the grid for the stage. False while the stage has no size (not shown yet): a later resize lays her out. */
  function layout() {
    if (!ctx) return false;
    dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    // the stage's own size, before any transform its page puts on it
    const cssW = stage.clientWidth || stage.getBoundingClientRect().width;
    const cssH = stage.clientHeight || stage.getBoundingClientRect().height;
    if (cssW < 8 || cssH < 8) return false;
    W = Math.max(1, Math.round(cssW * dpr));
    H = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    // a small stage has little room to give away: she fills more of it
    const small = Math.min(cssW, cssH);
    fit = fitWant || (small < 200 ? 0.96 : small < 520 ? 0.88 : 0.78);
    // she fits inside the stage with room to roam; well over a hundred cells across her on a desktop.
    // (a small stage keeps its cells small: 4 CSS pixels, 3 where the screen is dense enough to draw them)
    const least = Math.round((dpr >= 1.5 ? 3 : 4) * dpr);
    const size = (k, min = least) => {
      const wantW = Math.min(W * fit, H * fit * aspectOf(k));
      const cellCss = cellWant || clamp(wantW / dpr / CELLS_ACROSS, min / dpr, 7);
      const w = Math.max(2, Math.round(cellCss * dpr));
      return { w, cols: clamp(Math.floor(wantW / w), 10, 160), wantW };
    };
    cropName = cropWant ?? "head";
    let fitted = size(CROPS[cropName]);
    if (!cropWant && fitted.cols < TIGHT_UNDER) {
      // too few cells for her eyes: let the gears go and show her face
      cropName = "face";
      fitted = size(CROPS.face);
      if (fitted.cols < CLOSE_UNDER) {
        // fewer still: her brows to her chin, and cells as small as the screen draws, down to two pixels
        cropName = "close";
        fitted = size(CROPS.close);
        if (fitted.cols < CLOSE_UNDER) fitted = size(CROPS.close, clamp(Math.floor(fitted.wantW / CLOSE_UNDER), 2, least));
      }
    }
    crop = CROPS[cropName];
    cw = fitted.w;
    chh = cw * 2;
    cols = fitted.cols;
    rows = Math.max(5, Math.round((cols / aspectOf(crop)) * 0.5));
    // read the frames at about their own pixels: so many samples a cell
    SX = clamp(Math.round(((crop.x1 - crop.x0) * FRAME_W) / cols), 3, 6);
    SY = SX * 2;
    figW = cols * cw;
    figH = rows * chh;
    n = cols * rows;
    mat = new Uint8Array(n).fill(S.stone === "on" ? 1 : 0); // a front on its way fills it again as it passes
    shown = new Uint8Array(n);
    rowDx = new Int32Array(rows);
    rowHide = new Uint8Array(rows);
    rowMod = new Float32Array(rows);
    // what was in flight was made for the old grid
    S.tears.length = S.streaks.length = S.tiles.length = S.mods.length = S.sticky.length = S.ghosts.length = S.grit.length = S.sweeps.length = 0;
    S.disp = null;
    S.fade = null;
    image = ctx.createImageData(W, H);
    buf = new Uint32Array(image.data.buffer);
    was.x0 = was.y0 = 0;
    was.x1 = W;
    was.y1 = H;
    buildGlyphs();
    if (images) analyse();
    return true;
  }

  /**
   * The glyphs as coverage masks, one cell each, and for every colour the pixel
   * each coverage gives. She is stamped into one pixel buffer by hand: a few
   * thousand cells of fifty pixels is cheap on any CPU, where as many drawImage
   * calls are not.
   */
  function buildGlyphs() {
    cellPx = cw * chh;
    const strip = document.createElement("canvas");
    strip.width = cw * GLYPHS.length;
    strip.height = chh;
    const a = strip.getContext("2d", { willReadFrequently: true });
    // the font size at which one glyph is as wide as a cell
    a.font = `700 100px ${FONT}`;
    const advance = a.measureText("M").width / 100 || 0.6;
    const px = Math.max(5, (cw * 1.04) / advance);
    a.font = `700 ${px}px ${FONT}`;
    a.textAlign = "center";
    a.textBaseline = "alphabetic";
    a.fillStyle = "#fff";
    const baseY = chh * 0.5 + px * 0.33;
    for (let g = 1; g < GLYPHS.length; g++) {
      if (BLOCKS.includes(GLYPHS[g]) || GLYPHS[g] === BAR) continue;
      a.save();
      a.beginPath();
      a.rect(g * cw, 0, cw, chh);
      a.clip();
      a.fillText(GLYPHS[g], g * cw + cw / 2, baseY);
      a.restore();
    }
    const d = a.getImageData(0, 0, strip.width, chh).data;
    masks = new Uint8Array(GLYPHS.length * cellPx);
    for (let g = 1; g < GLYPHS.length; g++) {
      for (let j = 0; j < chh; j++) {
        // a small glyph's strokes are thin: lift the coverage a little so it carries its colour
        for (let i = 0; i < cw; i++) masks[g * cellPx + j * cw + i] = Math.round(255 * (d[(j * strip.width + g * cw + i) * 4 + 3] / 255) ** 0.75);
      }
    }
    // the shades are drawn by hand, a dither of small squares that fills the cell exactly
    const dot = Math.max(1, Math.round(cw / 4));
    for (let shade = 0; shade < 4; shade++) {
      const at = G_BLOCK[shade] * cellPx;
      for (let j = 0; j < chh; j++) {
        for (let i = 0; i < cw; i++) {
          const u = (i / dot) | 0;
          const v = (j / dot) | 0;
          const on = shade === 3 || (shade === 0 && u % 2 === 0 && v % 2 === 0) || (shade === 1 && (u + v) % 2 === 0) || (shade === 2 && !(u % 2 === 1 && v % 2 === 1));
          masks[at + j * cw + i] = on ? 255 : 0;
        }
      }
    }
    // the bar: one thin line across the middle of the cell, edge to edge
    const th = Math.max(1, Math.round(chh * 0.13));
    const top = Math.round(chh * 0.5 - th / 2);
    for (let j = top; j < top + th; j++) masks.fill(255, G_BAR * cellPx + j * cw, G_BAR * cellPx + (j + 1) * cw);
    lutCache.clear();
  }

  // the pixel tables of every colour, one set for each step of her light (see dim in PLAN), made when first asked for
  const lutCache = new Map();
  function useLight(dim) {
    const key = Math.round(clamp(dim, 0.2, 1) * 40);
    let set = lutCache.get(key);
    if (!set) lutCache.set(key, (set = makeLuts(key / 40)));
    ({ cellLut, inkLut, crackLut } = set);
  }
  function makeLuts(light) {
    // pixels are 0xAABBGGRR; the canvas stays clear wherever nothing is stamped
    const pack = (c, alpha) => ((Math.round(clamp(alpha, 0, 1) * 255) << 24) | (Math.round(c[2] * light) << 16) | (Math.round(c[1] * light) << 8) | Math.round(c[0] * light)) >>> 0;
    const table = (fn) => {
      const lut = new Uint32Array(256);
      for (let k = 0; k < 256; k++) lut[k] = fn(k / 255);
      return lut;
    };
    // a cell: its colour, thin behind the glyph (the backing, so a flat fill reads as one tone) and full in it
    const cells = STYLES.map(([ink, wash, solid]) => {
      const lo = solid ?? backing;
      return table((k) => pack([0, 1, 2].map((q) => Math.round(wash[q] + (ink[q] - wash[q]) * k)), lo + (1 - lo) * k));
    });
    // ink alone at four strengths: ghosts, echoes, grit
    const inks = INK_STRENGTH.map((s) => RGB.map((c) => table((k) => pack(c, k * s))));
    // a lit crack: lightning in the stone, the cell an electric blue, the crack itself an ice-white line in it; five strengths
    const cracks = CRACK_WASH.map((wash, lv) => {
      const lo = 0.82 + 0.04 * lv;
      const line = CRACK_LINE[lv];
      return table((k) => pack([0, 1, 2].map((q) => Math.round(wash[q] + (line[q] - wash[q]) * k)), lo + (1 - lo) * k));
    });
    return { cellLut: cells, inkLut: inks, crackLut: cracks };
  }

  /**
   * One frame at SX by SY samples a cell (about the frame's own pixels): the
   * luminance of every sample, and per cell its mean tone, its lightest and
   * darkest sample, and its edge.
   */
  function read(img, octx, hw, hh) {
    octx.fillStyle = "#000";
    octx.fillRect(0, 0, hw, hh);
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    octx.drawImage(img, crop.x0 * iw, crop.y0 * ih, (crop.x1 - crop.x0) * iw, (crop.y1 - crop.y0) * ih, 0, 0, hw, hh);
    const d = octx.getImageData(0, 0, hw, hh).data;
    const flat = new Float32Array(hw * hh);
    for (let i = 0, j = 0; i < flat.length; i++, j += 4) flat[i] = (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255;
    // her eyes through the lens (see lensOf): every frame the same way, so the frames still line up
    let L = flat;
    if (lens) {
      L = new Float32Array(hw * hh);
      for (let i = 0; i < L.length; i++) {
        const sx = lens[i * 2];
        const sy = lens[i * 2 + 1];
        const x0 = sx | 0;
        const y0 = sy | 0;
        const x1 = Math.min(hw - 1, x0 + 1);
        const y1 = Math.min(hh - 1, y0 + 1);
        const u = sx - x0;
        const v = sy - y0;
        L[i] = (flat[y0 * hw + x0] * (1 - u) + flat[y0 * hw + x1] * u) * (1 - v) + (flat[y1 * hw + x0] * (1 - u) + flat[y1 * hw + x1] * u) * v;
      }
    }
    const mean = new Float32Array(n);
    const top = new Float32Array(n);
    const low = new Float32Array(n);
    const edge = new Float32Array(n); // how strong
    const cls = new Uint8Array(n); // 0 none, else 1 + index into LINES
    const at = (x, y) => L[clamp(y, 0, hh - 1) * hw + clamp(x, 0, hw - 1)];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        let mx = 0;
        let mn = 1;
        let jxx = 0;
        let jyy = 0;
        let jxy = 0;
        let ey = 0;
        for (let y = r * SY; y < r * SY + SY; y++) {
          for (let x = c * SX; x < c * SX + SX; x++) {
            const v = L[y * hw + x];
            sum += v;
            if (v > mx) mx = v;
            if (v < mn) mn = v;
            // Sobel
            const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) / 4;
            const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) / 4;
            jxx += gx * gx;
            jyy += gy * gy;
            jxy += gx * gy;
            ey += (gx * gx + gy * gy) * ((y - r * SY + 0.5) / SY);
          }
        }
        const i = r * cols + c;
        const e2 = jxx + jyy;
        mean[i] = sum / (SX * SY);
        top[i] = mx;
        low[i] = mn;
        edge[i] = Math.sqrt(e2 / (SX * SY));
        if (e2 > 1e-6) {
          // the structure tensor gives the gradient's direction whichever way it points;
          // the edge runs across it. A "/" in a cell twice as tall as wide has its gradient at 27 degrees.
          const th = (0.5 * Math.atan2(2 * jxy, jxx - jyy) * 180) / Math.PI;
          const coherent = Math.hypot(jxx - jyy, 2 * jxy) / e2;
          const ath = Math.abs(th);
          if (coherent < 0.22) cls[i] = 8; // "+": a corner or a knot
          else if (ath < 13) cls[i] = 1; // |
          else if (ath < 58) cls[i] = th > 0 ? 2 : 3; // / or \
          else cls[i] = ey / e2 > 0.62 ? 5 : 4; // _ when the edge sits low in the cell, else -
        }
      }
    }
    return { L, mean, top, low, edge, cls };
  }

  /**
   * Anime eyes are large; the cel's are not, and at this grid an eye would be two rows of cells. So the
   * frames are read through a lens over each eye: inside it the picture is magnified (more down than
   * across), and round it the skin is squeezed a little to make the room. For every sample of the grid's
   * picture this gives the place in the frame's picture to read, as x, y pairs; null when the zoom is 1.
   */
  function lensOf(hw, hh) {
    if (eyeZoom <= 1.001) return null;
    const map = new Float32Array(hw * hh * 2);
    const wPx = (crop.x1 - crop.x0) * FRAME_W; // the crop in pixels of the frame
    const hPx = (crop.y1 - crop.y0) * FRAME_H;
    const zx = 1 + (eyeZoom - 1) * 0.5; // across
    const zy = eyeZoom; // down
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < hw; x++) {
        let px = crop.x0 * FRAME_W + ((x + 0.5) / hw) * wPx; // this sample, in pixels of the frame
        let py = crop.y0 * FRAME_H + ((y + 0.5) / hh) * hPx;
        for (const [cx, cy] of EYE_AT) {
          const dx = px - cx;
          const dy = py - cy;
          const r = Math.hypot(dx / LENS_RX, dy / LENS_RY);
          if (r >= 1) continue;
          const t = smooth(LENS_CORE, 1, r); // 0 in the lens's core, 1 at its rim
          px = cx + dx * (1 / zx + (1 - 1 / zx) * t);
          py = cy + dy * (1 / zy + (1 - 1 / zy) * t);
          break;
        }
        const i = (y * hw + x) * 2;
        map[i] = clamp(((px - crop.x0 * FRAME_W) / wPx) * hw - 0.5, 0, hw - 1);
        map[i + 1] = clamp(((py - crop.y0 * FRAME_H) / hPx) * hh - 0.5, 0, hh - 1);
      }
    }
    return map;
  }

  /** The largest (or smallest) value within r samples, along rows then columns: a square window. */
  function spread(src, hw, hh, r, biggest) {
    const pick = biggest ? Math.max : Math.min;
    const mid = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < hw; x++) {
        let v = src[y * hw + x];
        for (let k = Math.max(0, x - r); k <= Math.min(hw - 1, x + r); k++) v = pick(v, src[y * hw + k]);
        mid[y * hw + x] = v;
      }
    }
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < hw; x++) {
        let v = mid[y * hw + x];
        for (let k = Math.max(0, y - r); k <= Math.min(hh - 1, y + r); k++) v = pick(v, mid[k * hw + x]);
        out[y * hw + x] = v;
      }
    }
    return out;
  }

  /**
   * The ink of the cel: the thin dark lines that carry her features (lashes,
   * brows, the nose mark, the mouth, the jaw, the strands of the fringe, the
   * goggles' rims). A sample is dark when it is well under the lightest tone
   * around it (and that tone is skin or hair, not the ground); it is ink when
   * the dark shape it belongs to is thin, so a shadow or a pupil is not.
   * Returns per sample 1 for ink, 2 for a thick dark shape, and the tone around it.
   */
  function inkOf(L, hw, hh) {
    const perPx = hw / ((crop.x1 - crop.x0) * FRAME_W); // samples to one pixel of the frame
    const around = spread(L, hw, hh, Math.max(2, Math.round(4 * perPx)), true);
    const dark = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) dark[i] = L[i] < around[i] * INK_UNDER && around[i] > 0.35 && L[i] > 0.045 ? 1 : 0;
    const ro = Math.max(1, Math.round(3 * perPx));
    const thick = spread(spread(dark, hw, hh, ro, false), hw, hh, ro, true); // what is left of the dark after wearing it away and growing it back
    const kind = new Uint8Array(L.length);
    for (let i = 0; i < L.length; i++) if (dark[i]) kind[i] = thick[i] ? 2 : 1;
    return { kind, around };
  }

  function analyse() {
    const hw = cols * SX;
    const hh = rows * SY;
    const cellN = SX * SY;
    const off = document.createElement("canvas");
    off.width = hw;
    off.height = hh;
    const octx = off.getContext("2d", { willReadFrequently: true });
    octx.imageSmoothingQuality = "high";
    lens = lensOf(hw, hh);
    const raw = {};
    for (const name of NAMES) raw[name] = read(images[name], octx, hw, hh);
    // a point of the frame, in cells
    const colOf = (fx) => ((fx - crop.x0) / (crop.x1 - crop.x0)) * cols;
    const rowOf = (fy) => ((fy - crop.y0) / (crop.y1 - crop.y0)) * rows;

    const rnd = new Float32Array(n); // each cell's own number, for scattered orders and the stone's grain
    const rnd2 = new Float32Array(n);
    const fade = new Float32Array(n); // the neck dissolves, and so do the edges of a crop that cuts into her
    const depth = new Float32Array(n); // the parallax: a soft dome over the face, highest at the nose
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        rnd[i] = hash(i * 2 + 1 + seed * 7919);
        rnd2[i] = hash(i * 2 + 977 + seed * 104729);
        const u = (c + 0.5) / cols;
        const v = (r + 0.5) / rows;
        const fx = crop.x0 + u * (crop.x1 - crop.x0); // the same point in parts of the frame
        const fy = crop.y0 + v * (crop.y1 - crop.y0);
        fade[i] = Math.max(smooth(0.73, 0.86, fy), smooth(0.144, 0.384, Math.abs(fx - 0.5)) * smooth(0.706, 0.788, fy));
        if (crop.tight) fade[i] = Math.max(fade[i], 1 - smooth(0, 0.09, Math.min(u, 1 - u, v * 1.4)), smooth(0.86, 1, v));
        const d2 = ((fx - 0.5) / 0.4) ** 2 + ((fy - 0.542) / 0.41) ** 2;
        depth[i] = d2 < 1 ? (1 - d2) ** 1.5 : 0;
      }
    }
    const gone = (i) => rnd[i] < fade[i] ** 1.3;

    // strokes that curve: an upright one with a "/" above and a "\" below is a "(", the mirror a ")"
    const lineGlyph = (cl, i, c, r) => {
      let k = cl[i] - 1;
      if (k === 0 && r > 0 && r < rows - 1) {
        const up = cl[i - cols];
        const upR = c < cols - 1 ? cl[i - cols + 1] : 0;
        const upL = c > 0 ? cl[i - cols - 1] : 0;
        const dn = cl[i + cols];
        const dnR = c < cols - 1 ? cl[i + cols + 1] : 0;
        const dnL = c > 0 ? cl[i + cols - 1] : 0;
        const open = (up === 2 || upR === 2 ? 1 : 0) + (dn === 3 || dnR === 3 ? 1 : 0);
        const close = (up === 3 || upL === 3 ? 1 : 0) + (dn === 2 || dnL === 2 ? 1 : 0);
        if (open === 2 && close < 2) k = 5;
        else if (close === 2 && open < 2) k = 6;
      }
      return G_LINE[k];
    };

    // ---- the eyes, read from the open frame against the blink ----------------
    // Per eye: the iris (mid tones that the blink covers), the pupil (the dark inside it), one
    // highlight (the light inside it) and the white of the eye (the light between the lashes).
    const eye = new Uint8Array(n); // 0, or E_WHITE, E_IRIS, E_IRIS_DARK, E_PUPIL, E_LIGHT
    const eyeParts = []; // per eye: its cells, the rows they span, its half of the face, and how far a glance moves the iris
    {
      const A = raw["a-rest"].L;
      const B = raw["a-blink"].L;
      const perPx = hw / ((crop.x1 - crop.x0) * FRAME_W);
      const y0 = clamp(Math.floor(rowOf(0.4) * SY), 0, hh);
      const y1 = clamp(Math.ceil(rowOf(0.55) * SY), 0, hh);
      const xMid = Math.round(colOf(0.5) * SX);
      for (const [xa, xb] of [[clamp(Math.floor(colOf(0.2) * SX), 0, hw), xMid], [xMid, clamp(Math.ceil(colOf(0.8) * SX), 0, hw)]]) {
        if (xb - xa < 4 || y1 - y0 < 4) continue;
        const w = xb - xa;
        const h = y1 - y0;
        // the iris: mid tones of the open eye where the blink changes the picture, thin fringes worn off
        const mid = new Float32Array(w * h);
        const changed = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const a = A[(y + y0) * hw + x + xa];
            const diff = Math.abs(a - B[(y + y0) * hw + x + xa]) > 0.2;
            changed[y * w + x] = diff ? 1 : 0;
            mid[y * w + x] = diff && a > 0.2 && a < 0.64 ? 1 : 0;
          }
        }
        const ro = Math.max(1, Math.round(1.5 * perPx));
        const iris = spread(spread(mid, w, h, ro, false), w, h, ro, true);
        let bx0 = w;
        let bx1 = -1;
        let by0 = h;
        let by1 = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (!iris[y * w + x]) continue;
            if (x < bx0) bx0 = x;
            if (x > bx1) bx1 = x;
            if (y < by0) by0 = y;
            if (y > by1) by1 = y;
          }
        }
        if (bx1 < bx0) continue;
        // the eye's opening, row by row: from the first sample the blink changes to the last
        const rowL = new Int32Array(h).fill(w);
        const rowR = new Int32Array(h).fill(-1);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (!changed[y * w + x]) continue;
            if (x < rowL[y]) rowL[y] = x;
            if (x > rowR[y]) rowR[y] = x;
          }
        }
        // count, per cell, what its samples are
        const count = new Map(); // cell -> [white, iris, irisTone, pupil, light]
        const tally = (x, y, k, v = 1) => {
          const i = (((y + y0) / SY) | 0) * cols + (((x + xa) / SX) | 0);
          let t = count.get(i);
          if (!t) count.set(i, (t = [0, 0, 0, 0, 0]));
          t[k] += v;
        };
        const cx = (bx0 + bx1) / 2;
        const rad = (bx1 - bx0 + 1) / 2;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const a = A[(y + y0) * hw + x + xa];
            const inBox = x >= bx0 && x <= bx1 && y >= by0 && y <= by1;
            if (iris[y * w + x]) {
              tally(x, y, 1);
              tally(x, y, 2, a);
            } else if (inBox && a < 0.2 && Math.abs(x - cx) < rad * 0.62 && y > by0 + (by1 - by0) * 0.12) tally(x, y, 3); // the dark in the middle of the iris
            else if (inBox && a > 0.7 && Math.abs(x - cx) < rad * 0.85 && y < by0 + (by1 - by0) * 0.7) tally(x, y, 4); // the light inside it
            else if (a > 0.7 && x >= rowL[y] && x <= rowR[y] && y >= by0 - 1 && y <= by1) tally(x, y, 0); // the white, beside the iris
          }
        }
        let best = -1;
        let bestN = 0;
        for (const [i, t] of count) {
          if (t[4] > bestN) {
            bestN = t[4];
            best = i;
          }
          if (t[3] >= cellN * 0.4) eye[i] = E_PUPIL;
          else if (t[1] >= cellN * 0.34) eye[i] = t[2] / t[1] < 0.4 ? E_IRIS_DARK : E_IRIS;
          else if (t[0] >= cellN * 0.5) eye[i] = E_WHITE;
        }
        if (best >= 0) eye[best] = E_LIGHT; // one highlight an eye
        const cells = [...count.keys()].filter((i) => eye[i]);
        if (cells.length) {
          const rs = cells.map((i) => (i / cols) | 0);
          const cs = cells.map((i) => i % cols);
          const iris = cells.filter((i) => eye[i] >= E_IRIS);
          const ic = iris.map((i) => i % cols);
          const ir = iris.map((i) => (i / cols) | 0);
          const wide = iris.length ? Math.max(...ic) - Math.min(...ic) + 1 : 0;
          const tall = iris.length ? Math.max(...ir) - Math.min(...ir) + 1 : 0;
          eyeParts.push({ cells, set: new Set(cells), r0: Math.min(...rs), r1: Math.max(...rs), c0: Math.min(...cs), c1: Math.max(...cs), colA: Math.floor(xa / SX), colB: Math.min(cols, Math.ceil(xb / SX)), sx: clamp(Math.round(wide * 0.24), 1, 3), sy: clamp(Math.round(tall * 0.3), 1, 2) });
        }
      }
    }

    const inkBeside = (m, i) => {
      const c = i % cols;
      const r = (i / cols) | 0;
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && c + dx >= 0 && c + dx < cols && r + dy >= 0 && r + dy < rows && m[i + dy * cols + dx]) k++;
      return k;
    };

    // ---- a material as a cel ---------------------------------------------------
    // Each flat tone is one quiet glyph on a wash of its colour; the ink lines are dark cells with a
    // line glyph along the stroke; the anime eyes have their own colours. Nothing in a flat area of the
    // anime cel is random; the stone's tones mix a few glyphs cell by cell, its grain.
    const encodeCel = (name, stone, eyes) => {
      const { L, mean, top, low, edge, cls } = raw[name];
      const { kind, around } = inkOf(L, hw, hh);
      // per cell: how much of it is ink, which way the stroke runs, how light it is around the stroke
      const share = new Float32Array(n);
      const dir = new Uint8Array(n); // as cls: 1 | 2 / 3 \ 4 - 5 _ 8 a blot
      const lightAround = new Float32Array(n);
      const mx = Math.ceil(SX / 2); // the stroke's direction is read from a window a little wider than the cell
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let k = 0;
          let cyIn = 0;
          let sa = 0;
          for (let y = r * SY; y < r * SY + SY; y++) {
            for (let x = c * SX; x < c * SX + SX; x++) {
              if (kind[y * hw + x] !== 1) continue;
              k++;
              cyIn += (y - r * SY + 0.5) / SY;
              sa += around[y * hw + x];
            }
          }
          const i = r * cols + c;
          share[i] = k / cellN;
          if (!k) continue;
          lightAround[i] = sa / k;
          let m = 0;
          let sx = 0;
          let sy = 0;
          let sxx = 0;
          let syy = 0;
          let sxy = 0;
          for (let y = Math.max(0, r * SY - mx); y < Math.min(hh, r * SY + SY + mx); y++) {
            for (let x = Math.max(0, c * SX - mx); x < Math.min(hw, c * SX + SX + mx); x++) {
              if (kind[y * hw + x] !== 1) continue;
              m++;
              sx += x;
              sy += y;
              sxx += x * x;
              syy += y * y;
              sxy += x * y;
            }
          }
          const vx = sxx / m - (sx / m) ** 2;
          const vy = syy / m - (sy / m) ** 2;
          const vxy = sxy / m - (sx / m) * (sy / m);
          const long = Math.hypot(vx - vy, 2 * vxy);
          const ang = (0.5 * Math.atan2(2 * vxy, vx - vy) * 180) / Math.PI; // the stroke's own direction, y down
          const a = Math.abs(ang);
          if (long / (vx + vy + 1e-6) < 0.22) dir[i] = 8;
          else if (a < 31) dir[i] = cyIn / k > 0.62 ? 5 : 4;
          else if (a < 76) dir[i] = ang > 0 ? 3 : 2;
          else dir[i] = 1;
        }
      }
      // an ink cell: a good share of ink; a faint share counts only where the stroke is strongest across
      // its own direction, so a line a little off the grid is one cell thick, not two
      const isInk = new Uint8Array(n);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const s = share[i];
          if (s < INK_FAINT) continue;
          if (s >= INK_SURE) {
            isInk[i] = 1;
            continue;
          }
          let a = 0;
          let b = 0;
          if (dir[i] === 4 || dir[i] === 5) {
            a = r > 0 ? share[i - cols] : 0;
            b = r < rows - 1 ? share[i + cols] : 0;
          } else if (dir[i] === 1) {
            a = c > 0 ? share[i - 1] : 0;
            b = c < cols - 1 ? share[i + 1] : 0;
          }
          if (s >= a && s > b) isInk[i] = 1;
        }
      }

      const g = new Uint8Array(n);
      const row = new Uint8Array(n);
      const lv = new Uint8Array(n); // the tone as a level 0..9: what smears from the cell in a glitch, how high its scan line rides
      for (let i = 0; i < n; i++) {
        if (gone(i)) continue;
        const tone = mean[i];
        lv[i] = stone ? clamp(Math.floor(tone * TONES), 0, TONES - 1) : stepOf(ROW_AT_A, tone);
        const lit = (mean[i] - low[i]) / (top[i] - low[i] + 1e-6); // how much of the cell its lighter tone fills
        const e = eyes ? eye[i] : 0;
        if (e >= E_IRIS) {
          g[i] = EYE_GLYPH[e];
          row[i] = EYE_ROW[e];
        } else if (isInk[i]) {
          // ink: a dark cell with a line glyph along the stroke, lighter where the stroke crosses a light tone
          g[i] = dir[i] === 8 ? G_BLOT : lineGlyph(dir, i, i % cols, (i / cols) | 0);
          if (dir[i] === 8 && inkBeside(isInk, i) > 3) g[i] = G_KNOT; // a blot in the thick of other strokes is a knot of them
          row[i] = stone ? K_INK_STONE + (lightAround[i] > 0.6 ? 0 : 1) : lightAround[i] > 0.66 ? K_INK_SKIN : K_INK_HAIR;
        } else if (e === E_WHITE) {
          g[i] = EYE_GLYPH[e];
          row[i] = EYE_ROW[e];
        } else if (edge[i] > EDGE && top[i] - low[i] > 0.2 && lit < LIT_MOST && low[i] < GROUND && cls[i]) {
          // her outline against the black ground, and the gears' strokes: a line glyph that follows the
          // edge, in the lighter tone's colour
          g[i] = lineGlyph(cls, i, i % cols, (i / cols) | 0);
          const t2 = (mean[i] * 0.25 + top[i] * 0.75) * (1 - 0.55 * fade[i]);
          row[i] = stone ? ROW_S + clamp(Math.floor(t2 * TONES), 0, TONES - 1) : ROW_A + stepOf(ROW_AT_A, t2);
        } else if (tone >= 0.04) {
          const t2 = tone * (1 - 0.4 * fade[i]);
          if (stone) {
            let k = stepOf(CEL_AT_S, t2);
            if (k >= 2 && rnd[i] < 0.09) k--; // stone is pitted: one cell in eleven sits a shade darker
            const set = CELS_GLYPH[k];
            g[i] = set[(rnd2[i] * set.length) | 0];
            row[i] = K_CELS + k;
          } else {
            const k = stepOf(CEL_AT, t2);
            g[i] = CEL_GLYPH[k][0];
            row[i] = K_CEL + k;
          }
        }
      }
      return { g, row, lv };
    };

    // the cells where two frames differ, inside a box given in parts of the frame, small specks dropped, grown by one cell
    const differ = (pairs, fx0, fx1, fy0, fy1) => {
      const m = new Uint8Array(n);
      const c0 = clamp(Math.floor(colOf(fx0)), 0, cols);
      const c1 = clamp(Math.ceil(colOf(fx1)), 0, cols);
      const r0 = clamp(Math.floor(rowOf(fy0)), 0, rows);
      const r1 = clamp(Math.ceil(rowOf(fy1)), 0, rows);
      for (const [a, b] of pairs) {
        const A = raw[a];
        const B = raw[b];
        for (let r = r0; r < r1; r++) {
          for (let c = c0; c < c1; c++) {
            const i = r * cols + c;
            if (Math.abs(A.mean[i] - B.mean[i]) > 0.13 || Math.abs(A.top[i] - B.top[i]) > 0.3 || Math.abs(A.low[i] - B.low[i]) > 0.3) m[i] = 1;
          }
        }
      }
      const near = (i, c, r, src) => {
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const cc = c + dx;
            const rr = r + dy;
            if ((dx || dy) && cc >= 0 && cc < cols && rr >= 0 && rr < rows && src[rr * cols + cc]) k++;
          }
        }
        return k;
      };
      const kept = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (m[i] && near(i, i % cols, (i / cols) | 0, m) >= 2) kept[i] = 1;
      const grown = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (kept[i] || near(i, i % cols, (i / cols) | 0, kept) > 0) grown[i] = 1;
      return grown;
    };
    const frames = {
      a: [encodeCel("a-rest", false, true), encodeCel("a-half", false, true), encodeCel("a-open", false, true)],
      blink: encodeCel("a-blink", false, false),
      s: [encodeCel("s-rest", true, false), encodeCel("s-half", true, false), encodeCel("s-open", true, false)],
    };
    const open = frames.a[0];
    const isInkRow = (k) => k >= K_INK_SKIN && k < K_EYE;

    // ---- the closed mouth ------------------------------------------------------
    // The cel draws it as a faint line, broken in the middle, that this grid reads as a few specks. So it
    // is drawn again: one unbroken thin line where the rest frame has its mouth, and the small shadow under
    // the lower lip, both bars on the skin; the specks between the nose and the chin are let go.
    const mouthMarks = (() => {
      const L = raw["a-rest"].L;
      const x0 = clamp(Math.floor(colOf(0.36) * SX), 0, hw);
      const x1 = clamp(Math.ceil(colOf(0.64) * SX), 0, hw);
      const y0 = clamp(Math.floor(rowOf(0.625) * SY), 0, hh);
      const y1 = clamp(Math.ceil(rowOf(0.71) * SY), 0, hh);
      if (x1 - x0 < 4 || y1 - y0 < 4) return null;
      // the skin: the light the box is mostly made of
      const vals = [];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) vals.push(L[y * hw + x]);
      vals.sort((a, b) => a - b);
      const skin = vals[Math.floor(vals.length * 0.7)];
      // per sample row: how many samples are dark, and from where to where
      const band = [];
      for (let y = y0; y < y1; y++) {
        let k = 0;
        let a = x1;
        let b = -1;
        for (let x = x0; x < x1; x++) {
          if (L[y * hw + x] >= skin * 0.8) continue;
          k++;
          if (x < a) a = x;
          if (x > b) b = x;
        }
        band.push({ y, k, a, b });
      }
      // dark rows that touch make one mark; the widest is the mouth, the one under it with most dark the shadow
      const marks = [];
      for (const row of band) {
        if (row.k < 2) continue;
        const m = marks[marks.length - 1];
        if (m && row.y - m.yb <= 1) {
          m.yb = row.y;
          m.a = Math.min(m.a, row.a);
          m.b = Math.max(m.b, row.b);
          m.k += row.k;
          m.ys += row.y * row.k;
        } else marks.push({ ya: row.y, yb: row.y, a: row.a, b: row.b, k: row.k, ys: row.y * row.k });
      }
      if (!marks.length) return null;
      // the line is thin: a mark no taller than a few pixels of the frame (the jaw's shadow below is not one)
      const perPy = hh / ((crop.y1 - crop.y0) * FRAME_H);
      const tall = (m, px) => m.yb - m.ya <= Math.max(1, Math.round(px * perPy));
      const thin = marks.filter((m) => tall(m, 4));
      if (!thin.length) return null;
      const line = thin.reduce((p, m) => (m.b - m.a > p.b - p.a ? m : p));
      // the shadow: the next small mark under it, short, its middle under the line's
      const mid = (line.a + line.b) / 2;
      const below = marks.filter((m) => tall(m, 8)).filter((m) => m.ya > line.yb + 1 && m.b - m.a < (line.b - line.a) * 0.7 && Math.abs((m.a + m.b) / 2 - mid) < (line.b - line.a) * 0.25);
      const shadow = below.length ? below[0] : null;
      const cells = (m) => ({ r: clamp(Math.floor(m.ys / m.k / SY), 0, rows - 1), c0: clamp(Math.floor(m.a / SX), 0, cols - 1), c1: clamp(Math.floor(m.b / SX), 0, cols - 1) });
      return { line: cells(line), shadow: shadow ? cells(shadow) : null, r0: Math.floor(y0 / SY), r1: Math.ceil(y1 / SY), c0: Math.floor(colOf(0.38)), c1: Math.ceil(colOf(0.62)) };
    })();
    const fixMouth = (f, stone) => {
      if (!mouthMarks) return;
      const { line, shadow, r0, r1, c0, c1 } = mouthMarks;
      // the skin beside the mouth, to paint the specks over with
      const side = line.r * cols + clamp(line.c0 - 2, 0, cols - 1);
      const deep = stone ? K_CELS : K_CEL; // the two darkest tones of the cel
      const speck = (k) => isInkRow(k) || (k >= deep && k < deep + 2);
      for (let r = Math.max(0, r0); r < Math.min(rows, r1); r++) {
        for (let c = Math.max(0, c0), i = r * cols + c; c < Math.min(cols, c1); c++, i++) {
          if (f.g[i] && speck(f.row[i])) {
            f.g[i] = f.g[side];
            f.row[i] = f.row[side];
          }
        }
      }
      for (let c = line.c0, i = line.r * cols + c; c <= line.c1; c++, i++) {
        f.g[i] = G_BAR;
        f.row[i] = K_MOUTH + (stone ? 2 : 0);
      }
      if (shadow) {
        // the shadow is short: a bar in a softer colour, its middle under the middle of the line
        const mid = (line.c0 + line.c1) / 2;
        const half = Math.max(1, Math.round((shadow.c1 - shadow.c0) / 2));
        for (let c = Math.round(mid - half), i = shadow.r * cols + c; c <= Math.round(mid + half); c++, i++) {
          f.g[i] = G_BAR;
          f.row[i] = K_MOUTH + (stone ? 3 : 1);
        }
      }
    };
    fixMouth(frames.a[0], false);
    fixMouth(frames.s[0], true);

    // the masks: where the frames differ as pictures, and where they differ as drawn
    const mouthMask = differ([["a-rest", "a-open"], ["a-rest", "a-half"], ["s-rest", "s-open"], ["s-rest", "s-half"]], 0.3, 0.7, 0.56, 0.78);
    const eyeMask = differ([["a-rest", "a-blink"]], 0.2, 0.8, 0.4, 0.55);
    for (let i = 0; i < n; i++) if (eye[i]) eyeMask[i] = 1; // every cell the eyes paint closes with the blink
    const drawnApart = (mask, sets, fx0, fx1, fy0, fy1) => {
      const c0 = clamp(Math.floor(colOf(fx0)), 0, cols);
      const c1 = clamp(Math.ceil(colOf(fx1)), 0, cols);
      const r0 = clamp(Math.floor(rowOf(fy0)), 0, rows);
      const r1 = clamp(Math.ceil(rowOf(fy1)), 0, rows);
      for (const [A, B] of sets) for (let r = r0; r < r1; r++) for (let c = c0, i = r * cols + c0; c < c1; c++, i++) if (A.g[i] !== B.g[i] || A.row[i] !== B.row[i]) mask[i] = 1;
    };
    drawnApart(mouthMask, [[frames.a[0], frames.a[1]], [frames.a[0], frames.a[2]], [frames.s[0], frames.s[1]], [frames.s[0], frames.s[2]]], 0.36, 0.64, 0.6, 0.74);
    drawnApart(eyeMask, [[open, frames.blink]], 0.24, 0.76, 0.42, 0.54);

    // where she looks: the eyes' cells again, the iris a cell or two aside, up or down (in the order of GAZES)
    const drawnIris = (i) => open.row[i] >= K_EYE + E_IRIS && open.row[i] <= K_EYE + E_LIGHT;
    const gazes = [open];
    for (const [gx, gy] of GAZES.slice(1)) {
      const f = { g: open.g.slice(), row: open.row.slice(), lv: open.lv };
      for (const part of eyeParts) {
        for (const i of part.cells) {
          if (!open.g[i] || isInkRow(open.row[i])) continue; // a lash line stays where it is
          const c = (i % cols) - gx * part.sx;
          const r = ((i / cols) | 0) - gy * part.sy;
          const j = r * cols + c;
          const e = c >= 0 && c < cols && r >= 0 && r < rows && part.set.has(j) ? eye[j] : 0;
          if (e >= E_IRIS) {
            f.g[i] = EYE_GLYPH[e];
            f.row[i] = EYE_ROW[e];
          } else if (drawnIris(i)) {
            f.g[i] = EYE_GLYPH[E_WHITE];
            f.row[i] = EYE_ROW[E_WHITE];
          }
        }
      }
      gazes.push(f);
    }
    // her lids half closed, between open and the blink, for each way she may look: the closed frame above
    // the middle row of each eye, a lash line along it, the open eye below
    const lidOf = (src) => {
      const lid = { g: src.g.slice(), row: src.row.slice(), lv: src.lv };
      for (const part of eyeParts) {
        const mid = Math.floor((part.r0 + part.r1 + 1) / 2);
        for (let r = 0; r <= mid && r < rows; r++) {
          for (let c = part.colA, i = r * cols + part.colA; c < part.colB; c++, i++) {
            if (!eyeMask[i]) continue;
            if (r < mid) {
              lid.g[i] = frames.blink.g[i];
              lid.row[i] = frames.blink.row[i];
            } else if (part.set.has(i)) {
              lid.g[i] = G_LINE[3]; // "-"
              lid.row[i] = K_INK_HAIR;
            }
          }
        }
      }
      return lid;
    };
    frames.gaze = gazes;
    frames.lid = gazes.map(lidOf);
    // the boxes of the eyes and the mouth, in cells [c0, r0, c1, r1), for stats() and the checks
    const eyeBoxes = eyeParts.map((p) => [p.c0, p.r0, p.c1 + 1, p.r1 + 1]);
    let mb = [cols, rows, 0, 0];
    for (let i = 0; i < n; i++) {
      if (!mouthMask[i]) continue;
      const c = i % cols;
      const r = (i / cols) | 0;
      mb = [Math.min(mb[0], c), Math.min(mb[1], r), Math.max(mb[2], c + 1), Math.max(mb[3], r + 1)];
    }
    const mouthBox = mb[2] > mb[0] ? mb : null;

    // the mouth: where the stone starts, and the cells grit falls from
    let mc = 0;
    let mr = 0;
    let mk = 0;
    let mLow = 0;
    for (let i = 0; i < n; i++) {
      if (!mouthMask[i]) continue;
      mc += i % cols;
      mr += (i / cols) | 0;
      mk++;
      mLow = Math.max(mLow, (i / cols) | 0);
    }
    mc = mk ? mc / mk : colOf(0.5);
    mr = mk ? mr / mk : rowOf(0.64);
    const jaw = [];
    for (let i = 0; i < n; i++) if (mouthMask[i] && ((i / cols) | 0) >= mLow - 1) jaw.push(i);
    if (!jaw.length) jaw.push(clamp(Math.round(mr), 0, rows - 1) * cols + clamp(Math.round(mc), 0, cols - 1));

    // how far each cell is from the mouth (in cell widths, ragged), and the order the stone falls off in
    const dist = new Float32Array(n);
    const order = new Float32Array(n);
    let maxDist = 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        dist[i] = Math.hypot(c - mc, (r - mr) * 2) + (rnd2[i] - 0.5) * 5;
        if (dist[i] > maxDist) maxDist = dist[i];
        order[i] = 0.06 + 0.72 * rnd[i] + 0.2 * (r / rows);
      }
    }

    // the cracks of the statue: the cells s-cracks.png marks, each with a line glyph along the crack
    const cr = raw["s-cracks"];
    const crack = new Uint8Array(n); // 0, or the glyph a lit crack shows
    const crackCells = [];
    for (let i = 0; i < n; i++) {
      if (cr.top[i] < 0.5 || cr.mean[i] < 0.1 || gone(i)) continue;
      crack[i] = cr.cls[i] && cr.cls[i] !== 8 ? G_LINE[cr.cls[i] - 1] : G_LINE[1 + ((rnd[i] * 2) | 0)];
      crackCells.push(i);
    }

    // the cells beside a crack, which its light reaches: 1 right beside it, 2 a little further
    const near = new Uint8Array(n);
    for (const i of crackCells) {
      const c0 = i % cols;
      const r0 = (i / cols) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const c = c0 + dx;
          const r = r0 + dy;
          if (c < 0 || c >= cols || r < 0 || r >= rows || crack[r * cols + c]) continue;
          const k = Math.abs(dx) <= 1 && dy === 0 ? 1 : 2;
          const j = r * cols + c;
          if (!near[j] || k < near[j]) near[j] = k;
        }
      }
    }

    // the light cells of her, where a pixel-sort streak may start, and her first and last cell in each row
    const lit = [];
    for (let i = 0; i < n; i++) if (open.g[i] && open.lv[i] >= 5) lit.push(i);
    const edgeL = new Int16Array(rows).fill(-1);
    const edgeR = new Int16Array(rows).fill(-1);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!open.g[r * cols + c]) continue;
        if (edgeL[r] < 0) edgeL[r] = c;
        edgeR[r] = c;
      }
    }

    G = { frames, rnd, rnd2, depth, dist, order, maxDist, mouthMask, eyeMask, crack, near, crackCells, jaw, lit, edgeL, edgeR, mc, mr, eyeBoxes, mouthBox, mouthLine: mouthMarks?.line ?? null };
  }

  // ---- stepping the clock ----------------------------------------------------

  const stony = () => S.stone === "on" || S.stone === "petrify";

  /** The stone front out from the mouth, or the crumble back; at once under reduced motion. */
  function setStone(on) {
    if (reduced) {
      const was = S.stone;
      S.stone = on ? "on" : "off";
      mat.fill(on ? 1 : 0);
      if (!on && was !== "off") settleStone();
      return;
    }
    if (on && (S.stone === "off" || S.stone === "crumble")) {
      S.stone = "petrify";
      S.stoneT0 = S.t;
    } else if (!on && (S.stone === "on" || S.stone === "petrify")) {
      S.stone = "crumble";
      S.stoneT0 = S.t;
    }
  }
  /** the stone is off her: keep the promise of the line that turned her to stone */
  function settleStone() {
    const done = S.afterCrumble;
    S.afterCrumble = null;
    done?.();
  }

  /** the room she has to roam, each way from the centre */
  function room() {
    const pad = cw * 2;
    return { x: Math.max(0, (W - figW) / 2 - pad), y: Math.max(0, (H - figH) / 2 - pad) };
  }
  /** her top left corner on the canvas now */
  function origin() {
    const st = stony();
    // stone moves in steps
    let x = st ? S.qx : S.px;
    let y = st ? S.qy : S.py;
    const j = S.t - S.jolt.t;
    if (j >= 0 && j < 0.09) {
      x += S.jolt.x * (1 - j / 0.09);
      y += S.jolt.y * (1 - j / 0.09);
    }
    // (her head's small nod, S.swayY, moves her whole: cells shifted up and down singly would open seams)
    const nod = (st ? Math.round(S.swayY * 2) / 2 : S.swayY) * chh * 0.3 + S.bob;
    return { x: Math.round((W - figW) / 2 + x), y: Math.round((H - figH) / 2 + y + nod) };
  }

  /** A burst of glitch: eased in over 40 ms, held, eased out over 400 ms. None under reduced motion. */
  function burst(level, hold, mix) {
    if (reduced || level <= burstAt(S.t)) return;
    S.burst = { level, t0: S.t, hold, mix };
    // a burst opens with a handful of its own kind at once, so even a short one reads as what it is
    S.acc.streak += 14 * level * mix.streak;
    S.acc.tile += 26 * level * mix.tile;
    S.acc.mod += 3 * level * mix.mod;
    S.acc.tear += 3 * level * mix.tear;
  }
  function burstAt(t) {
    const b = S.burst;
    if (!b) return 0;
    const u = t - b.t0;
    if (u < 0.04) return b.level * easeOut(u / 0.04);
    if (u < 0.04 + b.hold) return b.level;
    const d = (u - 0.04 - b.hold) / 0.4;
    if (d >= 1) {
      S.burst = null;
      return 0;
    }
    return b.level * (1 - easeInOut(d));
  }

  function addGrit(i, count, spread = 1, chunks = false) {
    if (S.grit.length > 260) return;
    const o = origin();
    const c = i % cols;
    const r = (i / cols) | 0;
    for (let k = 0; k < count; k++) {
      const life = 0.55 + rand() * 0.6;
      S.grit.push({
        x: o.x + (c + rand()) * cw,
        y: o.y + (r + rand() * 0.6) * chh,
        vx: (rand() - 0.5) * 40 * dpr * spread,
        vy: (10 + rand() * 50) * dpr,
        life,
        life0: life,
        // grit is small; when the stone falls off, some of it is a crumb of the stone itself
        g: chunks && rand() < 0.4 ? G_CRUMB[(rand() * G_CRUMB.length) | 0] : G_GRIT[(rand() * G_GRIT.length) | 0],
        row: ROW_S + 6 + ((rand() * 4) | 0),
      });
    }
  }

  /** A tile of corrupt cells, square on the screen: on her mostly, some in the dark around her; in her blues, now and then a cool one. */
  function tileAt(sticky) {
    const h = sticky ? 1 + ((rand() * 2) | 0) : 1 + ((rand() ** 1.6 * 4) | 0);
    const w = h * 2 + (rand() < 0.3 ? 1 + ((rand() * 4) | 0) : 0);
    const out = !sticky && rand() < 0.3; // a tile thrown off her, into the room round her
    let c = 0;
    let r = 0;
    for (let k = 0; k < 6; k++) {
      c = out ? ((rand() * (cols + 24)) | 0) - 12 : (rand() * Math.max(1, cols - w)) | 0;
      r = out ? ((rand() * (rows + 6)) | 0) - 3 : (rand() * Math.max(1, rows - h)) | 0;
      if (out || G.frames.a[0].g[r * cols + c]) break;
    }
    const odd = rand();
    const on = c >= 0 && c < cols && r >= 0 && r < rows;
    const base = on && mat[r * cols + c] ? ROW_S : ROW_A;
    const tones = sticky ? [1, 2, 3, 4] : [1, 3, 5, 6, 7, 8, 9];
    const row = odd < 0.08 ? ROW_CYAN : odd < 0.1 ? ROW_VIOLET : base + tones[(rand() * tones.length) | 0];
    const life = sticky ? 1.2 + rand() * 2 : 0.12 + rand() * 0.3;
    const g = sticky && rand() < 0.5 ? G_FILL[(rand() * G_FILL.length) | 0] : G_BLOCK[(rand() * G_BLOCK.length) | 0];
    return { c, r, w, h, life, g, row };
  }

  function startDisplace() {
    if (S.disp || !n) return;
    // where to: another spot of the room, well away from here
    const rm = room();
    const far = 0.75 * Math.max(rm.x, rm.y, 1);
    let to = { x: 0, y: 0 };
    let best = -1;
    for (let k = 0; k < 8; k++) {
      const p = { x: rand() * 2 - 1, y: rand() * 2 - 1 };
      const d = Math.hypot((p.x - S.anchor.x) * rm.x, (p.y - S.anchor.y) * rm.y) * 0.62;
      if (d > best) {
        best = d;
        to = p;
      }
      if (d > far) break;
    }
    // the slices: bands of rows, each with its own sideways throw
    const slices = new Float32Array(rows);
    const gone = new Float32Array(rows);
    for (let r = 0; r < rows; ) {
      const h = 1 + ((rand() * 5) | 0);
      const dx = rand() < 0.2 ? 0 : (rand() * 2 - 1) * (4 + rand() * 12);
      const g = rand();
      for (let k = 0; k < h && r < rows; k++, r++) {
        slices[r] = dx;
        gone[r] = g;
      }
    }
    S.disp = { t0: S.t, to, slices, gone, cut: false };
    burst(0.45, D_CUT, FLAVOURS[0]);
  }

  function endSpeech(sp) {
    if (S.speech !== sp) return;
    progress(sp, sp.len);
    S.speech = null;
    if (S.stone === "off") sp.resolve();
    else {
      settleStone();
      S.afterCrumble = sp.resolve;
    }
    go("done");
  }
  /** told to stop mid-line: the rest of the text is shown at once and its promise kept */
  function cutSpeech() {
    const sp = S.speech;
    if (!sp) return;
    progress(sp, sp.len);
    S.speech = null;
    if (S.stone === "off") sp.resolve();
    else {
      settleStone();
      S.afterCrumble = sp.resolve;
    }
  }

  function progress(sp, shown) {
    if (shown === sp.shown) return;
    sp.shown = shown;
    try {
      sp.onProgress?.(shown, sp.len);
    } catch (err) {
      console.error("a say() onProgress threw", err);
    }
  }

  /** Move to a state: everything it asks for is eased from where she is (cross-faded under reduced motion). */
  function go(name, o = {}) {
    if (reduced && G && n && name !== S.state && buf.length) S.fade = { from: buf.slice(), t0: S.t };
    S.state = name;
    S.stateT0 = S.t;
    const P = PLAN[name];
    pose(name, reduced ? 0 : EASE * (P.ease ?? 1));
    const stone = o.stone ?? !!P.stone;
    if (stone) settleStone(); // a crumble cut short by more stone: its line is over all the same
    setStone(stone);
    S.thenAt = P.then ? S.t + P.then[1] + (S.stone === "crumble" ? CRUMBLE : 0) : Infinity;
    if (P.bursts) S.nextBurst = S.t + 0.25 + rand() * 0.5;
    if (P.sweep) S.nextSweep = S.t + 0.2;
    if (name === "done" && !reduced) S.sweeps.push({ t0: S.t + (S.stone === "crumble" ? CRUMBLE * 0.6 : 0.05), dur: SWEEP_DONE });
    if (name === "idle") S.nextDisplace = S.t + 6 + rand() * 8;
    if (name !== "speaking") S.pulseQ = S.pulseAcc = 0;
    relabel();
    if (!stepping) kick(); // (from inside a step the loop is running already)
  }

  let stepping = false;
  function step(dt) {
    stepping = true;
    try {
      advance(dt);
    } finally {
      stepping = false;
    }
  }
  function advance(dt) {
    const t = (S.t += dt);
    const calm = reduced; // nothing of her own moves: no drift, no blinks, no bursts
    if (t >= S.thenAt) {
      S.thenAt = Infinity;
      go(PLAN[S.state].then?.[0] ?? "idle");
    }
    const P = PLAN[S.state];

    // -- stone: the front out from the mouth, and the crumble back
    if (S.stone === "petrify") {
      const p = (t - S.stoneT0) / PETRIFY;
      const R = (G.maxDist + 3) * Math.pow(clamp(p, 0, 1), 0.85);
      for (let i = 0; i < n; i++) if (G.dist[i] <= R) mat[i] = 1;
      if (p >= 1) {
        S.stone = "on";
        mat.fill(1);
      }
    } else if (S.stone === "crumble") {
      const p = (t - S.stoneT0) / CRUMBLE;
      for (let i = 0; i < n; i++) {
        if (mat[i] && G.order[i] <= p) {
          mat[i] = 0;
          if (G.frames.s[0].g[i] && G.rnd2[i] < 0.1) addGrit(i, 1, 1.4, true);
        }
      }
      if (p >= 1) {
        S.stone = "off";
        mat.fill(0);
        settleStone();
      }
    }

    // -- the mouth: a text sets the pace, or the chunks of a streamed answer do (see pulse); it moves one
    // shape a tick, so open to closed passes through half
    const sp = S.speech;
    let want = -1; // -1: not this frame
    if (sp && sp.phase === "speak") {
      const tau = t - sp.t0;
      if (tau >= 0) {
        const shown = Math.min(sp.len, Math.floor((tau / sp.dur) * sp.len) + 1);
        if (t >= S.mouthNext) {
          S.mouthNext = t + MOUTH_TICK;
          // the widest shape among what was said since the last tick; a pause closes it
          let w = 0;
          let pause = false;
          for (let k = sp.mouthFrom; k < shown; k++) {
            w = Math.max(w, mouthFor(sp.chars[k]));
            if (PAUSE.test(sp.chars[k])) pause = true;
          }
          if (pause && shown - sp.mouthFrom < 4) w = 0;
          sp.mouthFrom = shown;
          if (w === 2 && S.mouthHeld >= 2) w = 1; // never held wide for long: a syllable closes a little
          S.mouthHeld = w === S.mouth ? S.mouthHeld + 1 : 0;
          want = w;
        }
        progress(sp, shown);
        if (tau >= sp.dur) {
          sp.phase = "tail";
          sp.tailT = t;
        }
      }
    } else if (sp && sp.phase === "hold") {
      if (t >= sp.until) endSpeech(sp);
    } else if (sp && sp.phase === "tail") {
      if (t >= S.mouthNext) {
        S.mouthNext = t + MOUTH_TICK;
        want = 0;
      }
      if (t - sp.tailT > 0.3) endSpeech(sp);
    } else if (!sp && S.state === "speaking") {
      if (pulseRate > 0 && !calm) for (S.pulseAcc += dt * pulseRate; S.pulseAcc >= 1; S.pulseAcc--) pulse(1);
      if (t >= S.mouthNext) {
        S.mouthNext = t + MOUTH_TICK;
        if (S.pulseQ > 0) {
          // a chunk: the mouth opens a step (closed to half, half to open, open back to half) ...
          S.pulseQ--;
          S.pulseN++;
          want = S.mouth === 0 ? 2 : S.mouth === 1 ? (S.pulseN % 3 ? 2 : 0) : 1;
        } else want = 0; // ... and with none, closes again
      }
    } else if (S.mouth && t >= S.mouthNext) {
      S.mouthNext = t + MOUTH_TICK;
      want = 0;
    }
    if (calm) S.mouth = S.state === "speaking" ? 1 : 0;
    else if (want >= 0) {
      const before = S.mouth;
      S.mouth += Math.sign(want - S.mouth);
      if (S.mouth === 2 && before !== 2 && S.stone !== "off") {
        // rock grinding: now and then grit falls from the jaw or a crack
        if (rand() < 0.65) addGrit(G.jaw[(rand() * G.jaw.length) | 0], 2 + ((rand() * 3) | 0));
        if (rand() < 0.35 && G.crackCells.length) addGrit(G.crackCells[(rand() * G.crackCells.length) | 0], 1 + ((rand() * 3) | 0));
        S.jolt = { x: (rand() - 0.5) * cw * 0.7, y: (rand() - 0.5) * cw * 0.5, t };
      }
    }
    const loud = S.mouth / 2;
    S.energy += (loud - S.energy) * Math.min(1, dt * (loud > S.energy ? 20 : 4.5));

    // -- the eyes: the state's lids, her blinks (at natural intervals, now and then a double), her glances
    if (P.blink && !calm && S.stone === "off" && !S.disp) {
      if (t >= S.nextBlink) {
        S.blinkT0 = t;
        S.nextBlink = t + (rand() < 0.16 ? 0.32 : 2.4 + rand() * 3.6);
      }
    } else if (t >= S.nextBlink) S.nextBlink = t + 0.8 + rand() * 2;
    const bu = t - S.blinkT0;
    const shut = BLINK.close + BLINK.hold;
    const blink = bu < 0 ? 0 : bu < BLINK.close ? bu / BLINK.close : bu < shut ? 1 : bu < shut + BLINK.open ? 1 - (bu - shut) / BLINK.open : 0;
    S.lid = Math.max(val("lid"), blink);
    S.eyes = S.lid < 0.3 ? 0 : S.lid < 0.75 ? 1 : 2;
    let gx = val("gx");
    let gy = val("gy");
    if (P.glance && !calm) {
      const g = S.glance;
      if (t >= g.next) {
        [g.x, g.y] = GLANCES[(rand() * GLANCES.length) | 0];
        g.until = t + 0.5 + rand() * 1.1;
        g.next = g.until + 2.5 + rand() * 5;
      }
      if (t < g.until) {
        gx = g.x;
        gy = g.y;
      }
    }
    S.gazeK = gazeIndex(gx, gy);

    // -- the glitch: the state's own level, a level held by glitch(v, true), and bursts
    const B = P.bursts;
    if (B && auto.glitch && !calm && t >= S.nextBurst) {
      S.flavour = (S.flavour + 1 + ((rand() * (FLAVOURS.length - 1)) | 0)) % FLAVOURS.length; // never the same twice running
      burst(B[2] + rand() * (B[3] - B[2]), 0.05 + rand() * 0.15, FLAVOURS[S.flavour]);
      S.nextBurst = t + B[0] + rand() * (B[1] - B[0]);
    }
    const inBurst = burstAt(t);
    const steady = Math.max(S.floor, val("level"));
    const L = (S.level = clamp(Math.max(steady, inBurst), 0, 1));
    const M = (S.mix = inBurst > steady && S.burst ? S.burst.mix : S.floor > val("level") ? MIX_ALL : (P.mix ?? MIX_ALL));
    if (L > 0.04 && !calm) {
      S.acc.tear += dt * (2 + 24 * L) * M.tear;
      S.acc.streak += dt * 34 * L * M.streak;
      S.acc.tile += dt * 20 * L * M.tile;
      S.acc.mod += dt * 7 * L * M.mod;
    }
    for (; S.acc.tear >= 1; S.acc.tear--) {
      const h = 1 + ((rand() * 7) | 0);
      const r0 = (rand() * Math.max(1, rows - h)) | 0;
      const dx = Math.round((rand() < 0.5 ? -1 : 1) * (1 + rand() * 16 * L));
      S.tears.push({ r0, r1: r0 + h, dx, life: 0.06 + rand() * 0.26 });
    }
    for (; S.acc.streak >= 1; S.acc.streak--) {
      if (!G.lit.length) break;
      const i = G.lit[(rand() * G.lit.length) | 0];
      const life = 0.3 + rand() * 0.55;
      // a light cell smears along its row, mostly outwards, off her and into the dark
      const out = i % cols < cols / 2 ? -1 : 1;
      const lv = (mat[i] ? G.frames.s[0].row[i] - ROW_S : G.frames.a[0].lv[i]) + 1;
      // a band of one to three rows smeared together, the way a sort drags a run of pixels
      S.streaks.push({ c: i % cols, r: (i / cols) | 0, h: 1 + ((rand() * rand() * 3) | 0), dir: rand() < 0.75 ? out : -out, len: 12 + ((rand() * 60 * (0.3 + L)) | 0), life, life0: life, lv: clamp(lv, 5, TONES - 1), stone: mat[i] });
    }
    for (; S.acc.tile >= 1; S.acc.tile--) S.tiles.push(tileAt(false));
    for (; S.acc.mod >= 1; S.acc.mod--) {
      const h = 4 + ((rand() * 11) | 0);
      const life = 0.22 + rand() * 0.4;
      S.mods.push({ r0: (rand() * Math.max(1, rows - h)) | 0, h, life, life0: life, amp: 1 + rand() * 1.6, k: 0.2 + rand() * 0.45, ph: rand() * 6.28, v: (rand() < 0.5 ? -1 : 1) * (5 + rand() * 9) });
    }
    const age = (list) => {
      let k = 0;
      for (const it of list) if ((it.life -= dt) > 0) list[k++] = it;
      list.length = k;
    };
    age(S.tears);
    age(S.streaks);
    age(S.tiles);
    age(S.mods);
    // a held glitch keeps a few tiles where they are, each for a second or three, one changing at a time
    if (!calm) age(S.sticky);
    const keep = Math.round(16 * Math.min(1, steady * 2.2) * M.sticky);
    while (S.sticky.length < keep) S.sticky.push(tileAt(true));
    if (S.sticky.length > keep) S.sticky.length = keep;
    // the slow clean line while she works
    if (P.sweep && !calm && t >= S.nextSweep) {
      S.sweeps.push({ t0: t, dur: SWEEP_WORK });
      S.nextSweep = t + SWEEP_WORK + SWEEP_GAP;
    }
    let k = 0;
    for (const s of S.sweeps) if (t - s.t0 < s.dur) S.sweeps[k++] = s;
    S.sweeps.length = k;

    // -- grit falls
    const grav = 620 * dpr;
    k = 0;
    for (const p of S.grit) {
      p.life -= dt;
      p.vy += grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.life > 0 && p.y < H + chh) S.grit[k++] = p;
    }
    S.grit.length = k;
    k = 0;
    for (const g of S.ghosts) if (t - g.t0 < GHOST_LIFE) S.ghosts[k++] = g;
    S.ghosts.length = k;

    // -- a displace: tear, leave a ghost, re-form somewhere else
    if (!calm && (S.wantDisplace || (auto.displace && P.displace && S.stone === "off" && !S.disp && t >= S.nextDisplace))) startDisplace();
    S.wantDisplace = false;
    let jumped = false;
    if (S.disp) {
      const d = S.disp;
      const u = t - d.t0;
      if (!d.cut && u >= D_CUT) {
        d.cut = true;
        const o = origin();
        S.ghosts.push({ x: o.x, y: o.y, slices: d.slices, t0: t, stone: S.stone === "on" });
        S.anchor = d.to;
        jumped = true;
      }
      if (u >= D_DUR) {
        S.disp = null;
        S.nextDisplace = t + 6 + rand() * 8;
      }
    }

    // -- where she is: an anchor (a displace moves it) plus a slow drift of summed sines, as much as the state lets her
    const rm = room();
    const ph = S.phase;
    const R = calm || !auto.roam ? 0 : val("roam");
    const dx = 0.6 * Math.sin(0.23 * t + ph[0]) + 0.4 * Math.sin(0.51 * t + ph[1]);
    const dy = 0.6 * Math.sin(0.19 * t + ph[2]) + 0.4 * Math.sin(0.43 * t + ph[3]);
    const tx = (S.anchor.x * 0.62 + dx * 0.38 * R) * rm.x;
    const ty = (S.anchor.y * 0.62 + dy * 0.38 * R) * rm.y;
    if (!jumped && dt > 0) S.vx += ((tx - S.px) / dt - S.vx) * Math.min(1, dt * 5);
    S.px = tx;
    S.py = ty;
    // stone grinds along in cell steps, with a tiny jolt at each
    const qx = Math.round(tx / cw) * cw;
    const qy = Math.round(ty / cw) * cw;
    if ((qx !== S.qx || qy !== S.qy) && S.stone === "on" && !jumped) S.jolt = { x: (rand() - 0.5) * cw * 0.6, y: (rand() - 0.5) * cw * 0.4, t };
    S.qx = qx;
    S.qy = qy;
    // she leans into her motion, and her head turns a little: on its own, with her drift, and towards the pointer
    const drift = clamp(S.vx / (46 * dpr), -1, 1);
    const free = Math.min(1, R * 1.2);
    let sway = free * (0.5 * Math.sin(0.37 * t + ph[4]) + 0.28 * Math.sin(0.83 * t + ph[5]) + drift * 0.5);
    let swayY = free * 0.3 * Math.sin(0.29 * t + ph[6]);
    if (S.pointer.on && !calm) {
      sway += S.pointer.x * 0.9;
      swayY += S.pointer.y * 0.7;
    }
    const ease = Math.min(1, dt * 4);
    S.sway += (clamp(sway, -1.4, 1.4) - S.sway) * ease;
    S.swayY += (clamp(swayY, -1, 1) - S.swayY) * ease;
    S.lean += (drift * free - S.lean) * ease;
    // her breath and her nod: she rises and sinks a little; the statue does not breathe
    S.breath += val("pace") * dt;
    const breathe = calm ? 0 : val("breathe") * Math.sin(S.breath * Math.PI * 2);
    const bob = val("nod") * chh + breathe * chh * 0.3;
    S.bob = stony() ? Math.round(bob / cw) * cw : bob;
  }

  // ---- drawing ---------------------------------------------------------------
  // Everything is stamped into one pixel buffer, a cell at a time, and the part
  // of it that changed is put on the canvas.

  /** One cell, whole: the glyph in its colour over its backing. Replaces what was there. */
  function stamp(g, lut, x, y) {
    if (x < 0 || y < 0 || x + cw > W || y + chh > H) return stampClipped(g, lut, x, y, 0);
    let si = g * cellPx;
    let di = y * W + x;
    const skip = W - cw;
    for (let j = 0; j < chh; j++, di += skip) for (let i = 0; i < cw; i++) buf[di++] = lut[masks[si++]];
    if (x < box.x0) box.x0 = x;
    if (y < box.y0) box.y0 = y;
    if (x + cw > box.x1) box.x1 = x + cw;
    if (y + chh > box.y1) box.y1 = y + chh;
  }
  /** One glyph's ink alone, over whatever is there. */
  function ink(g, lut, x, y) {
    if (x < 0 || y < 0 || x + cw > W || y + chh > H) return stampClipped(g, lut, x, y, 90);
    let si = g * cellPx;
    let di = y * W + x;
    const skip = W - cw;
    for (let j = 0; j < chh; j++, di += skip) {
      for (let i = 0; i < cw; i++, di++) {
        const m = masks[si++];
        if (m > 90) buf[di] = lut[m];
      }
    }
    if (x < box.x0) box.x0 = x;
    if (y < box.y0) box.y0 = y;
    if (x + cw > box.x1) box.x1 = x + cw;
    if (y + chh > box.y1) box.y1 = y + chh;
  }
  /** The same at the canvas's edge, pixel by pixel. */
  function stampClipped(g, lut, x, y, over) {
    if (x + cw <= 0 || y + chh <= 0 || x >= W || y >= H) return;
    const si = g * cellPx;
    for (let j = Math.max(0, -y); j < chh && y + j < H; j++) {
      for (let i = Math.max(0, -x); i < cw && x + i < W; i++) {
        const m = masks[si + j * cw + i];
        if (m >= over) buf[(y + j) * W + x + i] = lut[m];
      }
    }
    box.x0 = Math.max(0, Math.min(box.x0, x));
    box.y0 = Math.max(0, Math.min(box.y0, y));
    box.x1 = Math.min(W, Math.max(box.x1, x + cw));
    box.y1 = Math.min(H, Math.max(box.y1, y + chh));
  }
  /** The seam the parallax would open between two cells: the last column of the cell before, carried across. */
  function seam(x, y, w) {
    if (x < 1 || y < 0 || x + w > W || y + chh > H) return;
    for (let j = 0, di = y * W + x; j < chh; j++, di += W) {
      const px = buf[di - 1];
      for (let i = 0; i < w; i++) buf[di + i] = px;
    }
  }

  /** A copy of her rest frame in one colour, ink only: the ghost a displace leaves, and the echo inside a glitch. */
  function drawCopy(ox, oy, row, strength, keep, slices, spread, stone) {
    const f = stone ? G.frames.s[0] : G.frames.a[0];
    const lut = inkLut[strength][row];
    for (let r = 0; r < rows; r++) {
      const y = oy + r * chh;
      const x = ox + (slices ? Math.round(slices[r] * cw * spread) : rowDx[r]);
      for (let c = 0, i = r * cols; c < cols; c++, i++) {
        const g = f.g[i];
        if (g && G.rnd2[i] <= keep) ink(g, lut, x + c * cw, y);
      }
    }
  }

  function draw() {
    // wipe what the last frame stamped
    for (let y = was.y0; y < was.y1; y++) buf.fill(0, y * W + was.x0, y * W + was.x1);
    box.x0 = W;
    box.y0 = H;
    box.x1 = 0;
    box.y1 = 0;
    if (G) compose();
    if (S.fade && S.fade.from.length === buf.length) {
      // a cross-fade from the last state's frame: the whole canvas, pixel by pixel
      const f = easeInOut(clamp((S.t - S.fade.t0) / FADE, 0, 1));
      const from = S.fade.from;
      const g = 1 - f;
      for (let i = 0; i < buf.length; i++) {
        const p = from[i];
        const q = buf[i];
        if (p === q) continue;
        buf[i] =
          ((((p >>> 24) * g + (q >>> 24) * f) << 24) | ((((p >>> 16) & 255) * g + ((q >>> 16) & 255) * f) << 16) | ((((p >>> 8) & 255) * g + ((q >>> 8) & 255) * f) << 8) | ((p & 255) * g + (q & 255) * f)) >>> 0;
      }
      if (f >= 1) S.fade = null;
      box.x0 = box.y0 = 0;
      box.x1 = W;
      box.y1 = H;
    } else S.fade = null;
    // put the part that changed: what was stamped then, and what is stamped now
    const x0 = Math.min(was.x0, box.x0);
    const y0 = Math.min(was.y0, box.y0);
    const x1 = Math.max(was.x1, box.x1);
    const y1 = Math.max(was.y1, box.y1);
    if (x1 > x0 && y1 > y0) ctx.putImageData(image, 0, 0, x0, y0, x1 - x0, y1 - y0);
    was.x0 = box.x0;
    was.y0 = box.y0;
    was.x1 = Math.max(box.x0, box.x1);
    was.y1 = Math.max(box.y0, box.y1);
  }

  function compose() {
    const t = S.t;
    const L = S.level;
    const M = S.mix;
    const o = origin();
    const stiff = stony();
    useLight(val("dim"));
    shown.fill(0);
    let glitched = 0;

    // -- this frame's row shifts: tears, her lean and tilt, line modulation, the slices of a displace
    rowDx.fill(0);
    rowHide.fill(0);
    rowMod.fill(0);
    for (const tear of S.tears) {
      for (let r = tear.r0; r < tear.r1 && r < rows; r++) rowDx[r] += tear.dx * cw;
      glitched += (tear.r1 - tear.r0) * 4;
    }
    const lean = stiff ? Math.round(S.lean * 4) / 4 : S.lean;
    const tilt = val("tilt");
    if (lean || tilt) for (let r = 0; r < rows; r++) rowDx[r] += Math.round(lean * (1 - r / rows) * cw * 4.5 + tilt * (0.5 - r / rows) * cw * 6);
    const modK = new Float32Array(rows);
    const modPh = new Float32Array(rows);
    for (const m of S.mods) {
      const env = Math.sin(Math.PI * clamp(1 - m.life / m.life0, 0, 1)); // swells and dies away
      for (let r = m.r0; r < m.r0 + m.h && r < rows; r++) {
        if (env * m.amp > rowMod[r]) {
          rowMod[r] = env * m.amp;
          modK[r] = m.k;
          modPh[r] = m.ph + t * m.v + (r - m.r0) * 0.9;
        }
        rowDx[r] += Math.round(Math.sin(t * m.v * 0.7 + r * 0.8) * env * m.amp * cw);
      }
    }
    let reveal = 2;
    if (S.disp) {
      const d = S.disp;
      const u = t - d.t0;
      if (!d.cut) {
        const a = clamp(u / D_CUT, 0, 1);
        for (let r = 0; r < rows; r++) {
          rowDx[r] += Math.round(d.slices[r] * cw * a * a);
          if (d.gone[r] < a * 0.5) rowHide[r] = 1;
        }
      } else {
        const b = clamp((u - D_CUT) / (D_DUR - D_CUT), 0, 1);
        const back = (1 - b) ** 3;
        for (let r = 0; r < rows; r++) rowDx[r] -= Math.round(d.slices[r] * cw * 0.8 * back);
        reveal = 0.1 + b * 1.4;
      }
    }

    // -- behind her: where she was
    for (const g of S.ghosts) {
      const a = (t - g.t0) / GHOST_LIFE;
      drawCopy(g.x, g.y, ROW_GHOST, a < 0.25 ? 0 : a < 0.5 ? 1 : a < 0.75 ? 2 : 3, 1 - a * 0.8, g.slices, 1 + a * 0.5, g.stone);
    }

    // the echo of a glitch: a faint copy of her in a second blue, a few pixels off, showing past her edges
    const echoX = o.x + Math.round((3 + 9 * L) * dpr) * (Math.floor(t * 9) % 2 ? 1 : -1);
    if (L > 0.12 && M.echo > 0) drawCopy(echoX, o.y, ROW_ECHO, L > 0.5 ? 0 : 1, 1, null, 0, stiff);

    // -- which frames the cells read from
    const F = G.frames;
    const aRest = F.a[0];
    const aMouth = F.a[S.mouth];
    const aEyes = S.eyes === 2 ? F.blink : S.eyes === 1 ? F.lid[S.gazeK] : F.gaze[S.gazeK];
    const sRest = F.s[0];
    const sMouth = F.s[S.mouth];
    const { mouthMask, eyeMask, crack, near, depth, rnd, rnd2, dist, order } = G;

    // the stone front and the crumbling edge glint
    const petrifying = S.stone === "petrify";
    const crumbling = S.stone === "crumble";
    const front = petrifying ? (G.maxDist + 3) * Math.pow(clamp((t - S.stoneT0) / PETRIFY, 0, 1), 0.85) : 0;
    const crumbled = crumbling ? (t - S.stoneT0) / CRUMBLE : 0;
    // the cracks: lit while she is stone, pulsing with her voice; their light spills on the stone beside them
    const glow = S.stone === "off" ? 0 : clamp(0.34 + 0.66 * S.energy + (petrifying ? 0.4 : 0), 0, 1);

    // the parallax: each cell shifts by sway times its depth; stone turns in steps
    const sway = (stiff ? Math.round(S.sway * 3) / 3 : S.sway) * cw * 2.3;
    // scramble: some cells show a random glyph for a few frames
    const scr = L > 0.06 ? (0.03 * L + 0.2 * L * L) * M.scr : 0;
    const tick = Math.floor(t * 14) * 7919 + seed;
    const NG = GLYPHS.length - 1;
    // the sweeps: a bright line passing down her, rows above it still lit a little
    const sweepRow = S.sweeps.map((s) => clamp((t - s.t0) / s.dur, 0, 1) * (rows + 4) - 2);

    for (let r = 0; r < rows; r++) {
      if (rowHide[r]) continue;
      const y = o.y + r * chh;
      const xr = o.x + rowDx[r];
      const mod = rowMod[r] > 0.15;
      let lit = 0;
      for (const sr of sweepRow) {
        const d = sr - r;
        if (d >= 0 && d < 1) lit = 2;
        else if (d >= 1 && d < 3 && lit < 1) lit = 1;
      }
      let lastX = -1e9; // where the cell before this one ended, when it was drawn
      for (let c = 0, i = r * cols; c < cols; c++, i++) {
        let g;
        let lut;
        if (mat[i]) {
          const f = mouthMask[i] ? sMouth : sRest;
          g = f.g[i];
          if (!g) continue;
          let row = f.row[i];
          const beat = glow * (0.6 + 0.4 * Math.sin(t * 8 - c * 0.3 - r * 0.5));
          if (petrifying && front - dist[i] < 4) {
            // the wavefront: a bright rim where the stone has just taken hold
            g = rnd2[i] < 0.5 ? G_HASH : G_BLOCK[2];
            lut = cellLut[ROW_C + 3 + ((rnd[i] * 3) | 0)];
          } else if (crumbling && order[i] - crumbled < 0.05) {
            if (rnd2[i] < 0.5) g = G_STAR;
            lut = cellLut[ROW_S + TONES - 1];
          } else if (crack[i] && !mouthMask[i]) {
            g = crack[i];
            lut = crackLut[clamp(Math.round(4.4 * beat), 0, 4)];
          } else {
            if (near[i] && row >= K_CELS && row < K_CELS_LIT && beat > (near[i] === 1 ? 0.3 : 0.72)) row += K_CELS_LIT - K_CELS;
            lut = cellLut[row];
          }
        } else {
          const f = mouthMask[i] ? aMouth : eyeMask[i] ? aEyes : aRest;
          g = f.g[i];
          if (!g) continue;
          lut = cellLut[f.row[i]];
        }
        if (rnd[i] > reveal) continue;
        const lv = aRest.lv[i];
        if (mod) {
          // line modulation: the cell becomes a piece of a wave riding along the row, its height her tone
          const w0 = Math.sin(c * modK[r] + modPh[r]) * rowMod[r] + lv * 0.12;
          const w1 = Math.sin((c + 1) * modK[r] + modPh[r]) * rowMod[r] + (c + 1 < cols ? aRest.lv[i + 1] : lv) * 0.12;
          const s = w1 - w0;
          g = s > 0.22 ? G_BACK : s < -0.22 ? G_SLASH : w0 > lv * 0.12 ? G_UNDER : G_DASH;
          // the picture becomes its scan lines, bright where she is light
          lut = cellLut[K_MOD + (mat[i] ? 3 : 0) + (lv >= 7 ? 2 : lv >= 4 ? 1 : 0)];
          glitched++;
        } else if (lit) {
          g = lit === 2 ? G_SWEEP : g;
          lut = lit === 2 ? cellLut[(mat[i] ? ROW_S : ROW_A) + 9] : lut;
          if (lit === 1 && rnd2[i] < 0.35) lut = cellLut[(mat[i] ? ROW_S : ROW_A) + 7];
        }
        if (scr > 0) {
          const h = hash(i + tick);
          if (h < scr) {
            g = 1 + ((h * 1e7) % NG | 0);
            if (h < scr * 0.06) lut = cellLut[h < scr * 0.03 ? ROW_CYAN : ROW_VIOLET];
            glitched++;
          }
        }
        const x = xr + c * cw + Math.round(depth[i] * sway);
        // the parallax moved this cell a pixel or two off its neighbour: carry the neighbour across
        if (x > lastX && x - lastX <= 2) seam(lastX, y, x - lastX);
        stamp(g, lut, x, y);
        shown[i] = g;
        lastX = x + cw;
      }
    }

    // -- over her: in a hard glitch the echo breaks through here and there; pixel-sort streaks, tile blocks, grit
    if (L > 0.7 && M.echo > 0) drawCopy(echoX, o.y, ROW_ECHO, 1, (L - 0.7) * 0.8, null, 0, stiff);
    const dxOf = (r) => (r >= 0 && r < rows ? rowDx[r] : 0);
    for (const s of S.streaks) {
      const f = s.life / s.life0;
      const grown = Math.max(1, Math.round(s.len * Math.min(1, (s.life0 - s.life) / 0.1)));
      const base = s.stone ? ROW_S : ROW_A;
      for (let j = 0; j < s.h && s.r + j < rows; j++) {
        const y = o.y + (s.r + j) * chh;
        const x0 = o.x + dxOf(s.r) + s.c * cw;
        // the rows of a band drag a little less far the further they are from the first
        const len = Math.round(grown * (1 - j * 0.22));
        for (let k = 0; k < len; k++) {
          const fall = (1 - k / s.len) * (0.35 + 0.65 * f);
          const g = G_STREAK[clamp((fall * G_STREAK.length) | 0, 0, G_STREAK.length - 1)];
          stamp(g, cellLut[base + clamp(Math.round(s.lv * fall), 1, TONES - 1)], x0 + s.dir * k * cw, y);
        }
        glitched += len;
      }
    }
    for (const list of [S.tiles, S.sticky]) {
      for (const b of list) {
        const x = o.x + dxOf(b.r) + b.c * cw;
        const y = o.y + b.r * chh;
        const lut = cellLut[b.row];
        for (let j = 0; j < b.h; j++) for (let i = 0; i < b.w; i++) stamp(b.g, lut, x + i * cw, y + j * chh);
        glitched += b.w * b.h;
      }
    }
    for (const p of S.grit) {
      const f = p.life / p.life0;
      ink(p.g, inkLut[f > 0.55 ? 0 : f > 0.35 ? 1 : f > 0.18 ? 2 : 3][p.row], Math.round(p.x), Math.round(p.y));
    }
    S.glitchCells = glitched;
  }

  // ---- the loop --------------------------------------------------------------

  let raf = 0;
  let last = 0;
  let onScreen = true;
  let held = null; // seek(t): the moment the clock is held at
  let dead = false;
  const cost = { ms: 0, frames: 0, total: 0 };
  const paints = []; // when the last second's frames were drawn, for stats().fps
  let firstPaint = null;
  const painted = new Promise((resolve) => (firstPaint = resolve));

  function paint() {
    if (!n || !G) return;
    const t0 = performance.now();
    draw();
    const ms = performance.now() - t0;
    cost.frames++;
    cost.total += ms;
    cost.ms += (ms - cost.ms) * 0.05;
    paints.push(t0);
    while (paints.length && paints[0] < t0 - 1000) paints.shift();
    firstPaint?.(true);
    firstPaint = null;
  }

  function frame(now) {
    raf = 0;
    if (!running()) return;
    // a slower state draws less often (her clock still follows the real time)
    const cap = Math.min(maxFps, PLAN[S.state].fps || 240);
    if (last && now - last < 1000 / cap - 2) {
      raf = requestAnimationFrame(frame);
      return;
    }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    step(dt);
    paint();
    raf = requestAnimationFrame(frame);
  }
  // under reduced motion the clock runs only while a change of state is cross-fading, a line is being held, or a state is waiting to move on
  const running = () => !dead && !!G && n > 0 && onScreen && !document.hidden && held == null && (!reduced || S.fade != null || S.speech != null || S.thenAt < Infinity);
  function kick() {
    if (dead || !G || !n) return;
    if (held != null) {
      while (S.t < held - 1e-6) step(Math.min(1 / 60, held - S.t));
      paint();
    } else if (running()) {
      if (!raf) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    } else if (reduced) {
      step(0);
      paint();
    }
  }

  /** Reduced motion switched on: whatever was moving stops where she stands. */
  function calmDown() {
    S.tears.length = S.streaks.length = S.tiles.length = S.mods.length = S.grit.length = S.ghosts.length = S.sweeps.length = 0;
    S.burst = null;
    S.disp = null;
    S.wantDisplace = false;
    S.blinkT0 = -9;
    pose(S.state, 0);
    setStone(!!PLAN[S.state].stone || (S.speech != null && S.stone !== "off"));
  }

  function relabel() {
    if (label != null) canvas.setAttribute("aria-label", `${label}: ${S.state}`);
  }

  // ---- what the page calls ---------------------------------------------------

  function finishSpeech() {
    const sp = S.speech;
    if (!sp) return;
    progress(sp, sp.len);
    if (sp.phase === "speak") {
      sp.phase = "tail";
      sp.tailT = S.t;
    } else if (sp.phase === "hold") sp.until = S.t;
  }

  /** idle listening thinking speaking working held done sleep ("talking" is speaking) */
  function setState(name) {
    const to = ALIAS[name] ?? name;
    if (!PLAN[to]) {
      console.warn(`the face has no state "${name}" (she has ${STATES.join(", ")})`);
      return api;
    }
    if (to !== "speaking") cutSpeech();
    go(to);
    return api;
  }

  /**
   * One chunk of a streamed answer: her mouth opens a step and closes again, so
   * it follows the tokens with no text given. n chunks at once open it as one.
   * She is speaking from the first chunk on (stone, if she was not yet).
   */
  function pulse(count = 1) {
    if (dead) return api;
    if (S.state !== "speaking") setState("speaking");
    S.pulses += Math.max(1, count | 0);
    if (!reduced) S.pulseQ = Math.min(PULSE_QUEUE, S.pulseQ + 1);
    return api;
  }

  /**
   * Speak a line: she turns to stone from the mouth out, her mouth follows the
   * text, and the stone crumbles off when she is done (then "done", then idle).
   * Resolves then. o.cps (characters a second, 17), o.maxMs (the longest the
   * speaking may take, 7000: a long text is spoken faster), o.onProgress(shown,
   * total) (called as the text advances, for a bubble typing along), o.stone
   * (false: she speaks without turning to stone).
   */
  function say(text, o = {}) {
    const chars = Array.from(String(text ?? ""));
    const len = chars.length;
    // one voice at a time: a line still being spoken is shown whole and its promise kept
    const old = S.speech;
    if (old) {
      progress(old, old.len);
      S.speech = null;
      old.resolve();
    }
    settleStone();
    if (!len || dead) return Promise.resolve();
    return new Promise((resolve) => {
      const dur = clamp(len / (Number(o.cps) || 17), 0.5, Math.max(0.5, (Number(o.maxMs) || 7000) / 1000));
      const sp = { chars, len, dur, t0: 0, phase: "speak", shown: 0, mouthFrom: 0, onProgress: o.onProgress, resolve, tailT: 0 };
      const stone = o.stone !== false;
      go("speaking", { stone });
      S.speech = sp;
      if (reduced) {
        // no motion: the stone still, the whole text at once, then back
        sp.phase = "hold";
        sp.until = S.t + clamp(len * 0.045, 0.7, 2.6);
        progress(sp, len);
        kick();
        return;
      }
      sp.t0 = S.t + (stone && S.stone !== "on" ? 0.16 : 0.04); // the front is on its way before the first sound
      S.mouthNext = sp.t0;
    });
  }

  /** One burst of glitch (0..1) that eases away; with hold, a level that stays until changed (0 lets it go). */
  function glitch(strength = 0.8, hold = false) {
    const v = clamp(Number(strength) || 0, 0, 1);
    if (hold) {
      S.floor = v;
      if (reduced) kick();
    } else burst(v, 0.12, MIX_ALL);
    return api;
  }

  /** Tear into slices and re-form somewhere else on the stage. Not under reduced motion. */
  function displace() {
    if (!reduced) S.wantDisplace = true; // taken up at the next step of the clock
    return api;
  }

  /** Step the clock to t seconds and hold her there (a repeatable still); seek(null) lets her go again. */
  function seek(t) {
    held = t == null ? null : Math.max(0, Number(t) || 0);
    kick();
    return api;
  }

  /** The grid as she last drew it, a line of glyphs a row. */
  function text() {
    let out = "";
    for (let r = 0; r < rows; r++) {
      let line = "";
      for (let c = 0; c < cols; c++) line += GLYPHS[shown[r * cols + c]];
      out += line.replace(/\s+$/, "") + "\n";
    }
    return out;
  }

  function stats(reset) {
    const o = G && n ? origin() : null;
    const cells = (b) => (b && o ? [o.x + b[0] * cw, o.y + b[1] * chh, o.x + b[2] * cw, o.y + b[3] * chh] : null);
    const now = performance.now();
    const out = {
      renderer: ctx && !failed ? "glyphs" : "none",
      fps: running() ? paints.filter((p) => p >= now - 1000).length : 0,
      cols,
      rows,
      state: S.state,
      time: S.t,
      ms: cost.ms,
      mean: cost.frames ? cost.total / cost.frames : 0,
      frames: cost.frames,
      cell: [cw, chh],
      dpr,
      crop: cropName,
      stage: [W, H],
      size: [figW, figH],
      at: o,
      // what she is doing this frame
      eyes: S.eyes,
      lid: S.lid,
      gaze: GAZES[S.gazeK],
      mouth: S.mouth,
      pulses: S.pulses,
      stone: S.stone,
      glitch: S.level,
      glitchKind: S.burst && burstAt(S.t) > 0 ? (FLAVOUR_NAMES[FLAVOURS.indexOf(S.burst.mix)] ?? "all") : S.level > 0 ? "steady" : null,
      glitchCells: S.glitchCells,
      dim: val("dim"),
      reduced,
      speaking: !!S.speech,
      // where her features are on the canvas, in its pixels [x0, y0, x1, y1]
      boxes: G && o ? { figure: [box.x0, box.y0, box.x1, box.y1], mouth: cells(G.mouthBox), eyes: G.eyeBoxes.map(cells), line: G.mouthLine ? cells([G.mouthLine.c0, G.mouthLine.r, G.mouthLine.c1 + 1, G.mouthLine.r + 1]) : null } : null,
    };
    if (reset) cost.frames = cost.total = 0;
    return out;
  }

  function destroy() {
    if (dead) return;
    dead = true;
    if (raf) cancelAnimationFrame(raf);
    ro.disconnect();
    io?.disconnect();
    document.removeEventListener("visibilitychange", kick);
    motionQuery?.removeEventListener?.("change", onMotion);
    stage.removeEventListener("pointermove", onPointer);
    stage.removeEventListener("pointerleave", offPointer);
    S.speech?.resolve();
    S.speech = null;
    settleStone();
    firstPaint?.(false);
    if (own) canvas.remove();
    else {
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.opacity = opacityWas;
    }
  }

  function onPointer(e) {
    const r = stage.getBoundingClientRect();
    S.pointer.x = clamp(((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1, -1, 1);
    S.pointer.y = clamp(((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1, -1, 1);
    S.pointer.on = true;
  }
  function offPointer() {
    S.pointer.on = false;
  }
  stage.addEventListener("pointermove", onPointer);
  stage.addEventListener("pointerleave", offPointer);
  function onMotion() {
    reduced = !!motionQuery.matches;
    if (reduced) calmDown();
    kick();
  }
  motionQuery?.addEventListener?.("change", onMotion);

  // the loop stops when the tab is hidden or the stage is off the screen
  document.addEventListener("visibilitychange", kick);
  let io = null;
  if (typeof IntersectionObserver === "function") {
    io = new IntersectionObserver((entries) => {
      onScreen = entries[entries.length - 1].isIntersecting;
      kick();
    });
    io.observe(stage);
  }
  // a layout only when the stage's size really changes (the first one may come from here or from the frames arriving)
  const ro = new ResizeObserver(() => {
    if (dead) return;
    const rect = stage.getBoundingClientRect();
    const d = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    if (n && Math.round(rect.width * d) === W && Math.round(rect.height * d) === H) return;
    if (!layout() || !G) return;
    if (reduced) calmDown();
    paint();
    kick();
  });
  ro.observe(stage);

  if (!ctx) failed = true;
  const ready = (
    failed
      ? Promise.reject(new Error("no 2D canvas"))
      : Promise.all(NAMES.map((name) => loadImage(`${base}${name}.png`).then((img) => [name, img]))).then((pairs) => {
          if (dead) return false;
          images = Object.fromEntries(pairs);
          if (!n) layout();
          else analyse();
          if (!G) return painted; // the stage has no size yet: drawn when it has
          if (reduced) calmDown();
          paint();
          kick();
          return painted;
        })
  ).catch((err) => {
    failed = true;
    console.warn(`the face stays dark: ${err.message}`);
    firstPaint?.(false);
    return false;
  });
  relabel();

  const api = {
    setState,
    pulse,
    say,
    glitch,
    displace,
    destroy,
    seek,
    text,
    stats,
    /** show the rest of the line being spoken at once, and let the stone fall */
    skip: () => (finishSpeech(), api),
    /** resolves true once the frames are read and she is on the canvas, false when she cannot draw */
    ready,
    canvas,
    /** the same as stats(), under its older name */
    measure: () => stats(),
    get state() {
      return S.state;
    },
    get speaking() {
      return !!S.speech;
    },
    get time() {
      return S.t;
    },
  };
  return api;
}
