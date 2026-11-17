import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOWN_PER_C_S,
  DUTY_MAX,
  DUTY_MIN,
  DUTY_START,
  HOLD_C,
  HOLD_POLL_MS,
  IDLE_MS,
  ON_MS,
  PEAK_C,
  RELEASE_C,
  SAMPLE_MS,
  TARGET_C,
  UP_PER_C_S,
  createGovernor,
  govern,
  governorCan,
  nextDuty,
} from "./throttle.mjs";

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test("nextDuty rises under target, falls faster over it, scales with the time passed and stays in its bounds", () => {
  const up = nextDuty(0.1, TARGET_C - 5, { dtMs: 1000 });
  const down = nextDuty(0.1, TARGET_C + 5, { dtMs: 1000 });
  assert.ok(near(up, 0.1 * Math.exp(UP_PER_C_S * 5)), `5 C under for a second: a factor of e^${UP_PER_C_S * 5} (${up})`);
  assert.ok(near(down, 0.1 * Math.exp(-DOWN_PER_C_S * 5)), `5 C over for a second: a factor of e^-${DOWN_PER_C_S * 5} (${down})`);
  assert.ok(up > 0.1 && down < 0.1);
  assert.ok(0.1 / down > up / 0.1, "the same distance over target moves the duty further than under it");
  assert.equal(nextDuty(0.1, TARGET_C, { dtMs: 1000 }), 0.1, "on target: it stays");

  // the step is a factor that grows with the time: two seconds are two steps of one second, and no time is no step
  assert.ok(near(nextDuty(0.1, 80, { dtMs: 2000 }), nextDuty(nextDuty(0.1, 80, { dtMs: 1000 }), 80, { dtMs: 1000 })));
  assert.ok(near(nextDuty(0.1, 91, { dtMs: 500 }), nextDuty(nextDuty(0.1, 91, { dtMs: 250 }), 91, { dtMs: 250 })));
  assert.ok(nextDuty(0.1, 80, { dtMs: 100 }) < nextDuty(0.1, 80, { dtMs: 1000 }));
  assert.equal(nextDuty(0.1, 80, { dtMs: 0 }), 0.1);
  assert.ok(near(nextDuty(0.1, 80), nextDuty(0.1, 80, { dtMs: 1000 })), "one second when the time is not given");

  // its own target, and its bounds
  assert.ok(nextDuty(0.1, 84, { target: 82, dtMs: 1000 }) < 0.1);
  assert.equal(nextDuty(0.4, 200, { dtMs: 1000 }), DUTY_MIN);
  assert.equal(nextDuty(0.44, 0, { dtMs: 1000 }), DUTY_MAX);
  assert.equal(nextDuty(0.9, 0, { max: 1, dtMs: 1000 }), 1);
  assert.equal(nextDuty(0.02, 200, { min: 0.015, dtMs: 1000 }), 0.015);

  // no reading: the duty stays, inside its bounds
  assert.equal(nextDuty(0.3, null), 0.3);
  assert.equal(nextDuty(0.3, NaN), 0.3);
  assert.equal(nextDuty(0.3, undefined, { dtMs: 5000 }), 0.3);
  assert.equal(nextDuty(0.9, null), DUTY_MAX);
});

test("nextDuty with the peaks the bursts reach: it steers on whichever is further over its mark", () => {
  assert.ok(PEAK_C < HOLD_C && PEAK_C > TARGET_C, "the peaks are steered between the target and the hold");
  // the mean is under target but the peaks are over theirs: down, by the peaks' distance
  assert.ok(near(nextDuty(0.1, TARGET_C - 3, { peakC: PEAK_C + 2 }), 0.1 * Math.exp(-DOWN_PER_C_S * 2)));
  // both under: it climbs only as fast as the nearer mark allows
  assert.ok(near(nextDuty(0.1, TARGET_C - 5, { peakC: PEAK_C - 1 }), 0.1 * Math.exp(UP_PER_C_S * 1)));
  // the mean over target and the peaks under theirs: down by the mean
  assert.ok(near(nextDuty(0.1, TARGET_C + 1, { peakC: PEAK_C - 3 }), 0.1 * Math.exp(-DOWN_PER_C_S * 1)));
  // its own mark, and no peaks given: as before
  assert.ok(nextDuty(0.1, TARGET_C - 3, { peakC: 89, peak: 88 }) < 0.1);
  assert.equal(nextDuty(0.1, TARGET_C - 2, { peakC: null }), nextDuty(0.1, TARGET_C - 2));
  assert.equal(nextDuty(0.1, null, { peakC: 99 }), 0.1, "no smoothed reading: no step");
});

