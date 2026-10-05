# Tool API

The contract for the operations `pi-retrospect` exposes: `list_sessions`, which finds session
files, and `session_entries`, which reads the entries inside one of them.

These are read primitives. Neither one searches, summarizes, nor rebuilds the model's context.

## Calling `list_sessions`

### Purpose

`list_sessions` returns metadata for every discoverable Pi session, with subagent
transcripts nested under the session that launched them. It is the entry point for
"which past session do I want to look at" — it names sessions and locates them on disk;
it does not read the conversation inside them.

The call is **read-only**: it opens each file's first line directly and never goes through
Pi's `SessionManager.open()`, which can migrate or repair history. Nothing is written.

### Availability and invocation

The tool registers with `exposure: "codemode"`. That has three consequences a caller must
know:

- It is **callable from codemode scripts and listed by the `codemode` tool**, but it is
  never declared to the model and is not activated on registration. A plain "list my
  sessions" prompt does not reach it unless your own settings declare the tool directly.
- A script receives the **structured JSON result**, so filtering costs no context before
  you decide what to look at.
- The rendered text (`content`) is visible only in transcripts, logs, and UI rendering,
  and nested tool results do not become transcript entries — the JSON is reachable only
  from inside a script that asked for it.

It takes **optional** parameters; `{}` means "everything, oldest first".

```js
// in a codemode script
const { sessions, warnings } = await tools.list_sessions({});
```

### Parameters

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `cwds` | `string[]` | all | Absolute working directories to keep. At least one entry when present. Entries are compared literally, so a relative path or a `~`-prefixed one matches nothing — it is not resolved against the caller's directory (see TODOs). |
| `cwdMatch` | `"exact" \| "sibling-prefix"` | `"exact"` | How a `cwds` entry is matched; see below. |
| `startTimestamp` | ISO 8601 date or date-time | unbounded | Inclusive lower bound. |
| `endTimestamp` | ISO 8601 date or date-time | unbounded | Inclusive upper bound. |
| `sortBy` | `"timestamp" \| "cwd" \| "path" \| "id"` | `"timestamp"` | Field the top-level sessions are ordered by. |
| `sortDirection` | `"asc" \| "desc"` | `"asc"` | Direction for the top level only. |
| `limit` | integer ≥ 1 | none | Maximum top-level rows returned, applied after filtering and sorting. |

Four rules decide most of what callers ask:

1. **Filters act on top-level sessions only.** A parent that matches arrives with its
   complete `subagentSessions` tree — children are never filtered, counted against `limit`,
   or re-ordered. A delegated run whose own `cwd` differs from its parent still comes along.
2. **Dates are calendar days in the host timezone**, and a date-time carrying no offset is read
   there too: `startTimestamp: "2026-09-01"` is local midnight on 2026-09-01. A **date-only
   `endTimestamp` covers that whole day** — the bound is the next local midnight and is never
   kept, so nothing is lost to a `23:59:59.999` cut. A day is measured as two local midnights
   rather than 86 400 000 milliseconds, so a 23- or 25-hour daylight-saving day is spanned
   correctly. Pi writes header timestamps with `new Date().toISOString()`: measured on this
   machine's store, 196 of 196 timestamps end in `Z`, so the zone can only ever move a *bound*,
   never a stored instant.
3. **A naive bound is portable by coincidence.** A date-time carrying `Z` or `±HH:MM` is one
   instant everywhere, so `"2026-02-01T13:30:00+01:00"` and `"2026-02-01T12:30:00Z"` are the same
   bound. One with no offset is read in the host zone, so the same filter string can select
   different sessions on two machines — write `Z` when the range matters. Bounds are shape-gated
   to ISO 8601 by `src/timestamps.ts`, so `1/2/2026`, `Jan 2 2026`, and `12345` throw instead of
   resolving to a date nobody meant; `2026-02-30` has the shape and no date, and the parser rolls
   it to March 2, which is the bound you get. Both date-time bounds are inclusive.
4. **`limit` is an output cap, not an I/O bound.** Headers are still read for every session
   before the top N are picked, so a small `limit` shortens the result, not the scan.

