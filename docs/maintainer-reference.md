## Compatibility

Verified against `@earendil-works/pi-coding-agent` **0.99.2** and
`@earendil-works/pi-ai` **0.99.2** (TypeBox **1.3.27**), and re-checked against Pi
**1.0.0** on 2026-10-02 — the shipped `dist/core/session-manager.js` and `pi-ai`
`dist/types.d.ts` are byte-identical across those releases, so nothing here changed.
Subagent child layout is a `pi-subagents` convention, observed against **0.74.0**.
Measurements are snapshots of one developer machine's session store and are quoted as
ratios or timings, never as store totals; a store grows daily.

## Maintainer reference

The sections below are the implementation contract for `listSessions` (the exported
function behind the registered `list_sessions` tool). Each states *how* a guarantee from the
caller half is produced; the caller half states *what* is guaranteed.

### TypeBox schemas

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
        subagentSessions: Type.Array(Type.Ref("SessionMetadata"), {
          description: "Subagent transcripts launched from this session, in timestamp order",
        }),
      },
      { additionalProperties: false },
    ),
  },
  "SessionMetadata",
);

export const ListSessionsWarningSchema = Type.Object(
  {
    path: Type.String({ description: "Absolute path of the file or directory that was skipped" }),
    reason: Type.String({ description: "Why the file was not returned as a session" }),
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

`format: "date-time"` is a real guarantee rather than documentation, because timestamps are
validated before a row is returned (see Validation rules).

### Implementation boundary

The tool takes no parameters; the implementation takes the root, so tests can point it at a
fixture tree.

```ts
export interface ListSessionsOptions {
  sessionsRoot: string;
  /** Aborted between filesystem operations. */
  signal?: AbortSignal;
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
mirrors `structuredContent`; `outputSchema` is declared so codemode callers receive JSON
instead of prose.

### Discovery rules

1. **Project directories:** only immediate subdirectories of the root whose name matches
   `--<slug>--`. Other entries — measured here: `permission-forwarding/` — are ignored by
   rule, not by accident.
2. **Top-level sessions:** `*.jsonl` files *directly* inside a project directory. Not a
   recursive search, which keeps `subagent-artifacts/*_transcript.jsonl` copies (only a
   handful exist where this was measured, but they duplicate real children) out of the result
   set: they are neither roots (not directly in a project dir) nor children (not under a
   parent-stem directory).
3. **Children of a session:** every `session.jsonl` at any depth under a directory named
   after the session's own stem — `<file-timestamp>_<session-id>`, the parent filename with
   `.jsonl` removed. Today the observed shape is exactly
   `<slug>/<parent-stem>/<launch-uuid>/run-<n>/session.jsonl`.
4. **One entry per run directory.** A launch slot holding `run-0`, `run-1`, … produces one
   `SessionMetadata` per transcript; we do not collapse a resumed child into a single entry.
5. **Grouping by deepest container.** A session's container directory is
   `dirname(path)/basename-without-.jsonl`. Every transcript found under a root's container
   is attached to the session whose container is the deepest ancestor of its path, so a
   transcript is never reported under two parents. When a nested launch does not sit under
   its parent's container, it stays attached to the nearest session that does — the
   documented fallback for the unverified grandchild convention. Recursion is implemented
   generically and unverified: the store measured here holds no grandchild transcripts at
   all, and every child transcript observed sits at depth `run-0`. See TODOs.
6. **Header read:** only line 1 of each file is parsed, bounded to **4 KiB**
   (`MAX_HEADER_LINE_BYTES = 4096`). A longer first line is skipped with a warning. This is
   deliberately tighter than Pi's own 1 MiB `MAX_SESSION_HEADER_SCAN_BYTES`: real headers
   measured here are ~150 bytes, and a header over 4 KiB is not a session we can trust.
   A line of exactly 4096 bytes is accepted; a file whose last line has no terminating
   newline is read normally.
7. **Symlinks are not followed.** Discovery stays inside `sessionsRoot`. Implemented by
   `Dirent.isDirectory()` / `isFile()`, which are false for symlinks.

### Validation rules

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

Consequence: every returned row is fully trustworthy — `id`, absolute `path`, valid `cwd`,
and a parseable `timestamp` are guaranteed, so callers never handle a partial row and
sorting never meets an `Invalid Date`. Nothing the walk reached is ever silently dropped; a
skipped file costs one warning entry. Files the discovery rules exclude (non-slug
directories, `subagent-artifacts/` copies, orphaned stems, symlinks) are not skipped and
therefore not warned about — they are out of scope.

A missing subagent directory is the normal case and is **not** warned about; an existing
directory that cannot be read is. `parentSessionPath` is copied verbatim with no
resolution, normalization, or existence check. A `parentSession` present but not a string
is a skip-plus-warning; an empty-string `parentSession` is treated as absent and omitted
from the row. `path` is absolute because `sessionsRoot` is resolved with `path.resolve()`
before the walk and every row path is built from it; `cwd` is absolute because we require
it. Timestamp validation includes a calendar check `Date.parse` does not provide —
`"2026-02-30T08:00:00.000Z"` rolls over instead of failing, and would otherwise reach the
output as an untrustworthy string.

### Ordering rules

`timestamp` **ascending**, oldest first, at both levels, with ties broken by `path`. The
sessions root is resolved to an absolute path before the walk, so `path` is absolute even
when a caller passes a relative `sessionsRoot`. `warnings` are sorted by `path` (then
`reason`) so a run is reproducible regardless of `readdir` order. Ascending was chosen so
that a parent's subagent children appear in launch order, which mirrors how the runs were
started. The tool description is where "the sessions a caller usually wants are at the
tail" has to be spelled out, because ascending order is the counter-intuitive half.

### Missing or empty root

Two cases, verified against the implementation, and they differ:

- **Root not readable** (does not exist, or `scandir` fails for any other reason): not an
  error. Returns `{ sessions: [], warnings: [ … ] }` with one warning naming the resolved
  attempted path, whose reason begins `sessions root not readable:`.
- **Root exists but holds no `--<slug>--` directory** (or holds only directories with no
  readable session headers directly inside them): returns `{ sessions: [], warnings: [] }`.
  No warning is emitted, because walking an empty directory is not a failure.

A fresh install has no history yet and must not look broken, which is why neither case
throws. The distinction a caller has to remember: `sessions: []` plus empty `warnings` is
"found nothing", while `sessions: []` plus a warning naming the root is "could not read
the store".

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

The registered `description` must keep telling the caller what it cannot infer from the
shape: that results are oldest-first so the newest session is last, that nesting is
expressed by `subagentSessions` while `parentSessionPath` is fork lineage, and that an
empty list plus warnings means unreadable rather than absent history. It currently does not
say that `path` is the handle to key on — see TODOs.

`exposure`, `annotations`, and `outputSchema` require **Pi >= 0.99.0** (added
2026-09-29). Peer ranges stay `"*"` because that is Pi's stated convention for
host-provided packages and Pi does not resolve peer ranges for managed installs
(`--omit=peer`), so this minimum is recorded in prose rather than in `package.json`.

`exposure: "codemode"` means the tool is callable from codemode scripts and listed by the
`codemode` tool, but is never declared to the model and is not activated on registration.
The two consequences in the caller half (structured JSON to scripts; `content` visible only
in transcripts, logs, and UI) follow from this.

### Rendered `content` text format

Model/UI-facing text is an index of paths, not a re-encoding of the data:

```
Sessions (N)
- /Users/<user>/.pi/agent/sessions/--Users-<user>-repos-app--/2026-09-…_01a0….jsonl
- /Users/<user>/.pi/agent/sessions/--Users-<user>-repos-tool--/2026-10-…_01a0….jsonl
  - /Users/…/2026-10-…_01a0….jsonl/<launch-uuid>/run-0/session.jsonl

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
`test/fixtures/generate.mjs` (`node test/fixtures/generate.mjs` rebuilds the tree; both are
in the source repository, not in the npm tarball). The layout reproduces the real one —
`--<slug>--` project directories, parent `<stem>.jsonl` files,
`<stem>/<launch-uuid>/run-<n>/session.jsonl` children, a `subagent-artifacts/` dump, a
non-slug directory, a stray root-level `.jsonl`, two symlinks (a project-dir link and a
session-file link), an orphan stem directory with no matching parent file, a header of
exactly 4096 bytes and one of 4097, a header with no terminating newline, and one
deliberately broken file per warning branch. Fixture headers are hand-written; no real
session data is committed.

Assertions target the contract, not Pi's format: ordering, absolute paths, nesting by
containment, one row per run directory, symlink and non-slug exclusion, and warning
coverage.

Measured against the **live** store on this machine: every parent and child transcript
discovered, 0 warnings, unique paths and ids, ordering correct, and the whole walk
completes in roughly 200 ms. Running subagent workflows here is still the way to grow real
parent/child trees for spot-checks — see TODOs.

### Implementation guarantees

Restated from the caller half as properties a change must not break: total ascending
ordering with `path` tie-break at every level; `subagentSessions` always present; each file
reported at most once; containment-only child linkage with no structural field connecting
parents to children (Pi's `SessionHeader.parentSession` means fork/clone lineage, verified
against `pi-subagents` 0.74.0); `path` as the stable handle because `id` may repeat across
`run-<n>` directories; no use of Pi's `SessionManager.open()`, which can migrate or repair
history; and orphaned `--<slug>--` stems left unvisited, so only files reachable from a
discovered session are considered.

---

## TODOs

- **Verify grandchild nesting.** Every child transcript in the store measured here sits at
  `<slug>/<parent-stem>/<launch-uuid>/run-0/session.jsonl`; none launched their own
  subagent, so the recursive case is unexercised. Once a nested launch exists, confirm the
  convention — whether a child's own stem directory appears as `…/run-0/<child-stem>/…` —
  and that containment-based grouping does not attach a deep transcript to two parents.
- **Generate real fixture data.** Run subagent workflows in this project's `cwd` so that
  project's `--<slug>--/` session directory grows actual parent/child trees, then use them
  to check the synthetic layout against reality. Do not commit the output.
- **Filtering parameters.** `params` is an empty object by design. Deferred for later:
  by project/`cwd`, by time range, by presence of subagents, `includeCurrentSession`
  (the currently running session is included today; an exclusion parameter is the agreed
  future direction), depth limit for `subagentSessions`.
- **Ordering choice review.** Ascending order follows launch chronology; if callers keep
  needing the newest session, add a parameter rather than flipping the default.
- **Orphaned child trees.** Today they are reported neither as a row nor as a warning. If
  that ever needs to be visible, it should become an explicit warning branch rather than a
  silent rule.
- **Tool description should name `path` as the handle.** The caller half says to key on
  `path` rather than `id`, but `description` in `src/list-sessions-tool.ts` lists the fields
  without saying which identifies a transcript. Worth one clause, since a caller reading
  only the description has no other way to learn it.
