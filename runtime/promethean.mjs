// One Promethean: a worker on a small brain with its own context and tools.
// It tries a task, reports, or falls; the caller (runtime/quests.mjs) splits a
// fallen one into two Offspring.
//
// Input: { id, task, rubric, tier: "promethean"|"offspring", parent, depth,
//          budget: { tries, maxTurns, ctxTokens }, state }
// Report: { status: done|partial|blocked|fell, verified, inferred, files,
//           open, caught, summary, work, usage }
//
// The loop: system = persona + tier rules + rubric; the brain is called with
// the tools; every call is validated (an invalid one is sent back once with
// its error before it counts a try) and executed; it stops on a final report.
// It falls when the context budget is spent, the tries run out, or the brain
// answers with a line starting "FALL:".
//
// Events on the bus: agent.spawned, log, agent.done.

export const DEFAULT_BUDGET = { tries: 3, maxTurns: 12, ctxTokens: 6000 };

export const REPORT_STATUSES = ["done", "partial", "blocked", "fell"];

let seq = 0;
/** wisp:cp-<4 base36>-<n> for Prometheans, co- for Offspring, ck- for Chronos. */
export function agentId(tier, tag) {
  const prefix = tier === "promethean" ? "cp" : tier === "offspring" ? "co" : "ck";
  tag = tag ?? Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");
  return `wisp:${prefix}-${tag}-${++seq}`;
}

/** Reset the counter (tests). */
export function resetIds() {
  seq = 0;
}

export const TIER_RULES = {
  promethean: `You are a Promethean: a worker with your own tools and a short context. Do the task, nothing beyond it.
Work in small steps: one tool call per turn, read before you write, check after you write.
When the task is done, or you cannot go further, answer with no tool call and only the report JSON.
If the task is clearly too big for your context or tools, answer with a single line starting "FALL:" and what you managed so far; two smaller workers will take the halves.`,
  offspring: `You are an Offspring: a small, fast worker given half of a task a bigger worker could not finish, with its partial work as your starting state.
Do only your half. One tool call per turn. When done, answer with no tool call and only the report JSON.
If even your half is too big, answer with a single line starting "FALL:" and what you managed.`,
};

export const REPORT_FORMAT = `The report is one JSON object and nothing else:
{"status": "done" | "partial" | "blocked",
 "summary": "what you did, in two or three sentences",
 "verified": ["what you checked with a tool"],
 "inferred": ["what you believe but did not check"],
 "files": ["files you wrote or edited"],
 "open": ["questions left"],
 "caught": ["mistakes you made and fixed, or bugs you found"]}`;

/** The system prompt of a worker. */
export function systemPrompt({ persona = "", tier = "promethean", rubric = [], rules = "" } = {}) {
  const rubricText = rubric?.length ? `The report is judged against this rubric:\n${rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")}` : "";
  return [persona.trim(), rules.trim(), TIER_RULES[tier] ?? TIER_RULES.promethean, rubricText, REPORT_FORMAT].filter(Boolean).join("\n\n");
}

/** A rough token count when the server sends no usage. */
export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    chars += (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")).length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4);
}

/** Find the report JSON in a reply: a fenced block, else the outermost braces. */
export function parseReport(text) {
  if (typeof text !== "string") return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object" && typeof v.status === "string") return v;
    } catch {
      /* try the next */
    }
  }
  return null;
}

const list = (v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v.trim() ? [v] : []);

/** A report in the fixed shape, whatever the model sent. */
export function normalizeReport(raw, { files = [], work = [], usage = null } = {}) {
  const status = REPORT_STATUSES.includes(raw?.status) ? raw.status : "partial";
  return {
    status,
    summary: String(raw?.summary ?? raw?.text ?? "").trim() || "(no summary)",
    verified: list(raw?.verified),
    inferred: list(raw?.inferred),
    files: [...new Set([...list(raw?.files), ...files])],
    open: list(raw?.open),
    caught: list(raw?.caught),
    work,
    usage,
  };
}

/**
 * Run one worker. `chat(messages, { tools, maxTokens })` is the brain (the
 * real one is brains.chat bound to a brain id); `tools` is createTools().
 */
