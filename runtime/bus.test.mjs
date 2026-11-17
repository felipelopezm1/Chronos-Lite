import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Bus, trustedOrigin, corsHeaders } from "./bus.mjs";

test("emit stamps t and type and keeps the data", () => {
  const bus = new Bus();
  const heard = [];
  bus.on("brain.ready", (ev) => heard.push(ev));
  bus.on("event", (ev) => heard.push(ev));
  const before = Date.now();
  bus.emit("brain.ready", { id: "qwen3.5-9b", slot: "talk" });
  assert.equal(heard.length, 2);
  const ev = heard[0];
  assert.equal(ev.type, "brain.ready");
  assert.equal(ev.id, "qwen3.5-9b");
  assert.equal(ev.slot, "talk");
  assert.ok(ev.t >= before && ev.t <= Date.now());
  assert.deepEqual(bus.history, [ev]);
});

test("a whole event object is taken too and the type wins over data", () => {
  const bus = new Bus();
  bus.emit({ type: "log", text: "hi" });
  bus.emit("log", { type: "wrong", text: "there" });
  assert.equal(bus.history[0].type, "log");
  assert.equal(bus.history[1].type, "log");
  assert.equal(bus.history[1].text, "there");
});

test("history keeps only the last events", () => {
  const bus = new Bus({ historyMax: 5 });
  for (let i = 0; i < 12; i++) bus.emit("log", { i });
  assert.equal(bus.history.length, 5);
  assert.deepEqual(
    bus.history.map((e) => e.i),
    [7, 8, 9, 10, 11],
  );
});

test("trustedOrigin: none, localhost on any port, 127.0.0.1; a foreign origin is refused", () => {
  const req = (origin) => ({ headers: origin === undefined ? {} : { origin } });
  assert.equal(trustedOrigin(req(undefined)), true);
  assert.equal(trustedOrigin(req("http://localhost:5173")), true);
  assert.equal(trustedOrigin(req("http://127.0.0.1:7777")), true);
  assert.equal(trustedOrigin(req("http://[::1]:7777")), true);
  assert.equal(trustedOrigin(req("https://evil.example")), false);
  assert.equal(trustedOrigin(req("not a url")), false);
  assert.deepEqual(corsHeaders(req("https://evil.example")), {});
  assert.equal(corsHeaders(req("http://localhost:5173"))["Access-Control-Allow-Origin"], "http://localhost:5173");
});

test("sse replays history then streams new events", async () => {
  const bus = new Bus({ pingMs: 50 });
  bus.emit("log", { text: "before" });
  const server = http.createServer((req, res) => bus.sse(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const events = [];
  let sawPing = false;
  const req = http.get({ host: "127.0.0.1", port, path: "/events", headers: { origin: "http://localhost:5173" } });
  const res = await new Promise((r) => req.on("response", r));
  assert.equal(res.headers["content-type"], "text/event-stream");
  assert.equal(res.headers["cache-control"], "no-cache");
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:5173");

  const done = new Promise((resolve) => {
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (line === ": ping") sawPing = true;
        const data = line.split("\n").find((l) => l.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
      if (events.length >= 2 && sawPing) resolve();
    });
  });
  // the live event goes out once the stream is open
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bus.clients.size, 1);
  bus.emit("log", { text: "after" });
  await done;
  assert.deepEqual(
    events.map((e) => e.text),
    ["before", "after"],
  );

  req.destroy();
  // the server hears of the close when it hears of it: a slow runner takes longer than a few ms
  for (const until = Date.now() + 2000; bus.clients.size && Date.now() < until; ) await new Promise((r) => setTimeout(r, 10));
  assert.equal(bus.clients.size, 0, "a closed stream is forgotten");
  await new Promise((r) => server.close(r));
});
