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
    coverage: {
      provider: "v8",
      // Report every src module, including ones no test imports, so blind spots are visible.
      all: true,
      include: ["src/**/*.ts"],
      exclude: ["**/node_modules/**"],
      // Vitest 5 defaults the text reporter to skipFull, which hides every fully covered
      // module from the console. Show all seven src modules, blind spots or not.
      reporter: [["text", { skipFull: false }], "html", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
