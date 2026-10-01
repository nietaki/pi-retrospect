# Data types

Reference for the session data model `pi-retrospect` works with.

Verified 2026-10-01 against `@earendil-works/pi-coding-agent` **0.99.2** and
`@earendil-works/pi-ai` **0.99.2** (the versions in this repo's `node_modules`),
from their shipped `.d.ts` files, plus a live census of the session store on this
machine (`scratch/type-census.mjs`, `scratch/session-graph-probe.mjs`). Re-verify
against a pinned version after any Pi upgrade; the census numbers are from ~64 MB
of local history and will drift.

Upstream sources of truth, if this page and they disagree:

- Pi `docs/session-format.md` — persisted entries and the entry tree
- Pi `docs/message-types.md` — `AgentMessage` and content blocks
- Pi `docs/sessions.md`, `docs/compaction.md` — branch and context behaviour
- `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts`

---

## Layers

Three distinct models sit on one file, plus a derived index. Keeping them
separate matters because each answers a different question:

```
JSONL file
  └─ FileEntry = SessionHeader | SessionEntry      (what is stored)
       └─ message entries wrap AgentMessage        (what was said)
            └─ SessionContext / SessionProjection  (what the model saw)

SessionInfo                                         (a scan over a file: not stored,
                                                     not a conversation view)
```

## Storage layout and addressing

```
~/.pi/agent/sessions/--<slug>--/<file-timestamp>_<session-id>.jsonl
```

`getDefaultSessionDir(cwd, agentDir?)` computes the project directory: drop the
leading path separator, replace `/`, `\`, and `:` with `-`, wrap in `--…--`.
`/Users/nietaki/repos/pi-retrospect` → `--Users-nietaki-repos-pi-retrospect--`.

Addressing options: path (always works), session id (`SessionManager.findById(cwd,
id, sessionDir?)`), or `(cwd, id)`. File-name order is creation order; **entry
order in the file is not the active branch** — see
[Reading views](#reading-views-of-one-session).

## Identity

| Id | Form | Where |
|---|---|---|
| **Session id** | UUID **v7** by default (`createSessionId()` → `uuidv7()`, so ids are time-ordered and sortable), but the SDK and `--session-id` accept any custom id; `assertValidSessionId` constrains the character set (`[A-Za-z0-9._-]`, alphanumeric first/last), not the shape | `SessionHeader.id`, `SessionInfo.id`, file-name suffix |
| **Entry id** | 8 hex chars from `randomUUID().slice(0, 8)`, collision-checked against the entry index, falling back to a full UUID after 100 collisions (`generateId`, `session-manager.js:20-29`) | `SessionEntryBase.id`, `parentId`, and every cross-reference field (`targetId`, `fromId`, `firstKeptEntryId`) |
| **Tool call id** | provider-assigned, opaque format | `ToolCall.id` on an `assistant` message ↔ `ToolResultMessage.toolCallId` |
| **Run id** | UUID; **not a Pi identifier** | pi-subagents only: `subagent-artifacts/<runId>_*`, `$TMPDIR/…/async-subagent-runs/<runId>/`, and the child's `session_info.name` |

**Tool call id is the reliable request→result link.** Over 8 dotfiles sessions:
315 calls, 314 results, **0 orphans** — every `toolCallId` resolved to a call in the
same session. But **86 of 314 results were not the direct child of the calling
entry** in the tree, so *do not pair calls and results by adjacency* — use the id.
(The 315/314 gap is a call whose result was never written: the turn was aborted.)

**Run id is the best cross-store key for a subagent child.** The same UUID (verified
end to end: `7c3cb5d6-…`) appears in the child's `session_info.name`, prefixes its
`subagent-artifacts/` files, and names its temp control directory. It is *not* the
launch-slot directory name — for that child the slot was `310263c6-…`.

Do not assume a UUID shape for session ids or 8 chars for entry ids — both have
documented fallbacks. They are different id spaces: a parameter that "takes an id"
must say which, and a citation should carry both
(`<session path>#<entry-id>`) rather than a bare id.

`parentId: null` marks a root. **A file is not guaranteed to have exactly one**:
`getTree()` documents that a well-formed session has one root but that
**orphaned entries (a broken parent chain) are also returned as roots**, and
`resetLeaf()` deliberately sets the leaf to null so the next append becomes a new
`parentId: null` root (`session-manager.d.ts:317-321`, `:338-340`). So
"walk parents until null" may stop anywhere unexpected, and any tree walker must
handle multiple roots.

## Timestamps

| Field | Type | Format |
|---|---|---|
| `SessionHeader.timestamp` | `string` | ISO 8601 |
| `SessionEntryBase.timestamp` | `string` | ISO 8601 |
| `AgentMessage.timestamp` | `number` | Unix **milliseconds** |

Two conventions inside one nested object. Choosing a sort key means choosing
deliberately between entry time (when Pi wrote it) and message time (when the
provider answered).

`SessionInfo.modified` is **not** file `mtime`: `buildSessionInfo`
(`session-manager.js:543-547`) derives it from the latest message timestamp,
falling back to the header timestamp, and only then to `stats.mtime`. `created` is
the header timestamp. `listAll()` returns `modified` descending
(`sortSessionInfos:584-586`); an `mtime` pre-sort inside `listAll()` affects only
*discovery* order, not the returned order.

## Session versions

`CURRENT_SESSION_VERSION = 3`. `version` is optional on read — absent means v1.

- **v1** linear sequence
- **v2** tree via `id`/`parentId`
- **v3** `hookMessage` role renamed to `custom`

> [!warning]
> **`SessionManager.open()` can write to the file, on any version.** Two separate
> paths, both confirmed. (a) A legacy file is migrated and rewritten:
> `_loadEntries()` → `migrateToCurrentVersion()` → `_rewriteFile()`
> (`session-manager.js:717-725`). (b) Even a **current-version** file is appended to
> when its last line has no terminating newline — `loadEntriesFromFile` does
> `appendFileSync(filePath, "\n")` (`:367`). Reproduced on a v3 copy: opening it
> grew the file by exactly one byte. 0 of 128 parents and 0 of 58 children here are
> affected today (all newline-terminated, so (b) only fires on a crash-truncated
> tail), but it means **`open()` is not a read-only call**, and a tool advertised as
> "explore past sessions" must not silently migrate or repair history.
>
> The read-only alternative, using only root-exported API: read the file yourself and
> call `parseSessionEntries(content)` — it parses `FileEntry[]` and touches no disk.
> (`loadEntriesFromFile` also exists but is **not** re-exported from the package
> root, so it is not available to us.) Then run the exported free functions
> `buildContextEntries` / `buildSessionProjection` / `buildSessionContext` over those
> entries instead of the manager's methods.

## File entries

```ts
type FileEntry = SessionHeader | SessionEntry;

interface SessionHeader {
  type: "session";
  version?: number;          // absent => v1
  id: string;                // session id
  timestamp: string;         // ISO 8601
  cwd: string;               // empty string in old sessions
  parentSession?: string;    // path, not id — see below
}

interface SessionEntryBase {
  type: string;
  id: string;                // 8 hex chars
  parentId: string | null;
  timestamp: string;         // ISO 8601
}
```

The header is line 1 and is **not** part of the tree (no `id`/`parentId`).
`getHeader()` returns it; `getEntries()` returns everything except it.

`parentSession` is written only by `/fork`, `/clone`, and
`newSession({ parentSession })`, and surfaced as `SessionInfo.parentSessionPath`.
**Measured: 0 of 128 sessions in this store had it set.** It is *not* a
subagent-parenting field; see [Subagent child sessions](#subagent-child-sessions).

Header reads are bounded: `readSessionHeader` scans at most
`MAX_SESSION_HEADER_SCAN_BYTES = 1 MiB` (`:304-312`) and throws
`SessionHeaderScanLimitError` past that. `open()` catches it and falls back to a
full load; `readSessionHeaderForDiscovery` swallows it, so an oversized header
makes a session invisible to `findById` rather than erroring.

## Entry types

`SessionEntry` is a union of **11 types**. "Reaches the model?" is the field that
decides what any search must cover. Counts are the census of 13,270 entries in
this machine's 128 parent sessions; `0` means unused here, not absent from the
format.

| `type` | Fields beyond base | In LLM context? | Census |
|---|---|---|---|
| `message` | `message: AgentMessage` | yes | 11,957 |
| `custom` | `customType: string`, `data?: T` | **no** — extension state | 708 |
| `model_change` | `provider`, `modelId` | no (sets current model) | 245 |
| `thinking_level_change` | `thinkingLevel: string` | no (sets current level) | 232 |
| `custom_message` | `customType`, `content: string \| (TextContent \| ImageContent)[]`, `display: boolean`, `details?: T` | **yes** — surfaces as a `custom` message | 96 |
| `session_info` | `name?: string` | no | 16 |
| `compaction` | below | yes — system checkpoint + `compactionSummary` | 8 |
| `context_edit` | `targetId: string`, `replacement: { content } \| null` | no message of its own; mutates another entry | 8 |
| `usage` | `kind`, `provider`, `model`, `usage: Usage`, `note?` | **no** | 0 |
| `branch_summary` | `fromId`, `summary`, `details?`, `usage?`, `fromHook?` | yes — as `branchSummary` | 0 |
| `label` | `targetId`, `label: string \| undefined` | no | 0 |

```ts
interface CompactionEntry<T = unknown> extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;   // required; retain-none stores its own id
  tokensBefore: number;
  details?: T;
  usage?: Usage;
  fromHook?: boolean;         // true => produced by an extension
  systemMessage?: SystemMessage;  // full prompt+tool checkpoint at the boundary
}
```

Census optionality on those 8 compaction entries: `usage` 8/8, `fromHook` 8/8,
`details` 8/8, `systemMessage` 6/8 — extension-produced compaction dominates
here, and `systemMessage` can be absent on older entries.

`context_edit` is **branch-relative**: the latest edit targeting an entry on the
active branch wins, and navigating to before the edit reveals the original
content again. `replacement: null` omits the target; a value replaces only its
content, keeping the target's role and metadata. Raw history is never modified —
so a raw-entry search and a model-context search legitimately disagree after any
edit.

## Messages

A `message` entry's `message` is an `AgentMessage`: eight roles, four from the
base provider model (`pi-ai`) and four added by the coding agent. Census of the
11,957 message entries:

| `role` | Shape highlights | Count |
|---|---|---|
| `system` | `content: string \| TextContent[]`, `sections?: Record<string, string \| null>`, `toolsAdded?: Tool[]`, `toolsRemoved?: ToolReference[]` | 137 |
| `user` | `content: string \| (TextContent \| ImageContent)[]` | 549 |
| `assistant` | `content: (TextContent \| ThinkingContent \| ToolCall)[]`, `api`, `provider`, `model`, `responseModel?`, `responseId?`, `thinkingLevel?`, `providerThinkingLevel?`, `usage: Usage`, `stopReason`, `errorMessage?`, `rawStopReason?`, `endTurn?`, `deferred?`, `diagnostics?` | 5,201 |
| `toolResult` | `toolCallId`, `toolName`, `content: (TextContent \| ImageContent)[]`, `details?`, `usage?`, `nestedCalls?`, `isError: boolean` | 6,064 |
| `bashExecution` | `command`, `output`, `exitCode: number \| undefined`, `cancelled`, `truncated`, `fullOutputPath?`, `excludeFromContext?` | 6 |
| `custom` | `customType`, `content`, `display`, `details?` | 0 |
| `branchSummary` | `summary`, `fromId: string \| null` | 0 |
| `compactionSummary` | `summary`, `tokensBefore` | 0 |

Consequences for this project:

- The last three roles are **derived during context building**, never persisted as
  `message` entries. Their text lives in the `custom_message`, `branch_summary`,
  and `compaction` **entries** instead — so a persisted-message search cannot find
  them and a full-coverage search must read entries, not messages.
- `system` messages are the prompt and tool loadout: replaying them in order
  reconstructs sections (`sections`, `null` removes one) and tool availability
  (`toolsAdded`/`toolsRemoved`). Sessions predating this feature have no leading
  system message.
  > [!note] Pi's `docs/message-types.md` lists a `replace?: boolean` field on
  > `SystemMessage`; the **shipped** `SystemMessage` in `pi-ai` 0.99.2 has no such
  > field (`types.d.ts:350-366`, only `role`, `content`, `sections`, `toolsAdded`,
  > `toolsRemoved`, `timestamp`). Trust the installed types — treat an unexpected
  > `replace` key in older data as unknown and ignore it.
- `bashExecution` is a direct `!` shell command, not an LLM tool result; unless
  `excludeFromContext` is set it reaches the model as **user-role** text. So
  "user messages" in a transcript may contain shell output.
- `assistant.content` is always an array; `user.content` may be a string or an
  array (census: all 549 user messages here used the array form).
- `stopReason` observed: `toolUse` 4,686, `stop` 415, `aborted` 64, `error` 36.
  `"pending"` is streaming-only and never persisted; `"deferred"` carries a
  `DeferredHandle`. `errorMessage` was present on 100 assistant messages.
- `toolResult.isError` was `true` on 552 of 6,064 (~9%). **Filter tool failures on
  this boolean, not on substring matching** — error text varies, the flag does not.

## Content blocks and usage

```ts
interface TextContent     { type: "text";     text: string; textSignature?: string }
interface ThinkingContent { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
interface ImageContent    { type: "image";    data: string /* base64 */; mimeType: string }
interface ToolCall        { type: "toolCall"; id: string; name: string; arguments: JsonObject; thoughtSignature?: string; namespace?: string }
```

Signatures (`textSignature`, `thinkingSignature`, `thoughtSignature`) are opaque
provider payloads. A redacted thinking block can have empty `thinking` with the
payload only in `thinkingSignature`. Census of assistant blocks: `toolCall` 6,084,
`thinking` 4,871, `text` 1,934 — thinking is more frequent than visible text, so
searching it would bury the results a user actually wants.

```ts
interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cacheWrite1h?: number;   // Anthropic-only split of cacheWrite
  reasoning?: number;      // already INCLUDED in output — do not re-add
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
```

Assistant messages always carry `usage`. `toolResult.usage` (5 hits) and
`toolResult.nestedCalls` (32 hits) report work a tool did internally and are not
part of main model-call accounting. `nestedCalls` is
`{ calls: NestedToolCallRecord[], complete: boolean }`; each record has
`status: "ok" | "error" | "unfinished"`, and drops `arguments` over size limits in
favour of `argumentsBytes`. `usage` **entries** (0 here) contribute to session
totals without appearing in context, and unknown `kind` values must be treated as
normal usage, not rejected.

## Discovery model: `SessionInfo`

Derived by the walk, never stored:

```ts
interface SessionInfo {
  path: string;
  id: string;
  cwd: string;                  // empty string for old sessions
  name?: string;                // latest session_info entry, trimmed, "" => undefined
  parentSessionPath?: string;   // header parentSession — fork/clone only
  created: Date;                // Invalid Date if the header timestamp is absent
  modified: Date;               // last message timestamp, else header, else mtime
  messageCount: number;         // ALL message entries, every role
  firstMessage: string;         // first USER text, or the literal "(no messages)"
  allMessagesText: string;      // user + assistant text ONLY, joined with single spaces
}
```

Three asymmetries to design around:

1. **`messageCount` counts more roles than `allMessagesText` contains.**
   `buildSessionInfo` increments `messageCount` for every `message` entry, then
   skips any role that is not `user`/`assistant` before appending text
   (`session-manager.js:519-534`). Tool results and thinking are counted but not
   searchable through this field.
2. **`allMessagesText` is a summary, not a corpus.** Searching 104 dotfiles
   sessions for `Denied by policy`: **4** sessions via `allMessagesText`, **58**
   via raw entries. Where the ~3,900 matching fields actually live:
   `toolResult:bash` 2,786, `assistant` 471, `toolResult:read` 240,
   `toolResult:bash_readonly` 187, `toolResult:edit` 107, `custom_message` 71,
   `toolResult:write` 48, `compaction` 27, `toolResult:ls` 14,
   `toolResult:codemode` 2. It is also unbounded and unseparated — median 7.9 KB,
   max 105 KB per session, no role or entry markers, so a match in it cannot be
   located back to an entry. Fine for "which session was about X", useless for
   citation.
3. **Sentinels and invalid dates.** `firstMessage` can be the literal
   `"(no messages)"`, and `created` can be an `Invalid Date`. Both need explicit
   handling rather than being rendered as a title or a date.

## Reading views of one session

"Read this session" has seven different answers. Pick one per operation; never let
a parameter silently mean two.

| API | Returns | Sees |
|---|---|---|
| `getEntries()` | all stored entries (shallow copy) | every branch including abandoned; raw content before `context_edit` |
| `getEntryCount()` | a number only | cheap total, no copy — use instead of `getEntries().length` |
| `getBranch(fromId?)` | root→leaf entry list, **all entry types** | one path only |
| `getTree()` | `SessionTreeNode[]` — `{ entry, children, label?, labelTimestamp? }` | every branch, with labels resolved |
| `buildContextEntries()` | compaction-aware entry list | active branch; older entries replaced by the summary |
| `buildSessionProjection()` | `SessionProjection` = `{ entries: ProjectedSessionEntry[], messages, thinkingLevel, model }`, each `{ sourceEntry, messages }` | active branch, compaction applied, `context_edit` applied, **provenance kept** |
| `buildSessionContext()` | `SessionContext` = `{ messages, thinkingLevel, model }` | the same, flattened, provenance dropped |

`usage` and `custom` entries yield no messages; `context_edit` yields none of its
own. So "search the transcript" and "search what the model saw" are different
queries with different answers. A projection-based search is the only way to get
both hits *and* citations, because `sourceEntry` carries the entry id and
timestamp.

The free functions `buildContextEntries`, `buildSessionProjection`,
`buildSessionContext`, `sessionEntryToContextMessages`, `getLatestCompactionEntry`,
`parseSessionEntries`, `migrateSessionEntries`, and `CURRENT_SESSION_VERSION` are
all exported, so projection can run over entries obtained some other way (for
example read without the rewriting `open()`).

`getBranch()` and every `build*` view follow the **stored leaf**: `getLeafId()`
returns it, and `_buildIndex()` sets it to the **last entry in file order** — the
most recent entry written, not the most recent by timestamp and not necessarily
the entry the interactive session was left pointing at. So a session whose history
was navigated backwards still reports its newest appended entry as the leaf, and
`getBranch()` includes abandoned-then-re-appended entries rather than the branch
the user was looking at. `getChildren(parentId)` and `getEntry(id)` cover the rest
of tree navigation, `getLabel(id)` resolves a `label` entry's current value, and
`createBranchedSession(leafId)` extracts one root→leaf path into a **new file** —
a write, not a read operation.

## Subagent child sessions

A child run is a full, independent Pi session file in the same v3 format, written
by the `pi-subagents` extension. **Not part of Pi's data model** — nothing in
`@earendil-works/pi-coding-agent` knows these exist.

```
sessions/--<cwd-slug>--/
  <parent-stem>.jsonl                       # parent, discovered by listAll()
  <parent-stem>/                            # same stem, as a DIRECTORY
    <launch-uuid>/                          # internal slot id — not the runId
      run-<n>/session.jsonl                 # child transcript; n = resume index
  subagent-artifacts/                       # per project slug, shared across parents
    <runId>_<agent>[_<step>]_{input,output}.md
    <runId>_<agent>[_<step>]_transcript.jsonl   # full copy of the child
    <runId>_<agent>[_<step>]_meta.json
```

Slot directories contain **only** `run-<n>/` (verified across every slot of that
parent) — no sibling control dir lives here; run control state is in `$TMPDIR`.

Discovery, measured:

- `SessionManager.listAll()` returned 128 sessions with the parent present and
  **0 of its 9 children**; `list(cwd)` likewise.
- Cause: `listAll()` enumerates directories under the sessions root, then keeps
  `readdir(dir).filter(f => f.endsWith(".jsonl"))` — **one level**
  (`session-manager.js:1478-1484`). Parent-stem entries are directories, and so is
  `subagent-artifacts/`, so both are dropped before their contents are considered.
- `listAll(sessionDir)` is **not** a recursive variant. Passing the sessions root
  returned 0; passing a parent-stem directory returned 0.
- `SessionManager.open(childPath)` works normally: 40 entries, correct `cwd`,
  `getSessionName()` = `subagent-retro-scout-7c3cb5d6-…-1`.
- Therefore: children are readable by explicit path and undiscoverable by any list
  API. Reaching them requires our own walk of the project directory tree.

Linkage — there is **no structural link**:

1. **Containment** — the child's path contains the parent stem. This is the only
   reliable parent key.
2. **`session_info.name`** = `subagent-<agent>-<runId>-<launchSeq>`. One grep
   recovers agent and async runId from the file. The trailing number is a 1-based
   **launch** counter, *not* the resume index; the `run-<n>` **directory** is the
   resume index, and they disagree (a first-pass child lives in `run-0/` and is
   named `…-1`).
3. **Text coincidence** — the parent id appears inside child prompts as embedded
   paths, which is why a raw text search for a session id lights up child files.
   Not a join key.
4. `$TMPDIR/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/status.json` joins
   child→parent on `sessionId` (parent `.jsonl` path) and carries `sessionFile`,
   `parentWorkflowRunId`, `workflowKey`, plus `cwd`, `agent`, `exitCode`, `usage`.
   Ephemeral — purged on a schedule. A sibling `run-fanout-budgets/` holds
   `{ maxTotal }` per composite run.

A child header is an ordinary header with its own fresh id, the **parent's**
`cwd`, and no `parentSession`. No child entry mentions the parent id. Children
also open with a `model_change` → `thinking_level_change` → `session_info` prefix
(verified: the per-run model/thinking override is applied before any message), and
their system message carries `<active_agent name="retro-scout"/>` plus the role
persona — a reliable in-file marker of the subagent role, distinct from the
`session_info` name.

Store census: 12 project dirs, 128 parents, 58 child transcripts, 9 artifact
copies, 64 MB total, 12 parents > 1 MB, **0** children > 1 MB.

## Measured shape distribution

From 128 sessions / 13,270 entries, for bounding result sizes:

| Measure | p50 | p90 | p99 | max |
|---|---|---|---|---|
| Entries per session | 61 | 308 | — | 522 |
| Serialized entry (bytes) | 1,450 | 7,584 | 49,744 | **563,328** |
| Single content block (chars) | 267 | 3,236 | 16,669 | 51,338 |
| `allMessagesText` (chars) | 7,908 | — | — | 105,527 |

Parents total 48.6 MB; `listAll()` streams every line of every parent file in a
couple of seconds. Scanning is cheap, so an on-disk index has no justification at
this size — and `listAll()` already parses every file, making a metadata-only
result set essentially free.

The p99/max entry numbers are the argument for excerpts over raw entries: one
tool-result entry can be 563 KB serialized, so returning 20 raw hits can exceed
the context window on its own. Truncation must be a property of the tool (byte
budget, offset continuation), not the caller's problem.

### What raw entries actually contain

Serializing every entry of every session in this store gives **48.8 MB**, of which:

| Payload | Size | Note |
|---|---|---|
| Human-visible message text | 15.28 MB | ~31% of the bytes |
| Thinking text + `thinkingSignature` | **9.94 MB** | ~20% — opaque and rarely wanted |
| `toolResult.details` | **5.54 MB** | tool-specific, opaque to us |
| `ImageContent.data` (base64) | **1.02 MB across 8 blocks** | ~128 KB per image, each in one entry |
| `nestedCalls` | 0.02 MB | small but structured noise |
| `textSignature` / `thoughtSignature` / `diagnostics` | 0 MB here | in the schema, unused locally |
| Assistant `toolCall` blocks | 6,137 blocks | `arguments` are the useful part |

Roughly **two thirds of the bytes an agent would receive are not text it can use**,
and a single image block costs more than the median session's entire visible
conversation. Also measured: `SessionManager.open()` on the largest file here
(2.41 MB, 356 entries) parsed in **7 ms** — reading is cheap, *returning* is the
expensive part. That asymmetry is the case for re-wrapping: keep addressing
metadata, drop or bound the payload, and let the caller ask for more.

`open()` always reads the whole file. There is no lazy or ranged entry API:
`_setSessionFile()` → `loadEntriesFromFile()` loops the file to EOF and keeps every
parsed entry in memory (`fileEntries`), regardless of version. `readSessionHeader`
is bounded (4 KiB buffer, 1 MiB scan) but is only a *discovery* optimization —
`getBranch()`/`getTree()` cannot be answered without the full read.

## Import surface

The package root exports the **session** model but not the **message** model:

- From `@earendil-works/pi-coding-agent`: `SessionManager`, `SessionHeader`,
  `SessionEntry`, `SessionEntryBase`, `SessionMessageEntry`, `FileEntry`, all 11
  entry interfaces, `SessionInfo`, `SessionContext`, `SessionProjection`,
  `ProjectedSessionEntry`, `SessionTreeNode`, `ContextEditableContent`,
  `CURRENT_SESSION_VERSION`, the `build*` functions, `parseSessionEntries`,
  `migrateSessionEntries`, `getLatestCompactionEntry`,
  `sessionEntryToContextMessages`, `NewSessionOptions`, `defineTool`.
- `AgentMessage` and the coding-agent roles (`BashExecutionMessage`,
  `CustomMessage`, `BranchSummaryMessage`, `CompactionSummaryMessage`) are **not
  re-exported**. `AgentMessage` lives in `@earendil-works/pi-agent-core`, which Pi
  depends on transitively but which does **not** resolve from this package:
  `import("@earendil-works/pi-agent-core")` → `ERR_MODULE_NOT_FOUND`. Importing it
  would mean adding a dependency, against the project's minimal-dependency rule.
- From `@earendil-works/pi-ai` (already a peer dep here): `Message`,
  `SystemMessage`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`,
  `TextContent`, `ThinkingContent`, `ImageContent`, `ToolCall`, `Usage`,
  `StopReason`, `JsonValue`, `JsonObject`, `Tool`, `ToolReference`,
  `DeferredHandle`, and `Type`.

Practical pattern — derive the message union from the exported entry type and
narrow on `role`, which is exhaustive without naming the unavailable module
(verified to typecheck under `strict`):

```ts
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";

type SessionMessage = SessionMessageEntry["message"];

function describe(m: SessionMessage): string {
  switch (m.role) {
    case "system": return `sections=${Object.keys(m.sections ?? {}).length}`;
    case "user": return `user:${typeof m.content}`;
    case "assistant": return `${m.model} ${m.stopReason} ${m.usage.totalTokens}`;
    case "toolResult": return `${m.toolName} isError=${m.isError}`;
    case "bashExecution": return `exit ${m.exitCode}`;
    case "custom": return `custom:${m.customType}`;
    case "branchSummary": return "branchSummary";
    case "compactionSummary": return `compactionSummary:${m.tokensBefore}`;
    default: return (m as { role: string }).role; // hosts may augment CustomAgentMessages
  }
}
```

`content` does **not** exist on `BashExecutionMessage` (it has `output`); touching
it on the un-narrowed union fails with
`Property 'content' does not exist on type 'AgentMessage'`. Narrow before reading
content. Unknown `role` values must be tolerated, since
`@earendil-works/pi-agent-core`'s `CustomAgentMessages` is open to declaration
merging by any host extension.

## Naming collisions

Four unrelated "parent" concepts and several unrelated "details" fields. Always
qualify in API names and docs:

| Name | Meaning |
|---|---|
| `SessionEntryBase.parentId` | message-DAG link **inside** one session |
| `SessionHeader.parentSession` / `SessionInfo.parentSessionPath` | fork/clone lineage across files |
| `status.json.sessionId` | subagent child → parent session **path** |
| `<parent-stem>/` directory | subagent containment (the only reliable child→parent link) |
| `ToolResultMessage.details` | tool-specific payload, opaque to us |
| `CompactionEntry.details` / `BranchSummaryEntry.details` | extension data, not sent to the model |
| `CustomEntry.data` vs `CustomMessageEntry.details` | extension state vs extension metadata on a context message |
| `sessionDir` (Pi: a project directory) vs subagent `sessionDir` (a nested child run dir) | same word, different directory |
| `name`: `SessionInfo.name` vs `session_info` entry vs subagent `sessionName` | all three are the same string, different sources |
