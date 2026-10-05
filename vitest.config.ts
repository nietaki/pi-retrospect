import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Vitest configuration.
//
// `include` is scoped to the TypeScript suite. Vitest's default pattern
// (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) would also collect any `*.test.js` or `*.spec.*`
// artifact that lands in `coverage/`, `dist/`, or a generated tree, so collection stays
// explicit: `test/**/*.test.ts` is the whole suite.
// These are `//` comments because a literal `*/` inside a block comment would end it.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Timestamp semantics are host-local by design (`src/timestamps.ts`): a bare date bound names
    // the caller's day, and a date-time with no offset is read in the caller's zone. Without this
    // pin the same suite would pass or fail according to the machine running it, and the January
    // and February UTC midnights in the `list-sessions-filters` fixtures would stop being the edges
    // they claim to test.
    // Tests that exist to prove zone behavior set `process.env.TZ` themselves and restore it.
    env: { TZ: "UTC" },
    // Purges the gitignored `test/tmp/` once, before any test file is collected, so no run can
    // read state an earlier run left behind. Absolute path: independent of the process cwd.
    globalSetup: [fileURLToPath(new URL("./test/global-setup.ts", import.meta.url))],
    coverage: {
      provider: "v8",
      // Report every src module, including ones no test imports, so blind spots are visible.
      all: true,
      include: ["src/**/*.ts"],
      exclude: ["**/node_modules/**"],
      // Vitest 5 defaults the text reporter to skipFull, which hides every fully covered
      // module from the console. Show every src module, blind spots or not.
      reporter: [["text", { skipFull: false }], "html", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
