/**
 * Discovery and tree shape: which files become rows, how children nest, what gets warned
 * about once, and that the declared schema matches what is returned. Every case reads the
 * same committed tree under `test/fixtures/sessions/`.
 *
 * The store is read once at module scope, and every test below asserts against that same
 * result.
 *
 * Contract: docs/tool-api.md
 */

import { mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { listSessions } from "../src/list-sessions.ts";
import { ListSessionsOutputSchema, SessionMetadataSchema } from "../src/schemas.ts";
import type { ListSessionsOutput, SessionMetadata } from "../src/schemas.ts";

const FIXTURES = new URL("./fixtures/sessions/", import.meta.url).pathname;

/** Scratch tree for the empty-root case, written by the test and never committed. */
const TMP = new URL("tmp/", import.meta.url).pathname;

/** `00000000-0000-4000-8000-0000000000NN` -> NN, so expectations read as short labels. */
const tag = (id: string): string => id.slice(-4);
const tags = (sessions: SessionMetadata[]): string[] => sessions.map((session) => tag(session.id));

function flatten(sessions: SessionMetadata[], found: SessionMetadata[] = []): SessionMetadata[] {
  for (const session of sessions) {
    found.push(session);
    flatten(session.subagentSessions, found);
  }
  return found;
}

function isAscendingByTime(sessions: SessionMetadata[]): boolean {
  for (let i = 1; i < sessions.length; i += 1) {
    const previous = Date.parse(sessions[i - 1].timestamp);
    const current = Date.parse(sessions[i].timestamp);
    if (current < previous) return false;
    if (current === previous && sessions[i - 1].path > sessions[i].path) return false;
  }

  return true;
}

/** `.find()` is `T | undefined` under strict TS; the tests below all require the row to exist. */
function requireSession(sessions: SessionMetadata[], wanted: string): SessionMetadata {
  const found = sessions.find((session) => tag(session.id) === wanted);
  if (!found) throw new Error(`no session with tag ${wanted} in ${tags(sessions).join(", ")}`);
  return found;
}

let sessions: SessionMetadata[] = [];
let warnings: ListSessionsOutput["warnings"] = [];

beforeAll(async () => {
  ({ sessions, warnings } = await listSessions({}, { sessionsRoot: FIXTURES }));
});

describe("listSessions discovery", () => {
  it("returns every valid session at every level", () => {
    expect(
      tags(sessions),
      "expected timestamp ascending across project directories, with the filename order deliberately different",
    ).toStrictEqual(["0004", "0001", "0002", "0003", "0012", "0013", "0005"]);

    // The two 2026-01-01T10:00:00.000Z sessions tie on timestamp and split on path.
    expect(sessions[1].cwd).toBe("/repo/alpha");
    expect(sessions[2].cwd).toBe("/repo/beta");

    const parent = requireSession(sessions, "0003");
    expect(tags(parent.subagentSessions)).toStrictEqual(["0030", "0031", "0032"]);

    const first = parent.subagentSessions[0];
    expect(tags(first.subagentSessions), "grandchild groups under its own parent").toStrictEqual(["0033"]);
  });

  it("orders every session level by timestamp ascending, ties by path", () => {
    expect(isAscendingByTime(sessions)).toBe(true);

    const queue = [...sessions];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) throw new Error("queue drained mid-walk");
      expect(isAscendingByTime(current.subagentSessions), `unsorted children of ${current.id}`).toBe(true);
      queue.push(...current.subagentSessions);
    }
  });

  it("keeps every session path absolute and inside the sessions root", () => {
    for (const session of flatten(sessions)) {
      expect(isAbsolute(session.path), `${session.path} is not absolute`).toBe(true);
      expect(session.path.startsWith(FIXTURES), `${session.path} escapes the root`).toBe(true);
      expect(isAbsolute(session.cwd), `${session.cwd} is not absolute`).toBe(true);
      expect(session.path.endsWith(".jsonl")).toBe(true);
      expect(Number.isFinite(Date.parse(session.timestamp))).toBe(true);
      expect(Array.isArray(session.subagentSessions)).toBe(true);
    }
  });

  it("treats a resumed run directory as its own session entry", () => {
    const parent = requireSession(sessions, "0003");
    const runs = parent.subagentSessions.filter((session) => session.path.includes("/launch-bbbb/"));

    expect(runs.map((session) => session.path.split("/").slice(-3).join("/"))).toStrictEqual([
      "launch-bbbb/run-0/session.jsonl",
      "launch-bbbb/run-1/session.jsonl",
    ]);
  });

  it("copies parentSessionPath verbatim and only present when the header had one", () => {
    const withParent = sessions.filter((session) => "parentSessionPath" in session);

    expect(withParent.map((session) => tag(session.id))).toStrictEqual(["0003"]);
    expect(withParent[0].parentSessionPath).toBe(
      "/elsewhere/2025-12-31T00-00-00-000Z_00000000-0000-4000-8000-000000000099.jsonl",
    );
  });

  it("counts only --slug-- project directories as contributing top-level sessions", () => {
    const ids = new Set(flatten(sessions).map((session) => session.id));

    expect(ids.has("00000000-0000-4000-8000-000000000092"), "stray .jsonl at the root").toBe(false);
    expect(ids.has("00000000-0000-4000-8000-000000000093"), "session under a non-slug directory").toBe(false);
  });

  it("never returns subagent-artifacts copies and non-session filenames", () => {
    const paths = flatten(sessions).map((session) => session.path);

    expect(paths.some((path) => path.includes("subagent-artifacts"))).toBe(false);
    expect(paths.some((path) => path.endsWith("artifacts.jsonl"))).toBe(false);
    expect(paths.some((path) => path.endsWith("linked-session.jsonl")), "symlinked session file").toBe(false);
    expect(
      paths.filter((path) => path.includes("/run-0/session.jsonl")).length,
      "the three valid run-0 transcripts; the broken child and the orphan tree are excluded",
    ).toBe(3);

    const unique = new Set(paths);
    expect(unique.size, "no path appears under two parents").toBe(paths.length);
  });

  it("does not visit a stem directory with no matching parent file", () => {
    const ids = flatten(sessions).map((session) => session.id);
    const warned = warnings.map((warning) => warning.path);

    expect(ids.includes("00000000-0000-4000-8000-000000000094")).toBe(false);
    expect(
      warned.some((path) => path.includes("000000000094")),
      "an orphan tree is neither a row nor a warning",
    ).toBe(false);
  });
});

