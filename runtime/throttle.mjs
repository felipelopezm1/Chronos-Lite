// The governor: a power cap for a GPU brain, without root.
//
// This laptop's RX 6800M runs every job at full clock (2500 MHz, up to 136 W).
// Unthrottled, one prompt takes the junction past 100 C, its critical
// temperature, in under a second, and its firmware powered the machine off
// three times on 2026-10-20 and 21. Its clock and power files are root-only
// and its power cap is fixed at 130 W. So the governor caps it from user
// space: while a GPU brain works, it pauses and resumes the llama-server
// process (SIGSTOP / SIGCONT) in short bursts, and the junction temperature
// steers how far apart the bursts are.
//
// What a burst does, measured on 2026-11-14 with scripts/heat-probe.mjs (the
// card rests at 78 to 80 C). A paused process cannot cut GPU work it already
// submitted. Each burst lets the process submit about one token's work, and
// the card finishes it whether or not the process is paused. So the tokens a
// second follow the number of bursts a second, not their length, and so does
// the heat. Run / pause in milliseconds, tokens a second, junction in C:
//
//   4B   40 / 460    4.1 tok/s   median 80, highest 90
//        10 / 90     9.6 tok/s   median 82, highest 85
//        10 / 40    19.8 tok/s   median 87, 95th percentile 89, highest 91
//        10 / 20    about 19     95th percentile 94, highest 97 to 98, and
//        20 / 20                 about 20 safety stops in 20 seconds
//   27B  10 / 240    3.6 tok/s   median 83, 95th percentile 88, highest 91
//        10 / 115    6 tok/s     median 87, 95th percentile 93, highest 96,
//                                20 safety stops
//        10 / 52                 43 safety stops
//
// The first line is where the earlier law ended up: it ran a share of a
// 500 ms cycle, steered that share on the single reading at the end of each
// run, and fell to 0.06 to 0.08, which is 40 ms of run and 460 of pause.
//
// The law now. The burst is fixed at ON_MS. The steered number is still the
// duty, the share of time the process runs, so the pause after each burst is
// ON_MS x (1 / duty - 1). The right pause differs per brain (50 to 100 ms for
// the 4B, about 250 ms for the 27B), so the law finds it from the temperature.
// The junction is read after each burst and every SAMPLE_MS of the pause. The
// readings are smoothed over about a second (SMOOTH_MS), and once a cycle the
// duty is multiplied up while the smoothed junction is under TARGET_C and
// down, six times as fast for each degree, while it is over. One hot reading
// among cool ones barely moves the smoothed junction, so it no longer throws
// the duty to its floor. The spike guard works on the raw readings: at HOLD_C
// every brain is held paused until a reading is under RELEASE_C, and the duty
// is then halved.
//
// The peaks are steered too. A bigger brain heats the card more with each
// burst: on 2026-11-14 the 27B's reading right after a burst stood 7 to 9 C
// over its smoothed junction (the 4B's 2 to 4), so with the smoothed junction
// at 84 C its bursts reached HOLD_C, it was held 11 times in 40 seconds, and
// each hold halved its duty. So the law also learns each burst's rise: the
// hottest reading of a cycle over the smoothed junction. The rise is a
// property of the brain, not of the moment, so it is learned per burst and
// not forgotten with time: it moves half way to a higher rise at once
// (RISE_UP) and a twentieth of the way to a lower one each burst (RISE_DOWN),
// and a hold or a long pause does not reset it. (An envelope that sank back
// over a few seconds forgot the spikes while the duty sat low after a hold,
// the duty climbed straight back, and the 27B was held 25 times in 40
// seconds.) The peaks a burst reaches are then the smoothed junction plus the
// rise, and the duty is steered on whichever is further over its own mark: the
// smoothed junction over TARGET_C, or the peaks over PEAK_C. A small brain
// stays steered by its mean; a big one by its peaks, its mean held lower, under
// the hold.
//
// Brains still run with small prompt batches (-ub), so that one burst of
// prompt work is small too.

import { readFileSync, readdirSync } from "node:fs";
import { canPause } from "./platform.mjs";

