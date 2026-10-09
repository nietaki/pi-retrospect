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
import { readProjectAccessPolicy } from "./project-access.ts";
import { ListSessionsOutputSchema, ListSessionsParamsSchema } from "./schemas.ts";

export interface ListSessionsToolOptions {
  sessionsRoot: string;
  /**
   * Reads Pi's effective settings, asked on every call. `src/index.ts` supplies `pi.getSettings`.
   *
   * Omit it — a factory test, or the listing used as a library — and there is no policy to read, so
   * the tool keeps the access that existed before `allowedProjects` did.
   */
  readSettings?: () => unknown;
}

export function createListSessionsTool(options: ListSessionsToolOptions) {
  return defineTool({
    name: "list_sessions",
    label: "List Sessions",
    description: [
      "List recorded Pi sessions under the sessions root; with no parameters the newest session is last,",
      "and the session this call runs inside is not in the list at all unless includeCurrentSession asks",
      "for it.",
      "Returns { sessions, warnings }: each session carries its id, absolute file path, absolute cwd,",
      "the header timestamp as stored (a value the session parser can read, not necessarily strict ISO",
      "8601), an optional parentSessionPath for forked sessions, and subagentSessions",
      "holding the subagent transcripts launched from it (nested the same way).",
      "Sessions whose file cannot be read or has no valid session header on line 1 are not returned;",
      "they appear in warnings with the reason, so an empty list plus warnings means unreadable history",
      "rather than no history.",
      "Filters select TOP-LEVEL sessions only; a matching parent keeps its complete, unfiltered",
      "subagentSessions tree, and warnings still describe the whole scan:",
      "cwds plus cwdMatch ('exact' or 'sibling-prefix', where sibling-prefix also matches a sibling",
      "directory whose basename extends the requested one with a dash — the shape of a git worktree",
      "placed next to the main checkout; it is a lexical path rule and reads no git metadata);",
      "startTimestamp and endTimestamp, both inclusive, each an ISO 8601 date or date-time: a bare",
      "date names one whole calendar day and a date-time with no offset is read in the host",
      "timezone (Pi writes timestamps in UTC, so a naive bound means the same instant everywhere",
      "only when the machine is on UTC); sortBy (timestamp, cwd, path, id) and sortDirection",
      "(asc, desc) order the top level with ties broken by path, while children always stay in launch",
      "order; limit caps the returned top-level rows after filtering and sorting but is an output cap",
      "only, since every header is still read.",
      "By default the current session is excluded, together with the transcripts nested under it. Pi",
      "names it by its session file, matched as an absolute path, never by session id, timestamp, or",
      "recency, so a copy sharing the current id survives and an ephemeral session (no file) excludes",
      "nothing. A dropped session takes its own subtree with it, because those runs were launched by it.",
      "Exclusion runs before filtering, sorting, and limit, so a capped read still returns the newest",
      "other session rather than an empty list. Pass includeCurrentSession: true when the task means this",
      "very conversation, or wants the subagent runs this session already launched.",
      "An unparseable timestamp, a range ending before it starts, and a limit below 1 throw.",
      "The operator can bound which projects either retrospective tool may reach with the",
      "`piRetrospect.allowedProjects` setting, whose values are project cwd basenames: an allowed name",
      "covers that project and its `-`-suffixed worktree siblings, and nothing else. The bound is",
      "enforced here, before a session's children or warnings are collected, so `cwds` and `cwdMatch`",
      "select within it and can never widen it; a denied project contributes no row, no nested",
      "transcript, and no warning. Omitted configuration keeps every project reachable.",
    ].join(" "),
    parameters: ListSessionsParamsSchema,
    outputSchema: ListSessionsOutputSchema,
    exposure: "codemode",
    annotations: { readOnlyHint: true },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Asked per call, never cached: `/new`, `/resume`, and `/fork` replace the session inside one
      // Pi process, and a stale path would exclude the wrong transcript. A tool run without a
      // session context has no current session to exclude, so the reads stay optional.
      const currentSessionPath = ctx?.sessionManager?.getSessionFile();

      // Asked per call, never cached, for the same reason the session file is read per call: the
      // effective settings change inside one Pi process, and `/reload` is what picks up an edited
      // allowlist. A policy this call cannot read fails the call before the scan starts rather than
      // falling back to the wide-open access the operator's typo was meant to prevent.
      const policy = readProjectAccessPolicy(options.readSettings);

      const output = await listSessions(params, {
        sessionsRoot: options.sessionsRoot,
        currentSessionPath,
        policy,
        signal,
      });

      return {
        content: [{ type: "text", text: renderListSessionsContent(output) }],
        details: output,
        structuredContent: output,
      };
    },
  });
}