/**
 * A stand-in for the machine: a clock that only moves when the governor sleeps, a junction that reads what the
 * test says (a list, its last value repeating, or a function of the reading's number and the time), and a record
 * of every signal, reading and sleep with its time. No real time passes and no real signal is sent. It ends
 * with the test (t), whatever the test left running.
 */
function harness(t, temps) {
  const h = {
    t: 0,
    over: false, // the test has ended: the governor's next sleep never returns, so a failed test leaves no loop spinning
    signals: [], // { t, pid, s }
    reads: [], // { t, c }
    sleeps: [], // ms
    events: [], // { type, t, ...data }
    during: null, // (ms) => ..., called inside each sleep
  };
  const left = Array.isArray(temps) ? [...temps] : null;
  h.readJunction = () => {
    const c = left ? (left.length > 1 ? left.shift() : left[0]) : temps(h.reads.length, h.t);
    h.reads.push({ t: h.t, c });
    return c;
  };
  h.signal = (pid, s) => h.signals.push({ t: h.t, pid, s });
  h.sleep = async (ms) => {
    if (h.over) return new Promise(() => {});
    h.sleeps.push(ms);
    h.t += ms;
    h.during?.(ms); // what the test does while the governor sleeps
    await new Promise((r) => setImmediate(r));
  };
  t.after(() => {
    h.over = true;
  });
  h.now = () => h.t;
  h.bus = { emit: (type, data) => h.events.push({ type, t: h.t, signals: h.signals.length, ...data }) };
  /** what the governor is given: a Linux governor on every system (on Windows the real platform would give the one that does nothing) */
  h.opts = () => ({ platform: "linux", readJunction: h.readJunction, signal: h.signal, sleep: h.sleep, now: h.now, bus: h.bus });
  return h;
}

const tick = () => new Promise((r) => setImmediate(r));
const ticks = async (n) => {
  for (let i = 0; i < n; i++) await tick();
};
/** let the governor work until its clock has moved on by ms */
async function run(h, ms) {
  const until = h.t + ms;
  for (let i = 0; h.t < until && i < 20000; i++) await tick();
}

/** the times between each signal `from` and the signal right after it, when that one is `to` */
function gaps(signals, from, to) {
  const out = [];
  for (let i = 0; i + 1 < signals.length; i++) if (signals[i].s === from && signals[i + 1].s === to) out.push(signals[i + 1].t - signals[i].t);
  return out;
}

test("each burst is ON_MS long, and the pause after it is what the duty asks for", async (t) => {
  // on target the duty does not move: every cycle is the starting one
  const h = harness(t, [TARGET_C]);
  const g = govern(1234, { ...h.opts(), loading: false });
  g.busy(1);
  await run(h, 3000);
  const on = gaps(h.signals, "SIGCONT", "SIGSTOP");
  const off = gaps(h.signals, "SIGSTOP", "SIGCONT");
  assert.ok(on.length >= 5 && off.length >= 5, "it cycled");
  assert.ok(on.every((ms) => ms === ON_MS), `every burst is ${ON_MS} ms (${[...new Set(on)]})`);
  const asked = ON_MS * (1 / DUTY_START - 1);
  assert.ok(off.every((ms) => near(ms, asked, 1e-6)), `every pause is ${asked.toFixed(1)} ms at the starting duty`);
  assert.equal(g.stats().duty, DUTY_START);
  assert.equal(g.stats().onMs, ON_MS);
  assert.equal(g.stats().periodMs, Math.round(ON_MS / DUTY_START));
  assert.equal(g.stats().smoothC, TARGET_C);
  assert.ok(g.stats().cycles >= 5);
  g.busy(-1);
  g.stop();
  await ticks(3);
  assert.equal(h.signals.at(-1).s, "SIGCONT", "stopped: left running");
});

