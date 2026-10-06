# Tool API

The contract for the operations `pi-retrospect` exposes: `list_sessions`, which finds session
files, and `session_entries`, which reads the entries inside one of them.

These are read primitives. Neither one searches, summarizes, nor rebuilds the model's context.

Measurements quoted below come from one-off scripts kept in `scratch/` — not committed, not part of
the suite — run against the live session store. They drift; re-measure rather than trusting them.

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
   correctly. Pi writes header timestamps with `new Date().toISOString()`: measured on the live
   store, 196 of 196 timestamps end in `Z`, so the zone can only ever move a *bound*,
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
  range instead. The currently running session **is** included — verified against the live
  store. Exclude it yourself by comparing against `$PI_SESSION_FILE` if you mean "previous sessions
  only".
- **Sessions only.** Message content is out of scope for this operation — that is
  `session_entries`, which takes a `path` from here and reads the entries inside the file.

---

## Calling `session_entries`

### Purpose

`session_entries` reads one session file and returns its entries, each addressed by its physical
line number and carrying the parsed line unchanged as `raw`, plus `text`: the entry's primary
human-readable body when it has one, projected from that line. It is the step after `list_sessions`:
that operation names transcript files, this one opens one.

Optional parameters filter the rows — a line range, id and parent sets, entry types, message roles,
a timestamp window, and a cap. They narrow what is **returned**, never what is **read**: the file is
still scanned to its last line, so `warnings` describe the whole file whatever the parameters say.

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
| `startLineNo` | integer ≥ 1 | unbounded | Inclusive lower bound on the physical line number. |
| `endLineNo` | integer ≥ 1 | unbounded | Inclusive upper bound on the physical line number. |
| `ids` | non-empty `string[]` | unfiltered | Keep entries whose `id` is one of these. |
| `parentIds` | non-empty `string[]` | unfiltered | Keep entries whose `parentId` is one of these. |
| `startTimestamp` | ISO 8601 date or date-time | unbounded | Inclusive lower bound on each entry's own timestamp. |
| `endTimestamp` | ISO 8601 date or date-time | unbounded | Inclusive upper bound on each entry's own timestamp. |
| `types` | non-empty `string[]` | unfiltered | Keep entries whose `type` is one of these. |
| `messageRoles` | non-empty `string[]` | unfiltered | Keep message entries whose role is one of these. |
| `limit` | integer ≥ 1 | none | Maximum entries returned, applied after filtering. |

### Filters

1. **Categories are ANDed, values inside one array are ORed.**
   `{ types: ["message", "compaction"], messageRoles: ["user"] }` keeps user messages and no
   compaction row: the array offers alternatives, the categories stack. A parameter that is absent
   constrains nothing, and `{}` still means "every entry in the file".
2. **Matching is exact and case-sensitive**, on the returned field rather than on `raw`. There is no
   substring, no glob, and no fold: `ids: ["u"]` selects nothing, `types: ["Message"]` selects
   nothing, and a type this package has never seen is selectable only by naming it exactly.
3. **A null never matches.** `ids` and `parentIds` read the citable `id` / `parentId`, so a version 1
   file — where both are `null` even when the line stores values — is never selected, and a root entry
   is not selected by any `parentIds` value. `messageRoles` reads `messageRole`, which is `null` for
   every non-message row, so no role string reaches a `model_change` entry even if it is spelled the
   same way.
4. **Bounds are inclusive on both ends**, for lines and for timestamps. `startLineNo: 1` and
   `startLineNo: 2` are the same query: line 1 is the header and can never be a row.
5. **Timestamps mean what `list_sessions` timestamps mean** — one shared grammar in `filters.ts` and
   `timestamps.ts`. A bare date names a whole local day, so a date-only `endTimestamp` covers that day
   to its last millisecond; a date-time with no offset is read in the host timezone. Pi writes entry
   timestamps as UTC `Z` strings, so the zone can only ever move a bound, never a stored instant.
   The window compares each entry's own `timestamp`, never the header's.
6. **`limit` is an output cap, not an I/O bound** — the same rule `list_sessions` states for its own
   `limit`. Rows past the cap are dropped and their `raw` is not retained, which is what makes a
   filtered read of a large session affordable; the scan still runs to the end of the file, because a
   truncated scan would silently truncate `warnings` too.
7. **A filtered row is not a skipped row.** It costs no warning: `warnings` accounts for lines that
   could not become entries, and filters account for rows that exist and were not asked for.

