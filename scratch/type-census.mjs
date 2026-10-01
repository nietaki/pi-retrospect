// Census of real session data: entry types, message roles, optional-field presence.
// Run: node scratch/type-census.mjs
import { SessionManager } from "@earendil-works/pi-coding-agent";

const all = await SessionManager.listAll();
const entryTypes = {};
const roles = {};
const optional = {};
const stopReasons = {};
const toolNames = {};
let entries = 0;

for (const s of all) {
  const m = SessionManager.open(s.path);
  for (const e of m.getEntries()) {
    entries++;
    entryTypes[e.type] = (entryTypes[e.type] ?? 0) + 1;
    // Optional field presence on entries
    for (const k of ["details", "usage", "fromHook", "systemMessage", "name", "label", "replacement"]) {
      if (k in e) optional[`entry.${e.type}.${k}`] = (optional[`entry.${e.type}.${k}`] ?? 0) + 1;
    }
    if (e.type !== "message") continue;
    const msg = e.message;
    roles[msg.role] = (roles[msg.role] ?? 0) + 1;
    if (msg.role === "assistant") {
      stopReasons[msg.stopReason] = (stopReasons[msg.stopReason] ?? 0) + 1;
      for (const b of msg.content ?? []) optional[`assistant.block.${b.type}`] = (optional[`assistant.block.${b.type}`] ?? 0) + 1;
      for (const k of ["thinkingLevel", "providerThinkingLevel", "responseModel", "errorMessage", "nestedCalls"]) {
        if (msg[k] !== undefined) optional[`assistant.${k}`] = (optional[`assistant.${k}`] ?? 0) + 1;
      }
    }
    if (msg.role === "toolResult") {
      toolNames[msg.toolName] = (toolNames[msg.toolName] ?? 0) + 1;
      for (const k of ["details", "usage", "nestedCalls"]) if (msg[k] !== undefined) optional[`toolResult.${k}`] = (optional[`toolResult.${k}`] ?? 0) + 1;
      optional[`toolResult.isError.${msg.isError}`] = (optional[`toolResult.isError.${msg.isError}`] ?? 0) + 1;
    }
    if (msg.role === "user") {
      optional[`user.content.${typeof msg.content}`] = (optional[`user.content.${typeof msg.content}`] ?? 0) + 1;
    }
  }
}

const top = (o, n = 12) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n));
console.log(JSON.stringify({
  sessions: all.length,
  entries,
  entryTypes,
  roles,
  stopReasons,
  topTools: top(toolNames, 10),
  optionalPresence: top(optional, 30),
}, null, 2));
