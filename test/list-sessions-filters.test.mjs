/**
 * Parameter behavior of `listSessions`: filtering, ordering, and limiting.
 *
 * Contract: docs/tool-api.md
 */

import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { listSessions } from "../src/list-sessions.ts";

const FIXTURES = new URL("./fixtures/sessions/", import.meta.url).pathname;

/** Scratch trees for parameter grids that the committed fixtures deliberately do not hold. */
const TMP = new URL("tmp/filters/", import.meta.url).pathname;

const uuid = (n) => `00000000-0000-4000-8000-00000000${String(n).padStart(4, "0")}`;

/**
 * Write a store of one session per row, each in its own `--slug--` project directory.
 *
 * A row with `childOf` becomes a subagent transcript of that row instead: it lands at
 * `<parent-stem>/launch-0/run-0/session.jsonl`, which is how Pi stores delegated runs.
 * Returns the root, ready for `listSessions({ ... }, { sessionsRoot: root })`.
 */
async function makeStore(name, rows) {
  const root = join(TMP, name);
  await rm(root, { recursive: true, force: true });

  const directoryOf = new Map();

  for (const [index, row] of rows.entries()) {
    directoryOf.set(row.id, join(root, `--scratch-${index}--`));
  }

  for (const [index, row] of rows.entries()) {
    const parent = row.childOf === undefined ? undefined : directoryOf.get(row.childOf);
    // Each delegated run owns a launch directory, so two children of one parent never
    // collide on `<launch-uuid>/run-0/session.jsonl`.
    const file =
      parent === undefined
        ? join(directoryOf.get(row.id), `${row.id}.jsonl`)
        : join(parent, row.childOf, `launch-${row.id.slice(-4)}`, "run-0", "session.jsonl");

    await mkdir(dirname(file), { recursive: true });
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: row.id,
      timestamp: row.timestamp,
      cwd: row.cwd,
    });
    await writeFile(file, `${header}\n`);
  }

  return root;
}

/** `00000000-0000-4000-8000-0000000000NN` -> NN, so expectations read as short labels. */
const tag = (id) => id.slice(-4);
const tags = (sessions) => sessions.map((session) => tag(session.id));

test("cwds selects top-level sessions by exact working directory", async () => {
  const output = await listSessions({ cwds: ["/repo/alpha"] }, { sessionsRoot: FIXTURES });

  assert.deepEqual(
    tags(output.sessions),
    ["0004", "0001", "0003", "0005"],
    "only sessions whose cwd is /repo/alpha, still timestamp ascending",
  );
  assert.ok(
    output.sessions.every((session) => session.cwd === "/repo/alpha"),
    "no other cwd leaked in",
  );
});

const WORKTREES = [
  { id: uuid(101), cwd: "/repo/app", timestamp: "2026-01-01T00:00:00.000Z" },
  { id: uuid(102), cwd: "/repo/app-feature", timestamp: "2026-01-02T00:00:00.000Z" },
  { id: uuid(103), cwd: "/repo/app-review", timestamp: "2026-01-03T00:00:00.000Z" },
  // Prefixed basename with no dash separator.
  { id: uuid(104), cwd: "/repo/application", timestamp: "2026-01-04T00:00:00.000Z" },
  // Right basename shape, wrong parent directory.
  { id: uuid(105), cwd: "/other/app-feature", timestamp: "2026-01-05T00:00:00.000Z" },
  // Not a sibling: a directory nested inside the requested cwd.
  { id: uuid(106), cwd: "/repo/app/sub", timestamp: "2026-01-06T00:00:00.000Z" },
];

test("cwdMatch sibling-prefix adds sibling directories whose basename extends the requested one", async () => {
  const root = await makeStore("worktrees", WORKTREES);

  const output = await listSessions(
    { cwds: ["/repo/app"], cwdMatch: "sibling-prefix" },
    { sessionsRoot: root },
  );

  assert.deepEqual(tags(output.sessions), ["0101", "0102", "0103"]);
});

test("cwdMatch sibling-prefix tolerates a trailing separator on the requested cwd", async () => {
  const root = await makeStore("worktrees-trailing", WORKTREES);

  const output = await listSessions(
    { cwds: ["/repo/app/"], cwdMatch: "sibling-prefix" },
    { sessionsRoot: root },
  );

  assert.deepEqual(tags(output.sessions), ["0101", "0102", "0103"]);
});

/**
 * Grid around the boundaries: the last instant of January, the first instant of February,
 * midday, the last instant of the 5th, and the first instant of the 6th.
 */
