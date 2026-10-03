# pi-retrospect

A [Pi](https://github.com/earendil-works/pi) package that gives an agent tools for
exploring past Pi sessions and the messages they contain — the read side of harness
self-improvement. An agent that can look back over its own previous sessions can find
the conversation where it hit a given error, recover a decision it made, and audit
what actually happened before repeating it.

**Status: 0.x, early.** One operation is implemented — `listSessions` (see
[`docs/tool-api.md`](docs/tool-api.md) for its contract), registered as one
codemode-callable tool. Exploring the *messages* inside a session is not built yet;
that product scope stays open until it is discussed.

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

The registered tool is `list_sessions`. It walks the Pi sessions root, reads only
each file's header line, and returns session metadata — id, absolute path, absolute
`cwd`, timestamp, fork lineage (`parentSessionPath`) — with subagent transcripts
nested under the session that launched them, plus a warning for every file it had to
skip.

All of its parameters are optional, and all of them act on **top-level** sessions — a
matching parent always arrives with its complete subagent tree:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `cwds` | all working directories | Absolute `cwd`s to keep. |
| `cwdMatch` | `"exact"` | `"sibling-prefix"` also keeps sibling directories whose basename extends the requested one — the shape of git worktrees placed next to the main checkout (a lexical path rule; no git metadata is read). |
| `startTimestamp`, `endTimestamp` | unbounded | Inclusive ISO 8601 bounds. A date is a **UTC** calendar day, and a date-only `endTimestamp` covers that whole day; a date-time must carry `Z` or `±HH:MM`. |
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

## Reference

- [`docs/tool-api.md`](docs/tool-api.md) — the contract for the operations this
  package exposes, including `listSessions`, its discovery rules, and its guarantees.
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
