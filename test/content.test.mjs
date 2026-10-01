import assert from "node:assert/strict";
import { test } from "node:test";

import { renderListSessionsContent } from "../src/content.ts";

const TREE = {
  sessions: [
    {
      id: "…0002",
      path: "/root/--beta--/s2.jsonl",
      timestamp: "2026-01-02T00:00:00.000Z",
      cwd: "/repo/beta",
      subagentSessions: [],
    },
    {
      id: "…0003",
      path: "/root/--alpha--/s3.jsonl",
      timestamp: "2026-01-03T00:00:00.000Z",
      cwd: "/repo/alpha",
      parentSessionPath: "/root/--alpha--/older.jsonl",
      subagentSessions: [
        {
          id: "…0030",
          path: "/root/--alpha--/s3/launch-a/run-0/session.jsonl",
          timestamp: "2026-01-03T00:05:00.000Z",
          cwd: "/repo/alpha",
          subagentSessions: [
            {
              id: "…0033",
              path: "/root/--alpha--/s3/launch-a/run-0/session/launch-c/run-0/session.jsonl",
              timestamp: "2026-01-03T00:30:00.000Z",
              cwd: "/repo/alpha",
              subagentSessions: [],
            },
          ],
        },
      ],
    },
  ],
  warnings: [
    { path: "/root/--alpha--/bad.jsonl", reason: "file is empty" },
    { path: "/root/--alpha--/s3/launch-d/run-0/session.jsonl", reason: "session header has no id" },
  ],
};

test("content lists session paths with nesting indentation, then warnings", () => {
  assert.equal(
    renderListSessionsContent(TREE),
    [
      "Sessions (2)",
      "- /root/--beta--/s2.jsonl",
      "- /root/--alpha--/s3.jsonl",
      "  - /root/--alpha--/s3/launch-a/run-0/session.jsonl",
      "    - /root/--alpha--/s3/launch-a/run-0/session/launch-c/run-0/session.jsonl",
      "",
      "Warnings (2)",
      "- /root/--alpha--/bad.jsonl: file is empty",
      "- /root/--alpha--/s3/launch-d/run-0/session.jsonl: session header has no id",
    ].join("\n"),
  );
});

test("content omits the warnings section when there are none", () => {
  const text = renderListSessionsContent({ sessions: TREE.sessions, warnings: [] });

  assert.equal(text.includes("Warnings"), false);
  assert.equal(text.split("\n").length, 5);
});

test("content reports an empty store without dropping the header", () => {
  assert.equal(renderListSessionsContent({ sessions: [], warnings: [] }), "Sessions (0)");

  assert.equal(
    renderListSessionsContent({
      sessions: [],
      warnings: [{ path: "/nope", reason: "sessions root not readable: ENOENT" }],
    }),
    ["Sessions (0)", "", "Warnings (1)", "- /nope: sessions root not readable: ENOENT"].join("\n"),
  );
});

test("content contains one row per session at every depth", () => {
  const text = renderListSessionsContent(TREE);

  for (const path of [
    TREE.sessions[0].path,
    TREE.sessions[1].path,
    TREE.sessions[1].subagentSessions[0].path,
    TREE.sessions[1].subagentSessions[0].subagentSessions[0].path,
  ]) {
    assert.ok(text.includes(path), `missing row for ${path}`);
  }

  // 1 header + 4 session rows (2 roots, 1 child, 1 grandchild) + blank + warnings header
  // + 2 warning rows.
  assert.equal(text.split("\n").length, 9);
});