export async function runPromethean({
  id,
  task,
  rubric = [],
  tier = "promethean",
  parent = null,
  depth = 0,
  budget = {},
  state = "",
  persona = "",
  rules = "",
  brain = null,
  quest = null,
  chat,
  tools,
  bus = { emit() {} },
  signal = null,
  maxTokens = 1024,
}) {
  if (typeof chat !== "function") throw new Error("a Promethean needs a chat function");
  if (!tools?.call) throw new Error("a Promethean needs tools");
  const b = { ...DEFAULT_BUDGET, ...budget };
  id = id ?? agentId(tier);
  const files = new Set();
  const work = [];
  let usage = { prompt: 0, completion: 0 };
  let tries = 0;
  let fellWhy = null;
  // an engine failure (the brain down, a refused request) blocks the worker; it never splits the task
  let blockedWhy = null;

  bus.emit("agent.spawned", { id, kind: "wisp", arm: "chronos", vendor: "chronos", tier, parent, brain, task, depth, quest });
  const log = (text) => bus.emit("log", { id, quest, text });

  const messages = [
    { role: "system", content: systemPrompt({ persona, tier, rubric, rules }) },
    { role: "user", content: state ? `Task:\n${task}\n\nStarting state (a bigger worker's partial work):\n${state}` : `Task:\n${task}` },
  ];

  const contextSpent = (u) => {
    const used = u?.total_tokens ?? (u?.prompt_tokens ?? 0) + (u?.completion_tokens ?? 0);
    const n = used || estimateTokens(messages);
    return n >= b.ctxTokens ? n : 0;
  };

  let report = null;
  for (let turn = 1; turn <= b.maxTurns && !report && !fellWhy && !blockedWhy; turn++) {
    if (signal?.aborted) {
      fellWhy = "stopped";
      break;
    }
    let reply;
    try {
      reply = await chat(messages, { tools: tools.schemas, maxTokens, thinking: false });
    } catch (err) {
      tries++;
      log(`the brain failed: ${err?.message ?? err} (try ${tries}/${b.tries})`);
      if (tries >= b.tries) blockedWhy = `the brain failed ${tries} times: ${err?.message ?? err}`;
      continue;
    }
    if (reply?.usage) {
      usage = { prompt: (usage.prompt ?? 0) + (reply.usage.prompt_tokens ?? 0), completion: (usage.completion ?? 0) + (reply.usage.completion_tokens ?? 0) };
    }
    const content = typeof reply?.content === "string" ? reply.content : "";
    const calls = Array.isArray(reply?.toolCalls) ? reply.toolCalls : [];

    const spent = contextSpent(reply?.usage);
    if (spent) {
      fellWhy = `the context budget is spent (${spent} of ${b.ctxTokens} tokens)`;
      break;
    }

    if (!calls.length && /^\s*FALL:/m.test(content)) {
      fellWhy = `the brain says it is too big: ${content.replace(/^[\s\S]*?FALL:\s*/, "").trim().slice(0, 400)}`;
      break;
    }

    if (calls.length) {
      messages.push({ role: "assistant", content: content || null, tool_calls: calls.map((c, i) => ({ id: c.id ?? `call_${turn}_${i}`, type: "function", function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) } })) });
      let invalid = 0;
      for (const [i, c] of calls.entries()) {
        const callId = c.id ?? `call_${turn}_${i}`;
        const v = tools.validate(c);
        if (!v.ok) {
          invalid++;
          const already = work.some((w) => w.invalid && w.name === c.name && w.error === v.error);
          if (already) tries++;
          work.push({ name: c.name, invalid: true, error: v.error });
          log(`${c.name}: refused: ${v.error}${already ? ` (try ${tries}/${b.tries})` : ""}`);
          messages.push({ role: "tool", tool_call_id: callId, name: c.name, content: `error: ${v.error}. Fix the call and try again.` });
          continue;
        }
        const out = await tools.call(c);
        if (v.name === "write_file" || v.name === "edit_file") files.add(v.args.path);
        work.push({ name: v.name, args: v.args, ok: out.ok, out: out.text.slice(0, 200) });
        log(`${v.name} ${summarizeArgs(v.args)} -> ${out.ok ? "ok" : out.text.split("\n")[0].slice(0, 120)}`);
        messages.push({ role: "tool", tool_call_id: callId, name: v.name, content: out.text });
      }
      if (tries >= b.tries) fellWhy = `the tries ran out after ${tries} refused calls`;
      continue;
    }

    const parsed = parseReport(content);
    if (parsed) {
      report = normalizeReport(parsed, { files: [...files], work, usage });
      break;
    }
    tries++;
    log(`no report in the answer (try ${tries}/${b.tries})`);
    if (tries >= b.tries) {
      fellWhy = `no report after ${tries} tries`;
      break;
    }
    messages.push({ role: "assistant", content });
    messages.push({ role: "user", content: `That was not a report. Either call a tool, or answer with only the report JSON:\n${REPORT_FORMAT}` });
  }

  if (!report && blockedWhy) {
    report = normalizeReport({ status: "blocked", summary: `BLOCKED: ${blockedWhy}` }, { files: [...files], work, usage });
    report.why = blockedWhy;
  }
  if (!report && !fellWhy) fellWhy = `the turns ran out (${b.maxTurns})`;
  if (!report) {
    report = normalizeReport({ status: "fell", summary: `FALL: ${fellWhy}` }, { files: [...files], work, usage });
    report.why = fellWhy;
  }
  report.id = id;
  report.tier = tier;
  report.depth = depth;
  report.parent = parent;
  report.brain = brain;
  report.task = task;
  bus.emit("agent.done", { id, status: report.status, tier, parent, quest, summary: report.summary.slice(0, 300), files: report.files });
  return report;
}

