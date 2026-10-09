# Project purpose

- Build `pi-retrospect` as a Pi package that gives agents a tool for exploring past sessions and their messages.
- Keep product scope open until it is discussed with the operator.
- Do not assume:
  - which sessions are included;
  - how sessions are searched or indexed;
  - which filtering behavior is appropriate.
- Discuss API decisions and usage assumptions with the operator before committing to them.

# Implementation

- Write implementation code in TypeScript.
- Prefer documented Pi APIs and extension integration points over assumptions about the user's filesystem, configuration, or environment.
- Check the current Pi documentation and types when choosing an API.
- Keep dependencies minimal. Add runtime dependencies only when required and justified.

# Testing and validation

- Establish tests early and use them to guide behavior.
- Write tests in TypeScript under `test/*.test.ts`.
- Use the project scripts:
  - `npm test` — run the Vitest suite.
  - `npm run coverage` — run the suite with v8 coverage over every `src` module.
  - `npm run check` — run the full gate, including tests and `tsc --noEmit`.
- Keep `npm run check` passing.

## Temporary test state

- Tests may create throwaway fixtures under the gitignored `test/tmp/` directory.
- Treat `test/tmp/` as generated state, never as a precondition.
- Every test must create or remove the scratch paths whose state it asserts.
- Do not assert that a path is empty or absent unless the same test first establishes that state.
- `test/global-setup.ts` removes `test/tmp/` at the start of each Vitest run.
- `npm run clean`, which is the first step of `npm run check`, also removes `test/tmp/`.
- Do not run two Vitest suites concurrently in the same checkout; the start-of-run cleanup is not concurrency-safe.

# Dependencies and npm

- Local dependency operations are allowed, including:
  - `npm install`
  - `npm ci`
  - `npm outdated`
  - adding or removing dependency entries
  - changes to `package-lock.json` and `node_modules`
- Do not perform operations that modify the published npm package, including:
  - `npm publish`
  - `npm unpublish`
  - `npm deprecate`
  - `npm dist-tag`
  - `npm owner`
  - `npm star`
- Publishing and other npm-registry mutations are the operator's responsibility.

# Experiments

- Put one-off experiment scripts in `scratch/`.
- Do not commit experiment scripts.
- Do not reference them from project documentation.

# Changelog

- Add each notable user-facing change to the `[Unreleased]` section of `CHANGELOG.md` in the same change that implements it.
- Use the Keep a Changelog categories (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security`) and describe outcomes for users rather than commit-level implementation details.
- During development, do not replace `[Unreleased]` with a version or date and do not update release comparison links manually. The configured release-it plugin performs that mechanical finalization after the release version is selected.
- Keep internal-only maintenance out of the changelog unless it materially affects package users, contributors, compatibility, or the release process.

# Documentation

Maintain documentation according to its audience and level of abstraction. Prefer
links to the authoritative document over duplicating detailed explanations.

Implementation, schemas, and tests define actual behavior. `docs/tool-api.md` is the
canonical public contract. Keep terminology, defaults, examples, and cross-links
consistent with them.

## `README.md`

Write the README for people evaluating, installing, or trying the package.

Keep it at the product and workflow level:

- explain the package's purpose, capabilities, maturity, and scope;
- provide installation, compatibility, and a short path to first use;
- summarize major configuration and behavior;
- point readers to detailed references and contributor information.

Include only enough API detail to support orientation and an initial successful use.
Do not reproduce complete schemas, parameter tables, edge cases, warning semantics,
implementation rationale, or measurements that belong in more specialized
documentation.

## `docs/tool-api.md`

Treat `docs/tool-api.md` as the authoritative caller reference. Describe observable,
supported behavior precisely enough that callers do not need to inspect the
implementation.

For each operation, document its purpose, inputs, outputs, defaults, validation,
behavioral semantics, errors, warnings, limitations, and a compact example. Organize
shared behavior once rather than repeating it for every operation.

Keep implementation details, historical investigation, measurements, and maintainer
rationale out of the caller contract.

## `skills/pi-retrospect/SKILL.md`

Write the skill for an agent that has already selected `pi-retrospect` for a task.
It is an operational playbook, not an installation guide or API reference.

Keep it concise relative to the other documentation, but optimize for clarity and
reliable behavior rather than a target length. Prefer actionable guidance about:

- choosing an appropriate workflow;
- narrowing and projecting data before adding it to context;
- interpreting results without overstating what they prove;
- checking completeness and retaining useful provenance;
- avoiding likely, consequential mistakes.

Use an `Important distinctions` section for non-obvious facts that materially affect
tool selection, result interpretation, completeness, safety, or context use. Include
a distinction when an agent is reasonably likely to make the wrong choice without
it and the resulting mistake would matter. Remove or condense distinctions that are
obvious from the tool interface, rarely relevant, redundant with another rule, or
better handled by the caller reference.

Link to `docs/tool-api.md` for exact parameters, schemas, exhaustive semantics, and
edge cases. Do not copy detailed reference material into the skill merely for
completeness.

## Documentation changes

Update only the documentation layers affected by a change:

1. update `docs/tool-api.md` when the public caller contract changes;
2. update `README.md` when adoption, setup, compatibility, configuration, major
   capabilities, or the initial user experience changes;
3. update the skill when recommended agent behavior or important operational
   guidance changes.

Do not update `docs/maintainer-reference.md` merely to mirror public documentation
or as a destination for incidental detail. Touch it only when an existing
maintainer-facing statement would otherwise become materially incorrect, or when the
task explicitly includes maintainer documentation.

Verify examples against current behavior. Prefer links over maintaining equivalent
explanations or examples in several files.