test("the junction is read after each burst and at least every SAMPLE_MS of the pause", async (t) => {
  const h = harness(t, [TARGET_C]);
  const g = govern(1, { ...h.opts(), loading: false });
  g.busy(1);
  await run(h, 2000);
  g.busy(-1);
  g.stop();
  const between = h.reads.slice(1).map((r, i) => r.t - h.reads[i].t);
  assert.ok(between.length > 50, `many readings in two seconds (${between.length})`);
  assert.ok(between.every((ms) => ms > 0 && ms <= SAMPLE_MS), `never more than ${SAMPLE_MS} ms apart (${Math.max(...between)})`);
  // a reading right after each burst: at the moment of every SIGSTOP that ends one
  const stops = h.signals.filter((x, i) => x.s === "SIGSTOP" && h.signals[i - 1]?.s === "SIGCONT");
  assert.ok(stops.every((x) => h.reads.some((r) => r.t === x.t)));
  assert.equal(g.stats().n, h.reads.length, "every reading is in the stats");
});

test("the pause grows as the duty falls over target, and shrinks as it climbs under it", async (t) => {
  const hotter = harness(t, [TARGET_C + 4]); // over target, under the hold
  const a = govern(1, { ...hotter.opts(), loading: false });
  a.busy(1);
  await run(hotter, 4000);
  const off = gaps(hotter.signals, "SIGSTOP", "SIGCONT");
  assert.ok(off.length >= 4, `a few cycles (${off.length})`);
  for (let i = 1; i < off.length; i++) assert.ok(off[i] > off[i - 1] || near(off[i], ON_MS * (1 / DUTY_MIN - 1)), `pause ${i} is longer than the one before (${off[i - 1].toFixed(0)} -> ${off[i].toFixed(0)} ms)`);
  assert.ok(gaps(hotter.signals, "SIGCONT", "SIGSTOP").every((ms) => ms === ON_MS), "the burst stays the same");
  assert.ok(a.stats().duty < DUTY_START);
  assert.ok(a.stats().periodMs > Math.round(ON_MS / DUTY_START));
  assert.equal(a.stats().held, 0, "under the hold: never held");
  a.busy(-1);
  a.stop();

  const cooler = harness(t, [TARGET_C - 7]);
  const b = govern(2, { ...cooler.opts(), loading: false });
  b.busy(1);
  await run(cooler, 4000);
  const offB = gaps(cooler.signals, "SIGSTOP", "SIGCONT");
  assert.ok(offB.length >= 10);
  for (let i = 1; i < offB.length; i++) assert.ok(offB[i] < offB[i - 1], `pause ${i} is shorter than the one before`);
  assert.ok(gaps(cooler.signals, "SIGCONT", "SIGSTOP").every((ms) => ms === ON_MS));
  assert.ok(b.stats().duty > DUTY_START);
  b.busy(-1);
  b.stop();

  // it never leaves its bounds, however long it is hot or cool
  const long = harness(t, [TARGET_C + 5]);
  const c = govern(3, { ...long.opts(), loading: false });
  c.busy(1);
  await run(long, 20000);
  assert.equal(c.stats().duty, DUTY_MIN);
  assert.equal(c.stats().periodMs, Math.round(ON_MS / DUTY_MIN));
  c.busy(-1);
  c.stop();
  const cold = harness(t, [40]);
  const d = govern(4, { ...cold.opts(), loading: false });
  d.busy(1);
  await run(cold, 5000);
  assert.equal(d.stats().duty, DUTY_MAX);
  assert.equal(d.stats().periodMs, Math.round(ON_MS / DUTY_MAX));
  d.busy(-1);
  d.stop();
});

test("one hot reading under the hold among cool ones costs a little of the duty, not the duty: it steers on smoothed readings", async (t) => {
  const spike = HOLD_C - 1;
  const h = harness(t, (n) => (n === 40 ? spike : TARGET_C));
  const g = govern(1, { ...h.opts(), loading: false });
  g.busy(1);
  await run(h, 5000);
  assert.ok(h.reads.some((r) => r.c === spike), "the hot reading was taken");
  assert.equal(g.stats().peakC, spike);
  assert.equal(g.stats().held, 0);
  assert.equal(h.events.length, 0);
  const duty = g.stats().duty;
  assert.ok(duty < DUTY_START, "it was felt");
  // the rise it taught is remembered for some bursts (it put the peaks over PEAK_C), so it costs a little
  assert.ok(duty >= DUTY_START * 0.85, `and it cost a little of the duty, not the duty (${duty})`);
  // steering on that one raw reading for one cycle would have cut the duty by far more
  const raw = nextDuty(DUTY_START, spike, { dtMs: ON_MS / DUTY_START });
  assert.ok(raw < DUTY_START * 0.7, `on the raw reading: ${raw.toFixed(4)}`);
  assert.ok(g.stats().smoothC < TARGET_C + 0.2, "the smoothed junction is back at the target");
  g.busy(-1);
  g.stop();
});

