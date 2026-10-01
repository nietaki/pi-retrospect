# pi-retrospect

`pi-retrospect` is a Pi package intended to give the agent a tool for exploring past Pi sessions and the messages they contain.

The goal is to help the agent find useful context in prior conversations. The product scope and behavior—such as which sessions can be explored and how they are searched—are still to be decided.

This project is at an early stage. `list_sessions` is implemented: it walks the Pi sessions
root, reads only each file's header line, and returns session metadata with subagent
transcripts nested under the session that launched them, plus a warning for every file it had
to skip. Exploring the messages inside a session is not built yet, and that product scope
stays open until it is discussed.

## Reference

- [`docs/data-types.md`](docs/data-types.md) — Pi's session format, verified against the installed types and a census of the local session store.
- [`docs/tool-api.md`](docs/tool-api.md) — the contract for the operations this package exposes, including `listSessions`.
- [`test/fixtures/generate.mjs`](test/fixtures/generate.mjs) — rebuilds the synthetic session tree the tests run against.

## TODOs

Tracked in [`docs/tool-api.md`](docs/tool-api.md#todos); the ones that need real data rather than decisions:

- **Grandchild subagent nesting is unverified.** Every child transcript in this store sits at `<parent-stem>/<launch-uuid>/run-0/session.jsonl` and none launched its own subagent, so the recursive case in `SessionMetadata.subagentSessions` has never been exercised against real files.
- **Generate real fixture data.** Run subagent workflows in this project's `cwd` so `--Users-nietaki-repos-pi-retrospect--/` grows actual parent/child trees, then use them to validate the synthetic fixture layout. Do not commit session data into `test/fixtures/`.