const DAYS = [
  { id: uuid(111), cwd: "/repo/app", timestamp: "2026-01-31T23:59:59.999Z" },
  { id: uuid(112), cwd: "/repo/app", timestamp: "2026-02-01T00:00:00.000Z" },
  { id: uuid(113), cwd: "/repo/app", timestamp: "2026-02-01T12:30:00.000Z" },
  { id: uuid(114), cwd: "/repo/app", timestamp: "2026-02-05T23:59:59.999Z" },
  { id: uuid(115), cwd: "/repo/app", timestamp: "2026-02-06T00:00:00.000Z" },
];

test("startTimestamp as a date keeps sessions from the start of that UTC day", async () => {
  const root = await makeStore("date-start", DAYS);

  const output = await listSessions({ startTimestamp: "2026-02-01" }, { sessionsRoot: root });

  assert.deepEqual(tags(output.sessions), ["0112", "0113", "0114", "0115"]);
});

test("endTimestamp as a date keeps the whole UTC day but not the next one", async () => {
  const root = await makeStore("date-end", DAYS);

  const output = await listSessions({ endTimestamp: "2026-02-05" }, { sessionsRoot: root });

  assert.deepEqual(tags(output.sessions), ["0111", "0112", "0113", "0114"]);
});

test("endTimestamp as a date-time is an exact instant and keeps a session at that instant", async () => {
  const root = await makeStore("datetime-end", DAYS);

  const output = await listSessions({ endTimestamp: "2026-02-01T12:30:00.000Z" }, { sessionsRoot: root });

  assert.deepEqual(tags(output.sessions), ["0111", "0112", "0113"]);
});

test("a boundary date-time with an explicit offset compares as the same instant", async () => {
  const root = await makeStore("datetime-offset", DAYS);

  const output = await listSessions({ endTimestamp: "2026-02-01T13:30:00+01:00" }, { sessionsRoot: root });

  assert.deepEqual(tags(output.sessions), ["0111", "0112", "0113"]);
});

test("a boundary date-time without a timezone is rejected instead of read as local time", async () => {
  const root = await makeStore("datetime-naive", DAYS);

  await assert.rejects(
    listSessions({ startTimestamp: "2026-02-01T12:30:00" }, { sessionsRoot: root }),
    /startTimestamp.*timezone/i,
  );
});

test("a nonsense timestamp parameter is rejected, not treated as an empty range", async () => {
  const root = await makeStore("nonsense", DAYS);

  await assert.rejects(listSessions({ startTimestamp: "yesterday" }, { sessionsRoot: root }), /startTimestamp/);
  await assert.rejects(listSessions({ endTimestamp: "next week" }, { sessionsRoot: root }), /endTimestamp/);
});

test("an impossible calendar date is rejected rather than rolled over", async () => {
  const root = await makeStore("impossible-date", DAYS);

  await assert.rejects(listSessions({ startTimestamp: "2026-02-30" }, { sessionsRoot: root }), /startTimestamp/);
  await assert.rejects(listSessions({ endTimestamp: "2026-13-01" }, { sessionsRoot: root }), /endTimestamp/);
});

test("a reversed range is rejected, and bad parameters never reach the filesystem", async () => {
  const root = await makeStore("reversed", DAYS);

  await assert.rejects(
    listSessions({ startTimestamp: "2026-02-05", endTimestamp: "2026-02-01" }, { sessionsRoot: root }),
    /endTimestamp.*before.*startTimestamp|startTimestamp.*after.*endTimestamp/i,
  );

  await assert.rejects(
    listSessions({ startTimestamp: "garbage" }, { sessionsRoot: "/definitely/not/here/sessions" }),
    /startTimestamp/,
    "parameter errors outrank the missing-root warning",
  );
});

test("a one-day range from equal dates keeps that whole day", async () => {
  const root = await makeStore("equal-dates", DAYS);

  const output = await listSessions(
    { startTimestamp: "2026-02-01", endTimestamp: "2026-02-01" },
    { sessionsRoot: root },
  );

  assert.deepEqual(tags(output.sessions), ["0112", "0113"]);
});

test("sortDirection desc reverses the roots, tie-break included", async () => {
  const output = await listSessions({ sortDirection: "desc" }, { sessionsRoot: FIXTURES });

  assert.deepEqual(tags(output.sessions), ["0005", "0013", "0012", "0003", "0002", "0001", "0004"]);
  assert.ok(
    tags(output.sessions).indexOf("0002") < tags(output.sessions).indexOf("0001"),
    "the two 2026-01-01T10:00:00.000Z roots reverse their path tie-break too",
  );
});

test("sortBy cwd groups roots by directory, then by timestamp and path", async () => {
  const output = await listSessions({ sortBy: "cwd" }, { sessionsRoot: FIXTURES });

  assert.deepEqual(tags(output.sessions), ["0004", "0001", "0003", "0005", "0002", "0012", "0013"]);
});

