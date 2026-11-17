import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { postJson, request } from "./post.mjs";
import { sseData } from "./stream.mjs";

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))) };
}

test("postJson sends JSON and reads the answer; a refusal is not ok and still carries its body", async () => {
  const s = await serve((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const sent = body ? JSON.parse(body) : {}; // a GET sends no body
      res.writeHead(sent.bad ? 400 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(sent.bad ? { error: { message: "no" } } : { echo: sent, type: req.headers["content-type"], length: req.headers["content-length"] }));
    });
  });
  try {
    const ok = await postJson(`${s.url}/v1/chat/completions`, { hello: "wörld" });
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 200);
    const got = await ok.json();
    assert.deepEqual(got.echo, { hello: "wörld" });
    assert.equal(got.type, "application/json");
    assert.equal(Number(got.length), Buffer.byteLength(JSON.stringify({ hello: "wörld" })), "the length is in bytes, not characters");

    const bad = await postJson(`${s.url}/x`, { bad: true });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: { message: "no" } });

    const got2 = await request("GET", `${s.url}/anything`);
    assert.equal(got2.status, 200);
  } finally {
    await s.close();
  }
});

test("a streamed answer is read as it arrives, through sseData", async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"n":1}\n\n');
    setTimeout(() => res.write('data: {"n":2}\n\n'), 60);
    // the end comes well after the first chunk, so a first chunk that arrives late on a slow runner still shows it
    setTimeout(() => res.end("data: [DONE]\n\n"), 300);
  });
  try {
    const res = await postJson(`${s.url}/stream`, { stream: true });
    const seen = [];
    const at = [];
    const t0 = Date.now();
    for await (const data of sseData(res.body)) {
      seen.push(data);
      at.push(Date.now() - t0);
    }
    assert.deepEqual(seen, ['{"n":1}', '{"n":2}', "[DONE]"]);
    assert.ok(at[2] - at[0] >= 80, "the first chunk came before the stream ended");
  } finally {
    await s.close();
  }
});

test("it carries no clock of its own: a slow answer is waited for, and only the signal ends it early", async () => {
  // the socket has no timeout set: fetch's five-minute limit is a timer on the request, and this has none
  const s = await serve((req, res) => {
    req.resume();
    if (req.url === "/slow") setTimeout(() => (res.writeHead(200, { "content-type": "application/json" }), res.end('{"late":true}')), 700);
    // "/never" answers nothing
  });
  try {
    const t0 = Date.now();
    const slow = await postJson(`${s.url}/slow`, {});
    assert.deepEqual(await slow.json(), { late: true });
    assert.ok(Date.now() - t0 >= 650);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(postJson(`${s.url}/never`, {}, { signal: ac.signal }), (err) => err.name === "AbortError");
  } finally {
    await s.close();
  }
});

test("a server that is not there is an error, not a hang", async () => {
  await assert.rejects(postJson("http://127.0.0.1:9/none", {}), (err) => /ECONNREFUSED|connect/i.test(String(err.code ?? err.message)));
});
