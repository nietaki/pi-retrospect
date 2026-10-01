import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { test } from "node:test";

import { listSessions } from "../src/list-sessions.ts";
import { ListSessionsOutputSchema, SessionMetadataSchema } from "../src/schemas.ts";

const FIXTURES = new URL("./fixtures/sessions/", import.meta.url).pathname;

/** `00000000-0000-4000-8000-0000000000NN` -> NN, so expectations read as short labels. */
const tag = (id) => id.slice(-4);
const tags = (sessions) => sessions.map((session) => tag(session.id));

function flatten(sessions, found = []) {
  for (const session of sessions) {
    found.push(session);
    flatten(session.subagentSessions, found);
  }
  return found;
}

function isAscendingByTime(sessions) {
  for (let i = 1; i < sessions.length; i += 1) {
    const previous = Date.parse(sessions[i - 1].timestamp);
    const current = Date.parse(sessions[i].timestamp);
    if (current < previous) return false;
    if (current === previous && sessions[i - 1].path > sessions[i].path) return false;
  }

  return true;
}

const { sessions, warnings } = await listSessions({}, { sessionsRoot: FIXTURES });

test("listSessions returns every valid session at every level", () => {
  assert.deepEqual(
    tags(sessions),
    ["0004", "0001", "0002", "0003", "0012", "0013", "0005"],
    "expected timestamp ascending across project directories, with the filename order deliberately different",
  );

  // The two 2026-01-01T10:00:00.000Z sessions tie on timestamp and split on path.
  assert.equal(sessions[1].cwd, "/repo/alpha");
  assert.equal(sessions[2].cwd, "/repo/beta");

  const parent = sessions.find((session) => tag(session.id) === "0003");
  assert.deepEqual(tags(parent.subagentSessions), ["0030", "0031", "0032"]);

  const first = parent.subagentSessions[0];
  assert.deepEqual(tags(first.subagentSessions), ["0033"], "grandchild groups under its own parent");
});

test("every session level is ordered by timestamp ascending, ties by path", () => {
  assert.ok(isAscendingByTime(sessions));

  const queue = [...sessions];
  while (queue.length > 0) {
    const current = queue.shift();
    assert.ok(isAscendingByTime(current.subagentSessions), `unsorted children of ${current.id}`);
    queue.push(...current.subagentSessions);
  }
});

test("every session path is absolute and inside the sessions root", () => {
  for (const session of flatten(sessions)) {
    assert.ok(isAbsolute(session.path), `${session.path} is not absolute`);
    assert.ok(session.path.startsWith(FIXTURES), `${session.path} escapes the root`);
    assert.ok(isAbsolute(session.cwd), `${session.cwd} is not absolute`);
    assert.ok(session.path.endsWith(".jsonl"));
    assert.ok(Number.isFinite(Date.parse(session.timestamp)));
    assert.ok(Array.isArray(session.subagentSessions));
  }
});

test("a resumed run directory is its own session entry", () => {
  const parent = sessions.find((session) => tag(session.id) === "0003");
  const runs = parent.subagentSessions.filter((session) => session.path.includes("/launch-bbbb/"));

  assert.deepEqual(
    runs.map((session) => session.path.split("/").slice(-3).join("/")),
    ["launch-bbbb/run-0/session.jsonl", "launch-bbbb/run-1/session.jsonl"],
  );
});

test("parentSessionPath is copied verbatim and only present when the header had one", () => {
  const withParent = sessions.filter((session) => "parentSessionPath" in session);

  assert.deepEqual(
    withParent.map((session) => tag(session.id)),
    ["0003"],
  );
  assert.equal(
    withParent[0].parentSessionPath,
    "/elsewhere/2025-12-31T00-00-00-000Z_00000000-0000-4000-8000-000000000099.jsonl",
  );
});

test("only --slug-- project directories contribute top-level sessions", () => {
  const ids = new Set(flatten(sessions).map((session) => session.id));

  assert.equal(ids.has("00000000-0000-4000-8000-000000000092"), false, "stray .jsonl at the root");
  assert.equal(ids.has("00000000-0000-4000-8000-000000000093"), false, "session under a non-slug directory");
});

