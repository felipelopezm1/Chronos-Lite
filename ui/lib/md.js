// A tiny Markdown renderer for answers and reports: paragraphs, headings,
// lists with square accent bullets, task checks, code blocks, quotes, rules,
// simple tables and the inline marks (code, bold, emphasis, links). It builds
// DOM nodes and never sets innerHTML, so nothing a brain writes can become
// markup. A text that stops mid-way (a stream) renders as far as it goes: an
// open code fence is a code block to the end, an unclosed mark stays literal.

import { h } from "./dom.js";

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const TASK = /^\[( |x|X)\]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Only links that go somewhere safe become anchors. */
function safeHref(url) {
  return /^(https?:\/\/|#|\/(?!\/))/i.test(url) ? url : null;
}

/** The inline marks of one run of text, as nodes. */
export function inline(text) {
  const out = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(document.createTextNode(buf));
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length && /[\\`*_[\]()#>-]/.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push(h("code", text.slice(i + 1, end)));
        i = end + 1;
        continue;
      }
    }
    if ((c === "*" || c === "_") && text[i + 1] === c) {
      const end = text.indexOf(c + c, i + 2);
      if (end > i + 2) {
        flush();
        out.push(h("strong", ...inline(text.slice(i + 2, end))));
        i = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && text[i + 1] !== " " && text[i + 1] !== c && (c === "*" || !/\w/.test(text[i - 1] ?? ""))) {
      const end = text.indexOf(c, i + 1);
      if (end > i + 1 && text[end - 1] !== " " && (c === "*" || !/\w/.test(text[end + 1] ?? ""))) {
        flush();
        out.push(h("em", ...inline(text.slice(i + 1, end))));
        i = end + 1;
        continue;
      }
    }
    if (c === "[") {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (m) {
        flush();
        const href = safeHref(m[2]);
        out.push(href ? h("a", { href, target: href.startsWith("#") ? null : "_blank", rel: "noopener noreferrer" }, ...inline(m[1])) : h("span.md-nolink", { title: m[2] }, ...inline(m[1])));
        i += m[0].length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** One list (and the lists nested under its items) from the lines at index i; returns [node, next index]. */
function list(lines, i, indent) {
  const ordered = ORDERED.test(lines[i]);
  const el = h(ordered ? "ol" : "ul");
  let li = null;
  while (i < lines.length) {
    const line = lines[i];
    const m = BULLET.exec(line) ?? ORDERED.exec(line);
    if (!m) {
      // a continuation line of the item above (indented text), else the list ends
      if (li && /^\s+\S/.test(line) && !FENCE.test(line)) {
        li.append(" ", ...inline(line.trim()));
        i++;
        continue;
      }
      break;
    }
    const depth = m[1].length;
    if (depth < indent) break;
    if (depth > indent + 1 && li) {
      const [sub, next] = list(lines, i, depth);
      li.append(sub);
      i = next;
      continue;
    }
    const task = TASK.exec(m[3]);
    if (task) {
      const on = task[1] !== " ";
      li = h("li.md-task", h(`span.md-check${on ? ".on" : ""}`, { role: "img", "aria-label": on ? "done" : "not done" }), h("span", ...inline(task[2])));
    } else li = h("li", ...inline(m[3]));
    el.append(li);
    i++;
  }
  return [el, i];
}

function table(rows) {
  const cells = (line) => TABLE_ROW.exec(line)[1].split("|").map((c) => c.trim());
  const [head, , ...body] = rows;
  return h(
    "div.md-table",
    h(
      "table",
      h("thead", h("tr", ...cells(head).map((c) => h("th", ...inline(c))))),
      h("tbody", ...body.map((r) => h("tr", ...cells(r).map((c) => h("td", ...inline(c)))))),
    ),
  );
}

/** Markdown as a fragment of nodes. */
export function renderMarkdown(source) {
  const frag = document.createDocumentFragment();
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let para = [];
  const endPara = () => {
    if (!para.length) return;
    const p = h("p");
    para.forEach((line, k) => {
      if (k) p.append(document.createElement("br"));
      p.append(...inline(line));
    });
    frag.append(p);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      endPara();
      const body = [];
      i++;
      while (i < lines.length && !(FENCE.test(lines[i]) && lines[i].trim().startsWith(fence[1][0].repeat(3)) && !FENCE.exec(lines[i])[2])) body.push(lines[i++]);
      i++; // the closing fence, or past the end when the text stopped inside the block
      const text = body.join("\n");
      const copy = h("button.md-copy", { type: "button", title: "copy this code" }, "copy");
      copy.addEventListener("click", () => {
        navigator.clipboard?.writeText(text).then(
          () => {
            copy.textContent = "copied";
            setTimeout(() => (copy.textContent = "copy"), 1200);
          },
          () => (copy.textContent = "no clipboard"),
        );
      });
      frag.append(h("div.md-code", h("div.md-code-head", h("span", fence[2] || "code"), copy), h("pre", { tabindex: "0" }, h("code", text))));
      continue;
    }
    if (!line.trim()) {
      endPara();
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endPara();
      const level = heading[1].length;
      frag.append(h(`h${Math.min(6, level + 2)}.md-h.md-h${level}`, ...inline(heading[2])));
      i++;
      continue;
    }
    if (RULE.test(line) && !BULLET.test(line)) {
      endPara();
      frag.append(h("hr"));
      i++;
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      endPara();
      const m = BULLET.exec(line) ?? ORDERED.exec(line);
      const [el, next] = list(lines, i, m[1].length);
      frag.append(el);
      i = next;
      continue;
    }
    if (QUOTE.test(line)) {
      endPara();
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1]);
      frag.append(h("blockquote", renderMarkdown(body.join("\n"))));
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      endPara();
      const rows = [];
      while (i < lines.length && (TABLE_ROW.test(lines[i]) || (rows.length === 1 && TABLE_RULE.test(lines[i])))) rows.push(lines[i++]);
      frag.append(table(rows));
      continue;
    }
    para.push(line.trim());
    i++;
  }
  endPara();
  return frag;
}

/** The first plain sentence of a Markdown text, for a one-line summary. */
export function firstLine(source, max = 140) {
  const text = String(source ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/[#*_`>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
