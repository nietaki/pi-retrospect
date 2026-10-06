# pi-retrospect

A [Pi](https://github.com/earendil-works/pi) package that gives an agent tools for
exploring past Pi sessions and the messages they contain — the read side of harness
self-improvement. An agent that can look back over its own previous sessions can find
the conversation where it hit a given error, recover a decision it made, and audit
what actually happened before repeating it.

**Status: 0.x, early.** Two operations are implemented — `list_sessions` (find session files) and
`session_entries` (read the entries inside one), both codemode-callable; see
[`docs/tool-api.md`](docs/tool-api.md) for their contracts. Anything beyond reading history —
searching it, ranking it, or writing back — stays out of scope until it is discussed.

## Install

```sh
pi install npm:pi-retrospect
```

Or try it for a single invocation without adding it to settings:

```sh
pi -e npm:pi-retrospect
```

`pi list` shows configured packages, `pi remove pi-retrospect` removes it.

**Requires Pi 0.99.0 or newer.** The tool registration uses `exposure`, `annotations`,
and `outputSchema`, which were added in Pi 0.99.0 (2026-09-29). Verified against
0.99.2 and 1.0.0. The peer ranges stay `"*"` because that is the convention Pi
prescribes for host-provided packages — Pi does not resolve them for managed installs,
so the minimum is stated here rather than in `package.json`.

## Using it

Two tools register, and they chain: `list_sessions` names transcript files, `session_entries` opens
one of them.

**`list_sessions`** walks the Pi sessions root, reads only each file's header line, and returns
session metadata — id, absolute path, absolute `cwd`, timestamp, fork lineage
(`parentSessionPath`) — with subagent transcripts nested under the session that launched them, plus
a warning for every file it had to skip.

All of its parameters are optional, and all of them act on **top-level** sessions — a
matching parent always arrives with its complete subagent tree:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `cwds` | all working directories | Absolute `cwd`s to keep. |
| `cwdMatch` | `"exact"` | `"sibling-prefix"` also keeps sibling directories whose basename extends the requested one — the shape of git worktrees placed next to the main checkout (a lexical path rule; no git metadata is read). |
| `startTimestamp`, `endTimestamp` | unbounded | Inclusive ISO 8601 bounds, read in the **host timezone**: a bare date is one whole calendar day, and a date-time with no offset is local to the machine running the tool. |
| `sortBy`, `sortDirection` | `"timestamp"`, `"asc"` | Top-level order only; children always stay in launch order. `"desc"` puts the newest first. |
| `limit` | none | Cap on returned rows, after filtering and sorting. Headers are still all read. |

```js
// in a codemode script — the project and its worktrees, ten newest first
const { sessions } = await tools.list_sessions({
  cwds: ["/Users/me/repos/my-app"],
  cwdMatch: "sibling-prefix",
  sortDirection: "desc",
  limit: 10,
});
```

**It is exposed to codemode, not to the model.** The tool registers with
`exposure: "codemode"`, so it is never declared in the model's tool list and is not
activated on registration. Call it from a codemode script:

```js
// in a codemode script
const { sessions, warnings } = await tools.list_sessions({});
```

A plain "list my sessions" prompt will not reach it unless your own settings declare
the tool directly. This is deliberate — the result is structured JSON that a script
can filter before it costs context — but it does mean the tool is invisible to a
session running without codemode.

**`session_entries`** takes `sessionPath` plus optional filters, and returns the entries of that file:
`{ lineNo, id, parentId, timestamp, type, messageRole, text, raw }`, where `raw` is the whole parsed JSON
line unchanged and `text` is the entry's primary human-readable body — a message's content, a
compaction or branch summary, a `custom_message` content, a `context_edit` replacement, a
`session_info` name, a usage note, a label, or the command of a `!` shell run — or `null` when the
entry has no such payload. Assistant thinking, tool calls, and images never reach `text`; they are
still in `raw`. Line 1 is the session header and is never returned, so `lineNo` starts at 2 and a
malformed line costs a warning without shifting the lines after it. Unknown entry types and unknown
message roles come back verbatim, and the call cannot leave the sessions root — a relative path, a
`..` traversal, a symlink that resolves outside it, and a file whose first line is not a session
header all throw.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `startLineNo`, `endLineNo` | unbounded | Inclusive physical line bounds. |
| `ids`, `parentIds` | unfiltered | Exact, case-sensitive sets of entry ids. A `null` field matches nothing, so a version 1 file is never selected. |
| `types`, `messageRoles` | unfiltered | Exact, case-sensitive sets. `messageRoles` reaches only `type: "message"` rows. |
| `startTimestamp`, `endTimestamp` | unbounded | Inclusive ISO 8601 bounds on each entry's own timestamp, read in the host timezone — the same grammar `list_sessions` uses. |
| `limit` | none | Cap on returned entries, applied after filtering. |

Filters are ANDed, values inside one array are ORed, and order is never configurable: rows come back
in file order. Filtering narrows the **result**, never the **scan** — `warnings` still describe the
whole file. To page, pass `startLineNo` one past the last `lineNo` you already read.

```js
// in a codemode script — project the rows in the script, never hand `raw` to a model
const { sessions } = await tools.list_sessions({ sortDirection: "desc", limit: 1 });
const { entries, warnings } = await tools.session_entries({
  sessionPath: sessions[0].path,
  messageRoles: ["assistant"],
});

if (warnings.length > 0) return { skipped: warnings.length, warnings };

return entries.map((entry) => ({
  lineNo: entry.lineNo,
  said: entry.text,
  stopReason: entry.raw.message.stopReason,
}));
```

`raw` is unbounded per row — as large as the entries it keeps (a 2.4 MB session returned 2.46 MB of
`raw`) — and `text` is bounded only by the entry it was projected from (measured max 51 KB), so it is
a codemode-only tool by design. It reads stored history: no compaction, no
`context_edit`, no branch selection is applied, so it is not the model's context view. In a session
file older than version 2, `id` and `parentId` come back `null` even where the line stores them — Pi
replaces every id when it migrates such a file — and one `legacy_version` warning says so; `lineNo`
is the handle that stays valid, and `raw` keeps what was written.

## Reference

- [`docs/tool-api.md`](docs/tool-api.md) — the contract for the operations this
  package exposes: `list_sessions` (discovery rules, filters, ordering, guarantees) and
  `session_entries` (sessions-root confinement, line addressing, entry filters, the `text`
  projection, `raw`, warning codes).
- `test/fixtures/generate.mjs` (source repository, not in the npm tarball) — rebuilds
  the synthetic session tree the tests run against.

The deeper reference on Pi's session *format* — the measurements and Pi-internals
analysis this contract was derived from — lives in the author's Obsidian vault rather
than in the published package, because it documents Pi's schema (which changes with
Pi, not with this package) and quotes counts from one developer's local session store.

## Development

Run the gate locally with `npm run check` — it cleans `test/tmp/`, runs the Vitest suite,
then type-checks with `tsc --noEmit`. Do not run two Vitest processes in one checkout at
once: the start-of-run purge is not concurrency-safe.

CI is `.github/workflows/ci.yml`: on pull requests, pushes to `master`, and manual dispatch it
installs with `npm ci`, runs `npm run check`, and verifies the tarball contents with
`npm pack --dry-run`. It publishes nothing.

## License

MIT — see [`LICENSE`](LICENSE).
