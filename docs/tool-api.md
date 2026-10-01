# Tool API

Decisions for the operations `pi-retrospect` exposes. Data-model background lives in
[`data-types.md`](data-types.md); this file records *our* contract, not Pi's.

Verified against `@earendil-works/pi-coding-agent` **0.99.2** and
`@earendil-works/pi-ai` **0.99.2** (TypeBox **1.3.27**). Store census taken from
this machine on 2026-10-02: 12 project directories, 131 parent sessions,
58 subagent child transcripts, 9 `subagent-artifacts/*_transcript.jsonl` copies.

---

## `listSessions`

Returns metadata for every discoverable session, with subagent children nested under
the session that launched them.

### Signatures

```ts
import { Type, type Static } from "@earendil-works/pi-ai";

export const ListSessionsParamsSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const SessionMetadataSchema = Type.Cyclic(
  {
    SessionMetadata: Type.Object(
      {
        id: Type.String({ description: "Session id from the file header" }),
        path: Type.String({ description: "Absolute path to the session .jsonl file" }),
        timestamp: Type.String({
          format: "date-time",
          description: "Header timestamp, ISO 8601, validated before the row is returned",
        }),
        cwd: Type.String({ description: "Absolute working directory from the header" }),
        parentSessionPath: Type.Optional(
          Type.String({
            description: "Header parentSession value, copied verbatim (fork/clone lineage)",
          }),
        ),
        subagentSessions: Type.Array(Type.Ref("SessionMetadata")),
      },
      { additionalProperties: false },
    ),
  },
  "SessionMetadata",
);

export const ListSessionsWarningSchema = Type.Object(
  {
    path: Type.String(),
    reason: Type.String(),
  },
  { additionalProperties: false },
);

export const ListSessionsOutputSchema = Type.Object(
  {
    sessions: Type.Array(SessionMetadataSchema),
    warnings: Type.Array(ListSessionsWarningSchema),
  },
  { additionalProperties: false },
);

export type ListSessionsParams = Static<typeof ListSessionsParamsSchema>;
export type SessionMetadata = Static<typeof SessionMetadataSchema>;
export type ListSessionsWarning = Static<typeof ListSessionsWarningSchema>;
export type ListSessionsOutput = Static<typeof ListSessionsOutputSchema>;
```

Recursive schemas use `Type.Cyclic` + `Type.Ref`; this TypeBox release has no
`Type.Recursive`. `Static` resolves the `$ref` back to the interface, so
`SessionMetadata` is a genuinely recursive TypeScript type.

`id` stays `Type.String()`, **not** `format: "uuid"`. Pi mints UUIDv7 by default but
`assertValidSessionId` only constrains the character set, so a custom id is valid Pi
data and must not be rejected here.

`format: "date-time"` is a real guarantee rather than documentation, because
timestamps are validated before a row is returned (see Validation).

### Implementation boundary

The tool takes no parameters; the implementation takes the root, so tests can point it
at a fixture tree.

```ts
export interface ListSessionsOptions {
  sessionsRoot: string;
}

export async function listSessions(
  params: ListSessionsParams,
  options: ListSessionsOptions,
): Promise<ListSessionsOutput>;
```

The registered wrapper supplies the root. Pi's `getSessionsDir()` is **not** re-exported
from the package root; `getAgentDir()` is, and it honors the agent-dir environment
override. So `src/index.ts` computes:

```ts
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

const sessionsRoot = join(getAgentDir(), "sessions");
```

The `"sessions"` literal is the only path component we hardcode. The tool itself is built
by a factory — `createListSessionsTool({ sessionsRoot })` in `src/list-sessions-tool.ts` —
so tests can construct the registered shape against a fixture root instead of the live store.

`execute()` checks the `AbortSignal` between file reads and stops early; `details`
mirrors `structuredContent`; `outputSchema` is declared so codemode callers receive
JSON instead of prose.

### Discovery rules

1. **Project directories:** only immediate subdirectories of the root whose name matches
   `--<slug>--`. Other entries — measured here: `permission-forwarding/` — are ignored by
   rule, not by accident.
2. **Top-level sessions:** `*.jsonl` files *directly* inside a project directory. Not a
   recursive search, which keeps `subagent-artifacts/*_transcript.jsonl` copies (measured:
   9) out of the result set: they are neither roots (not directly in a project dir) nor
   children (not under a parent-stem directory).
