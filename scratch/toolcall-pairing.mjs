import { SessionManager } from "@earendil-works/pi-coding-agent";
let calls = 0, results = 0, paired = 0, orphan = 0, crossEntry = 0;
for (const p of process.argv.slice(2)) {
  const ids = new Map();
  for (const e of SessionManager.open(p).getEntries()) {
    if (e.type !== "message") continue;
    if (e.message.role === "assistant")
      for (const b of e.message.content) if (b.type === "toolCall") { calls++; ids.set(b.id, e.id); }
    if (e.message.role === "toolResult") {
      results++;
      const owner = ids.get(e.message.toolCallId);
      if (owner === undefined) orphan++;
      else { paired++; if (owner !== e.parentId) crossEntry++; }
    }
  }
}
console.log({ toolCalls: calls, toolResults: results, paired, orphan, callAndResultNotAdjacent: crossEntry });
