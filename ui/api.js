// Talking to the service: plain fetch for the routes, and one event stream that
// comes back after a drop with ?since=<the last n seen>, so nothing is missed.

const TIMEOUT_MS = 8000;

export async function call(method, path, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method,
      signal: ac.signal,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* an empty or non-JSON answer */
    }
    if (!res.ok) {
      const err = new Error(data?.error || `${method} ${path} answered ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === "AbortError") throw Object.assign(new Error("The service took too long to answer."), { status: 0 });
    if (err.status === undefined) err.status = 0;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  health: () => call("GET", "/health"),
  capabilities: () => call("GET", "/capabilities"),
  edition: () => call("GET", "/edition"),
  /** GET /quests: {quests, counts}; a bare array is taken too */
  list: () => call("GET", "/quests").then((r) => (Array.isArray(r) ? { quests: r, counts: null } : { quests: r?.quests ?? [], counts: r?.counts ?? null })),
  quest: (id) => call("GET", `/quests/${encodeURIComponent(id)}`),
  send: (task, size) => call("POST", "/quests", { task, size, by: "ui" }),
  stop: (id) => call("POST", `/quests/${encodeURIComponent(id)}/stop`),
};

/**
 * Follow GET /events. onEvent gets each event once, in order of n; onState gets
 * "connecting" | "live" | "reconnecting". After a drop it waits (1 s, doubling to
 * 15 s) and opens /events?since=<last n> again.
 */
export function followEvents({ onEvent, onState }) {
  let last = 0;
  let es = null;
  let wait = 1000;
  let timer = null;
  let closed = false;

  const open = () => {
    if (closed) return;
    onState(last ? "reconnecting" : "connecting");
    es = new EventSource(`/events?since=${last}`);
    es.onopen = () => {
      wait = 1000;
      onState("live");
    };
    es.onmessage = (m) => {
      let ev;
      try {
        ev = JSON.parse(m.data);
      } catch {
        return;
      }
      const n = Number(ev?.n);
      if (Number.isFinite(n)) {
        if (n <= last) return;
        last = n;
      }
      onEvent(ev);
    };
    es.onerror = () => {
      // the browser would retry by itself with Last-Event-ID; this takes over so ?since= is explicit
      es.close();
      es = null;
      onState("reconnecting");
      clearTimeout(timer);
      timer = setTimeout(open, wait);
      wait = Math.min(wait * 2, 15000);
    };
  };

  open();
  return {
    get last() {
      return last;
    },
    retryNow() {
      clearTimeout(timer);
      es?.close();
      wait = 1000;
      open();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      es?.close();
    },
  };
}