**Bad parameters are refused before the file is opened**, so a mistake cannot look like a missing
session, and they are refused by name. Line bounds and `limit` are positive integers; a filter array
must hold at least one value; a reversed line range (`endLineNo` below `startLineNo`), a reversed
timestamp window, and a timestamp the shape gate refuses all throw. Because the check runs before any
path resolution, a bad filter outranks a confinement failure or a missing file.

**Ordering is not a parameter.** Rows return in physical file order — write order, not time order —
whatever the filters, so a filtered read is always a contiguous slice of the transcript's own order.

**Pagination is a line bound, not an offset.** `offset` was deliberately left out: it counts matching
rows, so a page boundary moves whenever the filter changes and it cannot be computed from what a
previous call returned. A physical bound is stable and self-describing:

```js
// pages of 200 entries, advancing from the last line number already seen
let from = 2;
const pages = [];

for (;;) {
  const { entries } = await tools.session_entries({ sessionPath, startLineNo: from, limit: 200 });
  if (entries.length === 0) break;
  pages.push(entries);
  from = entries.at(-1).lineNo + 1;
  if (entries.length < 200) break;
}

return pages.flat();
```

The cost of the choice: a page is `limit` rows **from line `startLineNo` onward**, not the rows at
positions `offset..offset + limit` of the filtered set, so a caller who wants "the 500th matching
row" must count them itself.

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

The last user prompt of the newest session, without holding the rest of the file:

```js
const { sessions } = await tools.list_sessions({ sortDirection: "desc", limit: 1 });
const { entries } = await tools.session_entries({
  sessionPath: sessions[0].path,
  messageRoles: ["user"],
});

return entries.at(-1)?.text;
```

Every tool result that errored, without reading the rows in between:

```js
const { entries } = await tools.session_entries({ sessionPath, messageRoles: ["toolResult"] });

return entries
  .filter((e) => e.raw.message.isError)
  .map((e) => ({ lineNo: e.lineNo, content: e.raw.message.content }));
```

The head of a huge transcript, cheaply: `limit` drops the rows it cannot keep, so the result holds
200 entries' worth of `raw` rather than the file's.

