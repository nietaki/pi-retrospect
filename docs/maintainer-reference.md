## Compatibility

Verified against `@earendil-works/pi-coding-agent` **0.99.2** and
`@earendil-works/pi-ai` **0.99.2** (TypeBox **1.3.27**), and re-checked against Pi
**1.0.0** on 2026-10-02 — the shipped `dist/core/session-manager.js` and `pi-ai`
`dist/types.d.ts` are byte-identical across those releases, so nothing here changed.
Subagent child layout is a `pi-subagents` convention, observed against **0.74.0**.
Measurements are snapshots of one developer machine's session store and are quoted as
ratios or timings, never as store totals; a store grows daily.

## Maintainer reference

The sections below are the implementation contract for `listSessions` and `readSessionEntries` (the
exported functions behind the registered `list_sessions` and `session_entries` tools). Each states
*how* a guarantee from the caller half is produced; the caller half states *what* is guaranteed.
Sections that name neither operation describe `listSessions`.

### TypeBox schemas

```ts
import { Type, type Static } from "@earendil-works/pi-ai";

export const CwdMatchSchema = Type.Union([Type.Literal("exact"), Type.Literal("sibling-prefix")], {
  default: "exact",
  /* description: what sibling-prefix is for, and that it reads no git metadata */
});

export const SessionSortFieldSchema = Type.Union(
  [Type.Literal("timestamp"), Type.Literal("cwd"), Type.Literal("path"), Type.Literal("id")],
  { default: "timestamp" },
);

export const SortDirectionSchema = Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
  default: "asc",
});

export const ListSessionsParamsSchema = Type.Object(
  {
    cwds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    startTimestamp: Type.Optional(Type.String()),
    endTimestamp: Type.Optional(Type.String()),
    cwdMatch: Type.Optional(CwdMatchSchema),
    sortBy: Type.Optional(SessionSortFieldSchema),
    sortDirection: Type.Optional(SortDirectionSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  },
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
export type CwdMatch = Static<typeof CwdMatchSchema>;
export type SessionSortField = Static<typeof SessionSortFieldSchema>;
export type SortDirection = Static<typeof SortDirectionSchema>;
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

Filter parameters are `Type.String()`, **not** `format: "date"`/`"date-time"`: this TypeBox
release does not enforce formats, so both shapes are checked in `src/query.ts` instead.
`default` annotations on the enums document behavior; the code still applies the defaults
itself (`params.cwdMatch ?? "exact"`, `params.sortBy ?? "timestamp"`,
`params.sortDirection === "desc"`) because nothing guarantees the schema fills them in.
`Type.Integer({ minimum: 1 })` is a documentation-and-validation hint, and `buildQuery`
throws for a bad `limit` as well, so the exported function is safe when called directly.

TypeBox **1.3.27** has no `Type.Nullable` and no `Type.Object` open-shape helper that keeps its
TypeScript type. Two idioms cover both gaps, and both appear in `src/schemas.ts`:

```ts
// nullable field: a two-member union
const NullableString = (description: string) =>
  Type.Union([Type.String(), Type.Null()], { description });

