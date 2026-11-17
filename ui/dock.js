// The oracle dock: the one face of the app, under it the state word and an inspector-like readout
// (the brain at work, the size, the card, the junction, the VRAM, the queue). It folds to a 44px
// avatar in views that need the room and is a strip on top on a phone. Carried from Chronos's
// ui/dock.js; what it hears is Lite's (no conversation, no setup), and the avatar is the brand's:
//
//   kind face      Chronos's face (ui/face/face.js) from her own frames or the brand's (the same
//                  eight file names), her blues turned to a tint when the brand asks; her greys
//                  stay grey, so the stone stays stone
//   kind monogram  the brand's logo or monogram on the dark stage, the state on a ring around it
//
// The state is worked out by ui/mood.js from the store; the one-off reactions (she tears and
// re-forms on a split, a failure hits her hard, she says what a quest came back with) come from
// mood.js's reactionOf. Until the brand is read the stage stays dark: no face flashes before a
// rebrand's monogram. While the face cannot draw, the mark stands in, still.

import { h, fill } from "./lib/dom.js";
import { W, shortBrain, sizeLetter, plainText, the } from "./lib/words.js";
import { state, on, quests } from "./store.js";
import { moodOf, reactionOf, noteOf, LISTEN_MS, FAILED_MS, DONE_MS } from "./mood.js";
import { monogram } from "./brand.js";

const SAY_MAX_MS = 5200;

