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
      "Read every entry of one Pi session file, addressed by physical line number.",
      "Takes one parameter, sessionPath: an absolute path to a session .jsonl file under the sessions",
      "root, normally a path returned by list_sessions. Paths outside the root, relative paths,",
      "`..` traversals, and symlinks that leave the root throw, so this reads session files only.",
      "Line 1 is the session header and is never returned: entries start at line 2 and keep the file's",
      "own numbering, so a skipped line shifts nothing. The file is streamed, never read whole, and a",
      "line break is LF, CRLF, or a lone CR — plain `\\n` counting for every file Pi writes. Entries",
      "arrive in file order (write order, not",
      "timestamp order) and include every branch stored in the file, abandoned ones included.",
      "Returns { entries, warnings }. An entry is { lineNo, id, parentId, timestamp, type,",
      "messageRole, raw }: type and an unknown message role are copied verbatim, messageRole is null",
      "for non-message entries, and raw is the whole parsed JSON line, including fields this tool has",
      "never seen. warnings are { lineNo, code, reason } with code invalid_json, invalid_entry, or",
      "legacy_version (null lineNo: the whole file). raw is unbounded and can be megabytes: read the",
      "structured result in a script, never print it to a model.",
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