test("a brain whose bursts spike over the peak mark is steered down by its peaks while its mean is under target, and never held", async (t) => {
  // right after each burst the card reads PEAK_C + 1 (under the hold); through the pause it reads 4 under target
  let h = null;
  h = harness(t, () => (h.signals.at(-1)?.s === "SIGCONT" ? PEAK_C + 1 : TARGET_C - 4));
  const g = govern(1, { ...h.opts(), loading: false });
  g.busy(1);
  await run(h, 6000);
  const s = g.stats();
  assert.ok(s.smoothC < TARGET_C, `the smoothed junction stays under target (${s.smoothC})`);
  assert.ok(s.peaksC > PEAK_C, `the peaks sit over their mark (${s.peaksC}, a rise of ${s.riseC})`);
  assert.ok(s.duty < DUTY_START, `so the duty falls (${s.duty})`);
  assert.equal(s.held, 0);
  assert.equal(h.events.length, 0);

  // the same bursts with peaks a degree under the mark: the duty climbs, slowed by the nearer mark
  let k = null;
  k = harness(t, () => (k.signals.at(-1)?.s === "SIGCONT" ? PEAK_C - 1 : TARGET_C - 4));
  const g2 = govern(2, { ...k.opts(), loading: false });
  g2.busy(1);
  await run(k, 3000);
  assert.ok(g2.stats().duty > DUTY_START);
  assert.ok(g2.stats().duty < nextDuty(DUTY_START, TARGET_C - 4, { dtMs: 3000 }), "but slower than on the mean alone");
  g.busy(-1);
  g.stop();
  g2.busy(-1);
  g2.stop();
});

test("a burst's rise is learned per burst: half way up at once, a twentieth of the way down each burst, not forgotten with time", async (t) => {
  // right after each burst the card reads `rise` over a base of 80; through the pause it reads the base
  let h = null;
  let up = 6;
  const afterBurst = () => h.signals.at(-1)?.s === "SIGCONT" && h.t - h.signals.at(-1).t === ON_MS;
  h = harness(t, () => (afterBurst() ? 80 + up : 80));
  const g = createGovernor({ ...h.opts(), max: DUTY_MIN }); // one burst a second: long pauses between bursts
  const m = g.add(1, "qwen3.8-27b");
  assert.equal(g.stats().riseC, 0, "nothing learned yet");
  m.busy(1);
  await run(h, 1010); // a cycle is a burst and its pause: the rise is learned at its end
  const first = g.stats().riseC;
  assert.ok(first > 2.5 && first < 3.5, `one burst: about half the way to 6 (${first})`);
  await run(h, 2990);
  const learned = g.stats().riseC;
  assert.ok(learned > 5 && learned < 6.1, `a few bursts: near 6 (${learned})`);
  assert.ok(near(g.stats().peaksC, g.stats().smoothC + learned, 0.11), "the peaks are the smoothed junction plus the rise");
  up = 0;
  const c0 = g.stats().cycles;
  await run(h, 4000);
  const n = g.stats().cycles - c0;
  const later = g.stats().riseC;
  assert.ok(n >= 3 && n <= 5, `a burst a second (${n})`);
  assert.ok(later < learned, "bursts that rise less bring it down");
  assert.ok(later > learned * 0.95 ** n - 0.5, `by a twentieth a burst, not by the 4 s that passed (${learned} -> ${later} in ${n} bursts)`);
  // between requests and through the pause it is kept; a new member starts again
  m.busy(-1);
  await run(h, 1000); // the cycle in flight ends
  const kept = g.stats().riseC;
  await run(h, 3000);
  assert.equal(g.stats().riseC, kept);
  g.add(2, "qwen3.5-4b");
  assert.equal(g.stats().riseC, 0);
  m.stop();
});

