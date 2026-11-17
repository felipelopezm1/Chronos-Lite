// A request that waits as long as the answer takes.
//
// Node's built-in fetch gives up when no response headers have come within
// five minutes (and again when the body is silent for five), and offers no way
// to say otherwise without a dependency. A governed brain can need longer than
// that for one answer: on 2026-11-14 the 27B read a 1,568-token prompt at 3
// tokens a second under the governor, and at 300 s the request was cut off and
// the brain's work thrown away ("fetch failed"). node:http has no such clock.
//
// request() answers a small Response-like: { ok, status, headers, body, json(), text() }.
// `body` is the response stream itself, an async iterable of bytes, so
// runtime/stream.mjs's sseData reads it as it reads a fetch body.

import http from "node:http";

/**
 * One HTTP request to a server on this computer, with no time limit of its
 * own; `signal` (an AbortSignal) is the only thing that ends it early.
 * `body` is sent as JSON when given. Rejects when the server cannot be reached.
 */
export function request(method, url, body, { signal, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        // one connection per request: a kept-alive socket that the server closed while a long answer ran is a reset
        agent: false,
        headers: { accept: "application/json", ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers },
        signal,
      },
      (res) => {
        const text = async () => {
          const chunks = [];
          for await (const c of res) chunks.push(c);
          return Buffer.concat(chunks).toString("utf8");
        };
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          body: res,
          text,
          json: async () => JSON.parse(await text()),
        });
      },
    );
    req.on("error", reject);
    req.end(data ?? undefined);
  });
}

/** POST JSON and wait for the answer, however long it takes. */
export const postJson = (url, body, opts) => request("POST", url, body, opts);
