// Probe: what does SessionInfo.allMessagesText actually cover, vs raw entries?
// Run: node scratch/coverage-probe.mjs
import { SessionManager } from "@earendil-works/pi-coding-agent";

const NEEDLES = ["Denied by policy", "not found", "Error:", "isError"];
const all = await SessionManager.listAll();

// Coverage via the precomputed index field only.
const viaInfo = NEEDLES.map((n) => ({
  needle: n,
  sessionsViaAllMessagesText: all.filter((s) => s.allMessagesText.includes(n)).length,
}));

// Coverage via every entry in every session (what a real message search sees).
const dotfiles = all.filter((s) => s.cwd.includes("dotfiles"));
let viaEntries = 0;
const perNeedle = {};
for (const s of dotfiles) {
  const m = SessionManager.open(s.path);
  const blob = m.getEntries().map((e) => JSON.stringify(e)).join("\n");
  for (const n of NEEDLES) if (blob.includes(n)) perNeedle[n] = (perNeedle[n] ?? 0) + 1;
  viaEntries++;
}

console.log("sessions in listAll:", all.length, "| dotfiles sessions:", viaEntries);
console.log("via SessionInfo.allMessagesText (all sessions):", JSON.stringify(viaInfo, null, 2));
console.log("via raw entries (dotfiles only):", JSON.stringify(perNeedle, null, 2));

// Show a concrete miss: a session where the needle is in entries but not in allMessagesText.
const example = dotfiles.find((s) => {
  const m = SessionManager.open(s.path);
  return m.getEntries().some((e) => JSON.stringify(e).includes("Denied by policy"))
    && !s.allMessagesText.includes("Denied by policy");
});
if (example) {
  const m = SessionManager.open(example.path);
  const hit = m.getEntries().find((e) => JSON.stringify(e).includes("Denied by policy"));
  console.log("\nexample miss:", example.path);
  console.log("entry type:", hit.type, "| role:", hit.message?.role, "| toolName:", hit.message?.toolName);
}