test("a raw reading at HOLD_C holds the brain paused until one is under RELEASE_C, with both events, and halves the duty", async (t) => {
  const h = harness(t, [TARGET_C, TARGET_C, TARGET_C, TARGET_C, HOLD_C, 90, 86, RELEASE_C, RELEASE_C - 1, TARGET_C]);
  let g = null;
  const emit = h.bus.emit;
  h.bus.emit = (type, data) => emit(type, { ...data, duty: g.stats().duty, smoothC: g.stats().smoothC, riseC: g.stats().riseC });
  g = govern(1, { ...h.opts(), id: "qwen3.5-4b", loading: true });
  await run(h, 1500);
  const hold = h.events.find((e) => e.type === "throttle.hold");
  const release = h.events.find((e) => e.type === "throttle.release");
  assert.ok(hold, "held");
  assert.equal(hold.junctionC, HOLD_C);
  assert.equal(hold.id, "qwen3.5-4b");
  assert.match(hold.text, new RegExp(`qwen3\\.5-4b held: the GPU junction is at ${HOLD_C} C; it runs again under ${RELEASE_C} C`));
  assert.ok(release, "released");
  assert.equal(release.junctionC, RELEASE_C - 1, `not at ${RELEASE_C} C: under it`);
  assert.equal(h.events.length, 2, "one hold, one release");
  // from the hold to the release nothing resumes the brain, and the junction is read about every 50 ms
  const during = h.signals.slice(hold.signals, release.signals);
  assert.ok(during.length >= 1 && during.every((x) => x.s === "SIGSTOP"), "only pauses during the hold");
  const polls = h.reads.filter((r) => r.t > hold.t && r.t <= release.t);
  assert.deepEqual(polls.map((r) => r.c), [90, 86, RELEASE_C, RELEASE_C - 1]);
  assert.ok(polls.every((r, i) => r.t - (i ? polls[i - 1].t : hold.t) === HOLD_POLL_MS));
  // the duty is halved, not sent back to the start, and the smoothed junction starts again from the cool reading
  assert.equal(hold.duty, DUTY_START);
  assert.equal(release.duty, DUTY_START / 2);
  assert.equal(release.smoothC, RELEASE_C - 1);
  assert.ok(release.riseC >= hold.riseC && release.riseC > 2, `the rise the spike taught is kept through the hold (${hold.riseC} -> ${release.riseC})`);
  assert.equal(h.signals[release.signals]?.s, "SIGCONT", "then it runs again");
  assert.equal(g.stats().held, 1);
  assert.equal(g.stats().peakC, HOLD_C);
  g.stop();
});

test("a hold never takes the duty under its minimum, and a hold set by the caller is the one that counts", async (t) => {
  const h = harness(t, [TARGET_C, HOLD_C + 3, 80]);
  const g = createGovernor({ ...h.opts(), max: DUTY_MIN });
  const m = g.add(1, "qwen3.6-27b");
  assert.equal(g.stats().duty, DUTY_MIN, "the start is inside the bounds too");
  m.busy(1);
  await run(h, 2500);
  assert.equal(g.stats().held, 1);
  assert.equal(g.stats().duty, DUTY_MIN);
  m.stop();

  const low = harness(t, [80, 88, 88, 86, 80]);
  const g2 = createGovernor({ ...low.opts(), hold: 88 });
  const m2 = g2.add(2, "qwen3.5-4b");
  m2.busy(1);
  await run(low, 1000);
  assert.equal(low.events.find((e) => e.type === "throttle.hold")?.junctionC, 88, "held at its own hold, under HOLD_C");
  assert.equal(low.events.find((e) => e.type === "throttle.release")?.junctionC, 80);
  m2.stop();
});

test("a request that ends during a hold ends the hold: the brain runs free and the release is said", async (t) => {
  const h = harness(t, [HOLD_C + 2]);
  const g = createGovernor(h.opts());
  const m = g.add(1, "qwen3.5-4b");
  m.busy(1);
  await run(h, 600);
  assert.deepEqual(h.events.map((e) => e.type), ["throttle.hold"], "hot throughout: held, never released");
  assert.equal(h.signals.at(-1).s, "SIGSTOP");
  m.busy(-1);
  await run(h, 300);
  assert.deepEqual(h.events.map((e) => e.type), ["throttle.hold", "throttle.release"]);
  assert.equal(h.signals.at(-1).s, "SIGCONT", "nothing in flight: nothing is paused");
  h.signals.length = 0;
  await run(h, 500);
  assert.ok(h.signals.every((x) => x.s === "SIGCONT"));
  assert.equal(g.stats().duty, DUTY_START, "no cool reading ended it, so the duty was not halved");
  m.stop();
});

