/**
 * Covers `renderListSessionsContent`: path rows with nesting indentation, the conditional
 * warnings section, and the empty-store header. Also covers `renderSessionEntriesContent`:
 * line-numbered entry rows with no raw payload, and its line-level plus file-level warnings.
 *
 * Contract: docs/tool-api.md
 */

import { describe, expect, it } from "vitest";

import { renderListSessionsContent, renderSessionEntriesContent } from "../src/content.ts";
import type { ListSessionsOutput, SessionEntriesOutput, SessionFileEntry } from "../src/schemas.ts";

const TREE: ListSessionsOutput = {
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

describe("renderListSessionsContent", () => {
  it("lists session paths with nesting indentation, then warnings", () => {
    expect(renderListSessionsContent(TREE)).toBe(
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

  it("omits the warnings section when there are none", () => {
    const text = renderListSessionsContent({ sessions: TREE.sessions, warnings: [] });

    expect(text.includes("Warnings")).toBe(false);
    expect(text.split("\n")).toHaveLength(5);
  });

  it("reports an empty store without dropping the header", () => {
    expect(renderListSessionsContent({ sessions: [], warnings: [] })).toBe("Sessions (0)");

    expect(
      renderListSessionsContent({
        sessions: [],
        warnings: [{ path: "/nope", reason: "sessions root not readable: ENOENT" }],
      }),
    ).toBe(
      ["Sessions (0)", "", "Warnings (1)", "- /nope: sessions root not readable: ENOENT"].join("\n"),
    );
  });

  it("contains one row per session at every depth", () => {
    const text = renderListSessionsContent(TREE);

    const rows = [
      TREE.sessions[0].path,
      TREE.sessions[1].path,
      TREE.sessions[1].subagentSessions[0].path,
      TREE.sessions[1].subagentSessions[0].subagentSessions[0].path,
    ];

    for (const path of rows) {
      expect(text, `missing row for ${path}`).toContain(path);
    }

    // 1 header + 4 session rows (2 roots, 1 child, 1 grandchild) + blank + warnings header
    // + 2 warning rows.
    expect(text.split("\n")).toHaveLength(9);
  });
});

const MESSAGE_ROW: SessionFileEntry = {
  lineNo: 2,
  id: "aaaa1111",
  parentId: null,
  timestamp: "2026-01-01T10:00:01.000Z",
  type: "message",
  messageRole: "user",
  raw: { id: "aaaa1111", message: { content: "SECRET PAYLOAD" } },
};

const ADDRESSLESS_ROW: SessionFileEntry = {
  ...MESSAGE_ROW,
  lineNo: 3,
  id: null,
  type: "model_change",
  messageRole: null,
  raw: {},
};

describe("renderSessionEntriesContent", () => {
  it("indexes rows by line, type, role, and id without rendering raw", () => {
    const output: SessionEntriesOutput = { entries: [MESSAGE_ROW, ADDRESSLESS_ROW], warnings: [] };

    expect(renderSessionEntriesContent(output)).toBe(
      ["Entries (2)", "- 2 message user aaaa1111", "- 3 model_change"].join("\n"),
    );
  });

  it("never leaks a raw payload into the text", () => {
    const text = renderSessionEntriesContent({ entries: [MESSAGE_ROW], warnings: [] });

    expect(text).not.toContain("SECRET PAYLOAD");
    expect(text).not.toContain("raw");
  });

  it("omits the warnings section when there are none", () => {
    expect(renderSessionEntriesContent({ entries: [], warnings: [] })).toBe("Entries (0)");
  });

  it("names the line for a line warning and the file for a file warning", () => {
    const text = renderSessionEntriesContent({
      entries: [],
      warnings: [
        { lineNo: null, code: "legacy_version", reason: "session version 1: ids absent" },
        { lineNo: 7, code: "invalid_json", reason: "line is not valid JSON" },
      ],
    });

    expect(text).toBe(
      [
        "Entries (0)",
        "",
        "Warnings (2)",
        "- file legacy_version: session version 1: ids absent",
        "- line 7 invalid_json: line is not valid JSON",
      ].join("\n"),
    );
  });
});
