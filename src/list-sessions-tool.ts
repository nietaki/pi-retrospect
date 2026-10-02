/**
 * The `list_sessions` tool.
 *
 * Built by a factory so tests can register it against a fixture root instead of the live
 * session store. `src/index.ts` supplies the real one.
 *
 * Contract: docs/tool-api.md
 */

import { defineTool } from "@earendil-works/pi-coding-agent";

import { renderListSessionsContent } from "./content.ts";
import { listSessions } from "./list-sessions.ts";
import { ListSessionsOutputSchema, ListSessionsParamsSchema } from "./schemas.ts";

export interface ListSessionsToolOptions {
  sessionsRoot: string;
}

export function createListSessionsTool(options: ListSessionsToolOptions) {
  return defineTool({
    name: "list_sessions",
    label: "List Sessions",
    description: [
      "List recorded Pi sessions under the sessions root; with no parameters the newest session is last.",
      "Returns { sessions, warnings }: each session carries its id, absolute file path, absolute cwd,",
      "ISO 8601 timestamp, an optional parentSessionPath for forked sessions, and subagentSessions",
      "holding the subagent transcripts launched from it (nested the same way).",
      "Sessions whose file cannot be read or has no valid session header on line 1 are not returned;",
      "they appear in warnings with the reason, so an empty list plus warnings means unreadable history",
      "rather than no history.",
      "Filters select TOP-LEVEL sessions only; a matching parent keeps its complete, unfiltered",
      "subagentSessions tree, and warnings still describe the whole scan:",
      "cwds plus cwdMatch ('exact' or 'sibling-prefix', where sibling-prefix also matches a sibling",
      "directory whose basename extends the requested one with a dash — the shape of a git worktree",
      "placed next to the main checkout; it is a lexical path rule and reads no git metadata);",
      "startTimestamp and endTimestamp, both inclusive, each an ISO 8601 date or a date-time carrying",
      "an explicit timezone — Pi writes UTC, so a bare date means a UTC calendar day and a date-only",
      "endTimestamp covers that whole day; sortBy (timestamp, cwd, path, id) and sortDirection",
      "(asc, desc) order the top level with ties broken by path, while children always stay in launch",
      "order; limit caps the returned top-level rows after filtering and sorting but is an output cap",
      "only, since every header is still read.",
      "An unparseable timestamp, a range ending before it starts, and a limit below 1 throw.",
    ].join(" "),
    parameters: ListSessionsParamsSchema,
    outputSchema: ListSessionsOutputSchema,
    exposure: "codemode",
    annotations: { readOnlyHint: true },

    async execute(_toolCallId, params, signal) {
      const output = await listSessions(params, { sessionsRoot: options.sessionsRoot, signal });

      return {
        content: [{ type: "text", text: renderListSessionsContent(output) }],
        details: output,
        structuredContent: output,
      };
    },
  });
}