function summarizeArgs(args) {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(String(v).slice(0, 60))}`)
    .join(" ");
}

/** The partial work of a fallen worker as text the children start from. */
/** the most a fallen worker hands down, in characters (~1000 tokens): the Offspring's context is 4096 a slot */
export const STATE_MAX_CHARS = 4000;

export function partialState(report, max = STATE_MAX_CHARS) {
  const clip = (t, n) => (String(t).length > n ? `${String(t).slice(0, n)}...` : String(t));
  const lines = [];
  if (report.why) lines.push(`Why the parent fell: ${clip(report.why, 400)}`);
  if (report.files?.length) lines.push(`Files it touched: ${report.files.join(", ")}`);
  const steps = (report.work ?? []).filter((w) => !w.invalid).slice(-12);
  if (steps.length) lines.push("What it did:", ...steps.map((w) => `- ${w.name} ${clip(summarizeArgs(w.args ?? {}), 200)}: ${w.ok ? "ok" : clip(w.out, 200)}`));
  // A tool's output can be long (a glob, a file): keep the newest lines inside the budget.
  let out = lines.join("\n");
  while (out.length > max && lines.length > 3) {
    lines.splice(2, 1);
    out = lines.join("\n");
  }
  return out.length > max ? out.slice(0, max) : out;
}

/**
 * Split a task in two. Asks `chat` for {"a": "...", "b": "..."}; when the
 * brain cannot, splits the task by its sentences or lines, else by halves.
 */
export async function splitTask({ task, report = null, chat = null }) {
  if (typeof chat === "function") {
    try {
      const reply = await chat(
        [
          { role: "system", content: "You split one task into two halves of similar size that can be done one after the other. Answer with only JSON: {\"a\": \"the first half\", \"b\": \"the second half\"}." },
          { role: "user", content: `Split this task:\n${task}${report?.why ? `\n\nA worker fell on it: ${report.why}` : ""}` },
        ],
        { maxTokens: 400, thinking: false },
      );
      const a = reply?.content?.indexOf("{") ?? -1;
      const z = reply?.content?.lastIndexOf("}") ?? -1;
      if (a >= 0 && z > a) {
        const v = JSON.parse(reply.content.slice(a, z + 1));
        if (typeof v.a === "string" && typeof v.b === "string" && v.a.trim() && v.b.trim()) return [v.a.trim(), v.b.trim()];
      }
    } catch {
      /* fall through to the plain split */
    }
  }
  const parts = task
    .split(/\n+|(?<=[.;])\s+|\s+(?:and then|then|and)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const mid = Math.ceil(parts.length / 2);
    return [parts.slice(0, mid).join(" "), parts.slice(mid).join(" ")];
  }
  return [`First half of: ${task}`, `Second half of: ${task} (the first half is done by another worker)`];
}
