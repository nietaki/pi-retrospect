# Tool API

`pi-retrospect` exposes two read-only operations:

- `list_sessions` discovers recorded Pi sessions and nested subagent transcripts.
- `session_entries` reads and filters the entries in one discovered transcript.

It can also mark steering messages as they are submitted so later retrospective searches can find
likely corrections and misunderstandings. The marker is opt-in; the tools remain read-only whether or
not it is enabled.

Both tools can be bounded by one operator setting, `piRetrospect.allowedProjects`, which decides which
session projects either tool may reach at all. It is enforced by the extension rather than by the
parameters a caller chooses. See [Restricting session access](#restricting-session-access).

This document is the caller reference: it defines parameters, result fields, behavior that affects
correct use, the two settings, and common workflows. Implementation details and
maintainer-oriented analysis live in [`maintainer-reference.md`](maintainer-reference.md).

## Calling the tools

Both tools register with `exposure: "codemode"`. By default they are callable from codemode scripts
and listed by the `codemode` tool, but they are not declared directly to the model. A script receives
the structured result, so it can filter and project data before returning anything to model context.

```js
const { sessions, warnings: discoveryWarnings } = await tools.list_sessions({
  sortDirection: "desc",
  limit: 1,
});
if (sessions.length === 0) return { session: null, discoveryWarnings };

const { entries, warnings: entryWarnings } = await tools.session_entries({
  sessionPath: sessions[0].path,
  messageRoles: ["user", "assistant"],
});

return {
  entries: entries.map(({ lineNo, messageRole, text }) => ({ lineNo, messageRole, text })),
  discoveryWarnings,
  entryWarnings,
};
```

That listing takes no `includeCurrentSession`, so it reads the newest **previous** session: the running
one is dropped before `limit` applies. See
[Current-session exclusion](#current-session-exclusion).

Avoid returning complete entries or `raw` values unless the task needs them. Transcript rows can be
large, while a codemode script can retain only the relevant fields.

## Restricting session access

Which sessions exist under the sessions root is a fact about every project that ever ran Pi, and a
caller chooses what to look at by naming `cwds` and paths. `piRetrospect.allowedProjects` is the
operator's answer to that: an upper bound the **extension** enforces on both tools, which no parameter
of a call can widen.

Add it to the user-level `~/.pi/agent/settings.json` or a trusted project's `.pi/settings.json`:

```json
{
  "piRetrospect": {
    "allowedProjects": ["payments-service", "internal-tools"]
  }
}
```

Values are project **basenames** — the final segment of a session's working directory — rather than
absolute paths, so one committed configuration means the same thing on every machine that holds those
checkouts.

### What the list means

| Configuration | Effect |
| --- | --- |
| Omitted: no namespace, no key, or a key holding nothing | Every project is reachable — the behavior from before the setting existed. |
| `["*"]`, alone or beside named projects | Every project is reachable. The exact `"*"` is read as the wildcard before anything else. |
| `[]` | No project is reachable. An empty list is a decision, not an absent one. |
| `["bar", "baz"]` | Only sessions whose project basename is `bar` or `baz`, or a `-`-suffixed sibling of one of them. |
| Anything else: a value that is not a list, an item that is not a string, an empty item, or an item holding a path separator or reading as `.` or `..` | Both tools throw. A bound that cannot be read is never read as no bound. |
| Effective settings that the tool cannot read on a call | The same throw. A tool that cannot ask what is allowed does not assume that everything is. |

Matching is lexical and case-sensitive on the basename, and no parent directory is consulted:
`bar` admits `/Users/me/bar` and the adjacent worktree `/Users/me/bar-issue-7`, and refuses
`/Users/me/barista` and `/Users/me/Bar`. A trailing separator changes nothing
(`/Users/me/bar/` is `bar`), and nothing is resolved against the filesystem, so the same
configuration answers the same way wherever it is read.

### What the bound covers

- `list_sessions` reports no session, no nested transcript, and no warning from a denied project. The
  bound is asked of each validated header while discovering, before that session's child transcripts
  are walked, so a denied tree never becomes observable metadata.
- `session_entries` authorizes a directly addressed transcript through the **top-level session that
  owns its directory**. A delegated run is therefore readable when its parent's project is allowed,
  whatever cwd the run's own header carries — and a path no allowed top-level session owns is refused,
  including a path that was guessed rather than returned by `list_sessions`.
- `cwds` and `cwdMatch` select which *permitted* sessions to return and cannot widen the bound: a
  filter naming a denied project yields nothing.
- Sessions-root confinement still applies first and independently. A path outside the root is the
  confinement failure it has always been, configured bound or not.

Both refusals name the setting and nothing else, so a failed call cannot confirm which project it
refused, which path existed, or how many sessions were skipped:

| Failure | Thrown message |
| --- | --- |
| `allowedProjects` cannot be read as a policy, or the effective settings cannot be read | `piRetrospect.allowedProjects is not a valid project allowlist` |
| A transcript's project is not allowed | `session is outside the projects allowed by piRetrospect.allowedProjects` |

A denial is never an empty result. `session_entries` throws; `list_sessions` returns the sessions the
bound does allow, and describes nothing about the ones it dropped.

### Reloading and project override

The bound is read from Pi's effective settings on **every** call, so `/reload` picks up an edit without
restarting Pi, and nothing is cached while the extension loads.

Pi merges project settings over user settings, and `allowedProjects` is replaced rather than
intersected: a project that configures `["*"]` widens a restrictive user policy back to everything.
That is deliberate — a trusted project is expected to be able to inspect all sessions — and it means
the bound is only as strong as the settings Pi has merged. `allowedProjects` is not protection against
a repository whose configuration you would not trust.

### Compact example

```js
// Settings: { "piRetrospect": { "allowedProjects": ["payments-service"] } }

// A filter cannot reach past the bound: nothing from that project is returned, and nothing is
// said about it. `warnings` says nothing about a denied project either, though unrelated warnings
// from projects this call may see still appear.
const denied = await tools.list_sessions({ cwds: ["/Users/me/internal-tools"] });
// → denied.sessions is []

// An allowed project still behaves as before, and its `-`-suffixed siblings come with it.
const { sessions } = await tools.list_sessions({
  cwds: ["/Users/me/payments-service"],
  cwdMatch: "sibling-prefix",
});
// → `/Users/me/payments-service`, `/Users/me/payments-service-issue-4`, and any other sibling
//   whose name continues it with a dash
```

### Limitations

- Basenames are compared, not paths, so two different checkouts both named `api` are one project to
  this rule — `/Users/me/api` and `/tmp/api` are the same answer. Configure a name that identifies the
  project you mean and nothing else.
- A `-`-suffixed sibling is admitted because of its **name**, not because Git made it a worktree, so
  `payments-service-archive` and `payments-service-scratch` are reachable whenever `payments-service`
  is. The rule is deliberately the same shape `cwdMatch: "sibling-prefix"` already uses, which is a
  naming convention rather than a fact about the repository.
- A file whose own header cannot be read has no trustworthy cwd. Its warning disappears only when the
  directory it sits in was already established as a denied project; a directory holding nothing but
  unreadable files was never established as anything, so it keeps warning, because suppressing that
  would hide unrelated corruption to win nothing. A project directory that cannot be listed at all is
  the same case: nothing was established about it.
- A transcript under the root that no discoverable top-level session owns — a file at the root itself,
  or one under a directory Pi did not name from a cwd — has no project to authorize, so a configured
  bound refuses it. Without a bound it stays readable, as it is today.
- The bound governs these two tools. It is not a filesystem permission: another process, or another
  tool in the same session, can still read the same files directly.

## Marking steering messages

Add this opt-in setting to the user-level `~/.pi/agent/settings.json` or a trusted project's
`.pi/settings.json`:

```json
{
  "piRetrospect": {
    "markSteeringMessages": true
  }
}
```

After manually changing settings, run `/reload`. Pi merges user and project settings, so a project can
override the user-level value. Omitting the setting, or setting it to `false`, leaves input unchanged.

When enabled, `pi-retrospect` prepends `STEERING: ` to steering input submitted while an agent is
streaming. It marks steering received from both the interactive UI and RPC clients. It does not mark:

- ordinary idle prompts or queued follow-up messages;
- input generated by an extension;
- slash-prefixed input, so commands, skills, and prompt templates keep their normal behavior; or
- text that already starts with the exact `STEERING: ` prefix.

Attached images are preserved. The prefix is part of the user message sent to the model and stored in
the transcript; it is not out-of-band metadata. This both emphasizes the correction to the active
agent and makes it available through the ordinary `session_entries.text` projection and literal
search:

```js
const { entries, warnings } = await tools.session_entries({
  sessionPath,
  messageRoles: ["user"],
  search: { terms: ["STEERING: "], caseSensitive: true },
});

return {
  steeringMessages: entries.map(({ lineNo, text }) => ({ lineNo, text })),
  warnings,
};
```

Only messages submitted while this setting is enabled receive the marker. Existing transcript entries
are not rewritten, and disabling the setting does not remove prefixes already stored.

## Shared conventions

### Timestamps

Both operations accept inclusive ISO 8601 timestamp bounds:

- A date such as `"2026-09-01"` means that calendar day in the host timezone. A date-only end bound
  includes the whole day.
- A date-time with `Z` or an explicit offset identifies the same instant on every host.
- A date-time without an offset is interpreted in the host timezone.

Use an explicit offset when the exact instant matters. Invalid timestamp syntax and a range whose end
precedes its start throw before session data is read.

### Filters, limits, and scanning

Filters and `limit` reduce the returned structured data, not the underlying scan. `list_sessions`
still reads every discoverable header, and `session_entries` still scans the whole selected file. This
keeps warnings complete and bounds what enters context, but it is not an indexed or early-exit query.

### Errors and warnings

Invalid parameters and requests that cannot identify a readable Pi session throw. A call whose
configured access bound cannot be read, and a `session_entries` read of a transcript outside that
bound, both throw as well, and their message names the setting rather than the session
([Restricting session access](#restricting-session-access)). Recoverable problems encountered while
walking the session store or reading later transcript lines are returned in a `warnings` array. Check
warnings whenever the task depends on complete history.

---

## `list_sessions`

### Purpose

`list_sessions` returns metadata for discoverable Pi sessions. Top-level sessions contain nested
`subagentSessions`, allowing a caller to choose a parent or delegated transcript before reading its
entries. The operation reads session headers only and never migrates or repairs history.

### Parameters

Every parameter is optional; `{}` returns every discoverable top-level session except the running one,
in ascending timestamp order — within the projects the operator allowed, if any
([Restricting session access](#restricting-session-access)).

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `cwds` | non-empty `string[]` | all | Absolute working directories to keep. Relative and `~`-prefixed values are compared literally and normally match nothing. Selects within the access bound; cannot widen it. |
| `cwdMatch` | `"exact" \| "sibling-prefix"` | `"exact"` | How each `cwds` value is matched. `sibling-prefix` also includes sibling directories shaped like adjacent worktrees. |
| `includeCurrentSession` | boolean | `false` | Keep the session this call runs inside. By default it is excluded, with the transcripts nested under it, before filtering, sorting, and `limit`. |
| `startTimestamp` | ISO 8601 date or date-time | unbounded | Inclusive lower bound on the session header timestamp. |
| `endTimestamp` | ISO 8601 date or date-time | unbounded | Inclusive upper bound; a date-only value covers that whole local day. |
| `sortBy` | `"timestamp" \| "cwd" \| "path" \| "id"` | `"timestamp"` | Field used to order top-level sessions. |
| `sortDirection` | `"asc" \| "desc"` | `"asc"` | Top-level sort direction. |
| `limit` | integer ≥ 1 | none | Maximum top-level sessions returned after filtering and sorting. |

### Result

```ts
type ListSessionsOutput = {
  sessions: SessionMetadata[];
  warnings: ListSessionsWarning[];
};

type SessionMetadata = {
  id: string;
  path: string;
  timestamp: string;
  cwd: string;
  parentSessionPath?: string;
  subagentSessions: SessionMetadata[];
};

type ListSessionsWarning = {
  path: string;
  reason: string;
};
```

| Field | Meaning |
| --- | --- |
| `id` | Session id from the file header. It is not guaranteed unique across every returned transcript. |
| `path` | Absolute path to the session `.jsonl` file. Use this as the transcript handle and pass it to `session_entries`. |
| `timestamp` | Header timestamp as stored, accepted once the session parser can read it. |
| `cwd` | Absolute, non-empty working directory recorded in the header. |
| `parentSessionPath` | Optional fork or clone lineage copied from the header. It is not the nesting relationship for subagents. |
| `subagentSessions` | Nested delegated transcripts. Always present; `[]` when there are none. |
| `warnings` | Files or directories that were reached but could not produce session metadata. Reasons are prose, not enum values. |

### Selection and hierarchy

Filters and `limit` apply to top-level sessions only. A matching parent arrives with its complete
reachable `subagentSessions` tree; children are not filtered and do not count toward `limit`.

An access bound removes projects *before* any of this applies: a session in a denied project is not
filtered out by a parameter, it is never discovered for the call at all, and neither it nor its
children nor its warnings appear anywhere in the result.

Subagent nesting and `parentSessionPath` describe different relationships:

- `subagentSessions` follows the supported on-disk layout for delegated runs.
- `parentSessionPath` is Pi's fork/clone lineage value and is copied without resolution.

Do not use `parentSessionPath` to traverse delegated sessions.

#### Sibling worktree matching

`sibling-prefix` is a lexical path rule, not Git detection. Given `/repos/app`, it also matches
siblings such as `/repos/app-feature` and `/repos/app-review`. It does not match `/repos/application`,
`/other/app-feature`, or `/repos/app/sub`.

Consequently, an ordinary sibling named `/repos/app-backup` matches, while a real Git worktree placed
elsewhere does not.

#### Current-session exclusion

The session this call runs inside is dropped from `sessions` unless `includeCurrentSession: true` asks
for it. Its identity is the session **file** Pi reports for the call, compared as a resolved absolute
path:

- Not `id`. Two files can carry the same header id — a copy, a fork, a custom id — so a copy of the
  current session survives while the current file itself is dropped.
- Not recency. Being the newest session, or being in the current `cwd`, is not the same fact.
- Not a path the caller supplies. The parameter is only a switch; which session is current comes from
  Pi, so a model cannot point the rule at some other session it merely names.
- Not a filesystem check. Both sides are compared as normalized text, so a hard link to the current
  file, or the same file spelled with different case on a case-insensitive volume, is not recognized
  as current.

Because `subagentSessions` records who launched whom, a dropped node takes its own subtree with it and
nothing is promoted to a grandparent. When the current session is itself a delegated transcript, it is
pruned out of its parent's tree and the parent is still returned.

The order of operations is exclusion, then filters, then ordering, then `limit`. That is what makes
`{ sortDirection: "desc", limit: 1 }` mean "the newest *previous* session": the running session is
removed first, so the one behind it takes the slot instead of the page coming back empty.

Two consequences for callers:

- `warnings` are unaffected. They describe the whole scan, so the excluded session's unreadable
  neighbours are still reported even though its own rows are gone.
- The scan is unaffected too. The current path is read before the walk and applied to the rows it
  produced, so exclusion is not an early exit.

When there is nothing to exclude the result is the ordinary one, with no error and no fallback: an
ephemeral session (`--no-session`) has no file, and a session recorded under another `--session-dir`
names a file this root never yielded.

So a retrospective over earlier work needs no extra parameter, while inspecting this very
conversation — or the delegated runs it has already launched — needs `includeCurrentSession: true`.

### Ordering

Top-level sessions use `sortBy` and `sortDirection`, with timestamp and path tie-breakers for a stable
total order. The default is oldest first, so without explicit sorting the newest returned top-level
session is `sessions.at(-1)` — the newest *other* one, since the current session is already gone.

Nested `subagentSessions` always remain timestamp-ascending, ties by path, regardless of the requested
top-level order. This preserves delegated-run launch order.

### Warnings and empty results

Interpret the two result arrays together:

| `sessions` | `warnings` | Meaning |
| --- | --- | --- |
| non-empty | empty | Discoverable history was read cleanly. |
| non-empty | non-empty | Usable sessions were returned, but some reachable data was skipped. |
| `[]` | empty | Nothing discoverable matched, the sessions root was empty, or an access bound allowed no matching project. |
| `[]` | non-empty | History may exist but was unreadable; do not conclude that no history exists. |

Warnings cover the complete discovery walk, not only sessions retained by current-session exclusion,
filters, or `limit`. A failed child is absent from its parent's `subagentSessions` and contributes a
warning naming its path. Excluding the current session is likewise a step over the rows the walk
produced: its unreadable neighbours stay reported.

An access bound is the exception to "the whole scan is described": a denied project contributes no
warning, so `warnings` says what this call was allowed to see. With no bound configured, every reachable
file is described as before.

Invalid timestamp bounds, a reversed timestamp range, and `limit < 1` throw rather than returning an
empty result.

### Compact example

The ten newest sessions for a checkout and adjacent worktree-shaped siblings, this session excluded as
always:

```js
const { sessions, warnings } = await tools.list_sessions({
  cwds: ["/Users/me/repos/my-app"],
  cwdMatch: "sibling-prefix",
  sortDirection: "desc",
  limit: 10,
});

return {
  sessions: sessions.map(({ path, cwd, timestamp, subagentSessions }) => ({
    path,
    cwd,
    timestamp,
    delegatedRuns: subagentSessions.length,
  })),
  warnings,
};
```

### Limitations

- Use `path`, not `id`, as the unique handle for a returned transcript.
- Discovery follows supported Pi and pi-subagents storage layouts. Unreachable orphaned child trees
  are not returned and cannot produce warnings.
- An access bound is not reported. `sessions` shows what the bound permitted, and the absence of a
  project says nothing about whether it exists.
- `limit` caps output but does not reduce header reads, and there is no offset or cursor.
- The session the call runs inside is excluded by default, with the transcripts nested under it, and
  `includeCurrentSession: true` keeps it. Identity is that session's file, so the rule is exact only
  while Pi can name one: an ephemeral session excludes nothing, and a transcript copied under a second
  path is not detected as the same session.
- This operation reads metadata only. Use `session_entries` for transcript contents.

---

## `session_entries`

### Purpose

`session_entries` reads one Pi session file and returns selected transcript entries in physical file
order. Every returned row includes high-level fields for common analysis and `raw`, the complete parsed
JSON line.

It reads stored history rather than the model's reconstructed context: it does not apply compaction,
context edits, branch selection, or system-prompt state folding.

### Parameters

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `sessionPath` | absolute path string | required | Session `.jsonl` under the configured sessions root, normally a `path` returned by `list_sessions`. |
| `startLineNo` | integer ≥ 1 | unbounded | Inclusive lower physical line bound. Line 1 is the header and is never returned. |
| `endLineNo` | integer ≥ 1 | unbounded | Inclusive upper physical line bound. |
| `ids` | non-empty `string[]` | unfiltered | Keep entries whose returned `id` exactly matches any value. |
| `parentIds` | non-empty `string[]` | unfiltered | Keep entries whose returned `parentId` exactly matches any value. |
| `startTimestamp` | ISO 8601 date or date-time | unbounded | Inclusive lower bound on each entry's timestamp. |
| `endTimestamp` | ISO 8601 date or date-time | unbounded | Inclusive upper bound; a date-only value covers that whole local day. |
| `types` | non-empty `string[]` | unfiltered | Keep entries whose `type` exactly matches any value. |
| `messageRoles` | non-empty `string[]` | unfiltered | Keep message entries whose `messageRole` exactly matches any value. |
| `search` | `{ terms: string[], caseSensitive?: boolean }` | unfiltered | Literal substring search over `text`; any term may match. Case-insensitive by default. |
| `limit` | integer ≥ 1 | none | Maximum entries returned after filtering. |

`sessionPath` is confined to the sessions root. Relative paths, paths that escape the root, symlinks
whose resolved target is outside it, and files whose first line is not a Pi session header throw. A
nested subagent transcript path returned by `list_sessions` is valid.

Confinement is not permission. With `piRetrospect.allowedProjects` configured, the transcript is
authorized through the top-level session that owns its directory, so a delegated run is reachable when
its parent's project is allowed whatever its own cwd says, and a path no allowed session owns throws
([Restricting session access](#restricting-session-access)).

### Result

```ts
type SessionEntriesOutput = {
  entries: SessionFileEntry[];
  warnings: SessionEntriesWarning[];
};

type SessionFileEntry = {
  lineNo: number;
  id: string | null;
  parentId: string | null;
  timestamp: string;
  type: string;
  messageRole: string | null;
  text: string | null;
  raw: object;
};

type SessionEntriesWarning = {
  lineNo: number | null;
  code: "invalid_json" | "invalid_entry" | "legacy_version";
  reason: string;
};
```

| Field | Meaning |
| --- | --- |
| `lineNo` | Physical transcript line, always at least 2. It remains stable across filters and skipped lines while the file bytes remain unchanged. |
| `id` | Entry id, or `null` when the file version cannot provide a durable id. |
| `parentId` | Parent entry id, or `null` for a root, absent value, or legacy file. |
| `timestamp` | Entry timestamp as stored, accepted once the session parser can read it. |
| `type` | Entry type verbatim. Unknown future types are preserved. |
| `messageRole` | Stored role for `type: "message"`; otherwise `null`. Unknown roles are preserved. |
| `text` | Primary human-readable body for recognized entries, otherwise `null`. |
| `raw` | Complete parsed transcript line unchanged, including fields omitted from `text`. |

### Filtering

Filter categories are ANDed; values within one category are ORed. For example:

```js
const filters = {
  types: ["message", "compaction"],
  messageRoles: ["user", "assistant"],
};
```

keeps user and assistant messages. It does not keep compaction entries because those rows have
`messageRole: null` and therefore fail the role filter.

Exact filters—`ids`, `parentIds`, `types`, and `messageRoles`—are case-sensitive. A `null` field never
matches a supplied string. Omitted categories impose no constraint. Filter arrays must contain at
least one non-empty string.

Line and timestamp bounds are inclusive. Entry timestamps are compared using the shared timestamp
rules at the beginning of this document.

#### Text search

`search` tests literal substrings of `text`; it is not regex, glob, token, or ranked search. A row
matches when any term matches. Matching is case-insensitive unless `caseSensitive: true`.

Search cannot see data that `text` omits, including assistant thinking, tool-call arguments, images,
shell-command output, and fields of state-only entries. Inspect `raw` in the codemode script when the
task needs those fields.

System-message `text` contains prompt content and prompt sections. Therefore an ordinary term can match
the harness instructions rather than the conversation. When searching what participants said, usually
add an appropriate role filter, for example:

```js
const filters = {
  search: { terms: ["ETIMEDOUT", "connection timed out"] },
  messageRoles: ["user", "assistant", "toolResult"],
};
```

### Ordering and paging

Entries always return in physical file order. There is no sort parameter, and file order is not
necessarily chronological when branches or resumed runs append entries.

Use `lineNo` bounds for stable paging. Continue from one past the last returned `lineNo`; there is no
matching-row offset. A page still scans the whole file, but only the retained rows occupy the result.

### Warnings and errors

Filtered-out rows do not produce warnings and do not renumber later entries. Warnings describe malformed
lines across the whole file even when filters or `limit` omit nearby valid rows. A warning's `lineNo`
is the affected physical line; it is `null` only for the whole-file `legacy_version` warning. `reason`
is human-readable detail rather than an enum.

| Code | Meaning | Effect |
| --- | --- | --- |
| `invalid_json` | A later line is blank or cannot be parsed as JSON. | The line is skipped. |
| `invalid_entry` | A parsed line lacks the minimum entry shape, has no usable timestamp, or is another session header. | The line is skipped. |
| `legacy_version` | The session predates durable entry ids. | No rows are skipped, but returned `id` and `parentId` values are `null`. |

Invalid filters, an unreadable or out-of-root path, and a file without a valid session header throw
instead of producing warnings. So does a transcript whose project the configured access bound does not
admit: the refusal names the setting, never the path, and it is a throw rather than an empty `entries`
array, because "not permitted" must not look like "nothing there".

### `text` and `raw`

Start with `type`, `messageRole`, and `text` for ordinary analysis. Use `raw` when the projected fields
do not contain the required detail.

`text` is projected as follows:

| Entry | `text` source |
| --- | --- |
| `message` / `user`, `toolResult`, `custom` | `message.content` |
| `message` / `system` | `message.content`, followed by non-null `message.sections` values in stored order |
| `message` / `assistant` | `type: "text"` blocks from `message.content` |
| `message` / `bashExecution` | `message.command` |
| `message` / `branchSummary`, `compactionSummary` | `message.summary` |
| `custom_message` | `content` |
| `compaction`, `branch_summary` | `summary` |
| `context_edit` | `replacement.content` when a replacement exists |
| `session_info` | `name` |
| `usage` | `note` |
| `label` | `label` |
| State-only entries, unknown types, and unknown roles | `null` |

For string content, the stored string is used. For content arrays, only `type: "text"` blocks
contribute, joined with newlines. Thinking, tool calls, and images remain available only through
`raw`. Missing, empty, or unrecognized textual payloads produce `null`, not an empty string. Text is
not trimmed or truncated.

A system row's `text` represents that one stored message. Later system rows can patch prompt sections,
so no individual row necessarily equals the effective system prompt for the whole session.

`raw` is unbounded per row and can contain complete prompts, tool schemas, tool arguments and results,
images, thinking blocks, shell output, and extension data. Filter first and return only the fields the
current task requires.

### Compact example

Read the visible user and assistant conversation from one transcript:

```js
const { entries, warnings } = await tools.session_entries({
  sessionPath,
  messageRoles: ["user", "assistant"],
});

return {
  conversation: entries.flatMap((entry) =>
    entry.text === null
      ? []
      : [{ lineNo: entry.lineNo, role: entry.messageRole, text: entry.text }],
  ),
  warnings,
};
```

### Limitations

- This operation searches one transcript at a time and has no cross-session index, ranking, match
  offsets, snippets, or relevance ordering.
- Filters and `limit` reduce returned data but do not shorten the file scan.
- A single `text` or `raw` value can still be large; there is no per-row byte budget.
- Stored entries are not the model's effective context. Compaction, context edits, active-branch
  selection, and system-prompt patch folding are not applied.
- `lineNo` is a reference into the current file bytes, not a permanent identifier if the file is later
  rewritten.

---

## Common recipes

These examples are complete codemode script bodies. They return compact projections rather than whole
entries.

### Find marked steering messages

Find corrections recorded in one transcript while steering-message marking was enabled:

```js
const { entries, warnings } = await tools.session_entries({
  sessionPath,
  messageRoles: ["user"],
  search: { terms: ["STEERING: "], caseSensitive: true },
});

return {
  steeringMessages: entries.map(({ lineNo, text }) => ({ lineNo, text })),
  warnings,
};
```

The match is a textual convention, not separate transcript metadata. A manually typed message with the
same prefix is indistinguishable, and steering recorded before the setting was enabled has no automatic
marker.

### Search recent project history

Search recent parent and delegated sessions for an error or decision:

```js
function flatten(sessions) {
  return sessions.flatMap((session) => [session, ...flatten(session.subagentSessions)]);
}

const { sessions, warnings: discoveryWarnings } = await tools.list_sessions({
  cwds: ["/Users/me/repos/my-app"],
  cwdMatch: "sibling-prefix",
  sortDirection: "desc",
  limit: 20,
});

const matches = [];
const readWarnings = [];

for (const session of flatten(sessions)) {
  const { entries, warnings } = await tools.session_entries({
    sessionPath: session.path,
    search: { terms: ["ETIMEDOUT", "connection timed out"] },
    messageRoles: ["user", "assistant", "toolResult"],
    limit: 20,
  });

  matches.push(
    ...entries.map(({ lineNo, messageRole, text }) => ({
      sessionPath: session.path,
      sessionTimestamp: session.timestamp,
      lineNo,
      role: messageRole,
      text,
    })),
  );
  readWarnings.push(...warnings.map((warning) => ({ sessionPath: session.path, ...warning })));
}

return { matches, discoveryWarnings, readWarnings };
```

`limit` in this recipe applies separately to each transcript. It bounds returned matches, not the
number of lines scanned.

### Pair failed tool results with their calls

A tool result is not guaranteed to be adjacent to its call. Pair them by tool-call id:

```js
const { entries, warnings } = await tools.session_entries({
  sessionPath,
  messageRoles: ["assistant", "toolResult"],
});
const calls = new Map();

for (const entry of entries) {
  if (entry.messageRole !== "assistant") continue;
  for (const block of entry.raw.message.content ?? []) {
    if (block.type === "toolCall") {
      calls.set(block.id, {
        callLineNo: entry.lineNo,
        name: block.name,
        arguments: block.arguments,
      });
    }
  }
}

const failures = entries
  .filter((entry) => entry.messageRole === "toolResult" && entry.raw.message.isError)
  .map((entry) => ({
    resultLineNo: entry.lineNo,
    ...calls.get(entry.raw.message.toolCallId),
    result: entry.text,
  }));

return { failures, warnings };
```

If arguments or results may contain sensitive or very large data, project only the fields needed for
the investigation.

### Inspect delegated runs

Summarize the last visible user and assistant messages from each delegated transcript of the newest
matching parent session:

```js
const { sessions, warnings: discoveryWarnings } = await tools.list_sessions({
  cwds: ["/Users/me/repos/my-app"],
  cwdMatch: "sibling-prefix",
  sortDirection: "desc",
  limit: 20,
});

const parent = sessions.find((session) => session.subagentSessions.length > 0);
if (!parent) return { parent: null, runs: [], discoveryWarnings };

const runs = [];
for (const child of parent.subagentSessions) {
  const { entries, warnings } = await tools.session_entries({
    sessionPath: child.path,
    messageRoles: ["user", "assistant"],
  });

  const user = entries.filter((entry) => entry.messageRole === "user" && entry.text !== null).at(-1);
  const assistant = entries
    .filter((entry) => entry.messageRole === "assistant" && entry.text !== null)
    .at(-1);

  runs.push({
    sessionPath: child.path,
    timestamp: child.timestamp,
    lastUser: user && { lineNo: user.lineNo, text: user.text },
    lastAssistant: assistant && { lineNo: assistant.lineNo, text: assistant.text },
    warnings,
  });
}

return { parent: parent.path, runs, discoveryWarnings };
```

For deeper nesting, recursively flatten `subagentSessions` as in the project-history recipe.

To audit the delegated runs of the session you are in rather than an earlier one, add
`includeCurrentSession: true`. Without it the current session and its whole subtree are gone before
`limit` applies, and `sessions.find(...)` lands on the most recent *previous* parent.

### Page a large transcript

Read one page by physical line number rather than matching-row offset:

```js
const { entries, warnings } = await tools.session_entries({
  sessionPath,
  startLineNo: 2,
  messageRoles: ["user", "assistant", "toolResult"],
  limit: 200,
});

return {
  rows: entries.map(({ lineNo, messageRole, text }) => ({ lineNo, messageRole, text })),
  nextStartLineNo: entries.length === 0 ? null : entries.at(-1).lineNo + 1,
  warnings,
};
```

For the next page, pass the returned `nextStartLineNo` as `startLineNo`. Paging bounds each returned
page; every call still scans the transcript to keep warnings complete.

## Further reference

See [`maintainer-reference.md`](maintainer-reference.md) for schema construction, discovery layout,
validation internals, compatibility notes, implementation guarantees, test policy, and known TODOs.
