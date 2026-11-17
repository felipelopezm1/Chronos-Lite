// Reading a streamed answer: the "data:" lines of a Server-Sent Events body
// (llama-server's /v1/chat/completions with stream: true), and the split of
// text from thinking when a brain writes its thinking inline between <think>
// and </think> (the brains launched with --reasoning-format none).

/** Every "data:" payload of an SSE body (a web ReadableStream or any async iterable of bytes), as it arrives. */
export async function* sseData(body) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) yield line.slice(5).replace(/^ /, "");
    }
  }
  buf += dec.decode();
  const last = buf.replace(/\r$/, "");
  if (last.startsWith("data:")) yield last.slice(5).replace(/^ /, "");
}

const OPEN = "<think>";
const CLOSE = "</think>";

/**
 * A splitter for text that may carry <think>...</think>: push(chunk) returns
 * the parts it can already tell apart, [{text} | {thinking}], and holds back
 * the tail that may be the start of a tag; end() gives what was held.
 */
export function thinkSplitter() {
  let inside = false;
  let hold = "";
  const part = (t) => (inside ? { thinking: t } : { text: t });
  function push(chunk) {
    const out = [];
    let buf = hold + String(chunk ?? "");
    hold = "";
    for (;;) {
      const tag = inside ? CLOSE : OPEN;
      const i = buf.indexOf(tag);
      if (i >= 0) {
        if (i > 0) out.push(part(buf.slice(0, i)));
        buf = buf.slice(i + tag.length);
        inside = !inside;
        continue;
      }
      let keep = 0;
      for (let k = Math.min(tag.length - 1, buf.length); k > 0; k--) {
        if (tag.startsWith(buf.slice(-k))) {
          keep = k;
          break;
        }
      }
      if (buf.length > keep) out.push(part(buf.slice(0, buf.length - keep)));
      hold = keep ? buf.slice(-keep) : "";
      return out;
    }
  }
  function end() {
    const t = hold;
    hold = "";
    return t ? [part(t)] : [];
  }
  return { push, end };
}

/** An answer without its inline thinking: {content, thinking}. */
export function splitThinking(text) {
  const s = thinkSplitter();
  let content = "";
  let thinking = "";
  for (const p of [...s.push(text), ...s.end()]) {
    if (p.text) content += p.text;
    if (p.thinking) thinking += p.thinking;
  }
  return { content: thinking ? content.replace(/^\s+/, "") : content, thinking };
}
