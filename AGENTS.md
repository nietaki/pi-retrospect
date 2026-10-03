# Project intentions

- Build `pi-retrospect` as a Pi package that gives the agent a tool for exploring past sessions and their messages.
- Keep product scope open until it is discussed. Do not assume which sessions are included or choose search, indexing, or filtering behavior without agreement.
- Write implementation code in TypeScript.
- Establish tests early and use them to guide behavior.
- The test runner is Vitest: keep the suite in TypeScript at `test/*.test.ts`, run it with
  `npm test` (or `npm run coverage` for the v8 report over every `src` module), and let
  `npm run check` stay the gate that runs the suite together with `tsc --noEmit`. Tests may
  write throwaway fixtures under `test/tmp/`, which is gitignored.
- Prefer documented Pi APIs and extension integration points over assumptions about the user's filesystem, configuration, or environment. Check current Pi documentation and types when choosing an API.
- Keep dependencies minimal. Add runtime dependencies only when required and justified.
- Keep tests and type-checking passing with `npm run check`.
- Do not make API decisions or usage assumptions without discussing them with the operator

# Development rules

- Don't run non-read-only commands against the npm registry: no `npm publish`, `npm unpublish`,
  `npm deprecate`, `npm dist-tag`, `npm owner`, `npm star`, or anything else that changes the
  published state of this package. Publishing is the operator's job.
- Local dependency work is fair game: `npm install`, `npm ci`, `npm outdated`, adding or removing
  `devDependencies`/`dependencies` entries, and the resulting `package-lock.json` and
  `node_modules` changes. These are not "non-read-only" in the sense the rule above forbids.