export const ON_MS = 10; // the burst: how long the process runs each cycle
export const SAMPLE_MS = 20; // the junction is read at least this often while the process is paused
export const SMOOTH_MS = 1000; // the time constant of the smoothed junction the law steers on
export const RISE_UP = 0.5; // a burst that rises higher than the rise learned moves it this share of the way at once
export const RISE_DOWN = 0.05; // one that rises less moves it this share of the way
export const TARGET_C = 87; // the smoothed junction the governor steers to (CHRONOS_TARGET_C)
export const HOLD_C = 93; // a raw reading at or above this holds every brain paused until one is under RELEASE_C
export const PEAK_C = HOLD_C - 2; // the peaks (smoothed junction plus a burst's rise) the governor steers under (the catalogue's peakC)
export const RELEASE_C = 85;
export const HOLD_POLL_MS = 50; // how often the junction is read during a hold
export const IDLE_MS = 100; // how often the governor looks for a request while none is in flight
export const DUTY_START = 0.03; // 10 ms of run, 323 of pause
export const DUTY_MIN = 0.01; // 10 ms of run, 990 of pause
export const DUTY_MAX = 0.5; // 10 ms of run, 10 of pause (CHRONOS_DUTY_MAX)
export const UP_PER_C_S = 0.05; // under target the duty grows by e^0.05 for each degree under, each second
export const DOWN_PER_C_S = 0.3; // over target it shrinks by e^0.3 for each degree over, each second

/**
 * The next duty from the current one and the smoothed junction, after dtMs of
 * steering (one second when not given). The step is a factor, not a sum, and
 * it scales with the time passed: the duty climbs slowly while the card is
 * under target and falls six times as fast once it is over. With peakC (the
 * peaks the bursts reach) it steers on whichever is further over its mark: the
 * smoothed junction over target, or the peaks over peak. With no reading
 * the duty stays where it is.
 */
export function nextDuty(duty, smoothC, { target = TARGET_C, peakC = null, peak = PEAK_C, min = DUTY_MIN, max = DUTY_MAX, dtMs = 1000 } = {}) {
  const clamp = (d) => Math.max(min, Math.min(max, d));
  if (!Number.isFinite(smoothC) || !Number.isFinite(dtMs) || dtMs <= 0) return clamp(duty);
  let over = smoothC - target; // degrees over the mark; under it when negative
  if (Number.isFinite(peakC) && Number.isFinite(peak)) over = Math.max(over, peakC - peak);
  const k = over > 0 ? DOWN_PER_C_S : UP_PER_C_S;
  return clamp(duty * Math.exp((-k * over * dtMs) / 1000));
}

/** the discrete GPU's junction temperature in C, or null */
export function junctionReader() {
  let file = null;
  try {
    for (const h of readdirSync("/sys/class/hwmon")) {
      const base = `/sys/class/hwmon/${h}`;
      try {
        if (readFileSync(`${base}/name`, "utf8").trim() === "amdgpu" && readFileSync(`${base}/temp2_input`, "utf8")) {
          file = `${base}/temp2_input`;
          break;
        }
      } catch {
        /* not this one */
      }
    }
  } catch {
    /* no hwmon */
  }
  return () => {
    if (!file) return null;
    try {
      return Math.round(Number(readFileSync(file, "utf8")) / 1000);
    } catch {
      return null;
    }
  };
}

/**
 * Can the governor run here? It needs two things: a way to pause a process
 * (SIGSTOP, which Windows does not have) and a junction temperature to steer
 * by (today the amdgpu sensor on Linux; macOS gives none without root, and
 * NVIDIA's one temperature is not a junction). Returns { runs, why }: why is
 * a plain sentence when it cannot, null when it can. Where it cannot, GPU
 * brains run ungoverned and GET /health says so.
 */