describe("listSessions warnings", () => {
  it("skips and warns about unreadable and invalid files, once each", () => {
    const expectedReasons: Array<[string, RegExp]> = [
      ["bad-zero-byte.jsonl", /file is empty/],
      ["bad-empty-line.jsonl", /first line is empty/],
      ["bad-nonjson.jsonl", /not valid JSON/],
      ["bad-array.jsonl", /not a JSON object/],
      ["bad-wrong-type.jsonl", /not a session header \(type: message\)/],
      ["bad-missing-id.jsonl", /no id/],
      ["bad-empty-cwd.jsonl", /no cwd/],
      ["bad-timestamp.jsonl", /ISO 8601/],
      ["bad-impossible-timestamp.jsonl", /ISO 8601/],
      ["bad-parent-session.jsonl", /parentSession is not a string/],
      ["00000000-0000-4000-8000-000000000006.jsonl", /longer than 4096 bytes/],
      // A broken child transcript: warned by its full path, absent from its parent's list.
      ["launch-dddd/run-0/session.jsonl", /ISO 8601/],
    ];

    for (const [suffix, expected] of expectedReasons) {
      const matches = warnings.filter((warning) => warning.path.endsWith(suffix));
      expect(matches.length, `expected exactly one warning for ${suffix}`).toBe(1);
      expect(matches[0].reason).toMatch(expected);
      expect(isAbsolute(matches[0].path)).toBe(true);
    }

    const warnedPaths = new Set(warnings.map((warning) => warning.path));
    for (const session of flatten(sessions)) {
      expect(warnedPaths.has(session.path), `${session.path} is both a row and a warning`).toBe(false);
    }

    expect(warnings.length).toBe(expectedReasons.length);
    expect(
      warnings.every((warning, index) => index === 0 || warnings[index - 1].path <= warning.path),
      "warnings are sorted by path so runs are reproducible",
    ).toBe(true);
  });

  it("accepts a header at exactly the 4096-byte bound, warns one byte past it", () => {
    const ids = flatten(sessions).map((session) => tag(session.id));

    expect(ids.includes("0005"), "4096-byte header must be accepted").toBe(true);
    expect(ids.includes("0006"), "4097-byte header must be rejected").toBe(false);
  });

  it("still treats a file whose last header line has no newline as a session", () => {
    expect(flatten(sessions).some((session) => tag(session.id) === "0012")).toBe(true);
  });

  it("returns empty plus one warning for an absent sessions root, not an error", async () => {
    const output = await listSessions({}, { sessionsRoot: "/definitely/not/here/sessions" });

    expect(output.sessions).toStrictEqual([]);
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0].path).toBe("/definitely/not/here/sessions");
    expect(output.warnings[0].reason).toMatch(/sessions root not readable/);
  });

  it("returns nothing and warns about nothing for an empty sessions root", async () => {
    const root = `${TMP}list-sessions-empty-root`;
    await mkdir(root, { recursive: true });

    const output = await listSessions({}, { sessionsRoot: root });

    expect(output.sessions).toStrictEqual([]);
    expect(output.warnings).toStrictEqual([]);
  });

  it("stops the walk on an aborted signal instead of returning partial data", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      listSessions({}, { sessionsRoot: FIXTURES, signal: controller.signal }),
    ).rejects.toSatisfy((error: Error) => error.name === "AbortError" || /abort/i.test(error.message));
  });
});

describe("declared output schema", () => {
  it("matches the returned shape", () => {
    expect(ListSessionsOutputSchema.type).toBe("object");
    expect(Object.keys(ListSessionsOutputSchema.properties)).toStrictEqual(["sessions", "warnings"]);
    expect(ListSessionsOutputSchema.required).toStrictEqual(["sessions", "warnings"]);

    const sessionType = SessionMetadataSchema.$defs.SessionMetadata;
    const properties = sessionType.properties;

    expect(Object.keys(properties).sort()).toStrictEqual([
      "cwd",
      "id",
      "parentSessionPath",
      "path",
      "subagentSessions",
      "timestamp",
    ]);

    const required = sessionType.required;
    expect(required).toStrictEqual(["id", "path", "timestamp", "cwd", "subagentSessions"]);

    for (const session of flatten(sessions)) {
      const keys = Object.keys(session).sort();
      expect(
        keys.every((key) => key in properties),
        `unexpected field in ${session.path}: ${keys.filter((key) => !(key in properties)).join(", ")}`,
      ).toBe(true);

      for (const field of required) {
        expect(field in session, `${field} missing from ${session.path}`).toBe(true);
      }
    }
  });
});
