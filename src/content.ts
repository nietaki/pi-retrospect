/**
 * Model/UI-facing text for `listSessions`.
 *
 * An index of paths, not a re-encoding of the data: `Sessions (N)` and one bullet per
 * session, subagent transcripts indented under their parent, then `Warnings (N)` and
 * `path: reason` bullets. No row cap and no truncation.
 *
 * Contract: docs/tool-api.md
 */

import type { ListSessionsOutput, SessionMetadata } from "./schemas.ts";

function sessionLines(sessions: SessionMetadata[], depth: number): string[] {
  const indent = "  ".repeat(depth);

  return sessions.flatMap((session) => [
    `${indent}- ${session.path}`,
    ...sessionLines(session.subagentSessions, depth + 1),
  ]);
}

export function renderListSessionsContent(output: ListSessionsOutput): string {
  const lines = [`Sessions (${output.sessions.length})`, ...sessionLines(output.sessions, 0)];

  if (output.warnings.length > 0) {
    lines.push("", `Warnings (${output.warnings.length})`);
    for (const warning of output.warnings) {
      lines.push(`- ${warning.path}: ${warning.reason}`);
    }
  }

  return lines.join("\n");
}