export function mountDock(root, { pickedSize = () => null } = {}) {
  const canvas = h("canvas.face-canvas", { "aria-hidden": "true" });
  const still = h("span.face-still", { "aria-hidden": "true" });
  const faceBox = h("div.dock-face", canvas, still);
  const word = h("span.pixel.dock-word", "idle");
  const note = h("span.tiny.dock-note", "");
  const rows = {};
  const labels = {};
  const row = (k, label) => {
    rows[k] = h("dd", "—");
    labels[k] = h("dt", label);
    return [labels[k], rows[k]];
  };
  const readout = h("dl.dock-read", row("brain", "brain"), row("size", "size"), row("card", "card"), row("heat", "junction"), row("vram", "vram"), row("queue", "queue"));
  const head = h("span.tiny.dock-title", W.oracle);
  const fold = h("button.dock-fold", { type: "button", "aria-expanded": "true", "aria-controls": "dock-body", title: "fold to the avatar" }, h("span.dock-fold-mark", { "aria-hidden": "true" }, "‹"), h("span.sr", "fold the dock"));
  const body = h("div#dock-body.dock-body", h("div.dock-state", { role: "status", "aria-live": "polite" }, word, note), readout);
  const avatar = h("button.dock-avatar", { type: "button", title: "unfold", "aria-label": "unfold the dock" });
  fill(root, h("div.dock-head", head, fold), faceBox, body);
  faceBox.append(avatar);

  let brand = null;
  let face = null;
  let folded = false;
  let current = "idle";
  const T = { typingUntil: 0, failedUntil: 0, doneUntil: 0, speakingUntil: 0, lastActivity: Date.now() };
  let shownNote = "";

  // ---- fold ---------------------------------------------------------------------------

  let onFold = () => {};
  function setFolded(v, { tell = false } = {}) {
    folded = !!v;
    root.classList.toggle("folded", folded);
    fold.setAttribute("aria-expanded", folded ? "false" : "true");
    avatar.hidden = !folded;
    avatar.title = `${current}: ${shownNote} · unfold`;
    if (tell) onFold(folded);
  }
  fold.addEventListener("click", () => setFolded(true, { tell: true }));
  avatar.addEventListener("click", () => setFolded(false, { tell: true }));

  // ---- the state ----------------------------------------------------------------------

  const snapshot = () => ({ ...T, hold: state.hold, waiting: state.waiting.size > 0, quest: quests.running() });

  function noteWords() {
    return { name: brand?.name ?? "the service", planner: the("planner"), thinkVerb: quests.running()?.phase === "judge" ? "judges the reports" : "plans the work", task: W.task };
  }

  function paint() {
    const next = moodOf(snapshot());
    const say = noteOf(next, noteWords());
    if (next !== current) {
      current = next;
      // speaking is put there by say(); every other state the face is told
      if (next !== "speaking") face?.setState(next);
      word.textContent = next;
      root.dataset.state = next;
    }
    if (say !== shownNote) {
      shownNote = say;
      note.textContent = say;
      avatar.title = `${next}: ${say} · unfold`;
    }
    readouts();
  }

  function readouts() {
    const q = quests.running();
    const running = q && (q.status === "running" || q.status === "stopping") ? q : null;
    const brain = running?.phaseBrain ?? running?.tier?.titan ?? running?.tier?.promethean ?? state.brains.find((b) => b.status === "ready")?.id ?? null;
    rows.brain.textContent = brain ? shortBrain(brain) || W.model : "—";
    const size = running?.size ?? pickedSize() ?? null;
    rows.size.textContent = sizeLetter(size) || "—";
    const c = state.health?.card;
    rows.card.textContent = !c ? "—" : !c.lock || c.stale ? "free" : c.mine ? "in use here" : "busy elsewhere";
    rows.card.classList.toggle("warn", !!c?.lock && !c.mine && !c.stale);
    const hw = state.hardware ?? state.health?.hardware;
    const j = hw?.heat?.junctionC;
    rows.heat.textContent = j != null ? `${Math.round(j)} C` : "—";
    rows.heat.classList.toggle("heat", !!hw?.heat?.hot || !!state.hold);
    const v = hw?.vram;
    rows.vram.textContent = v?.totalMiB ? `${(v.usedMiB / 1024).toFixed(1)} / ${(v.totalMiB / 1024).toFixed(1)} G` : "—";
    const all = [...state.quests.values()];
    const waiting = all.filter((x) => x.status === "queued").length;
    const runningN = all.filter((x) => x.status === "running" || x.status === "stopping").length;
    rows.queue.textContent = `${runningN} running · ${waiting} waiting`;
  }

  function react(ev) {
    const r = reactionOf(ev);
    if (r.failed) T.failedUntil = Date.now() + FAILED_MS;
    if (r.glitch) face?.glitch?.(r.glitch);
    if (r.displace) {
      face?.displace?.();
      jolt();
    }
    if (r.say && face?.say) {
      const text = plainText(r.say);
      T.speakingUntil = Date.now() + SAY_MAX_MS + 800;
      current = "speaking";
      root.dataset.state = "speaking";
      word.textContent = "speaking";
      face.say(text, { maxMs: SAY_MAX_MS }).then(() => {
        T.speakingUntil = 0;
        T.doneUntil = Date.now() + DONE_MS;
        paint();
      });
    } else if (r.done) T.doneUntil = Date.now() + DONE_MS + (r.say ? 2600 : 0);
    if (r.failed || r.glitch) jolt();
  }

  /** the monogram's stand-in for a glitch or a displace: one short shake */
  let joltTimer = null;
  function jolt() {
    if (face) return;
    root.classList.remove("jolt");
    void root.offsetWidth;
    root.classList.add("jolt");
    clearTimeout(joltTimer);
    joltTimer = setTimeout(() => root.classList.remove("jolt"), 600);
  }

  on("*", (ev) => {
    if (ev.type === "hardware.read") return readouts();
    if (ev.replayed) return paint();
    T.lastActivity = Date.now();
    react(ev);
    paint();
  });
  for (const topic of ["@brains", "@quests", "@hold", "@health", "@hardware"]) on(topic, paint);
  setInterval(paint, 1000);

  // ---- the avatar ----------------------------------------------------------------------

  async function mountAvatar() {
    const a = brand.avatar;
    root.dataset.avatar = a.kind;
    if (a.kind === "monogram") {
      fill(still, brand.logo ? h("img", { src: brand.logo, alt: "" }) : monogram(brand.shortName, brand.name));
      root.classList.remove("has-face");
      return;
    }
    fill(still, monogram(brand.shortName, brand.name));
    try {
      const mod = await import("./face/face.js");
      face = mod.mountFace(canvas, { state: current === "speaking" ? "idle" : current, label: `${brand.name}, drawn in glyphs`, ...(a.frames ? { base: a.frames } : {}) });
      root.classList.add("has-face");
      // ready resolves false (and the renderer reads "none") on a canvas she cannot draw on
      const drawn = await face.ready;
      if (drawn === false || face.stats?.().renderer === "none") throw new Error("the face found no way to draw");
    } catch (err) {
      console.info("the face cannot draw here: the dock shows the mark", err?.message ?? err);
      root.classList.remove("has-face");
      face = null;
    }
  }

  setFolded(false);
  paint();

  return {
    setFolded,
    folded: () => folded,
    onFold: (fn) => (onFold = fn),
    /** the brand is read: the avatar mounts once, the words follow every time */
    setBrand(b) {
      const first = !brand;
      brand = b;
      head.textContent = W.oracle;
      labels.brain.textContent = W.model;
      shownNote = "";
      if (first) mountAvatar();
      paint();
    },
    /** the owner is typing (the ask box calls this on input) */
    typing() {
      T.lastActivity = Date.now();
      T.typingUntil = Date.now() + LISTEN_MS;
      paint();
    },
    state: () => current,
    face: () => face,
    paint,
  };
}

