// The models: the three brains, what each size may ask of them, what the machine has and who holds
// the card. Written fresh for Lite from the parts of Chronos's ui/views/brains.js that Lite can
// serve: Lite has no /brains route and no start, stop or seat (the runner starts a brain when a
// quest needs it), so everything here is read from GET /health and the brain.* and
// hardware.read events.
//
//   the brains    each with its role in the brand's words, its size, its status and whether its
//                 file is on disk (and whose copy it runs from: Lite's, or a full Chronos's)
//   the sizes     s and m: which brain plans, works, helps and judges, the caps, and why a size
//                 cannot run now
//   the hardware  VRAM, RAM, CPU load and the temperatures as meters
//   the card      the card lock: free, held here, held by another service, or left stale
//
// The view contract: mount(root, api) -> { enter(context), leave() }.

import { h, fill, chip, dot } from "../lib/dom.js";
import { W, shortBrain, roleWord, plainText, many, cap, sizeLetter } from "../lib/words.js";
import { dur, hms } from "../lib/time.js";
import { meter, sizeChip } from "../lib/parts.js";
import { state, on } from "../store.js";

const ROLES = ["titan", "promethean", "offspring", "judge"];
const LIMITS = { reserve: 0.2, hotC: 90, coolC: 85 };
const GiB = (mib) => ((mib ?? 0) / 1024).toFixed(1);
const kilo = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const STATUS = { ready: "ready", loading: "loading", waiting: "waits for the card", failed: "failed", idle: "asleep", stopped: "asleep" };