`sibling-prefix` exists for **git worktrees created next to the main checkout**. Given
`/repos/app` it also matches `/repos/app-feature-a` and `/repos/app-review`, because their
basename starts with `app-` and their parent directory is `/repos`. It does not match
`/repos/application` (no dash separator), `/other/app-feature` (wrong parent directory), or
`/repos/app/sub` (nested rather than sibling). It is a **lexical path rule and nothing
else**: no git metadata is read, so `/repos/app-backup` — an ordinary directory that happens
to be named that way — matches, and a worktree created with `git worktree add` somewhere
else does not. Callers who need certainty about worktrees still have to check the directory.

Errors are thrown, not returned as empty results: a bound that is not ISO 8601 shaped
(`"1/2/2026"`, `"12345"`, `"yesterday"`), one whose shape is right and has no instant behind it
(`"2026-13-01"`), a range whose end resolves before its start, and a `limit` below 1 all fail before
any file is opened. A shape-right, calendar-wrong date such as `"2026-02-30"` does not throw: the
parser rolls it to March 2 and that is the bound you get. A call that merely matches nothing returns
`sessions: []`.

### Quick examples

Every example below is a codemode script body: top-level `await` and a top-level `return`
work, and the returned value is what the calling agent sees.

Newest recorded session — the default order is oldest-first, so the entry you usually want
is last. `sortDirection: "desc"` puts it first instead:

```js
const { sessions, warnings } = await tools.list_sessions({});
const newest = sessions.at(-1);

return newest
  ? { path: newest.path, cwd: newest.cwd, timestamp: newest.timestamp }
  : { path: null, warnings };
```

Sessions for one project — no script-side filtering needed:

```js
const project = "/Users/me/repos/my-app";
const { sessions } = await tools.list_sessions({ cwds: [project] });

return sessions.map((session) => ({ path: session.path, timestamp: session.timestamp }));
```

The main checkout plus its worktrees, newest first, capped at ten:

```js
const { sessions } = await tools.list_sessions({
  cwds: ["/Users/me/repos/my-app"],
  cwdMatch: "sibling-prefix",
  sortDirection: "desc",
  limit: 10,
});

return sessions.map((session) => ({ path: session.path, cwd: session.cwd }));
```

One calendar month, date-only bounds — each bound is that day in the host timezone, so on a
machine west of UTC the first hours of September 1 belong to the August 31 day:

```js
const { sessions } = await tools.list_sessions({
  startTimestamp: "2026-09-01",
  endTimestamp: "2026-09-30", // the whole of the 30th is included
});

return sessions.map((session) => session.path);
```

Every transcript, parents and children flattened, newest last:

```js
function flatten(sessions, depth = 0) {
  return sessions.flatMap((session) => [
    { depth, path: session.path, cwd: session.cwd, timestamp: session.timestamp },
    ...flatten(session.subagentSessions, depth + 1),
  ]);
}

const { sessions } = await tools.list_sessions({});
return flatten(sessions).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
```

Delegated work: root sessions that have subagent children, with their run count:

```js
const { sessions } = await tools.list_sessions({});

return sessions
  .filter((session) => session.subagentSessions.length > 0)
  .map((session) => ({
    path: session.path,
    cwd: session.cwd,
    runs: session.subagentSessions.length,
  }));
```

The result is an index of transcript files. To read one, pass its `path` to a file-reading
tool; a `.jsonl` transcript is one JSON object per line, which `read` handles directly.

### Result fields

```ts
type ListSessionsOutput = {
  sessions: SessionMetadata[];
  warnings: ListSessionsWarning[];
};
```

| Field | Caller meaning |
| --- | --- |
| `id` | Session id from the file header. Not a safe key — see Limitations. |
| `path` | Absolute path to the session `.jsonl` file. **The handle to key on**: unique among returned rows, and what you hand to a file-reading tool. |
| `timestamp` | Header timestamp as stored, accepted only once the session parser can read it; safe to sort and compare, and not necessarily strict ISO 8601. |
| `cwd` | Absolute working directory of the session. Empty `cwd` never appears: such files are skipped. |
| `parentSessionPath` | Optional. Fork/clone lineage copied verbatim from the header. **Not** the nesting relationship. |
| `subagentSessions` | Transcripts launched under this session, nested recursively. Always present; `[]` when there are none. |

```ts
type ListSessionsWarning = {
  path: string;   // absolute path of the skipped file or directory
  reason: string; // free-form text, not an enum
};
```

### Interpreting the hierarchy

Two different "parent" concepts exist and are unrelated:

