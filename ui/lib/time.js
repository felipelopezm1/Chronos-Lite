// Times as the UI says them: a clock, a span, how long ago, a day.

const pad = (n) => String(n).padStart(2, "0");

/** 14:03:27 */
export function hms(t) {
  if (!t) return "";
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 14:03 */
export function hm(t) {
  if (!t) return "";
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A span: 840 ms, 4.2 s, 3 m 12 s, 1 h 04 m */
export function dur(ms) {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${pad(Math.round(s % 60))} s`;
  return `${Math.floor(m / 60)} h ${pad(m % 60)} m`;
}

/** How long ago: now, 40 s, 12 m, 3 h, 2 d */
export function ago(t, now = Date.now()) {
  if (!t) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} m`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

/** The local day of a time as YYYY-MM-DD (the ledger's file name). */
export function dayOf(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** A ledger day as words: today, yesterday, or "wed 11 nov". */
export function dayLabel(day, now = Date.now()) {
  if (day === dayOf(now)) return "today";
  if (day === dayOf(now - 86_400_000)) return "yesterday";
  const [y, m, d] = String(day).split("-").map(Number);
  if (!y || !m || !d) return String(day);
  const date = new Date(y, m - 1, d);
  return `${DAYS[date.getDay()]} ${d} ${MONTHS[m - 1]}`;
}

/** A moment with its day when it is not today: "14:03" or "wed 11 nov 14:03". */
export function when(t, now = Date.now()) {
  if (!t) return "";
  const day = dayOf(t);
  return day === dayOf(now) ? hm(t) : `${dayLabel(day, now)} ${hm(t)}`;
}