3. **Children of a session:** every `session.jsonl` at any depth under a directory named
   after the session's own stem — `<file-timestamp>_<session-id>`, the parent filename with
   `.jsonl` removed. Today the observed shape is exactly
   `<slug>/<parent-stem>/<launch-uuid>/run-<n>/session.jsonl`.
4. **One entry per run directory.** A launch slot holding `run-0`, `run-1`, … produces one
   `SessionMetadata` per transcript; we do not collapse a resumed child into a single entry.
5. **Grouping by deepest container.** A session's container directory is
   `dirname(path)/basename-without-.jsonl`. Every transcript found under a root's container
   is attached to the session whose container is the deepest ancestor of its path, so a
   transcript is never reported under two parents. Recursion is implemented generically and
   unverified: this store has zero grandchildren, all 58 children sit at depth `run-0`.
   See TODOs.
6. **Header read:** only line 1 of each file is parsed, bounded to **4 KiB**
   (`MAX_HEADER_LINE_BYTES = 4096`). A longer first line is skipped with a warning. This is
   deliberately tighter than Pi's own 1 MiB `MAX_SESSION_HEADER_SCAN_BYTES`: real headers
   measured here are ~150 bytes, and a header over 4 KiB is not a session we can trust.
   A line of exactly 4096 bytes is accepted; a file whose last line has no terminating
   newline is read normally.
7. **Symlinks are not followed.** Discovery stays inside `sessionsRoot`.

### Validation and warnings

A file yields a session row only when all of the following hold; otherwise it is skipped
and one warning `{ path, reason }` is emitted. The reason vocabulary is free-form text, not
an enum.

| Condition | Outcome |
| --- | --- |
| Line 1 missing, empty, or unreadable | skip + warn |
| Line 1 not valid JSON | skip + warn |
| Line 1 JSON is not an object, or `type !== "session"` | skip + warn |
| Missing/invalid `id` | skip + warn |
| Missing or empty `cwd` (Pi writes `""` in old sessions) | skip + warn |
| `timestamp` absent, wrong type, ISO-shaped but not a real date, or not parseable | skip + warn |
| `parentSessionPath` present but not a string | skip + warn |
| First line longer than 4 KiB | skip + warn |

Consequence: every returned row is fully trustworthy — `id`, absolute `path`, valid
`cwd`, and a parseable `timestamp` are guaranteed, so callers never handle a partial row
and sorting never meets an `Invalid Date`. Nothing is ever silently dropped; a skipped
file costs one warning entry.

A failed child is simply absent from its parent's `subagentSessions` list, plus one
warning naming the child's path. The warnings array is flat: it does not say which level
the failure happened at.

`parentSessionPath` is copied verbatim from the header with no resolution, normalization,
or existence check. A `parentSession` present but not a string is a skip-plus-warning; an
empty-string `parentSession` is treated as absent and omitted from the row. `path` is
absolute because `sessionsRoot` is resolved with `path.resolve()` before the walk and every
row path is built from it; `cwd` is absolute because we require it.

### Ordering

`timestamp` **ascending**, oldest first, at both levels, with ties broken by `path`. The
sessions root is resolved to an absolute path before the walk, so `path` is absolute even
when a caller passes a relative `sessionsRoot`. `warnings` are sorted by `path` so a run is
reproducible regardless of `readdir` order. Ascending was chosen so that a parent's subagent
children appear in launch order, which mirrors how the runs were started. Note for the tool
description: the sessions a caller usually wants most are at the tail.

### Missing or empty root

A root that does not exist, or that holds no `--slug--` directory, is not an error:
return `{ sessions: [], warnings: [...] }` with one warning naming the attempted path.
A fresh install has no history yet and must not look broken.

### Tool registration

```ts
defineTool({
  name: "list_sessions",
  label: "List Sessions",
  description: "...",
  parameters: ListSessionsParamsSchema,
  outputSchema: ListSessionsOutputSchema,
  exposure: "codemode",
  annotations: { readOnlyHint: true },
});
```

`exposure: "codemode"` means the tool is callable from codemode scripts and listed by the
`codemode` tool, but is never declared to the model and is not activated on registration.
Two consequences:

- The `content` text below is seen only in transcripts, logs, and UI rendering — a script
  receives `structuredContent` instead.
- Nested tool results do not become transcript entries, so the JSON is only reachable from
  inside a script that asked for it.

### `content` text format

Model/UI-facing text is an index of paths, not a re-encoding of the data:

```
Sessions (131)
- /Users/nietaki/.pi/agent/sessions/--Users-nietaki-repos-dmarc--/2026-09-…_01a0….jsonl
- /Users/nietaki/.pi/agent/sessions/--Users-nietaki-repos-pi-retrospect--/2026-10-…_01a0….jsonl
  - /Users/…/2026-10-…_01a0….jsonl/1671820d-…/run-0/session.jsonl

Warnings (2)
- /Users/…/broken.jsonl: first line is not a session header
```

- `Sessions (N)` header, then one bullet per root session, children indented two spaces per
  nesting level, in the same order as `sessions`.
- `Warnings (N)` section only when there is at least one warning.
- No row cap and no truncation: the list is bounded by the number of sessions, and the JSON
  is available to scripts regardless.

### Testing policy

Committed synthetic fixtures under `test/fixtures/sessions/`, generated by
`test/fixtures/generate.mjs` (`node test/fixtures/generate.mjs` rebuilds the tree). The layout
reproduces the real one — `--<slug>--` project directories, parent `<stem>.jsonl` files,
`<stem>/<launch-uuid>/run-<n>/session.jsonl` children, a `subagent-artifacts/` dump, a non-slug
directory, a stray root-level `.jsonl`, two symlinks (a project-dir link and a session-file
link), an orphan stem directory with no matching parent file, a header of exactly 4096 bytes and
one of 4097, a header with no terminating newline, and one deliberately broken file per warning
branch. Fixture headers are hand-written; no real session data is committed.

Assertions target the contract, not Pi's format: ordering, absolute paths, nesting by
containment, one row per run directory, symlink and non-slug exclusion, and warning coverage.

Measured against the **live** store on this machine: 131 root sessions, 58 child transcripts,
0 warnings, unique paths and ids, ordering correct, ~185 ms for the whole walk. Running
subagent workflows here is still the way to grow real parent/child trees for spot-checks — see
TODOs.

### Guarantees

1. `sessions` is ordered by `timestamp` ascending, ties by `path`, at every nesting level.
2. Every row has `id`, absolute `path`, absolute non-empty `cwd`, and parseable ISO 8601
   `timestamp`.
3. `subagentSessions` is always present; `[]` for a session with no children.
4. A file is reported at most once, either as a row or as a warning.
5. Children are linked to a parent by path containment only — there is no structural field
   connecting them (see Subagent child sessions in `data-types.md`).
6. `path` is the stable handle. `id` may repeat across rows if Pi ever reuses a session id
   across `run-<n>` directories, which is unverifiable today (this store has only `run-0`).
7. The call is read-only: no file is opened through Pi's `SessionManager.open()`, which can
   migrate or repair history.
8. A `--<slug>--` directory whose stem has no matching parent file is not visited, so an
   orphaned child tree is reported neither as a row nor as a warning. Only files reachable
   from a discovered session are considered.

---

## TODOs

- **Verify grandchild nesting.** All 58 child transcripts in this store sit at
  `<slug>/<parent-stem>/<launch-uuid>/run-0/session.jsonl`; none launched their own
  subagent, so the recursive case is unexercised. Once a nested launch exists, confirm the
  convention — whether a child's own stem directory appears as `…/run-0/<child-stem>/…` —
  and that containment-based grouping does not attach a deep transcript to two parents.
- **Generate real fixture data.** Run subagent workflows in this project's `cwd` so
  `--Users-nietaki-repos-pi-retrospect--/` grows actual parent/child trees, then use them to
  check the synthetic layout against reality. Do not commit the output.
- **Filtering parameters.** `params` is an empty object by design. Deferred for later:
  by project/`cwd`, by time range, by presence of subagents, `includeCurrentSession`
  (the currently running session is included today; an exclusion parameter is the agreed
  future direction), depth limit for `subagentSessions`.
- **Ordering choice review.** Ascending order follows launch chronology; if callers keep
  needing the newest session, add a parameter rather than flipping the default.