- **Nesting** is expressed only by `subagentSessions`. Each transcript is attached to the
  discovered session whose directory is the closest containing directory of its path, so a
  transcript never appears under two parents.
- **`parentSessionPath`** is Pi's header `parentSession` value: fork/clone lineage between
  top-level sessions. It is copied verbatim with no resolution, normalization, or existence
  check, and it does not point at the entry that nests the transcript. Do not use it to
  walk `subagentSessions`.

Every discovered transcript is reported **at most once**, either as a row or as a warning.

### Ordering

By default arrays are **oldest first** — `timestamp` ascending, ties broken by `path`, at
every nesting level. `sortBy` and `sortDirection` change the **top-level** order only:
`desc` reverses the whole comparison, tie-breaks included, and every non-`timestamp` field
still falls back to `timestamp`, then `path`, so the order stays total and reproducible.
`subagentSessions` is always timestamp ascending regardless of those two parameters.
`warnings` are sorted by `path`, then `reason`, and are never filtered.

**Caller rule:** with defaults the sessions you usually want are at the tail — use
`sessions.at(-1)` for the newest, or ask for `sortDirection: "desc"` and read the head.
Ascending at the child level is deliberate: it puts a parent's subagent runs in launch
order, and re-ordering them would hide which run came first.

### Warnings and empty results

How to read the shape of a response:

| `sessions` | `warnings` | What it means |
| --- | --- | --- |
| non-empty | empty | Clean read of the store. |
| non-empty | non-empty | Usable sessions, but some files were skipped. Say so if completeness matters. |
| `[]` | empty | Nothing discoverable: no `--<slug>--` project directory held a readable session header. An existing-but-empty root looks exactly like this — no warning. |
| `[]` | non-empty | **Unreadable history, not absence of history.** Inspect the reasons before concluding there are no sessions. |

Neither case is an error. A root that cannot be read returns one warning naming the
resolved path; an existing root with nothing discoverable returns
`{ sessions: [], warnings: [] }`. A fresh install therefore never looks broken — see
Missing or empty root in the maintainer half.

The `warnings` array is flat: it does not say which nesting level the failure happened at.
A failed child is simply absent from its parent's `subagentSessions` list, plus one warning
naming the child's path — so a parent can look childless while its child tree was
partially unreadable. A child directory that does not exist at all is the normal case and
adds no warning.

### Caller guarantees

1. Every row has `id`, absolute `path`, absolute non-empty `cwd`, and a `timestamp` the session
   parser (`src/timestamps.ts`) can read. There are no partial rows and no `Invalid Date`.
2. `subagentSessions` is always present; `[]` for a session with no children.
3. Ordering is total and reproducible: the top level follows `sortBy`/`sortDirection` with
   timestamp and `path` tie-breaks, children are always timestamp ascending, ties by `path`.
4. Filters and `limit` select top-level sessions; a kept parent arrives with its complete
   subagent tree, and `warnings` cover the whole scan rather than the kept subset.
5. A file is reported at most once, as a row or as a warning. Every file the walk
   *considered* costs exactly one warning if it is skipped — but the walk does not consider
   everything on disk, so "no warnings" does not mean "the store is complete". See
   Limitations.
6. The call is read-only and cannot repair or migrate history.

### Limitations

- **`id` is not guaranteed unique across rows.** `path` is the handle to key on. A session
  id could repeat across `run-<n>` directories if Pi ever reuses one; today's store has only
  `run-0`, so this is unverifiable rather than known-safe.
- **The hierarchy is inferred from on-disk layout**, not from a structural field. It is a
  `pi-subagents` storage convention, not Pi's own model.
- **Orphaned child trees are invisible.** A `--<slug>--` directory whose stem has no
  matching parent `.jsonl` is never visited, so its transcripts are reported neither as a
  row nor as a warning. The same is true of everything else the discovery rules exclude.
  "No warnings" means "nothing I reached was unreadable", not "the store is complete".
- **Grandchild nesting is unverified against real data.** See TODOs.
- **Filtering is in-process, and there is no pagination.** The parameters filter, order, and
  cap rows after every header has been read; no index or cursor exists, so a `limit` never
  makes the walk cheaper. There is no offset or cursor parameter either — narrow the time
  range instead. The currently running session **is** included — verified
  2026-10-02, where `sessions.at(-1)` matched `$PI_SESSION_FILE`. Exclude it yourself by
  comparing against that variable if you mean "previous sessions only".
