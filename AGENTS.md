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
