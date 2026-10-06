# Tool API

`pi-retrospect` exposes two read-only operations:

- `list_sessions` discovers recorded Pi sessions and nested subagent transcripts.
- `session_entries` reads and filters the entries in one discovered transcript.

This document is the caller reference: it defines parameters, result fields, behavior that affects
correct use, and common workflows. Implementation details and maintainer-oriented analysis live in
[`maintainer-reference.md`](maintainer-reference.md).

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

Invalid parameters and requests that cannot identify a readable Pi session throw. Recoverable problems
encountered while walking the session store or reading later transcript lines are returned in a
`warnings` array. Check warnings whenever the task depends on complete history.

---

## `list_sessions`

### Purpose

`list_sessions` returns metadata for discoverable Pi sessions. Top-level sessions contain nested
`subagentSessions`, allowing a caller to choose a parent or delegated transcript before reading its
entries. The operation reads session headers only and never migrates or repairs history.

### Parameters

Every parameter is optional; `{}` returns every discoverable top-level session except the running one,
in ascending timestamp order.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `cwds` | non-empty `string[]` | all | Absolute working directories to keep. Relative and `~`-prefixed values are compared literally and normally match nothing. |
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
| `[]` | empty | Nothing discoverable matched, or the sessions root was empty. |
| `[]` | non-empty | History may exist but was unreadable; do not conclude that no history exists. |

Warnings cover the complete discovery walk, not only sessions retained by current-session exclusion,
filters, or `limit`. A failed child is absent from its parent's `subagentSessions` and contributes a
warning naming its path. Excluding the current session is likewise a step over the rows the walk
produced: its unreadable neighbours stay reported.

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
instead of producing warnings.

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
