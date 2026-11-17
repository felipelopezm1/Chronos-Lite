// What Chronos Lite is and can do, in one small manifest (GET /capabilities)
// and one white-label card (GET /edition). Written fresh for Lite: full
// Chronos's manifest reaches every part it has; this one is built from
// lite/edition.json, lite/brand.json and package.json, with the brains and the
// sizes as they are right now.
//
// The hash is over the parts that change what a caller can ask (the routes,
// the sizes, the brains present, the caps), not over statuses that change
// every second, so a reader fetches the manifest again only when it matters.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TOOL_NAMES } from "./tools.mjs";
import { describeSizes, CUT_SIZES } from "./sizes.mjs";

/** the manifest's shape, for a reader to check */
export const SCHEMA = "chronos-lite.capabilities/1";

/** the routes this service answers, as GET /capabilities lists them (docs/runtime-api.md) */
export const ROUTES = [
  { method: "GET", path: "/health", what: "who this is, the brains, the sizes, the card lock, the queue" },
  { method: "GET", path: "/capabilities", what: "this manifest" },
  { method: "GET", path: "/edition", what: "the white label and the caps" },
  { method: "GET", path: "/events", what: "the bus as Server-Sent Events; ?since=n replays from the in-memory ring" },
  { method: "GET", path: "/quests", what: "the quests this run knows, newest first, without reports" },
  { method: "POST", path: "/quests", what: "{task, by?, size?, budget?} -> 202 {id, status, size, tier}; idempotency-key header" },
  { method: "GET", path: "/quests/:id", what: "one quest with its report" },
  { method: "POST", path: "/quests/:id/stop", what: "the workers halt between turns" },
  { method: "GET", path: "/", what: "the UI's static files under ui/, when there are any" },
];

/** the event types the bus carries (docs/runtime-api.md says each one's payload) */
export const EVENT_TYPES = [
  "quest.queued",
  "quest.started",
  "quest.running",
  "quest.phase",
  "quest.done",
  "agent.spawned",
  "agent.split",
  "agent.done",
  "log",
  "brain.loading",
  "brain.waiting",
  "brain.ready",
  "brain.failed",
  "brain.stopped",
  "brain.switched",
  "heat.cutoff",
  "heat.clear",
  "hardware.read",
];

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

/**
 * The edition as files say it, read once: { edition, brand, version }. A
 * missing file reads as empty, so a stripped copy still answers.
 */
export function readEdition(root) {
  const edition = readJson(path.join(root, "lite", "edition.json"), {});
  const brand = readJson(path.join(root, "lite", "brand.json"), {});
  const pkg = readJson(path.join(root, "package.json"), {});
  return { edition, brand, version: pkg.version ?? edition.version ?? null };
}

/** the caps as GET /edition and GET /capabilities give them */
export function capsOf(edition = {}) {
  return {
    brains: edition.brains?.max ?? null,
    sizes: edition.sizes ?? null,
    cards: edition.cards ?? null,
    turns: edition.quest?.maxTurns ?? null,
    splitDepth: edition.quest?.splitDepth ?? null,
    tools: edition.tools?.max ?? null,
  };
}

/** GET /edition: the white label, the version and the caps */
export function editionCard({ edition = {}, brand = {}, version = null } = {}) {
  return {
    name: brand.name ?? edition.name ?? "Chronos Lite",
    shortName: brand.shortName ?? "Lite",
    accent: brand.accent ?? null,
    logo: brand.logo ?? null,
    builtOn: brand.builtOn ?? "built on Chronos",
    version,
    caps: capsOf(edition),
  };
}

/**
 * The manifest of this service. Every argument but root is a function or a
 * value read each time, so the manifest is always the live one.
 */
export function createCapabilities({ root, commit = null, port = () => null, brains = null, tiers = null, card = () => null, governor = () => null, info = readEdition(root) } = {}) {
  const list = () => (brains?.list?.() ?? []).filter((b) => !b.alternate);
  const stable = () => {
    const l = list();
    return {
      schema: SCHEMA,
      kind: "chronos",
      edition: "lite",
      version: info.version,
      routes: ROUTES.map((r) => `${r.method} ${r.path}`),
      sizes: info.edition.sizes ?? Object.keys(describeSizes({ tiers, list: l })),
      cutSizes: CUT_SIZES,
      caps: capsOf(info.edition),
      tools: TOOL_NAMES,
      events: EVENT_TYPES,
      brains: l.map((b) => ({ id: b.id, role: b.role ?? null, slot: b.slot ?? null, device: b.device ?? null, present: b.present !== false })),
    };
  };
  const hash = () => createHash("sha256").update(JSON.stringify(stable())).digest("hex").slice(0, 12);
  return {
    hash,
    manifest() {
      const l = list();
      return {
        ...stable(),
        hash: hash(),
        name: info.brand.name ?? "Chronos Lite",
        builtOn: info.brand.builtOn ?? "built on Chronos",
        commit,
        port: typeof port === "function" ? port() : port,
        routes: ROUTES,
        sizes: describeSizes({ tiers, list: l }),
        brains: l.map((b) => ({ id: b.id, role: b.role ?? null, slot: b.slot ?? null, device: b.device ?? null, present: b.present !== false, status: b.status ?? null })),
        card: card(),
        governor: governor(),
        cut: info.edition.cut ?? [],
        hiredBy: info.edition.hiredBy ?? null,
      };
    },
  };
}