// arbitrary JSON: `Type.Unsafe`, because TypeBox infers `{}` from empty `properties`
export const JsonObjectSchema = Type.Unsafe<JsonObject>({
  type: "object",
  additionalProperties: true,
});
```

`Type.Unsafe<JsonObject>` is not decoration: Pi types `structuredContent` as `JsonValue`, and a
`Record<string, unknown>` is not assignable to `JsonObject` (`unknown` is not a `JsonValue`), so the
weaker type fails `tsc` on the tool's return value. `JsonObject` is exported by `pi-ai`, which is
already a peer dependency.

### Implementation boundary

The tool takes optional filter parameters; the implementation also takes the root, so tests
can point it at a fixture tree.

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

Two modules split the work:

- `src/list-sessions.ts` — discovery. Walks the root, reads and validates headers, nests
  transcripts, sorts warnings. Knows nothing about filtering, ordering, or limiting.
- `src/query.ts` — the query. `buildQuery(params)` returns `{ matchesRoot, compareRoots,
  limit }` and throws on bad parameters; `applyQuery(roots, query)` filters, sorts, and
  slices the **top level only**. It receives already-validated rows, so every parameter rule
  is testable through `listSessions` without touching disk.

`buildQuery` runs before the first `readdir`, which is why a malformed timestamp or a
reversed range fails on an unreadable root rather than returning `sessions: []` plus a
warning: a caller's typo must not look like absent history.

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

### `session_entries` boundary

`src/session-entries.ts` exports `readSessionEntries(params, { sessionsRoot, signal })`;
`src/session-entries-tool.ts` is the factory-wrapped tool, same shape as the listing. Confinement,
header checks, and line mapping all live in the one module, because there is no query layer to
separate from the walk.

**Confinement** (`resolveSessionPath`) is the only security-relevant rule:

1. `sessionPath` must be a non-empty string and `isAbsolute`. Nothing is resolved against the
   process cwd, so the same call means the same file from any directory a script happens to sit in.
2. `realpath(sessionsRoot)` runs first: a missing root is `sessions root is not readable`, matching
   the way the listing reports it.
3. `realpath(sessionPath)` runs second. If it throws, the path is checked **lexically**
   (`within(root, resolve(sessionPath))`) purely to choose the message: outside the root is a
   confinement error, inside it is `could not read session file`. A missing file must not look like
   a policy violation.
4. If it resolves, `within(root, file)` decides. This is the pass a symlink cannot fake: containment
   is computed on resolved targets, so a link planted inside the root and aimed at `/etc/passwd`
   resolves outside and throws. `within` treats the root itself as outside — a directory is not a
   session file.
5. The **resolved** path is what `readFile` opens, so replacing `sessionPath` with a different symlink
   after step 3 cannot redirect this read. A target swapped after resolution is not defended (no
   `O_NOFOLLOW`), which is the residual window; it only matters against a concurrent writer inside the
   operator's own sessions root, which is not the threat this confinement exists for.

**Header check** (`inspectHeaderLine`) is deliberately weaker than `validateHeaderLine` in
`src/session-metadata.ts`, which the listing uses. The listing returns `id`, `cwd`, and `timestamp`,
so it requires them; this operation returns none of them and reads only two facts from line 1 — that
`type === "session"` and what `version` says. Reusing the strict validator would make an old header
with an empty `cwd` hide a file whose entries are perfectly readable. What it does reject: a blank or
unparseable line 1, a line that is not an object, a `type` that is not `"session"`, and a `version`
that is present but not a positive integer.

**Line splitting** keeps physical numbering: `content.split("\n")`, one trailing empty element dropped
(a terminating newline is not a line), a leading BOM stripped before the split, and a single trailing
`\r` removed per line so CRLF files read cleanly. Line 1 is consumed by the header check; the loop
starts at index 1 and reports `index + 1` as `lineNo`.

**Entry acceptance** (`toEntry`) separates "addressable" from "describable":

| Field | Rule |
| --- | --- |
| `type` | must be a non-empty string and not `"session"`, else `invalid_entry` — a row nobody can name, or a header that has drifted off line 1 |
| `timestamp` | must be a string passing `isRealTimestamp`, else `invalid_entry` — a row nobody can place in time |
| `id` | non-empty string **and** a header `version` of at least 2, else `null`. Never rejects a line |
| `parentId` | same rule as `id`: non-empty string in a v2+ file, else `null` (a root, an absent field, or a non-string all read as null) |
| `messageRole` | the `message.role` string when `type === "message"`, else `null` |
| `raw` | the parsed line, cast to `JsonObject` — safe by construction, it came from `JSON.parse` |

`id` and `parentId` cannot be acceptance criteria — a missing one is a null, not a rejected row — and
in a version 1 file neither is citable, so `addressable` (header `version >= 2`) gates both. An
extension-written or partially migrated entry that lacks them in a v2+ file also simply reads as null.
`isRealTimestamp` is shared with the listing precisely so `2026-02-30` does not roll
over into March and reach the output as a timestamp.

**Version 1 is reported, never migrated.** `migrateSessionEntries` mints fresh random ids on every
call (`generateId` is collision-checked within one pass only), so a migrated id would look like a
durable citation and resolve to nothing on the next read. The reader therefore reports `id: null` and
`parentId: null` for every version 1 row **even when the line stores them** — `migrateV1ToV2` assigns
`entry.id = generateId(ids)` unconditionally, so Pi replaces a stored v1 id the next time it opens the
file — plus one `legacy_version` warning with `lineNo: null`. `raw` keeps what was actually written,
so nothing is hidden; the null is about citability, not about the bytes. `SessionManager.open()` is
never used for the same reason it is never used in the listing: it rewrites.

**Abort** is checked before resolving the path and again per line, so a huge file can be abandoned
mid-map rather than only before or after it.

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

The **top level** follows `sortBy` + `sortDirection`, defaulting to `timestamp` ascending.
A non-`timestamp` field falls back to `timestamp` and then to `path`; a `timestamp` sort
falls back straight to `path`, which is the documented unique handle, so the comparison is
total and a run is reproducible. `desc` negates the finished comparison — tie-breaks flip
with it, which is what "reverse the order" means to a caller. String comparisons are
codepoint-order `<`/`>`, never `localeCompare`, so ordering does not change with the
machine's locale.

**Children are exempt**: `subagentSessions` is always timestamp ascending, ties by `path`,
because a parent's runs must read in launch order. Sorting therefore happens twice — inside
`nestTranscripts` for children, inside `applyQuery` for roots — and `path` is absolute in
both because the sessions root is resolved with `path.resolve()` before the walk.

`warnings` are sorted by `path` (then `reason`) so a run is reproducible regardless of
`readdir` order, and they are never filtered: they describe the scan, not the kept subset.

### Filter rules

- **Scope.** `matchesRoot` is applied to top-level rows only, so a kept parent always
  arrives with its full tree. This is the alternative to pruning children, which would make
  "sessions in this range" unspeakable whenever a child's own `cwd` or timestamp differs.
- **Dates are UTC**, matching `new Date().toISOString()` in Pi's `session-manager.js` (196
  of 196 timestamps on this machine's store end in `Z`). A date-only start is
  `Date.UTC(y, m-1, d)`; a date-only end is that plus 86 400 000 ms, compared with `>=`, so
  the day is included whole. `23:59:59.999` was rejected as a cut because a header carrying
  more precision would silently vanish.
- **Date-times need an offset.** `ISO_DATE_TIME_WITH_OFFSET` gates the value before
  `Date.parse`, so a naive `"2026-02-01T12:30:00"` throws instead of resolving in the local
  zone. Values that do carry `Z` or `±HH:MM` are compared as instants, and the existing
  `isRealTimestamp` calendar check (exported from `session-metadata.ts`) rejects impossible
  dates that `Date.parse` would roll over.
- **`sibling-prefix` is lexical.** Trailing separators are stripped (`/repo/app` equals
  `/repo/app/`), then a candidate matches if it equals the requested path or shares its
  `dirname()` and has a basename starting with `<requested-basename>-`. No `git` call, no
  `realpath`, no case folding: path comparisons stay exactly as headers recorded them.
- **`limit` caps output, not work.** Headers are all read first; there is no index.
- **Errors are throws.** Unparseable bounds, impossible dates, naive date-times, a range
  ending before it starts, and `limit < 1` each throw, which the tool layer turns into a
  failed tool result. Matching nothing is not an error.

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

defineTool({
  name: "session_entries",
  label: "Session Entries",
  description: "...",
  parameters: SessionEntriesParamsSchema,
  outputSchema: SessionEntriesOutputSchema,
  exposure: "codemode",
  annotations: { readOnlyHint: true },
});
```

