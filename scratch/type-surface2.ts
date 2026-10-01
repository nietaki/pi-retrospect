import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";

// Trick: derive the message union from the exported entry type, without naming pi-agent-core.
type SessionMessage = SessionMessageEntry["message"];

export function kind(m: SessionMessage): string {
  switch (m.role) {
    case "system": return `system:${m.sections ? Object.keys(m.sections).length : 0}`;
    case "user": return `user:${typeof m.content}`;
    case "assistant": return `assistant:${m.stopReason}:${m.usage.totalTokens}`;
    case "toolResult": return `toolResult:${m.toolName}:${m.isError}`;
    case "bashExecution": return `bashExecution:${m.exitCode}`;
    case "custom": return `custom:${m.customType}`;
    case "branchSummary": return "branchSummary";
    case "compactionSummary": return `compactionSummary:${m.tokensBefore}`;
    default: return `unknown:${(m as { role: string }).role}`;
  }
}
