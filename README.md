# pi-retrospect

`pi-retrospect` is a [Pi](https://github.com/earendil-works/pi) package for
learning from previous Pi sessions. It helps agents recover prior context, audit
completed work, compare approaches, understand how a task was handled, and improve
the local harness that produced it.

Past sessions can reveal repeated failures, ineffective instructions, tool friction,
delegation problems, and opportunities to improve local skills, prompts, tools, and
workflows.

The package provides two read-only tools for discovering recorded sessions and
inspecting their entries. It also includes a skill that guides agents through
retrospective analysis and an optional setting that makes steering corrections easier
to find later.

> **Status:** `pi-retrospect` is an early 0.x package. Its session-discovery and
> transcript-reading tools are implemented and usable, but broader capabilities such
> as ranking or modifying history remain out of scope until their behavior is
> discussed.

## What can it help with?

- Recover decisions or context from an earlier session.
- Understand how a previous task was approached.
- Audit what an agent or delegated subagent actually did.
- Compare approaches used across multiple sessions.
- Find recurring failures, corrections, or misunderstandings.
- Identify improvements to instructions, skills, prompts, tools, and workflows.

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
| `includeCurrentSession` | `false` | Keep the session this call runs inside. By default it is dropped, with the transcripts nested under it, before filtering, sorting, and `limit` — a retrospective normally means earlier sessions. Pi names it by its session file, never by id, so a copy of it survives; an ephemeral session has no file and so excludes nothing. |
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
// every session but this one, oldest first
const { sessions, warnings } = await tools.list_sessions({});
```

A plain "list my sessions" prompt will not reach it unless your own settings declare
the tool directly. This is deliberate — the result is structured JSON that a script
can filter before it costs context — but it does mean the tool is invisible to a
session running without codemode.

**`session_entries`** takes `sessionPath` plus optional filters, and returns the entries of that file:
`{ lineNo, id, parentId, timestamp, type, messageRole, text, raw }`, where `raw` is the whole parsed JSON
line unchanged and `text` is the entry's primary human-readable body — a message's content, a system
message's content plus its prompt sections, a compaction or branch summary, a `custom_message` content,
a `context_edit` replacement, a `session_info` name, a usage note, a label, or the command of a `!`
shell run — or `null` when the entry has no such payload. Assistant thinking, tool calls, and images
never reach `text`; they are still in `raw`. Line 1 is the session header and is never returned, so
`lineNo` starts at 2 and a
malformed line costs a warning without shifting the lines after it. Unknown entry types and unknown
message roles come back verbatim, and the call cannot leave the sessions root — a relative path, a
`..` traversal, a symlink that resolves outside it, and a file whose first line is not a session
header all throw.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `startLineNo`, `endLineNo` | unbounded | Inclusive physical line bounds. |
| `ids`, `parentIds` | unfiltered | Exact, case-sensitive sets of entry ids. A `null` field matches nothing, so a version 1 file is never selected. |
| `types`, `messageRoles` | unfiltered | Exact, case-sensitive sets. `messageRoles` reaches only `type: "message"` rows. |
| `search` | unfiltered | Literal substring search over `text`: `{ terms: string[], caseSensitive?: boolean }`. A row matches when its non-null `text` contains **any** term. Case-insensitive by default. |
| `startTimestamp`, `endTimestamp` | unbounded | Inclusive ISO 8601 bounds on each entry's own timestamp, read in the host timezone — the same grammar `list_sessions` uses. |
| `limit` | none | Cap on returned entries, applied after filtering. |

Filters are ANDed, values inside one array are ORed, and order is never configurable: rows come back
in file order. Filtering narrows the **result**, never the **scan** — `warnings` still describe the
whole file. To page, pass `startLineNo` one past the last `lineNo` you already read.

`search` is the one filter that is not exact. Terms are literal bytes — no pattern, no tokenization,
no glob — so `["h.llo"]` matches only `h.llo` and `["the"]` matches inside `there`; a term of `""` and
an empty `terms` array are refused rather than read as "every row". It runs over `text`, never `raw`,
so thinking, tool calls, images, and the output of a `!` shell run are unreachable (they are still in
`raw` for a script to filter), and a row whose `text` is null is never a hit. Because a `system` row's
`text` is that message's rendered prompt, an ordinary word matches harness text — the preamble, the
tool rules, every `AGENTS.md` — so AND the search with `types` or `messageRoles` when the question is
about what was said.

```js
// in a codemode script — project the rows in the script, never hand `raw` to a model
// the newest *previous* session: this one is dropped before `limit` applies
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

```js
// in a codemode script — the rows that mention one error, in the conversation only
const { entries } = await tools.session_entries({
  sessionPath,
  search: { terms: ["ETIMEDOUT", "connection timed out"] },
  messageRoles: ["user", "assistant", "toolResult"],
});

return entries.map((entry) => ({ lineNo: entry.lineNo, role: entry.messageRole, text: entry.text }));
```

`raw` is unbounded per row — as large as the entries it keeps (a 2.4 MB session returned 2.46 MB of
`raw`) — and `text` is bounded only by the entry it was projected from (measured max 51 KB on a tool
result), so it is a codemode-only tool by design. A `system` row is the largest category `text` carries
by mean (16.7 KB, max 38.3 KB): it projects that message's rendered prompt, which is one message's own
state — a session folds several such rows to get the prompt the model actually had.

It reads stored history: no compaction, no `context_edit`, no branch selection is applied, so it is not
the model's context view. In a session file older than version 2, `id` and `parentId` come back `null`
even where the line stores them — Pi
replaces every id when it migrates such a file — and one `legacy_version` warning says so; `lineNo`
is the handle that stays valid, and `raw` keeps what was written.

## Steering-message markers

A mid-run correction often means the agent misunderstood the task. Making those corrections findable
turns one-off friction into evidence of recurring harness problems: an instruction that is not
landing, a tool that keeps getting misused, or a repo whose `AGENTS.md` needs a clearer rule.

### Enable marking

Installing the package registers the two read-only tools without changing input. To opt into marking,
set `markSteeringMessages` in the user-level `~/.pi/agent/settings.json` or a trusted project's
`.pi/settings.json`, which Pi merges over the user value:

```json
{
  "piRetrospect": {
    "markSteeringMessages": true
  }
}
```

The default is `false`. After editing the settings file, run `/reload`.

### What gets marked

While the setting is enabled, `pi-retrospect` prepends `STEERING: ` to steering input submitted from
the interactive UI or an RPC client while the agent is streaming. It leaves idle prompts, queued
follow-ups, extension-generated input, slash-prefixed input, and text that already starts with the
exact marker unchanged. Attached images are preserved.

The prefix is part of the user message sent to the model and stored in the transcript, not separate
metadata. This changes what the model sees — often usefully, because the correction is explicitly
labelled — as well as making the message searchable later.

### Find and interpret markers

Use a literal, case-sensitive search over user messages, then keep entries where the automatic marker
appears as a prefix:

```js
// in a codemode script — the marked steering messages of one session
const { entries, warnings } = await tools.session_entries({
  sessionPath,
  messageRoles: ["user"],
  search: { terms: ["STEERING: "], caseSensitive: true },
});

return {
  steeringMessages: entries
    .filter(({ text }) => text?.startsWith("STEERING: ") === true)
    .map(({ lineNo, text }) => ({ lineNo, text })),
  warnings,
};
```

Treat matches as high-signal candidates, not authoritative metadata. A user can type the same prefix
manually, and unmarked steering can exist when the setting was disabled or the input belonged to an
excluded category. Inspect the surrounding conversation before deciding why the user intervened, and
compare sessions before concluding that a misunderstanding recurs.

Only messages submitted while marking is enabled receive the prefix. Existing history is never
rewritten, and disabling the setting does not remove markers already stored. The full behavior is in
[`docs/tool-api.md`](docs/tool-api.md#marking-steering-messages).

## Reference

- [`docs/tool-api.md`](docs/tool-api.md) — the contract for the operations this
  package exposes: `list_sessions` (discovery rules, filters, ordering, guarantees) and
  `session_entries` (sessions-root confinement, line addressing, entry filters, the literal
  `text` search, the `text` projection, `raw`, warning codes).
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

### Releasing

Releases are run locally with [release-it](https://github.com/release-it/release-it). Start from a
clean `master` branch that tracks its upstream and make sure npm is authenticated for this package.
Preview the interactive flow without changing Git or npm state:

```sh
npm run release:dry-run
```

A dry run still performs read-only prerequisite checks such as npm authentication. For a real
release, run either the interactive version selector or name the SemVer increment explicitly:

```sh
npm run release
npm run release -- patch
```

The release runs `npm run check`, updates `package.json` and `package-lock.json`, creates and pushes
a `chore: release vX.Y.Z` commit and `vX.Y.Z` tag, and publishes the package to npm. The existing
`prepublishOnly` guard runs the checks again immediately before publication, so a direct
`npm publish` remains protected too. This workflow does not create a GitHub Release or maintain a
changelog.

## License

MIT — see [`LICENSE`](LICENSE).
