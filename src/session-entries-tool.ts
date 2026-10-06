/**
 * The `session_entries` tool.
 *
 * Built by a factory so tests can point it at a fixture root instead of the live session store.
 * `src/index.ts` supplies the real one.
 *
 * Contract: docs/tool-api.md
 */

import { defineTool } from "@earendil-works/pi-coding-agent";

import { renderSessionEntriesContent } from "./content.ts";
import { readSessionEntries } from "./session-entries.ts";
import { SessionEntriesOutputSchema, SessionEntriesParamsSchema } from "./schemas.ts";

export interface SessionEntriesToolOptions {
  sessionsRoot: string;
}

export function createSessionEntriesTool(options: SessionEntriesToolOptions) {
  return defineTool({
    name: "session_entries",
    label: "Session Entries",
    description: [
      "Read entries of one Pi session file, addressed by physical line number, with optional filters.",
      "Takes one required parameter, sessionPath: an absolute path to a session .jsonl file under the",
      "sessions root, normally a path returned by list_sessions. Paths outside the root, relative paths,",
      "`..` traversals, and symlinks that leave the root throw, so this reads session files only.",
      "Line 1 is the session header and is never returned: entries start at line 2 and keep the file's",
      "own numbering, so a skipped line shifts nothing. The file is streamed, never read whole, and a",
      "line break is LF, CRLF, or a lone CR — plain `\\n` counting for every file Pi writes. Entries",
      "arrive in file order (write order, not",
      "timestamp order) and include every branch stored in the file, abandoned ones included; order is",
      "not configurable.",
      "Optional filters are ANDed, values inside one array are ORed, and each matches the returned",
      "field exactly: startLineNo and endLineNo are inclusive physical line bounds, ids and parentIds",
      "are string sets, types and messageRoles are string sets, startTimestamp and endTimestamp are",
      "inclusive ISO 8601 date or date-time bounds read in the host timezone (a bare date end covers",
      "that whole day), and limit caps entries after filtering. A null field matches no array value,",
      "so ids and parentIds never select a version 1 row and messageRoles never select a non-message",
      "entry. Line bounds and limit are positive integers and an empty filter array is refused; a",
      "reversed line or timestamp range and an unparseable timestamp throw before the file is opened.",
      "Filters bound the result, never the scan: warnings describe the whole file whatever the",
      "parameters are, so a limited read still walks every line and a filtered row costs no warning.",
      "Paginate by passing startLineNo one past the last lineNo already returned.",
      "Returns { entries, warnings }. An entry is { lineNo, id, parentId, timestamp, type,",
      "messageRole, text, raw }: type and an unknown message role are copied verbatim, messageRole is",
      "null for non-message entries, text is the entry's primary human-readable body or null, and raw",
      "is the whole parsed line, including fields this tool has never seen. text is a projection, not a",
      "copy of raw: a message contributes its content (user, system, tool result, and an assistant",
      "message's visible text only — never its thinking, tool calls, or images), a custom_message its",
      "content, a compaction or branch_summary its summary, a context_edit its replacement, a",
      "session_info its name, a usage its note, a label its label, and a bashExecution its command;",
      "model_change, thinking_level_change, custom, and any unseen type contribute null. Content",
      "arrays are joined with a newline, nothing is trimmed or truncated, and a payload that holds no",
      "text is null rather than an empty string. raw remains the only field that carries everything.",
      "warnings are { lineNo, code, reason } with code invalid_json, invalid_entry, or",
      "legacy_version (null lineNo: the whole file). raw is unbounded per row and can be megabytes:",
      "read the structured result in a script, never print it to a model, and use limit plus the",
      "filters to hold only the rows you will keep.",
      "Read-only: never migrates, repairs, or writes the file. Session version 1 entry ids are not",
      "durable — Pi replaces them on migration — so id and parentId come back null even when the line",
      "stores them, alongside a legacy_version warning; raw keeps what was written, and lineNo is the",
      "one handle that stays valid across reads.",
    ].join(" "),
    parameters: SessionEntriesParamsSchema,
    outputSchema: SessionEntriesOutputSchema,
    exposure: "codemode",
    annotations: { readOnlyHint: true },

    async execute(_toolCallId, params, signal) {
      const output = await readSessionEntries(params, {
        sessionsRoot: options.sessionsRoot,
        signal,
      });

      return {
        content: [{ type: "text", text: renderSessionEntriesContent(output) }],
        details: output,
        structuredContent: output,
      };
    },
  });
}