test("nothing is paused while no request is in flight, and the duty keeps its level between requests", async (t) => {
  const h = harness(t, [78]);
  const g = createGovernor(h.opts());
  const m = g.add(33, "qwen3.5-4b");
  await run(h, 1000);
  assert.ok(h.signals.length > 0 && h.signals.every((x) => x.s === "SIGCONT"), "idle: never paused");
  assert.equal(h.reads.length, 0, "idle: the junction is not even read");
  assert.equal(g.stats().duty, DUTY_START, "the duty waits at its start until the first request");
  assert.equal(g.stats().cycles, 0);

  m.busy(1);
  await run(h, 4000);
  const climbed = g.stats().duty;
  assert.ok(climbed > DUTY_START * 2, `it climbed while working cool (${climbed})`);
  assert.ok(h.signals.some((x) => x.s === "SIGSTOP"), "working: paused and resumed");
  assert.equal(g.stats().smoothC, 78);

  m.busy(-1);
  await ticks(3);
  const kept = g.stats().duty;
  assert.ok(kept >= climbed);
  h.signals.length = 0;
  const cycles = g.stats().cycles;
  await run(h, 3000);
  assert.ok(h.signals.length > 0 && h.signals.every((x) => x.s === "SIGCONT"), "between requests: never paused");
  assert.equal(g.stats().duty, kept, "idle keeps the learned duty");
  assert.equal(g.stats().cycles, cycles);
  assert.equal(g.stats().smoothC, null, "the smoothed junction is dropped: the next request starts its own");

  // the next request starts at once, at the level the last one reached
  const before = h.signals.length;
  m.busy(1);
  await ticks(2);
  assert.ok(h.signals.slice(before).some((x) => x.s === "SIGSTOP"), "the first burst of the next request is already over");
  assert.ok(g.stats().duty >= kept);
  assert.equal(g.stats().smoothC, 78);
  m.busy(-1);
  m.stop();
});

test("a request that ends during a burst is not paused after it", async (t) => {
  const h = harness(t, [TARGET_C]);
  const g = createGovernor(h.opts());
  const m = g.add(1, "qwen3.5-4b");
  m.busy(1);
  await run(h, 1000);
  let mark = null;
  h.during = (ms) => {
    if (ms !== ON_MS) return;
    m.busy(-1); // the answer ends while the brain runs
    mark = h.signals.length;
    h.during = null;
  };
  await run(h, 1000);
  assert.notEqual(mark, null, "the request ended inside a burst");
  const after = h.signals.slice(mark);
  assert.ok(after.length > 0 && after.every((x) => x.s === "SIGCONT"), "no pause follows that burst");
  m.stop();
});

test("a request does not wait for the governor's idle look: its first burst starts at once", async (t) => {
  const h = harness(t, [TARGET_C]);
  const sleep = h.sleep;
  // the look between requests never comes back by itself here
  const g = createGovernor({ ...h.opts(), sleep: (ms) => (ms === IDLE_MS ? new Promise(() => {}) : sleep(ms)) });
  const m = g.add(1, "qwen3.5-4b");
  await ticks(5);
  assert.equal(g.stats().cycles, 0);
  m.busy(1);
  await ticks(3);
  assert.ok(g.stats().cycles >= 1, "the governor woke with the request");
  assert.ok(h.signals.some((x) => x.s === "SIGSTOP"), "and its first burst is already over");
  m.stop();
});

