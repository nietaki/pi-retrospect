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
      "List every recorded Pi session under the sessions root, newest last.",
      "Returns { sessions, warnings }: each session carries its id, absolute file path, absolute cwd,",
      "ISO 8601 timestamp, an optional parentSessionPath for forked sessions, and subagentSessions",
      "holding the subagent transcripts launched from it (nested the same way).",
      "Both levels are ordered by timestamp ascending, so the most recent session is the last entry.",
      "Sessions whose file cannot be read or has no valid session header on line 1 are not returned;",
      "they appear in warnings with the reason, so an empty list plus warnings means unreadable history",
      "rather than no history.",
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