- **Sessions only.** Message content is out of scope for this operation — that is
  `session_entries`, which takes a `path` from here and reads the entries inside the file.

---

## Calling `session_entries`

### Purpose

`session_entries` reads one session file and returns its entries, each addressed by its physical
line number and carrying the parsed line unchanged as `raw`. It is the step after `list_sessions`:
that operation names transcript files, this one opens one.

It is a **reader of stored history**, not a view of a conversation. It applies no compaction, no
`context_edit` replacement, and no branch selection, and it never migrates anything — see
"What this is not" below.

The call is read-only: the file is streamed line by line with `FileHandle#readLines()` and never
opened through Pi's `SessionManager.open()`, which can rewrite a legacy file or append a missing
newline.

### Availability and invocation

Registered with `exposure: "codemode"` and `annotations.readOnlyHint`, like `list_sessions`: callable
from codemode scripts and listed by the `codemode` tool, never declared to the model. A script gets
`structuredContent`, so `raw` costs context only if the script chooses to spend it.

```js
// in a codemode script
const { entries, warnings } = await tools.session_entries({ sessionPath });
```

### Parameters

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `sessionPath` | absolute path string | — | **Required.** A session `.jsonl` file under the sessions root — normally a `path` returned by `list_sessions`, including a nested subagent transcript path. |

The path is confined to the sessions root, so this operation cannot read an arbitrary `.jsonl`:

1. A relative path, or one containing `..` that leaves the root, throws.
2. Confinement is decided with `realpath` on **both** sides. A symlink planted inside the root whose
   target is outside it resolves to that target and throws — the rule follows the bytes, not the
   spelling. A symlink that stays inside the root is fine.
3. A path that cannot be resolved is reported by what the caller got wrong: outside the root is a
   confinement error, inside it is `could not read session file`.
4. Line 1 must be a session header. A file whose first line is not one throws `not a Pi session file`
   — which is what keeps non-session `.jsonl` that live inside the root (a `subagent-artifacts/`
   transcript dump, whose first line is `{"version":1,"recordType":"message",…}`) out. A missing or
   unreadable root throws `sessions root is not readable`, and a header `version` that is present but
   is not a positive integer throws too.
5. A later line carrying `type: "session"` is **not** an entry: it is skipped with `invalid_entry`,
   because line 1 is the only place a header belongs.

Confinement is decided when the path is resolved, and the **resolved** path is what gets opened — so
swapping the symlink afterwards does not redirect the read to somewhere else. What is not defended is
a swap of the resolved target itself between resolution and opening (no `O_NOFOLLOW` open is used),
which only matters if another process is rewriting the sessions root while this call runs.

Anything else about the file — a blank line, a truncated line, an entry from an unknown future Pi —
is a warning, not an error.

### Quick examples

The last user prompt of the newest session, without reading the rest:

```js
const { sessions } = await tools.list_sessions({ sortDirection: "desc", limit: 1 });
const { entries } = await tools.session_entries({ sessionPath: sessions[0].path });

const user = entries.filter((e) => e.messageRole === "user").at(-1);
return user?.raw.message.content;
```

Counting entry types across a session, keeping `raw` inside the script:

```js
const { entries, warnings } = await tools.session_entries({ sessionPath });
const byType = entries.reduce((m, e) => m.set(e.type, (m.get(e.type) ?? 0) + 1), new Map());

return { count: entries.length, byType: Object.fromEntries(byType), warnings };
```

Pairing a tool call with its result by id rather than by adjacency (a result is often not the direct
child of its call):

```js
const { entries } = await tools.session_entries({ sessionPath });
const calls = new Map();
for (const e of entries) {
  if (e.messageRole !== "assistant") continue;
  for (const block of e.raw.message.content)
    if (block.type === "toolCall") calls.set(block.id, { lineNo: e.lineNo, name: block.name });
}

return entries
  .filter((e) => e.messageRole === "toolResult" && e.raw.message.isError)
  .map((e) => ({ lineNo: e.lineNo, ...calls.get(e.raw.message.toolCallId) }));
```

### Result fields