export function mount(root) {
  root.classList.add("vw", "view-brains");
  let shown = false;

  const meta = h("span.tiny.v-head-meta");
  const title = h("span.v-title");
  const sub = h("span.tiny.v-sub");
  const brainsEl = h("div.br-list");
  const tiersEl = h("div.br-tiers");
  const hwMeta = h("span.tiny");
  const cardEl = h("div.br-dog");
  const meters = { vram: meter("vram"), ram: meter("ram"), cpu: meter("cpu load"), junction: meter("junction"), edge: meter("edge"), cpuC: meter("cpu") };
  const heads = {};
  const card = (cls, key, metaEl, ...body) => {
    heads[key] = { title: h("span.br-card-title"), sub: h("span.tiny.br-card-sub") };
    return h(`section.br-card.${cls}`, h("header.br-card-head", heads[key].title, heads[key].sub, metaEl ? h("span.br-card-meta", metaEl) : null), ...body);
  };

  root.append(
    h("header.v-head", title, sub, h("span.v-head-right", meta)),
    h(
      "div.br-body.v-scroll",
      h(
        "div.br-cols",
        h("div.br-col", card("br-brains", "brains", null, brainsEl), card("br-sizes", "sizes", null, tiersEl)),
        h("div.br-col", card("br-hw", "hw", hwMeta, h("div.br-meters", meters.vram.el, meters.ram.el, meters.cpu.el, h("div.br-rule"), meters.junction.el, meters.edge.el, meters.cpuC.el)), card("br-heat", "card", null, cardEl)),
      ),
    ),
  );

  function relabel() {
    title.textContent = many("model");
    sub.textContent = `the ${many("model")}, what each size may ask of them, and what the machine has`;
    heads.brains.title.textContent = `the ${many("model")}`;
    heads.brains.sub.textContent = `started by the runner when a ${W.task} needs one`;
    heads.sizes.title.textContent = "the sizes";
    heads.sizes.sub.textContent = `which ${many("model")} do a ${W.task} of each size`;
    heads.hw.title.textContent = "the hardware";
    heads.hw.sub.textContent = "what the machine has, read every few seconds";
    heads.card.title.textContent = "the graphics card";
    heads.card.sub.textContent = "one card, one lock, shared with every Chronos on this computer";
  }

  /** a brain's part, from the sizes' tiers (the 9B's own role reads "talk"), else its role */
  function partOf(b) {
    const tiers = Object.values(state.health?.sizes ?? {}).map((x) => x?.tier ?? {});
    for (const part of ["titan", "promethean", "offspring"]) if (tiers.some((t) => t[part] === b.id)) return part;
    return b.role;
  }

  function paintBrains() {
    const list = state.brains;
    if (!list.length) return fill(brainsEl, h("div.tiny.v-empty", state.healthError ? `the service is not answering: ${state.healthError}` : `no ${W.model} is named yet`));
    const order = { titan: 0, promethean: 1, offspring: 2 };
    meta.textContent = `${list.filter((b) => b.status === "ready").length} of ${list.length} awake`;
    fill(
      brainsEl,
      list
        .map((b) => ({ b, part: partOf(b) }))
        .sort((x, y) => (order[x.part] ?? 9) - (order[y.part] ?? 9))
        .map(({ b, part }) => {
          const ready = b.status === "ready";
          const loading = b.status === "loading" || state.loading.has(b.id);
          const since = state.loading.get(b.id);
          const missing = b.present === false;
          return h(
            `div.brain${ready ? ".ready" : ""}${loading ? ".loading" : ""}`,
            { dataset: { status: b.status ?? "unknown" } },
            h(
              "div.brain-top",
              dot(missing ? "warn" : loading ? "on" : ready ? "awake" : b.status === "failed" ? "bug" : b.status === "waiting" ? "heat" : "asleep"),
              h("span.brain-short", shortBrain(b.id) || W.model),
              h("span.brain-name", cap(roleWord(part))),
              h(
                "span.brain-chips",
                chip(missing ? "not on disk" : (STATUS[b.status] ?? b.status ?? "?"), missing ? "warn" : loading || b.status === "waiting" ? "hot" : b.status === "failed" ? "bug" : ready ? null : "mute", loading && since ? `loading for ${dur(Date.now() - since)}` : undefined),
                b.where === "chronos" ? chip("shared file", "mute", "its file is a full Chronos's, used in place and never changed") : null,
              ),
            ),
            h("div.tiny.brain-sub", [`${roleWord(part)} · ${shortBrain(b.id)}`, b.port != null ? `port ${b.port}` : null, b.where ? `from ${b.where === "lite" ? "this edition's home" : "a full Chronos's home"}` : null].filter(Boolean).join(" · ")),
          );
        }),
    );
  }

  function paintTiers() {
    const sizes = state.health?.sizes;
    if (!sizes) return fill(tiersEl, h("div.tiny.v-empty", state.healthError ? `the sizes could not be read: ${state.healthError}` : "reading the sizes…"));
    const byId = new Map(state.brains.map((b) => [b.id, b]));
    const keys = ["s", "m"].filter((k) => sizes[k]);
    fill(
      tiersEl,
      h("div.tier-row.tier-head.tiny", { "aria-hidden": "true" }, h("span", "size"), ROLES.map((r) => h("span", roleWord(r))), h("span.tier-cap", many("step")), h("span.tier-cap", "tokens"), h("span.tier-cap", "time")),
      keys.map((k) => {
        const row = sizes[k];
        const tier = row.tier ?? {};
        const ok = row.ok !== false;
        return h(
          `div.tier-block${ok ? "" : ".off"}`,
          h(
            "div.tier-row",
            h("span.tier-size", sizeChip(k, `size ${sizeLetter(k)}${row.note ? `: ${plainText(row.note)}` : ""}`)),
            ROLES.map((role) => {
              const id = tier[role];
              if (!id) return h("span.tier-brain.none", { dataset: { role: roleWord(role) }, title: `a size ${sizeLetter(k)} ${W.task} has no ${roleWord(role)}` }, h("span.tiny", "—"));
              const present = row.present?.[id] ?? (byId.has(id) ? byId.get(id).present !== false : null);
              const up = byId.get(id)?.status === "ready";
              return h("span.tier-brain", { dataset: { role: roleWord(role) } }, dot(present === false ? "warn" : up ? "awake" : "asleep"), chip(shortBrain(id) || W.model, present === false ? "warn" : up ? null : "mute"), present === false ? h("span.tiny.tier-missing", "not on disk") : null);
            }),
            h("span.tier-cap", row.maxTasks != null ? String(row.maxTasks) : "—"),
            h("span.tier-cap", row.tokens != null ? kilo(row.tokens) : "—"),
            h("span.tier-cap", row.seconds != null ? dur(row.seconds * 1000).replace(/ 00 s$/, "") : "—"),
          ),
          h("div.tiny.tier-note", { dataset: ok ? null : { tone: "warn" } }, ok ? plainText(row.note ?? "") : `cannot run now: ${plainText(row.why ?? `a ${W.model} it needs is missing`)}${row.fallsTo ? ` · it falls to ${sizeLetter(row.fallsTo)}` : ""}`),
        );
      }),
      h("div.tiny.br-legend", h("span.br-key", dot("awake"), "ready now"), h("span.br-key", dot("asleep"), "on disk, asleep"), h("span.br-key", dot("warn"), "not on disk"), h("span.br-key", "an L is taken and runs as M")),
    );
  }

  function setHeat(m, c, top, { line = true } = {}) {
    if (c == null) {
      m.set(0, "no sensor");
      m.mark(null);
      return;
    }
    const hot = line && c >= LIMITS.hotC;
    m.set(c / top, `${Math.round(c)} C${hot ? " · hot" : ""}`, hot ? "heat" : c >= LIMITS.hotC - 15 ? "warm" : "");
    if (line) m.mark(LIMITS.hotC / top, `${LIMITS.hotC} C: nothing new starts on the GPU above this`);
  }

  function paintHardware() {
    const hw = state.hardware ?? state.health?.hardware;
    if (!hw) {
      hwMeta.textContent = "no reading on this system";
      for (const m of Object.values(meters)) m.set(0, "—");
      return;
    }
    const { vram, ram, cpu, heat } = hw;
    const keep = 1 - LIMITS.reserve;
    if (vram?.totalMiB) {
      const share = vram.usedMiB / vram.totalMiB;
      meters.vram.set(share, `${GiB(vram.usedMiB)} / ${GiB(vram.totalMiB)} GiB`, share > keep ? "warm" : "on");
      meters.vram.mark(keep, "the 20% kept for the owner: nothing new starts on the card past this");
    } else meters.vram.set(0, "no discrete GPU found");
    if (ram?.totalMiB) {
      const used = ram.totalMiB - (ram.availableMiB ?? 0);
      meters.ram.set(used / ram.totalMiB, `${GiB(used)} / ${GiB(ram.totalMiB)} GiB`, used / ram.totalMiB > keep ? "warm" : "");
    } else meters.ram.set(0, "not read");
    if (cpu?.threads) meters.cpu.set((cpu.load1 ?? 0) / cpu.threads, `${Number(cpu.load1 ?? 0).toFixed(2)} on ${cpu.threads} threads`);
    else meters.cpu.set(0, "not read");
    const top = Math.max(100, heat?.critC ?? 100);
    setHeat(meters.junction, heat?.junctionC ?? null, top);
    setHeat(meters.edge, heat?.edgeC ?? null, top);
    setHeat(meters.cpuC, heat?.cpuC ?? null, top, { line: false });
    hwMeta.textContent = [vram?.card ?? null, hw.at ? `read ${hms(hw.at)}` : null].filter(Boolean).join(" · ");
  }

  function paintCard() {
    const c = state.health?.card;
    const hold = state.hold;
    if (!c) return fill(cardEl, h("div.tiny.v-empty", "the card lock has not been read yet"));
    const kind = hold ? "heat" : !c.lock || c.stale ? "awake" : c.mine ? "on" : "warn";
    const word = hold ? (hold.type === "heat.cutoff" ? "cut off" : "held") : !c.lock ? "free" : c.stale ? "free (stale lock)" : c.mine ? "in use here" : "busy elsewhere";
    const say = hold
      ? plainText(hold.text ?? "the junction is too hot: every brain was stopped until it cools")
      : !c.lock
        ? `no service holds the card: the next ${W.task} takes it`
        : c.stale
          ? "a service that has stopped left its lock; the next start on the card takes it over"
          : c.mine
            ? `this service holds it for the ${shortBrain(c.lock.brain) || W.model}${c.lock.since ? ` since ${hms(c.lock.since)}` : ""}`
            : `another service on this computer holds it: work waits until it is free`;
    fill(cardEl, h(`div.br-dog-state.is-${kind}`, dot(kind), h("span.br-dog-word", word)), h("div.br-dog-say", say), h("div.tiny.br-dog-last", `governor: ${state.health?.governor?.runs ? "runs" : (plainText(state.health?.governor?.why ?? "") || "off")}`));
  }

  function paint() {
    if (!shown) return;
    paintBrains();
    paintTiers();
    paintHardware();
    paintCard();
  }
  for (const topic of ["@health", "@brains", "@hold"]) on(topic, paint);
  on("@hardware", () => shown && paintHardware());
  on("@brand", () => {
    relabel();
    paint();
  });
  relabel();

  return {
    enter() {
      shown = true;
      paint();
    },
    leave() {
      shown = false;
    },
  };
}
