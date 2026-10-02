# Project intentions

- Build `pi-retrospect` as a Pi package that gives the agent a tool for exploring past sessions and their messages.
- Keep product scope open until it is discussed. Do not assume which sessions are included or choose search, indexing, or filtering behavior without agreement.
- Write implementation code in TypeScript.
- Establish tests early and use them to guide behavior.
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