`src/index.ts` registers both against the same `join(getAgentDir(), "sessions")` root. The
`session_entries` description must keep stating what a caller cannot infer from one string
parameter: that the path is confined to the sessions root, that line 1 is the header and is never
returned, that `raw` is the whole line and can be megabytes, that entries arrive in file order with
every branch included, and that version 1 rows come back with null ids.

The registered `description` must keep telling the caller what it cannot infer from the
shape: that the default order is oldest-first so `sessions.at(-1)` is the newest, that
filters and ordering act on top-level sessions while children arrive whole and in launch
order, that a date-only `endTimestamp` means the whole UTC day, that `sibling-prefix` is a
path heuristic rather than git detection, that nesting is expressed by `subagentSessions`
while `parentSessionPath` is fork lineage, and that an empty list plus warnings means
unreadable rather than absent history. It currently does not say that `path` is the handle
to key on — see TODOs.

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

`session_entries` renders an index of lines and never a payload — one `lineNo type role id` bullet
per row, with `raw` left out entirely because a single entry can exceed the context window:

```
Entries (2)
- 2 message user aaaa1111
- 3 model_change

Warnings (2)
- file legacy_version: session version 1: entry ids are not durable, so id and parentId are null
- line 7 invalid_json: line is not valid JSON: Unexpected end of JSON input
```

A null `messageRole` or null `id` simply leaves that column out rather than printing `null`. The
warning prefix is `file` or `line N`, matching the `lineNo: null` / `lineNo: n` split in the JSON.

### Testing policy

