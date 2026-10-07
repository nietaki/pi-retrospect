---
name: pi-retrospect
description: Review past Pi sessions to recover context, audit prior work, compare approaches, and improve the local Pi harness.
---

# pi-retrospect

Use `pi-retrospect` to learn from earlier Pi sessions and improve the harness
that produced them. Past sessions can reveal repeated failures, ineffective
instructions, tool friction, delegation problems, and opportunities to improve
local skills, prompts, tools, and workflows. The same tools are useful for
recovering prior context, comparing approaches, auditing work, and understanding
how a task was handled before.

## Available tools

- `list_sessions` discovers recorded parent sessions and their nested subagent
  transcripts, returning metadata for choosing which transcripts to inspect.
- `session_entries` reads entries from one transcript and supports narrowing
  them to the parts relevant to the task.

Both tools are read-only. See [`docs/tool-api.md`](../../docs/tool-api.md) for
the complete parameters, result schemas, filtering semantics, examples, and
limitations.

## Recommended workflow

1. Use `list_sessions` to identify likely transcripts and narrow the candidates
   before reading their contents.
2. Use `session_entries` to retrieve only the entries relevant to the task.
3. Start with the high-level `type`, `messageRole`, and `text` fields. Inspect
   `raw` only when those projections do not contain the required detail.
4. Filter and project results inside codemode rather than returning entire
   entries unnecessarily, especially when using `raw`.
5. Transform the findings for the current task. Retain session paths and entry
   line numbers when provenance may be useful, but follow the invoking prompt's
   requirements for presenting or forwarding findings.

Check `warnings` when the task depends on completeness. An empty result with
warnings can mean unreadable history rather than no history.

## Investigating steering messages

When the task is to identify corrections or recurring misunderstandings:

1. Search user messages for the literal, case-sensitive `STEERING: ` text, then
   prefer candidates whose `text` starts with that exact prefix.
2. Inspect the surrounding conversation to determine what prompted each
   correction and how the agent responded.
3. Compare matches across sessions before concluding that an instruction,
   tool, skill, or workflow causes a recurring problem.
4. Retain session paths and entry line numbers when reporting evidence.

The marker is a high-signal convention, not authoritative metadata. When
`piRetrospect.markSteeringMessages` is enabled, `pi-retrospect` prepends it to
interactive and RPC steering submitted while an agent is streaming; it does not
mark extension-generated or slash-prefixed input. The prefix is ordinary user
message text seen by the model and stored in the transcript, so a user can type
it manually. Unmarked steering can also exist because marking was disabled or
because the message belonged to an excluded category. Existing history is
never rewritten. See [`docs/tool-api.md`](../../docs/tool-api.md#marking-steering-messages)
for the complete marking rules.

## Important distinctions

### The session you are in

`list_sessions` drops the current session by default, so `{ sortDirection: "desc", limit: 1 }` is
the newest *previous* session rather than this conversation. Pass `includeCurrentSession: true` when
the task is about the session now running — reviewing what this session has already done, or reading
the subagent transcripts it launched. The exclusion happens before `limit`, so a capped read still
returns a real session, and it matches by session file, never by session id or recency, so a copied
transcript that shares the current id survives.

### Codemode exposure

The tools are exposed through `codemode` only by default. Call them from a
codemode script, where their structured results can be filtered and summarized
before anything is returned to the model.

### Sibling worktrees

`list_sessions` can include sibling directories whose names look like worktrees
of a requested checkout, such as `app-feature` alongside `app`. This is a
lexical sibling-prefix match, not Git worktree detection: similarly named
ordinary directories can match, while worktrees located elsewhere do not.

### High-level and low-level entries

For ordinary analysis, `type`, `messageRole`, and `text` provide a convenient
high-level view. `text` is the entry's primary human-readable projection; it
deliberately omits details such as assistant thinking, tool calls, images, and
some state-only data.

`raw` contains the complete parsed transcript line unchanged. Use it when the
task needs details omitted from the projections, such as tool-call arguments,
structured tool-result fields, thinking blocks, shell output, or extension data.
It can be large, so select only the fields needed by the task.

### Stored history is not effective context

`session_entries` returns stored transcript entries in file order. It does not
reconstruct the model's effective context, apply compaction or context edits,
select an active branch, summarize the session, or reorder entries
chronologically. Use the returned fields according to the question being asked
rather than treating them as a replay of exactly what the model saw.