test("subagent-artifacts copies and non-session filenames are never returned", () => {
  const paths = flatten(sessions).map((session) => session.path);

  assert.equal(paths.some((path) => path.includes("subagent-artifacts")), false);
  assert.equal(paths.some((path) => path.endsWith("artifacts.jsonl")), false);
  assert.equal(paths.some((path) => path.endsWith("linked-session.jsonl")), false, "symlinked session file");
  assert.equal(
    paths.filter((path) => path.includes("/run-0/session.jsonl")).length,
    3,
    "the three valid run-0 transcripts; the broken child and the orphan tree are excluded",
  );

  const unique = new Set(paths);
  assert.equal(unique.size, paths.length, "no path appears under two parents");
});

test("a stem directory with no matching parent file is not visited", () => {
  const ids = flatten(sessions).map((session) => session.id);
  const warned = warnings.map((warning) => warning.path);

  assert.equal(ids.includes("00000000-0000-4000-8000-000000000094"), false);
  assert.equal(
    warned.some((path) => path.includes("000000000094")),
    false,
    "an orphan tree is neither a row nor a warning",
  );
});

test("unreadable and invalid files are skipped and warned about, once each", () => {
  const expectedReasons = [
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
    assert.equal(matches.length, 1, `expected exactly one warning for ${suffix}`);
    assert.match(matches[0].reason, expected);
    assert.ok(isAbsolute(matches[0].path));
  }

  const warnedPaths = new Set(warnings.map((warning) => warning.path));
  for (const session of flatten(sessions)) {
    assert.equal(warnedPaths.has(session.path), false, `${session.path} is both a row and a warning`);
  }

  assert.equal(warnings.length, expectedReasons.length);
  assert.ok(
    warnings.every((warning, index) => index === 0 || warnings[index - 1].path <= warning.path),
    "warnings are sorted by path so runs are reproducible",
  );
});

test("a header at exactly the 4096-byte bound is a session, one byte more is a warning", () => {
  const ids = flatten(sessions).map((session) => tag(session.id));

  assert.ok(ids.includes("0005"), "4096-byte header must be accepted");
  assert.ok(!ids.includes("0006"), "4097-byte header must be rejected");
});

test("a file whose last header line has no newline is still a session", () => {
  assert.ok(flatten(sessions).some((session) => tag(session.id) === "0012"));
});

test("an absent sessions root is empty plus one warning, not an error", async () => {
  const output = await listSessions({}, { sessionsRoot: "/definitely/not/here/sessions" });

  assert.deepEqual(output.sessions, []);
  assert.equal(output.warnings.length, 1);
  assert.equal(output.warnings[0].path, "/definitely/not/here/sessions");
  assert.match(output.warnings[0].reason, /sessions root not readable/);
});

test("an empty sessions root returns nothing and warns about nothing", async () => {
  const root = new URL("tmp/empty-root/", import.meta.url).pathname;
  await mkdir(root, { recursive: true });

  const output = await listSessions({}, { sessionsRoot: root });

  assert.deepEqual(output.sessions, []);
  assert.deepEqual(output.warnings, []);
});

test("an aborted signal stops the walk instead of returning partial data", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    listSessions({}, { sessionsRoot: FIXTURES, signal: controller.signal }),
    (error) => error.name === "AbortError" || /abort/i.test(error.message),
  );
});

test("the declared output schema matches the returned shape", () => {
  assert.equal(ListSessionsOutputSchema.type, "object");
  assert.deepEqual(Object.keys(ListSessionsOutputSchema.properties), ["sessions", "warnings"]);
  assert.deepEqual(ListSessionsOutputSchema.required, ["sessions", "warnings"]);

  const properties = SessionMetadataSchema.$defs.SessionMetadata.properties;
  assert.deepEqual(Object.keys(properties).sort(), [
    "cwd",
    "id",
    "parentSessionPath",
    "path",
    "subagentSessions",
    "timestamp",
  ]);
  assert.deepEqual(SessionMetadataSchema.$defs.SessionMetadata.required, [
    "id",
    "path",
    "timestamp",
    "cwd",
    "subagentSessions",
  ]);

  for (const session of flatten(sessions)) {
    const keys = Object.keys(session).sort();
    assert.ok(
      keys.every((key) => key in properties),
      `unexpected field in ${session.path}: ${keys.filter((key) => !(key in properties)).join(", ")}`,
    );
    for (const required of SessionMetadataSchema.$defs.SessionMetadata.required) {
      assert.ok(required in session, `${required} missing from ${session.path}`);
    }
  }
});
