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
import type {
  SessionEntriesOutput,
  SessionEntriesWarning,
  SessionFileEntry,
} from "./schemas.ts";

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

/**
 * Model/UI-facing text for `readSessionEntries`.
 *
 * An index of lines, never the payloads: `Entries (N)` and one `lineNo type role id` bullet per
 * entry — `raw` is deliberately left out, since one entry can exceed the context window on its
 * own — then `Warnings (N)` and one bullet per skipped line, or `file:` for the whole file.
 */
function entryLine(entry: SessionFileEntry): string {
  return [
    `- ${entry.lineNo}`,
    entry.type,
    entry.messageRole ?? "",
    entry.id ?? "",
  ]
    .filter((part) => part !== "")
    .join(" ");
}

function warningLine(warning: SessionEntriesWarning): string {
  const where = warning.lineNo === null ? "file" : `line ${warning.lineNo}`;

  return `- ${where} ${warning.code}: ${warning.reason}`;
}

export function renderSessionEntriesContent(output: SessionEntriesOutput): string {
  const lines = [`Entries (${output.entries.length})`, ...output.entries.map(entryLine)];

  if (output.warnings.length > 0) {
    lines.push("", `Warnings (${output.warnings.length})`);
    lines.push(...output.warnings.map(warningLine));
  }

  return lines.join("\n");
}