The suite runs on Vitest (`npm run test`, `npm run coverage` for the v8 report over every
`src` module); `npm run check` is the gate that runs both the suite and `tsc --noEmit`. Tests
are TypeScript and live in `test/*.test.ts`, and `tsconfig.json` includes `test/**/*.ts` so
the suite is type-checked with the source.

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
containment, one row per run directory, symlink and non-slug exclusion, warning coverage,
and the parameter rules.

`test/list-sessions-filters.test.ts` covers parameters. It reads the committed fixtures for
shapes the walk already produces, and builds throwaway trees under `test/tmp/filters/`
(gitignored, written by the test) for grids the committed fixtures deliberately do not hold:
worktree-named siblings, timestamp boundaries at midnight and at `23:59:59.999`, and parent
rows with children whose `cwd` and timestamp fall outside the filter. Keeping those grids
out of `test/fixtures/sessions/` protects the whole-store assertions in
`test/list-sessions.test.ts`, which count rows and warnings exactly.

`test/tmp/` is generated state: nothing in it is committed, and no run may depend on what an
earlier run left behind. Three mechanisms enforce that, from strongest to weakest. **Every
scratch consumer owns its precondition** — `makeStore` removes its tree before rebuilding it,
`session-metadata.test.ts` truncates each numbered file as it writes it, and the empty-root
and absent-store cases in `test/list-sessions.test.ts` purge the path they assert on before
asserting, so the guarantee holds per test and survives a crashed run or a single-file run.
**`test/global-setup.ts`**, registered as Vitest `globalSetup`, removes
`test/tmp/` once before any test file is collected, which extends the fresh-tmp guarantee to
`npm test`, `npm run coverage`, `vitest run <file>`, and CI rather than only to the
`npm run check` entry point. **`npm run clean`** — the first step of `npm run check` — removes
`test/tmp/` for humans; it touches nothing else, so `coverage/` and `dist/` survive it, and
there is no teardown purge so a failing run's artifacts stay on disk to inspect. Verified both
ways: the suite is green with `test/tmp/` absent, as on a fresh clone, and green with stale
session trees planted under `test/tmp/`.

Caveat, and the reason the per-test purge is the primary mechanism rather than the hook: a
start-of-run purge of a shared root is unsafe against **two Vitest runs in the same checkout**
— the later run wipes the earlier one's scratch mid-flight. Run one suite at a time per worktree.

Measured against the **live** store on this machine: every parent and child transcript
discovered, 0 warnings, unique paths and ids, ordering correct, and the whole walk
completes in roughly 200 ms. Running subagent workflows here is still the way to grow real
parent/child trees for spot-checks — see TODOs.

`session_entries` is covered by `test/session-entries.test.ts` (confinement, header rules, physical
line numbers, arbitrary `raw`, the three warning codes, v1 nulls, abort) and
`test/session-entries-tool.test.ts` (registration shape, open `raw` subschema, structured output
equality, rendered rows, entry point registering both tools), plus a describe block in
`test/content.test.ts` for `renderSessionEntriesContent` (row columns, no `raw` leak, the empty
header, and the `file` versus `line N` warning prefixes). Its fixtures are throwaway files under
`test/tmp/session-entries*/` written by the tests themselves, not entries in
`test/fixtures/sessions/`: adding a multi-entry file there would change the row and warning counts
that `test/list-sessions.test.ts` asserts exactly.

Live-store spot-checks live in `scratch/` (not the suite, not the tarball, and never asserted on):
`node --experimental-strip-types scratch/entries-smoke.mts` reads one real session and rejects
`/etc/hosts`; `scratch/entries-size.mts` reports what the largest sessions return;
`scratch/entries-store.mts` reads every parent session; `scratch/entries-artifacts.mts` walks every
`.jsonl` under the root recursively. Measured 2026-10-02: of 215 `.jsonl` files under the root, 204
read with **0 warnings** and the other 11 — every `subagent-artifacts/*_transcript.jsonl` dump in the
store, counted independently — refused by the header check with no other error class appearing. Every
parent session read together: 145 files, 15,928 entries, 0 warnings, ~250 ms. `raw` came back within a
hair of the file size (2.46 MB from a 2.4 MB session), which is the number behind the unbounded-`raw`
limitation. These are live-store counts and drift while the operator works: the same walk measured
212 files an hour earlier. Re-measure rather than trusting the totals.

### Implementation guarantees

Restated from the caller half as properties a change must not break: a total, reproducible
order (top level per `sortBy`/`sortDirection` with `timestamp` then `path` tie-breaks,
children always timestamp ascending); `subagentSessions` always present; each file
reported at most once; containment-only child linkage with no structural field connecting
parents to children (Pi's `SessionHeader.parentSession` means fork/clone lineage, verified
against `pi-subagents` 0.74.0); `path` as the stable handle because `id` may repeat across
`run-<n>` directories; no use of Pi's `SessionManager.open()`, which can migrate or repair
history; and orphaned `--<slug>--` stems left unvisited, so only files reachable from a
discovered session are considered.