export function governorCan({ platform = process.platform, readJunction = junctionReader() } = {}) {
  if (!canPause(platform)) return { runs: false, why: "this system cannot pause a process (Windows has no SIGSTOP), so GPU brains run ungoverned" };
  let j = null;
  try {
    j = readJunction();
  } catch {
    j = null;
  }
  if (!Number.isFinite(j)) return { runs: false, why: "no GPU junction temperature can be read on this system, so there is nothing to steer by and GPU brains run ungoverned" };
  return { runs: true, why: null };
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One governor for every GPU brain: they share one card, so they are paused
 * and resumed together and the duty is steered by the one junction they heat.
 * add(pid, id) returns a member { busy(n), loaded(), stop(), stats() }:
 * busy(+1) when a request starts, busy(-1) when it ends. Nothing is paused
 * while no member has a request in flight (a loading model is cool: 34 W, 72 C
 * measured). The duty starts at DUTY_START, moves only while a request runs
 * and keeps its level between requests. A hold halves it, and a new member
 * sends it back to DUTY_START, because another brain heats the card
 * differently for each token.
 *
 * Options: on (the burst in ms), target (C, the smoothed junction), peak (C,
 * the peaks the bursts reach; two under the hold when not given, and always
 * under it), max (the highest duty; at 1 a cool card is not paused at all),
 * hold (C, on raw readings), and for tests readJunction, signal, sleep and now
 * (a clock in ms).
 */
export function createGovernor({
  readJunction = junctionReader(),
  signal = (p, s) => process.kill(p, s),
  sleep = realSleep,
  now = Date.now,
  target = Number(process.env.CHRONOS_TARGET_C) || TARGET_C,
  max = Number(process.env.CHRONOS_DUTY_MAX) || DUTY_MAX,
  on = ON_MS,
  hold = HOLD_C,
  peak,
  bus = null,
  platform = process.platform,
} = {}) {
  // A system that cannot pause a process gets a governor that does nothing: no loop, and no signal ever sent
  // (on Windows process.kill(pid, "SIGSTOP") would end the brain, not pause it).
  if (!canPause(platform)) {
    const idle = () => ({ peakC: 0, sumC: 0, n: 0, held: 0, cycles: 0, meanC: null, duty: 1, smoothC: null, riseC: null, peaksC: null, onMs: null, periodMs: null });
    return { add: () => ({ busy() {}, loaded() {}, stop() {}, stats: idle }), stats: () => ({ ...idle(), members: 0 }) };
  }
  const release = Math.min(RELEASE_C, hold - 1); // a hold set under the release still has to cool before it ends
  const peakMark = Math.min(Number.isFinite(peak) ? peak : hold - 2, hold - 1); // the peaks are steered under the hold
  const clamp = (d) => Math.max(DUTY_MIN, Math.min(max, d));
  const members = new Map(); // pid -> { id, inflight }
  let duty = clamp(DUTY_START);
  let smooth = null; // the smoothed junction of the request in flight; null between requests
  let smoothAt = 0;
  let rise = 0; // how far a burst's hottest reading stands over the smoothed junction, learned per burst
  let cycleRise = null; // the most this cycle's readings stood over the smoothed junction
  let looping = false;
  let wake = null; // ends the wait between requests the moment one starts
  const stats = { peakC: 0, sumC: 0, n: 0, held: 0, cycles: 0 };
  const send = (s) => {
    for (const [pid] of members) {
      try { signal(pid, s); } catch { members.delete(pid); }
    }
  };
  const busy = () => [...members.values()].some((m) => m.inflight > 0);
  const working = () => members.size > 0 && busy();
  const label = () => [...members.values()].map((m) => m.id).join(", ");
  const offMs = () => (duty >= 1 ? 0 : on * (1 / duty - 1));
  const peaks = () => (smooth === null ? null : smooth + Math.max(0, rise)); // where the next burst's hottest reading should land

  /** One reading: into the stats and into the smoothed junction. Returns the raw reading, or null. */
  const sample = () => {
    let j = null;
    try { j = readJunction(); } catch { j = null; }
    if (!Number.isFinite(j)) return null;
    stats.peakC = Math.max(stats.peakC, j);
    stats.sumC += j;
    stats.n++;
    const t = now();
    const dt = Math.max(0, t - smoothAt);
    if (smooth === null) smooth = j;
    else smooth += (1 - Math.exp(-dt / SMOOTH_MS)) * (j - smooth);
    cycleRise = Math.max(cycleRise ?? -Infinity, j - smooth);
    smoothAt = t;
    return j;
  };
  const hot = (j) => j !== null && j >= hold;

  /** The spike guard: everything stays paused until a raw reading is under the release. */
  async function holdAll(j) {
    stats.held++;
    send("SIGSTOP");
    bus?.emit?.("throttle.hold", { id: label(), junctionC: j, text: `${label()} held: the GPU junction is at ${j} C; it runs again under ${release} C` });
    let last = j;
    while (working()) {
      await sleep(HOLD_POLL_MS);
      if (!working()) break;
      send("SIGSTOP"); // a brain added during the hold is held too
      const r = sample();
      if (r === null) continue;
      last = r;
      if (r < release) {
        duty = clamp(duty / 2);
        smooth = r; // the card has just cooled under a pause: the readings before it say nothing about the next burst
        // the rise is kept: the bursts that follow rise as high as the one that caused the hold
        smoothAt = now();
        bus?.emit?.("throttle.release", { id: label(), junctionC: r });
        return;
      }
    }
    // the request ended (or the brain went away) while the card was still hot: nothing is held any more, so say so
    bus?.emit?.("throttle.release", { id: label(), junctionC: last });
  }

  async function loop() {
    if (looping) return;
    looping = true;
    try {
      while (members.size) {
        if (!busy()) {
          // between requests: run free and keep the duty learned so far; the
          // smoothed junction is dropped, the next request starts its own
          send("SIGCONT");
          smooth = null;
          cycleRise = null;
          await new Promise((resolve) => {
            wake = resolve;
            sleep(IDLE_MS).then(resolve, resolve);
          });
          wake = null;
          continue;
        }
        // One cycle: a burst, then the pause the duty asks for. The junction is
        // read after the burst and every SAMPLE_MS of the pause; every reading
        // is checked against the hold.
        stats.cycles++;
        const startedAt = now();
        // a request's first reading is taken before its first burst, so the smoothed junction starts from the card
        // as it is and not from the burst's peak (which would teach no rise at all)
        if (smooth === null) sample();
        cycleRise = null;
        send("SIGCONT");
        await sleep(on);
        let j = sample();
        let spike = hot(j);
        let left = offMs();
        if (!spike && left > 0 && working()) {
          send("SIGSTOP");
          const until = now() + left;
          while (left > 0 && working()) {
            const chunk = Math.min(SAMPLE_MS, left);
            await sleep(chunk);
            // the pause ends by the clock; where the clock stands still (a test), by the time slept
            left = Math.min(left - chunk, until - now());
            j = sample();
            if (hot(j)) { spike = true; break; }
          }
        }
        // what this burst taught about how high a burst rises (also the one that caused a hold)
        if (Number.isFinite(cycleRise)) rise += (cycleRise > rise ? RISE_UP : RISE_DOWN) * (cycleRise - rise);
        if (spike) {
          await holdAll(j);
          continue;
        }
        duty = nextDuty(duty, smooth, { target, peakC: peaks(), peak: peakMark, max, dtMs: now() - startedAt });
      }
    } finally {
      looping = false;
    }
  }

  const read = () => ({
    ...stats,
    meanC: stats.n ? Math.round(stats.sumC / stats.n) : null,
    duty: Math.round(duty * 1000) / 1000,
    smoothC: smooth === null ? null : Math.round(smooth * 10) / 10,
    riseC: Math.round(rise * 10) / 10,
    peaksC: smooth === null ? null : Math.round(peaks() * 10) / 10,
    onMs: on,
    periodMs: Math.round(on + offMs()),
  });

  return {
    add(pid, id = String(pid)) {
      const m = { id, inflight: 0 };
      members.set(pid, m);
      duty = clamp(DUTY_START); // what the last brain could take says nothing about this one
      rise = 0; // nor how high its bursts rose
      loop();
      return {
        busy(n) {
          m.inflight = Math.max(0, m.inflight + n);
          if (n > 0) wake?.();
        },
        loaded() {},
        stop() {
          members.delete(pid);
          try { signal(pid, "SIGCONT"); } catch { /* gone */ }
        },
        stats: read,
      };
    },
    stats: () => ({ ...read(), members: members.size }),
  };
}

/**
 * Govern one process on its own (the group above with one member); kept for
 * callers and tests that hold a single brain. loading: true counts the load as
 * a request in flight until loaded() is called.
 */
export function govern(pid, opts = {}) {
  const { loading = true, id = String(pid), ...rest } = opts;
  const g = createGovernor(rest);
  const m = g.add(pid, id);
  if (loading) m.busy(1);
  let loadingLeft = loading;
  return {
    busy: m.busy,
    loaded() {
      if (loadingLeft) { loadingLeft = false; m.busy(-1); }
    },
    stop: m.stop,
    stats: m.stats,
  };
}
