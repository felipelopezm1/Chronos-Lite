// The bus: every event Chronos makes, kept in a short history and streamed to
// anyone who opens GET /events. The event shape is Hephaestus's HephEvent,
// { t: <ms epoch>, type: "<dotted.type>", ...data }, so Hephaestus's bridge can
// hear Chronos with the same code it uses for its own cities.
//
// Every event also carries n, a sequence number counted here from 1 each time
// the service starts (Lite has no ledger: a restart forgets). An SSE block is
// "id: <n>\ndata: <json>\n\n"; GET /events?since=<n> (or the Last-Event-ID
// header a browser sends when it reconnects) replays what came after n from
// the in-memory ring of the last HISTORY_MAX events, before it streams live.

import { EventEmitter } from "node:events";

/**
 * Event types streamed and heard but never kept in the ring: the hardware sense
 * reads the box every 2 s, and kept it would push a quest's events out of a
 * 2000-event ring in about an hour, so a caller's ?since=n could no longer
 * replay them.
 */
export const VOLATILE = new Set(["hardware.read"]);

/** how many events the bus remembers for a late listener */
export const HISTORY_MAX = 2000;

/** how often a keep-alive comment goes down an open stream */
export const PING_MS = 15_000;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * True when the request comes from this computer: no Origin header (curl, a
 * script, another runtime) or a page served from localhost on any port.
 * Any other page open in the browser is refused, else it could drive Chronos.
 */
export function trustedOrigin(req) {
  const origin = req?.headers?.origin;
  if (!origin) return true;
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** The CORS headers a trusted browser page gets back; none for anyone else. */
export function corsHeaders(req) {
  const origin = req?.headers?.origin;
  if (!origin || !trustedOrigin(req)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, last-event-id",
    Vary: "Origin",
  };
}

/** One event as an SSE block: its n as the id, then the JSON. */
export function sseBlock(ev) {
  return `${Number.isFinite(ev?.n) ? `id: ${ev.n}\n` : ""}data: ${JSON.stringify(ev)}\n\n`;
}

/** The n a listener says it has seen: ?since=<n>, else the Last-Event-ID header; null when it names none. */
export function sinceOf(req) {
  let raw = null;
  try {
    raw = new URL(req?.url ?? "/", "http://chronos").searchParams.get("since");
  } catch {
    /* an odd url: no since */
  }
  if (raw === null || raw === "") raw = req?.headers?.["last-event-id"] ?? null;
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export class Bus extends EventEmitter {
  /** the last HISTORY_MAX events, oldest first */
  history = [];
  /** the open SSE responses */
  clients = new Set();
  /** the n of the newest event */
  n = 0;

  constructor({ pingMs = PING_MS, historyMax = HISTORY_MAX, volatile = VOLATILE } = {}) {
    super();
    this.pingMs = pingMs;
    this.historyMax = historyMax;
    this.volatile = volatile;
  }

  /**
   * Put one event on the bus: emit("brain.ready", { id }) becomes
   * { n, t, type: "brain.ready", id }. A whole event object is taken too.
   * Listeners hear it under its type and under "event". A volatile type
   * (chat.delta) is streamed and heard but not kept.
   */
  emit(type, data = {}) {
    const whole = typeof type === "object" && type !== null;
    const ev = whole ? { n: 0, t: Date.now(), type: type.type, ...type } : { n: 0, t: Date.now(), type, ...data };
    if (!whole) ev.type = type;
    ev.n = this.n = this.n + 1;
    if (!this.volatile.has(ev.type)) {
      this.history.push(ev);
      if (this.history.length > this.historyMax) this.history.splice(0, this.history.length - this.historyMax);
    }
    const line = sseBlock(ev);
    for (const res of this.clients) {
      try {
        res.write(line);
      } catch {
        this.clients.delete(res);
      }
    }
    super.emit(ev.type, ev);
    super.emit("event", ev);
    return true;
  }

  /** What a listener who has seen n is owed: the ring's events after n (older ones have left the ring). */
  after(n) {
    return this.history.filter((e) => e.n > n);
  }

  /**
   * Serve one GET /events: headers, the replay, then every event as it comes,
   * with a comment every pingMs so proxies and browsers keep the line open.
   * The replay is what came after ?since=<n> (or Last-Event-ID); without
   * either, the history.
   */
  sse(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(req),
    });
    res.write(": chronos\n\n");
    const since = sinceOf(req);
    for (const ev of since === null ? this.history : this.after(since)) res.write(sseBlock(ev));
    this.clients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        close();
      }
    }, this.pingMs);
    ping.unref?.();
    const close = () => {
      clearInterval(ping);
      this.clients.delete(res);
    };
    req.on("close", close);
    res.on("close", close);
    res.on("error", close);
  }

  /** End every open stream (at shutdown). */
  closeAll() {
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
  }
}