test("the pause ends by the clock when sleeps run late, and by the time slept when the clock stands still", async (t) => {
  // timers run late on a real machine: every sleep here takes 3 ms more than asked
  const late = harness(t, [TARGET_C]);
  const sleep = late.sleep;
  const g = createGovernor({ ...late.opts(), sleep: (ms) => sleep(ms + 3) });
  const m = g.add(1, "qwen3.5-4b");
  m.busy(1);
  await run(late, 3000);
  const asked = ON_MS * (1 / DUTY_START - 1);
  const off = gaps(late.signals, "SIGSTOP", "SIGCONT");
  assert.ok(off.length >= 5);
  assert.ok(off.every((ms) => ms >= asked && ms <= asked + SAMPLE_MS + 3), `the lateness of each sleep does not add up over the pause (${Math.max(...off).toFixed(0)} ms for ${asked.toFixed(0)})`);
  m.stop();

  // a clock that does not move: the cycle still turns, and with no time passed the duty is not steered
  const still = harness(t, [TARGET_C - 10]);
  const g2 = createGovernor({ ...still.opts(), now: () => 0 });
  const m2 = g2.add(2, "qwen3.5-4b");
  m2.busy(1);
  await run(still, 3000);
  assert.ok(g2.stats().cycles >= 5, `it cycles (${g2.stats().cycles})`);
  assert.equal(g2.stats().duty, DUTY_START);
  m2.stop();
});

test("adding a member sends the duty back to the start: another brain heats the card differently", async (t) => {
  const h = harness(t, [78]);
  const g = createGovernor(h.opts());
  const a = g.add(11, "qwen3.5-4b");
  a.busy(1);
  await run(h, 4000);
  assert.ok(g.stats().duty > DUTY_START * 2);
  a.busy(-1);
  const b = g.add(22, "qwen3.6-27b");
  assert.equal(g.stats().duty, DUTY_START);
  assert.equal(b.stats().duty, DUTY_START);
  assert.equal(g.stats().members, 2);
  a.stop();
  b.stop();
  await ticks(3);
  assert.equal(g.stats().members, 0);
});

test("with a maximum of 1 a cool card is not paused at all, but it is still read and the hold still applies", async (t) => {
  let hot = false;
  const h = harness(t, () => (hot ? HOLD_C : 40));
  const g = createGovernor({ ...h.opts(), max: 1 });
  const m = g.add(7, "qwen3.5-4b");
  m.busy(1);
  await run(h, 4000);
  assert.equal(g.stats().duty, 1);
  assert.equal(g.stats().periodMs, ON_MS, "no pause in the cycle");
  h.signals.length = 0;
  const reads = h.reads.length;
  await run(h, 500);
  assert.ok(h.signals.every((x) => x.s === "SIGCONT"), "never paused");
  assert.ok(h.reads.length - reads >= 500 / SAMPLE_MS, "still read");
  hot = true;
  await run(h, 200);
  assert.equal(h.events.at(-1)?.type, "throttle.hold");
  assert.equal(h.signals.at(-1).s, "SIGSTOP", "held");
  m.stop();
});

test("the burst, the target and the maximum can be set", async (t) => {
  const h = harness(t, [80]);
  const g = createGovernor({ ...h.opts(), on: 25, target: 75, max: 0.2 });
  const m = g.add(5, "qwen3.5-4b");
  assert.equal(g.stats().onMs, 25);
  assert.equal(g.stats().periodMs, Math.round(25 / DUTY_START));
  m.busy(1);
  await run(h, 3000);
  assert.ok(gaps(h.signals, "SIGCONT", "SIGSTOP").every((ms) => ms === 25));
  assert.ok(g.stats().duty < DUTY_START, "80 C is over a target of 75");
  m.busy(-1);
  m.stop();

  const cool = harness(t, [40]);
  const g2 = createGovernor({ ...cool.opts(), max: 0.2 });
  const m2 = g2.add(6, "qwen3.5-4b");
  m2.busy(1);
  await run(cool, 5000);
  assert.equal(g2.stats().duty, 0.2);
  m2.busy(-1);
  m2.stop();
});

test("a vanished process ends the governor without throwing", async (t) => {
  const g = govern(999999, { platform: "linux", readJunction: () => 80, signal: () => { throw new Error("ESRCH"); }, sleep: async () => {}, loading: true });
  await ticks(5);
  g.busy(1);
  g.stop();
  assert.equal(g.stats().duty, DUTY_START);

  // in a group: the one that is gone leaves, the other is still governed
  const h = harness(t, [TARGET_C]);
  const group = createGovernor({ ...h.opts(), signal: (pid, s) => { if (pid === 404) throw new Error("ESRCH"); h.signal(pid, s); } });
  const gone = group.add(404, "gone");
  const here = group.add(22, "qwen3.5-4b");
  here.busy(1);
  await run(h, 1000);
  assert.equal(group.stats().members, 1);
  assert.ok(h.signals.some((x) => x.pid === 22 && x.s === "SIGSTOP"));
  gone.stop();
  here.stop();
  await ticks(3);
  assert.equal(group.stats().members, 0);
});

