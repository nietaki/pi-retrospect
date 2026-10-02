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

It takes no parameters: pass an empty object.

```js
// in a codemode script
const { sessions, warnings } = await tools.list_sessions({});
```

Every example below is a codemode script body: top-level `await` and a top-level `return`
work, and the returned value is what the calling agent sees.

### Quick examples

Newest recorded session — arrays are oldest-first, so the entry you usually want is last:

```js
const { sessions, warnings } = await tools.list_sessions({});
const newest = sessions.at(-1);

return newest
  ? { path: newest.path, cwd: newest.cwd, timestamp: newest.timestamp }
  : { path: null, warnings };
```

Sessions for one project:

```js
const { sessions } = await tools.list_sessions({});
const project = "/Users/me/repos/my-app";

return sessions
  .filter((session) => session.cwd === project)
  .map((session) => ({ path: session.path, timestamp: session.timestamp }));
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

Arrays are **oldest first** — `timestamp` ascending, ties broken by `path`, at every
nesting level. `warnings` are sorted by `path`, then `reason`.

**Caller rule:** the sessions you usually want are at the tail. Use `sessions.at(-1)` for
the newest; never assume the first element is the most recent. Ascending is deliberate at
the child level because it puts a parent's subagent runs in launch order. If you keep
wanting newest-first at the root, that is a parameter request, not a default to flip — see
TODOs.

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
3. Ordering is total and reproducible (timestamp ascending, ties by `path`).
4. A file is reported at most once, as a row or as a warning. Every file the walk
   *considered* costs exactly one warning if it is skipped — but the walk does not consider
   everything on disk, so "no warnings" does not mean "the store is complete". See
   Limitations.
5. The call is read-only and cannot repair or migrate history.

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
- **No filtering, no pagination.** `params` is an empty object by design; every filter is
  yours to write in the script. The currently running session **is** included — verified
  2026-10-02, where `sessions.at(-1)` matched `$PI_SESSION_FILE`. Exclude it yourself by
  comparing against that variable if you mean "previous sessions only".
- **Sessions only.** Message content is out of scope for this operation.

