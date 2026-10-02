import { defineConfig } from "vitest/config";

// Vitest configuration.
//
// `include` is deliberately narrow. Vitest's default pattern
// (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) also matches the `node:test` files in this
// directory, which import `test()` from `node:test` and therefore register nothing with
// Vitest's runner - collecting them would fail the run. While both suites coexist, only
// `*.test.ts` belongs to Vitest; the `*.test.mjs` originals stay on `npm run test:node`.
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