test("a junction that cannot be read leaves the duty where it is", async (t) => {
  const h = harness(t, [null]);
  const g = createGovernor(h.opts());
  const m = g.add(8, "qwen3.5-4b");
  m.busy(1);
  await run(h, 2000);
  assert.equal(g.stats().duty, DUTY_START);
  assert.equal(g.stats().n, 0);
  assert.equal(g.stats().meanC, null);
  assert.equal(g.stats().smoothC, null);
  assert.ok(gaps(h.signals, "SIGCONT", "SIGSTOP").length >= 3, "it still cycles at the starting duty");
  m.stop();

  const broken = harness(t, () => { throw new Error("EIO"); });
  const g2 = createGovernor(broken.opts());
  const m2 = g2.add(9, "qwen3.5-4b");
  m2.busy(1);
  await run(broken, 1000);
  assert.equal(g2.stats().duty, DUTY_START, "a sensor that throws is no reading");
  m2.stop();
  await ticks(3);
  assert.equal(broken.signals.at(-1).s, "SIGCONT");
});

test("one governor pauses and resumes every GPU brain together, only while one of them works", async (t) => {
  const h = harness(t, [70]);
  const g = createGovernor(h.opts());
  const a = g.add(11, "qwen3.5-9b");
  const b = g.add(22, "qwen3.5-4b");
  await run(h, 500);
  assert.ok(h.signals.every((x) => x.s === "SIGCONT"), "nobody works: nobody is paused");
  assert.equal(g.stats().duty, DUTY_START, "the duty waits at its start until the first request");
  b.busy(1);
  h.signals.length = 0;
  await run(h, 1000);
  for (const s of ["SIGSTOP", "SIGCONT"]) {
    const at = (pid) => h.signals.filter((x) => x.pid === pid && x.s === s).map((x) => x.t);
    assert.ok(at(11).length > 0, `${s} reaches the brain that is not working too: they share one card`);
    assert.deepEqual(at(11), at(22), `${s} at the same moments for both`);
  }
  b.busy(-1);
  a.stop();
  b.stop();
  await ticks(4);
  assert.equal(g.stats().members, 0);
});

test("the governor runs only where a junction can be read and a process can be paused", () => {
  assert.deepEqual(governorCan({ platform: "linux", readJunction: () => 71 }), { runs: true, why: null });
  const noSensor = governorCan({ platform: "linux", readJunction: () => null });
  assert.equal(noSensor.runs, false);
  assert.match(noSensor.why, /no GPU junction temperature can be read/);
  assert.equal(governorCan({ platform: "darwin", readJunction: () => null }).runs, false, "macOS gives no junction");
  const win = governorCan({ platform: "win32", readJunction: () => 71 });
  assert.equal(win.runs, false, "even with a temperature: nothing there can pause a process");
  assert.match(win.why, /cannot pause a process/);
  assert.equal(governorCan({ platform: "linux", readJunction: () => { throw new Error("gone"); } }).runs, false, "a sensor that throws is no sensor");
  const here = governorCan();
  assert.equal(typeof here.runs, "boolean");
  assert.equal(here.runs ? here.why : typeof here.why, here.runs ? null : "string");
});

test("on Windows the governor sends no signal at all, whatever the brains do", async (t) => {
  const signals = [];
  const g = createGovernor({ platform: "win32", readJunction: () => 99, signal: (pid, s) => signals.push(s), sleep: async () => {} });
  const m = g.add(4242, "qwen3.5-4b");
  m.busy(1);
  await ticks(10);
  m.busy(-1);
  m.loaded();
  m.stop();
  assert.deepEqual(signals, [], "no SIGSTOP, no SIGCONT");
  assert.equal(g.stats().members, 0);
  assert.equal(m.stats().cycles, 0);
  assert.equal(m.stats().duty, 1);
  const solo = govern(4243, { platform: "win32", readJunction: () => 99, signal: (pid, s) => signals.push(s), sleep: async () => {} });
  solo.busy(1);
  solo.loaded();
  solo.stop();
  assert.deepEqual(signals, []);
});