```js
const { entries, warnings } = await tools.session_entries({ sessionPath, limit: 200 });

return { count: entries.length, firstLine: entries[0]?.lineNo, warnings };
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
  text: string | null;         // the entry's primary human-readable body, else null (see below)
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

### The `text` projection

`text` answers the question a caller would otherwise ask `raw` about: what did this entry actually
say. It is **the entry's stored prose, taken from the field that carries it** — never a serialization
of `raw`, and never a rendering of a field that has no text form. One role needs two fields: Pi
persists a system message with an empty `content` and its prompt in `sections`, so that role joins them
the way Pi's own renderer does (see below).

| Entry | Source |
| --- | --- |
| `message` / `user`, `toolResult`, `custom` | `message.content` |
| `message` / `system` | `message.content`, then every non-`null` `message.sections` value, in stored order, joined with `"\n\n"` — **not** `toolsAdded` or `toolsRemoved` |
| `message` / `assistant` | the `type: "text"` blocks of `message.content` — **not** thinking, tool calls, or images |
| `message` / `bashExecution` | `message.command` only |
| `message` / `branchSummary`, `compactionSummary` | `message.summary` |
| `custom_message` | `content` |
| `compaction`, `branch_summary` | `summary` |
| `context_edit` | `replacement.content` — null when `replacement` is null (an omission has no text) |
| `session_info` | `name` |
| `usage` | `note` — the token and cost numbers are not text |
| `label` | `label` — null when the row clears a label |
| `custom`, `model_change`, `thinking_level_change`, any unknown type, any unknown role | null |

The rules that hold across the table:

- **A content array contributes its `type: "text"` blocks, joined with `"\n"`.** Images contribute
  nothing (`data` is base64, and a single image block costs more than the median session's entire
  visible conversation), and a block that is malformed — missing `text`, or `text` not a string — is
  dropped rather than poisoning the join.
- **Assistant thinking is never in `text`.** It is natural language and would be findable, but it is
  the model's reasoning rather than what it said, and measured on the live store it *outlines* visible
  text: two of every three assistant rows carry thinking and no visible text at all, so folding it in
  would make `text` mostly reasoning. It stays in `raw.message.content`, reachable per block type.
- **A system message contributes its content *and* its sections.** `content` alone projected nothing:
  measured over the live store, **all 168 parent-session system rows persisted
  `content: ""`**, because `buildSystemPromptState` in `@earendil-works/pi-coding-agent` returns
  `{ content: "", sections }` for every prompt it builds normally and puts prose in `content` only for a
  forced, section-less prompt. The rule is `getSystemMessageText` in `@earendil-works/pi-ai` — content,
  then every non-`null` section value in stored order, joined with `"\n\n"` — so this is Pi's own
  definition of a system message's text, not an invented rendering. Nothing needs re-wrapping either:
  `buildSystemPromptSections` stores each value already tag-wrapped (`"<tools>\n…\n</tools>"`, with only
  `preamble` untagged), so the join reproduces the prompt verbatim.
  Three consequences a caller has to hold:
  - The result is **one message's own rendered state**, not the session's effective prompt. The first
    system row that names sections declares the whole set; later rows patch by name — 28 of the 155
    parent sessions hold more than one system row, and their later rows carry e.g. `{ skills }` alone —
    so the text of a patch row is the new block. Folding a sequence into the prompt the model ended up
    with is a replay over `sections` by name, which no row here performs (the recipe is below).
  - A section value of `null` is a removal marker and contributes nothing: 0 of the 168 rows used
    one, but `SystemMessage.sections` is typed `Record<string, string | null>` and Pi's
    renderer skips nulls, so this does too.
  - The **tool loadout stays out**: `toolsAdded` carries complete JSON Schemas, which is why a rendered
    system message is only about a third of its own `raw` bytes.
  Stored order is followed, not canonicalized, and JSON reorders integer-like keys — Pi warns about that
  in the `SystemMessage.sections` docstring — so a section named `2026` would lead. It is the same order
  Pi's renderer sees, so the two still agree.
- **No rendering of state.** A `model_change` has a provider and a model id, and a `custom` entry has
  extension `data` that may be a string by coincidence. Turning either into text would invent a
  presentation and put it in the data layer.
- **`null`, never `""`.** A row whose source is absent (a `session_info` with no `name`), empty
  (a content array holding no text), or unrecognized gets `null`. The field is always present on the
  row — it is a `string | null`, like `id`, `parentId`, and `messageRole`, not an optional key.
- **Nothing is trimmed or truncated.** Pi's bytes survive: `"  keep the padding \n"` comes back with
  its padding. `text` is bounded only by the entry it was projected from, so a row can still be large —
  measured over every parent session in the live store (155 files, 17,348 rows): 64% of
  rows carry text, mean 2.1 KB, max 51 KB (a `toolResult`), a `compaction` summary averages 9.8 KB, and
  a `system` row averages 16.7 KB (max 38.3 KB) — the largest category by mean. The system rule costs
  little next to `raw`: over 40 sampled sessions its rendered prompts add 0.55 MB to the 15.5 MB a full
  read already returns, about 3.5%, because two-thirds of a system row's `raw` is tool schemas. And
  `renderSessionEntriesContent` sends no payloads at all, so none of it reaches a model unless a script
  puts it there. `limit` and the filters remain the only bound on a result.

Coverage by kind on that same store, as ratios rather than totals (a session store grows daily, so
re-measure rather than trusting these — see `docs/maintainer-reference.md`): **every** `toolResult`,
`custom_message`, `compaction`, `session_info`, and `bashExecution` row had text; `user` rows were
99.5%, the misses carrying content with no text in it; `assistant` rows were about a third, the rest
thinking and tool calls only; `system` rows were 162 of 168, the misses being rows that carry only
`toolsAdded`/`toolsRemoved` with neither `content` nor `sections`. None of the measured `context_edit`
rows carried a replacement either: all of them omitted their target, which is the `null` branch.

The point of the field is that the common read needs no knowledge of Pi's content-block shapes:

```js
// every prompt the user typed, in file order, without touching raw
const { entries } = await tools.session_entries({ sessionPath, messageRoles: ["user"] });

return entries.flatMap((e) => (e.text === null ? [] : [{ lineNo: e.lineNo, text: e.text }]));
```

Because a system row's `text` is one message's own state, the prompt a session actually ran is a fold
over its system rows — a caller-side recipe, not something any row here computes. It spells out
`getCurrentSystemMessage` plus `getSystemMessageText` from `@earendil-works/pi-ai`, so it runs in a
plain script:

```js
// the effective system prompt at the end of a session, and what each row changed
const { entries } = await tools.session_entries({ sessionPath, messageRoles: ["system"] });

const contents = [];
const sections = new Map(); // patched by name, in first-declared order
const changes = [];

