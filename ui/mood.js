// The face's state, worked out from what stands now and not from single events, so a reload in the
// middle of a quest shows the right face. The order of weight is Chronos's (its docs/ui-contract.md
// 3.4 and ui/dock.js); Lite has no conversation, so what was "an answer streams" is here "the
// face says what a quest came back with" (face.say), and a brain that waits for a card another
// service holds counts as held. Pure: the dock gives it a snapshot, the test gives it another.
//
//   held       a heat.cutoff or throttle.hold stands (until heat.clear or throttle.release); a
//              brain waits for the card another service holds; or something just failed
//              (brain.failed, a quest that came back failed or blocked) for a few seconds
//   speaking   the face says what a quest came back with
//   thinking   the quest that runs is in its plan or judge phase
//   working    a quest runs (its work phase, or a size s quest that has no phase)
//   listening  the owner is typing an ask
//   done       a quest just landed
//   sleep      nothing happened for ten minutes
//   idle       otherwise

export const SLEEP_AFTER_MS = 10 * 60_000;
export const LISTEN_MS = 1800;
export const FAILED_MS = 5000;
export const DONE_MS = 1700;
export const STATES = ["idle", "listening", "thinking", "speaking", "working", "held", "done", "sleep"];

/**
 * snapshot: { hold, waiting, failedUntil, speakingUntil, quest: { status, phase, size } | null,
 * typingUntil, doneUntil, lastActivity }; every field may be left out.
 */
export function moodOf(s = {}, now = Date.now()) {
  if (s.hold || s.waiting || now < (s.failedUntil ?? 0)) return "held";
  if (now < (s.speakingUntil ?? 0)) return "speaking";
  const q = s.quest;
  if (q && (q.status === "running" || q.status === "stopping")) return q.phase === "plan" || q.phase === "judge" ? "thinking" : "working";
  if (now < (s.typingUntil ?? 0)) return "listening";
  if (now < (s.doneUntil ?? 0)) return "done";
  if (now - (s.lastActivity ?? now) > SLEEP_AFTER_MS) return "sleep";
  return "idle";
}

/**
 * What one event does to the face beyond its state: a reaction the dock plays once, and the
 * timers it moves. Answers { failed?, done?, say?, glitch?, displace? }.
 */
export function reactionOf(ev) {
  const t = ev?.type ?? "";
  if (t === "agent.split" || t === "brain.switched") return { displace: true };
  if (t === "brain.failed") return { failed: true, glitch: 0.9 };
  if (t === "quest.done") {
    const s = ev.status ?? "done";
    if (s === "failed" || s === "blocked") return { failed: true, glitch: 0.9 };
    if (s === "stopped") return { done: true, glitch: 0.45 };
    const say = String(ev.summary ?? "").trim();
    return say ? { say, done: true } : { done: true };
  }
  return {};
}

/** The line under the state word, in the page's words. */
export function noteOf(state, w) {
  return {
    idle: `nothing is asked of ${w.name}`,
    listening: "you are typing",
    thinking: `${w.planner} ${w.thinkVerb}`,
    speaking: `what the ${w.task} came back with`,
    working: `a ${w.task} runs`,
    held: "held: the heat, the card or a failure stopped the work",
    done: "it landed",
    sleep: "nothing happened for ten minutes",
  }[state];
}
