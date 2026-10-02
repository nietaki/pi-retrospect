# Project intentions

- Build `pi-retrospect` as a Pi package that gives the agent a tool for exploring past sessions and their messages.
- Keep product scope open until it is discussed. Do not assume which sessions are included or choose search, indexing, or filtering behavior without agreement.
- Write implementation code in TypeScript.
- Establish tests early and use them to guide behavior. Prefer Node's built-in test runner; add a third-party test framework only when there is a concrete need.
- Prefer documented Pi APIs and extension integration points over assumptions about the user's filesystem, configuration, or environment. Check current Pi documentation and types when choosing an API.
- Keep dependencies minimal. Add runtime dependencies only when required and justified.
- Keep tests and type-checking passing with `npm run check`.
- Do not make API decisions or usage assumptions without discussing them with the operator

# Development rules

- Don't run any non-read-only `npm` commands on behalf of the user - let the user publish package on their own