For `session_entries`: `sessionPath` is confined to the sessions root by `realpath` containment on
both sides, so no spelling or symlink route reaches a file outside it; line 1 is validated as a
session header and never returned; `lineNo` is the physical line and survives skipped lines;
nothing is migrated, repaired, or written; `id` and `parentId` are null rather than fabricated whenever
the file cannot supply a citable one — an absent id, and *any* id in a file older than version 2, which
Pi replaces on migration; every returned row has a real `type` and a validated `timestamp`;
unknown types, unknown roles, and unknown fields pass through `raw` untouched; and one skipped line
produces exactly one warning.

---

## TODOs

- **Verify grandchild nesting.** Every child transcript in the store measured here sits at
  `<slug>/<parent-stem>/<launch-uuid>/run-0/session.jsonl`; none launched their own
  subagent, so the recursive case is unexercised. Once a nested launch exists, confirm the
  convention — whether a child's own stem directory appears as `…/run-0/<child-stem>/…` —
  and that containment-based grouping does not attach a deep transcript to two parents.
- **Bound `session_entries` `raw`.** One call returns the whole file: measured 2.46 MB of `raw`
  from a 2.4 MB session, and `structuredContent` has no size cap, so a script that hands the rows
  back verbatim can spend more than the context window it is reading. Deferred parameters, not
  chosen yet: a row range (`startLine` plus `limit`, which composes with the physical `lineNo` the
  tool already promises) or a byte budget with an offset continuation. The decision that follows: a
  capped read reported as a warning, as a `complete: false` field, or as nothing at all.
- **Generate real fixture data.** Run subagent workflows in this project's `cwd` so that
  project's `--<slug>--/` session directory grows actual parent/child trees, then use them
  to check the synthetic layout against reality. Do not commit the output.
- **Remaining filter parameters.** Time range, `cwd`, ordering, and a row cap exist now.
  Still deferred: by presence or count of subagents, `includeCurrentSession` (the currently
  running session is included today; an exclusion parameter is the agreed future direction,
  most likely `excludePaths`), and a depth limit for `subagentSessions`.
- **Resolve or reject relative `cwds`.** Header `cwd` is always absolute, so a relative entry
  (`repos/app`) or a shell tilde (`~/repos/app`) matches nothing and looks like "no history for
  this project" rather than like a mistake. Two ways out, not chosen yet: reject a
  non-absolute entry in `buildQuery` — cheap, and it keeps the listing independent of where the
  caller sits, which matters because a codemode script may be asking about another checkout
  than its own session; or resolve before comparing, which needs the caller's working directory
  threaded in from `ExtensionContext.cwd`, a separate decision about `~` expansion, and accepts
  that the same parameters can select different sessions in two sessions. Nothing relative is
  pinned by a test today — `test/list-sessions-filters.test.ts` uses absolute entries, plus
  the non-matching `cwds: ["/repo/never"]` case that keeps `warnings` whole — so whichever way
  this goes, the test comes with it.
- **Pagination.** `limit` caps rows but does not cursor. If a store ever needs more, a
  cursor carrying the sort value plus `path` beats an `offset`, which shifts as history
  grows.
- **Orphaned child trees.** Today they are reported neither as a row nor as a warning. If
  that ever needs to be visible, it should become an explicit warning branch rather than a
  silent rule.
- **Tool description should name `path` as the handle.** The caller half says to key on
  `path` rather than `id`, but `description` in `src/list-sessions-tool.ts` lists the fields
  without saying which identifies a transcript. Worth one clause, since a caller reading
  only the description has no other way to learn it.
- **A context view, if ever wanted.** `session_entries` returns stored history: every branch, no
  compaction, `context_edit` unreplaced. The other question — what the model actually saw — needs
  Pi's `buildContextEntries` / `buildSessionProjection` over the same entries, which those exported
  free functions allow without `SessionManager.open()`. That is a second operation with its own
  contract, not a parameter on this one, and it stays unbuilt until it is discussed.
- **Entry-id addressing.** `parentId` comes back but no tree is computed, so a caller that wants one
  branch root→leaf either walks ids in a script or waits for a `fromId`-style parameter. If
  citations by entry id become the norm, decide whether the reader or a future view owns that.