```ts
type SessionEntriesOutput = {
  entries: SessionFileEntry[];
  warnings: SessionEntriesWarning[];
};

type SessionFileEntry = {
  lineNo: number;              // physical line, >= 2; the handle that always resolves
  id: string | null;           // entry id, or null when the file carries none
  parentId: string | null;     // null for a root, an absent value, or a non-string
  timestamp: string;           // entry timestamp, as stored, once the session parser can read it
  type: string;                // verbatim — an unknown type is preserved, not rejected
  messageRole: string | null;  // role of a "message" entry, else null
  raw: object;                 // the whole parsed line, unchanged
};

type SessionEntriesWarning = {
  lineNo: number | null;       // null only for `legacy_version`, which describes the file
  code: "invalid_json" | "invalid_entry" | "legacy_version";
  reason: string;              // prose, not an enum
};
```

| `code` | Raised when | Effect |
| --- | --- | --- |
| `invalid_json` | the line is blank, or does not parse | line skipped |
| `invalid_entry` | the line parsed but is not an object, has no `type`, is a second header row, or has no real `timestamp` | line skipped |
| `legacy_version` | the header `version` is absent or below 2 | nothing skipped; every row's `id` and `parentId` are `null`, because a version 1 id does not survive a Pi migration — even an id the file stores |

`raw` is the parsed line exactly as stored — Pi's fields, plus anything a newer Pi or an extension
wrote, including fields this package has never seen. Nothing is decoded, re-encoded, reordered, or
dropped from it.

### What this is not

- **Not the model's context.** No compaction summary replaces older entries, no `context_edit`
  replacement is applied, and the stored leaf and active branch are ignored. `entries` is every line
  in the file, including abandoned branches and the raw text that an edit later replaced. For
  "what the model actually saw" you need Pi's `buildContextEntries`/`buildSessionProjection`, which
  this package does not wrap yet.
- **Not chronological.** `entries` is in **file order**, which is write order. A session whose leaf
  was moved backwards interleaves branches, and a resumed subagent run appends. Sort by `timestamp`
  yourself if you want time order — and pick deliberately between entry time and
  `raw.message.timestamp`, which is Unix milliseconds for a message.
- **Not tree-shaped.** `parentId` is returned, but no nesting is computed: a forked branch, an
  orphan, and a linear run all look the same here.

### Caller guarantees

1. Line 1 is never returned, and `lineNo` is the **physical** line: a skipped line costs a warning
   and shifts nothing. A line break is LF, CRLF, or a lone CR — the rule Node's readline applies — and
   Pi writes LF, so for any file Pi produced this is `\n` counting. Only a hand-edited file with mixed
   endings numbers differently than `wc -l` would.
2. Every row has a `type` string and a `timestamp` the session parser can read. `id` and `parentId` are
   `string | null`, and the null is about citability rather than contents: a value appears only when
   the header `version` is at least 2, because Pi replaces every id when it migrates a version 1
   file. What the line actually stored stays visible in `raw`.
3. `messageRole` is non-null only for `type === "message"`, and is the stored role verbatim —
   including a role this package has never seen.
4. Each skipped line produces exactly one warning, in line order, so `entries.length` plus skipped
   lines accounts for the whole file.
5. Nothing is written. The file is neither migrated nor repaired.

### Limitations

- **`raw` is unbounded.** The result is as large as the session file: measured 2026-10-02 on one
  store, the largest session (2.4 MB) returned 356 entries and 2.46 MB of `raw`. Filter and project
  inside a script; never return `entries` to a model, and never print `raw`.
- **No range, no filter, no byte budget.** There is no line range, entry-type filter, or limit: the
  scan takes the whole file. It streams, so the file's bytes are not held at once, but the **result**
  is held whole — `entries` carrying `raw` is as large as the session, which is the cost that matters.
- **`lineNo` is the only durable handle here, and it is durable only while the file is.** Pi appends
  and `createBranchedSession` writes new files, so a line number is a citation into a snapshot, not
  a permanent address. `id` is the stable handle for a v2+ file; in a version 1 file it is `null`
  even when the line stores one, because `migrateV1ToV2` assigns `entry.id = generateId(ids)`
  unconditionally — so the stored value would be replaced the next time Pi opens the file, and this
  tool returns `null` rather than minting or preserving an id it cannot stand behind.
- **Header fields are checked only as far as this operation needs.** `list_sessions` requires a
  non-empty `id` and `cwd` because it returns them; here a file whose header lacks them still reads,
  because its entries are readable.

