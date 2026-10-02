# Tool API

The contract for the operations `pi-retrospect` exposes.

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
2. **Dates are UTC calendar days**, because Pi writes header timestamps with
   `new Date().toISOString()`: measured on this machine's store, 196 of 196 timestamps end
   in `Z`. `startTimestamp: "2026-09-01"` is `2026-09-01T00:00:00.000Z`. A **date-only
   `endTimestamp` covers that whole day**: `"2026-09-30"` keeps every session up to
   `2026-09-30T23:59:59.999Z` and drops `2026-10-01T00:00:00.000Z`. Internally that is the
   exclusive start of the next day, not a `23:59:59.999` cut, so no session is lost to
   sub-millisecond precision.
3. **A date-time boundary must carry a timezone** (`Z` or `±HH:MM`). A naive date-time would
   otherwise be read in the machine's local zone, so the same filter string could select
   different sessions on two machines; it throws instead. With an offset, the comparison is
   the instant, so `"2026-02-01T13:30:00+01:00"` and `"2026-02-01T12:30:00Z"` are the same
   bound. Both date-time bounds are inclusive.
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

Errors are thrown, not returned as empty results: an unparseable or impossible calendar date
(`"2026-02-30"`), a naive date-time, a range whose end resolves before its start, and a
`limit` below 1 all fail before any file is opened. A call that merely matches nothing
returns `sessions: []`.

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

One calendar month, date-only bounds:

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
| `timestamp` | Valid ISO 8601 header timestamp; always parseable, so it is safe to sort and compare. |
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

1. Every row has `id`, absolute `path`, absolute non-empty `cwd`, and a parseable ISO 8601
   `timestamp`. There are no partial rows and no `Invalid Date`.
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
- **Sessions only.** Message content is out of scope for this operation.