test("sortBy path orders roots by filename, project directory first", async () => {
  const output = await listSessions({ sortBy: "path" }, { sessionsRoot: FIXTURES });

  assert.deepEqual(tags(output.sessions), ["0001", "0003", "0004", "0005", "0002", "0012", "0013"]);
});

function flatten(sessions, found = []) {
  for (const session of sessions) {
    found.push(session);
    flatten(session.subagentSessions, found);
  }
  return found;
}

test("sorting desc leaves each parent's children in launch order", async () => {
  const output = await listSessions({ sortDirection: "desc" }, { sessionsRoot: FIXTURES });

  const parent = output.sessions.find((session) => tag(session.id) === "0003");
  assert.deepEqual(tags(parent.subagentSessions), ["0030", "0031", "0032"]);
  assert.deepEqual(tags(parent.subagentSessions[0].subagentSessions), ["0033"]);
});

test("limit caps top-level sessions after filtering and sorting", async () => {
  const root = await makeStore("limit-desc", DAYS);

  const output = await listSessions({ limit: 2, sortDirection: "desc" }, { sessionsRoot: root });

  assert.deepEqual(tags(output.sessions), ["0115", "0114"]);
});

test("limit counts top-level sessions only, keeping each parent's children", async () => {
  const root = await makeStore(
    "limit-children",
    [
      { id: uuid(121), cwd: "/repo/app", timestamp: "2026-02-01T00:00:00.000Z" },
      { id: uuid(122), cwd: "/repo/app", timestamp: "2026-02-02T00:00:00.000Z" },
      { id: uuid(130), cwd: "/repo/app", timestamp: "2026-02-01T01:00:00.000Z", childOf: uuid(121) },
      { id: uuid(131), cwd: "/repo/app", timestamp: "2026-02-01T02:00:00.000Z", childOf: uuid(121) },
    ],
  );

  // Ascending, so the kept root is the parent that owns both children.
  const output = await listSessions({ limit: 1 }, { sessionsRoot: root });

  assert.deepEqual(tags(output.sessions), ["0121"]);
  assert.deepEqual(tags(output.sessions[0].subagentSessions), ["0130", "0131"]);
  assert.equal(flatten(output.sessions).length, 3, "one row kept, its children arrive with it");
});

test("a limit larger than the result set changes nothing", async () => {
  const root = await makeStore("limit-generous", DAYS);

  const output = await listSessions({ limit: 99 }, { sessionsRoot: root });

  assert.deepEqual(tags(output.sessions), tags((await listSessions({}, { sessionsRoot: root })).sessions));
});

test("limit below one is rejected instead of silently returning nothing", async () => {
  const root = await makeStore("limit-zero", DAYS);

  await assert.rejects(listSessions({ limit: 0 }, { sessionsRoot: root }), /limit/);
  await assert.rejects(listSessions({ limit: -3 }, { sessionsRoot: root }), /limit/);
});

test("warnings still cover the whole scan when filters keep nothing", async () => {
  const output = await listSessions({ cwds: ["/repo/never"] }, { sessionsRoot: FIXTURES });

  assert.deepEqual(output.sessions, []);
  assert.equal(output.warnings.length, 12, "every skipped file is still reported");
});

test("an empty cwds array selects nothing, which the schema refuses before this code runs", async () => {
  const output = await listSessions({ cwds: [] }, { sessionsRoot: FIXTURES });

  assert.deepEqual(output.sessions, []);
});

test("cwdMatch is meaningless without cwds and never filters by itself", async () => {
  const output = await listSessions({ cwdMatch: "sibling-prefix" }, { sessionsRoot: FIXTURES });

  assert.equal(output.sessions.length, 7, "every session still returned");
});

test("sortBy id orders roots by session id", async () => {
  const output = await listSessions({ sortBy: "id" }, { sessionsRoot: FIXTURES });

  assert.deepEqual(tags(output.sessions), ["0001", "0002", "0003", "0004", "0005", "0012", "0013"]);
});

test("filters never descend into subagentSessions", async () => {
  const root = await makeStore(
    "children-survive",
    [
      { id: uuid(141), cwd: "/repo/app", timestamp: "2026-02-01T00:00:00.000Z" },
      // Child outside the requested window and with a different cwd: still returned with its parent.
      { id: uuid(142), cwd: "/repo/other", timestamp: "2026-04-01T00:00:00.000Z", childOf: uuid(141) },
      { id: uuid(143), cwd: "/repo/app", timestamp: "2026-04-02T00:00:00.000Z" },
    ],
  );

  const output = await listSessions(
    { cwds: ["/repo/app"], endTimestamp: "2026-02-28" },
    { sessionsRoot: root },
  );

  assert.deepEqual(tags(output.sessions), ["0141"]);
  assert.deepEqual(tags(output.sessions[0].subagentSessions), ["0142"]);
});