for (const { raw } of entries) {
  const message = raw.message;
  const text =
    typeof message.content === "string"
      ? message.content
      : (message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (text !== "") contents.push(text); // later content is appended to the base prompt
  for (const [name, value] of Object.entries(message.sections ?? {})) {
    if (value === null) sections.delete(name); // a removal marker
    else sections.set(name, value); // a later row replaces by name
  }
  changes.push({ timestamp: raw.timestamp, names: Object.keys(message.sections ?? {}) });
}

return { prompt: [...contents, ...sections.values()].join("\n\n"), changes };
```

One order caveat the fold has to survive: a session can open with a row that only changes the tool
loadout, which names neither `content` nor `sections`, projects `null`, and contributes nothing (6 of
the 168 parent rows in the live store). Folded as above over the same store, 118 of the 155 parent
sessions hold a system row, every one of them agrees with Pi's `getCurrentSystemPrompt`, and 3 lead
with such a loadout-only row.

### What this is not

- **Not the model's context.** No compaction summary replaces older entries, no `context_edit`
  replacement is applied, and the stored leaf and active branch are ignored; a `system` row's `text` is
  that message's own rendered state, not the prompt the model holds after later patch rows. `entries` is
  every line in the file that the filters let through, including abandoned branches and the raw text
  that an edit later replaced. For "what the model actually saw" you need Pi's
  `buildContextEntries`/`buildSessionProjection`, which this package does not wrap yet.
- **Not chronological.** `entries` is in **file order**, which is write order. A session whose leaf
  was moved backwards interleaves branches, and a resumed subagent run appends. Sort by `timestamp`
  yourself if you want time order — and pick deliberately between entry time and
  `raw.message.timestamp`, which is Unix milliseconds for a message.
- **Not tree-shaped.** `parentId` is returned, but no nesting is computed: a forked branch, an
  orphan, and a linear run all look the same here.

### Caller guarantees

1. Line 1 is never returned, and `lineNo` is the **physical** line: a skipped line costs a warning
   and shifts nothing, and a filtered line shifts nothing either. A line break is LF, CRLF, or a lone
   CR — the rule Node's readline applies — and Pi writes LF, so for any file Pi produced this is `\n`
   counting. Only a hand-edited file with mixed endings numbers differently than `wc -l` would.
2. Every row has a `type` string and a `timestamp` the session parser can read. `id` and `parentId` are
   `string | null`, and the null is about citability rather than contents: a value appears only when
   the header `version` is at least 2, because Pi replaces every id when it migrates a version 1
   file. What the line actually stored stays visible in `raw`.
3. `messageRole` is non-null only for `type === "message"`, and is the stored role verbatim —
   including a role this package has never seen.
4. `text` is present on every row, and is `null` unless the entry has a recognized textual payload
   that holds text. It is projected from `raw` and never replaces it: whatever `text` leaves out
   (thinking, tool calls, images, a bash execution's output, every field of a state-only entry) is
   still in `raw`, unchanged. See "The `text` projection" above for the mapping and its measurements.
5. Each skipped line produces exactly one warning, in line order, **whatever the filters are**: a
   limited or windowed read still reports every line of the file that could not become an entry, and
   a row excluded by a filter produces none. So `warnings` always accounts for the file, and
   `entries` accounts only for the rows that were asked for.
6. Filters never reorder or renumber: `entries` stays a subsequence of the file's own order, and a
   `lineNo` read from one call means the same line in another call against the same bytes.
7. Nothing is written. The file is neither migrated nor repaired.

### Limitations

- **`raw` is unbounded per row, and only `limit` and the filters bound the whole.** The result is as
  large as the rows it keeps: measured on the live store, the largest session (2.4 MB) returned
  356 entries and 2.46 MB of `raw`, and an unfiltered read still returns all 356. A filtered read
  retains only the rows it keeps — a dropped row's `raw` is never held — but one row can still be
  megabytes, because there is no per-row budget. Filter and project inside a script; never return
  `entries` to a model, and never print `raw`.
- **Filters do not shorten the scan.** There is a line range, a timestamp window, entry-type and role
  sets, and a row cap, but the reader still walks every line of the file — it must, to keep
  `warnings` whole-file. So a `limit: 1` read of a 2.4 MB session costs the same parse as a full one
  and returns a fraction of the rows. There is no byte budget and no early-exit hint.
- **`lineNo` is the only durable handle here, and it is durable only while the file is.** Pi appends
  and `createBranchedSession` writes new files, so a line number is a citation into a snapshot, not
  a permanent address. `id` is the stable handle for a v2+ file; in a version 1 file it is `null`
  even when the line stores one, because `migrateV1ToV2` assigns `entry.id = generateId(ids)`
  unconditionally — so the stored value would be replaced the next time Pi opens the file, and this
  tool returns `null` rather than minting or preserving an id it cannot stand behind.
- **Header fields are checked only as far as this operation needs.** `list_sessions` requires a
  non-empty `id` and `cwd` because it returns them; here a file whose header lacks them still reads,
  because its entries are readable.

