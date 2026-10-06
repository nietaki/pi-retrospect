/**
 * Parameter behavior of `listSessions`: filtering, ordering, and limiting.
 *
 * Scratch trees are built under `test/tmp/filters/` (gitignored) for grids the committed
 * fixtures deliberately do not hold. Committed fixtures under `test/fixtures/sessions/` are
 * read-only and shared.
 *
 * Contract: docs/tool-api.md
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { listSessions } from "../src/list-sessions.ts";
import { instantOf } from "../src/query.ts";
import type { SessionMetadata } from "../src/schemas.ts";

const FIXTURES = new URL("./fixtures/sessions/", import.meta.url).pathname;

/** Scratch trees for parameter grids that the committed fixtures deliberately do not hold. */
const TMP = new URL("tmp/filters/", import.meta.url).pathname;

const uuid = (n: number): string => `00000000-0000-4000-8000-00000000${String(n).padStart(4, "0")}`;

type StoreRow = { id: string; cwd: string; timestamp: string; childOf?: string };

/**
 * Write a store of one session per row, each in its own `--slug--` project directory.
 *
 * A row with `childOf` becomes a subagent transcript of that row instead: it lands at
 * `<parent-stem>/launch-0/run-0/session.jsonl`, which is how Pi stores delegated runs.
 * Returns the root, ready for `listSessions({ ... }, { sessionsRoot: root })`.
 */
async function makeStore(name: string, rows: StoreRow[]): Promise<string> {
  const root = join(TMP, name);
  await rm(root, { recursive: true, force: true });

  const directoryOf = new Map<string, string>();

  for (const [index, row] of rows.entries()) {
    directoryOf.set(row.id, join(root, `--scratch-${index}--`));
  }

  /** `Map.get()` is `string | undefined`; every id here was just recorded, so require it. */
  const dirOf = (id: string): string => {
    const directory = directoryOf.get(id);
    if (directory === undefined) throw new Error(`no scratch directory recorded for ${id}`);
    return directory;
  };

  for (const row of rows) {
    // Each delegated run owns a launch directory, so two children of one parent never
    // collide on `<launch-uuid>/run-0/session.jsonl`.
    const file =
      row.childOf === undefined
        ? join(dirOf(row.id), `${row.id}.jsonl`)
        : join(dirOf(row.childOf), row.childOf, `launch-${row.id.slice(-4)}`, "run-0", "session.jsonl");

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
const tag = (id: string): string => id.slice(-4);
const tags = (sessions: SessionMetadata[]): string[] => sessions.map((session) => tag(session.id));

/**
 * Run `body` with the host timezone forced to `zone`, then put the variable back.
 *
 * `body` is awaited inside the `try`: the timestamp grammar reads the zone every time it parses, and
 * for `listSessions` some of that work happens after its first `await`.
 */
async function withZone<T>(zone: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

function flatten(sessions: SessionMetadata[], found: SessionMetadata[] = []): SessionMetadata[] {
  for (const session of sessions) {
    found.push(session);
    flatten(session.subagentSessions, found);
  }
  return found;
}

function requireSession(sessions: SessionMetadata[], wanted: string): SessionMetadata {
  const found = sessions.find((session) => tag(session.id) === wanted);
  if (!found) throw new Error(`no session with tag ${wanted} in ${tags(sessions).join(", ")}`);
  return found;
}

const WORKTREES: StoreRow[] = [
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

/**
 * Grid around the boundaries: the last instant of January, the first instant of February,
 * midday, the last instant of the 5th, and the first instant of the 6th.
 */
const DAYS: StoreRow[] = [
  { id: uuid(111), cwd: "/repo/app", timestamp: "2026-01-31T23:59:59.999Z" },
  { id: uuid(112), cwd: "/repo/app", timestamp: "2026-02-01T00:00:00.000Z" },
  { id: uuid(113), cwd: "/repo/app", timestamp: "2026-02-01T12:30:00.000Z" },
  { id: uuid(114), cwd: "/repo/app", timestamp: "2026-02-05T23:59:59.999Z" },
  { id: uuid(115), cwd: "/repo/app", timestamp: "2026-02-06T00:00:00.000Z" },
];

/** Three plain top-level sessions, oldest first, for current-session cases. */
const CURRENT: StoreRow[] = [
  { id: uuid(161), cwd: "/repo/app", timestamp: "2026-02-01T00:00:00.000Z" },
  { id: uuid(162), cwd: "/repo/app", timestamp: "2026-02-02T00:00:00.000Z" },
  { id: uuid(163), cwd: "/repo/app", timestamp: "2026-02-03T00:00:00.000Z" },
];

/**
 * Two files that carry the *same* header id, in two project directories.
 *
 * The committed fixtures never duplicate an id, and `makeStore` derives the filename from it,
 * so a copy of a session file — which is what a fork or a hand copy produces — needs its own
 * store. Returns the root plus both paths so a case can name the current one and assert on the
 * copy by path rather than by the id they share.
 */
async function makeCopyStore(name: string): Promise<{ root: string; current: string; copy: string }> {
  const root = join(TMP, name);
  await rm(root, { recursive: true, force: true });

  const current = join(root, "--scratch-a--", "current.jsonl");
  const copy = join(root, "--scratch-b--", "copy.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: uuid(180),
    timestamp: "2026-02-01T00:00:00.000Z",
    cwd: "/repo/app",
  };

  for (const file of [current, copy]) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(header)}\n`);
  }

  return { root, current, copy };
}

describe("cwds and cwdMatch", () => {
  it("selects top-level sessions by exact working directory", async () => {
    const output = await listSessions({ cwds: ["/repo/alpha"] }, { sessionsRoot: FIXTURES });

    expect(
      tags(output.sessions),
      "only sessions whose cwd is /repo/alpha, still timestamp ascending",
    ).toStrictEqual(["0004", "0001", "0003", "0005"]);

    expect(output.sessions.every((session) => session.cwd === "/repo/alpha"), "no other cwd leaked in").toBe(
      true,
    );
  });

  it("sibling-prefix adds sibling directories whose basename extends the requested one", async () => {
    const root = await makeStore("worktrees", WORKTREES);

    const output = await listSessions(
      { cwds: ["/repo/app"], cwdMatch: "sibling-prefix" },
      { sessionsRoot: root },
    );

    expect(tags(output.sessions)).toStrictEqual(["0101", "0102", "0103"]);
  });

  it("sibling-prefix tolerates a trailing separator on the requested cwd", async () => {
    const root = await makeStore("worktrees-trailing", WORKTREES);

    const output = await listSessions(
      { cwds: ["/repo/app/"], cwdMatch: "sibling-prefix" },
      { sessionsRoot: root },
    );

    expect(tags(output.sessions)).toStrictEqual(["0101", "0102", "0103"]);
  });

  it("cwdMatch is meaningless without cwds and never filters by itself", async () => {
    const output = await listSessions({ cwdMatch: "sibling-prefix" }, { sessionsRoot: FIXTURES });

    expect(output.sessions.length, "every session still returned").toBe(7);
  });

  it("an empty cwds array selects nothing, which the schema refuses before this code runs", async () => {
    const output = await listSessions({ cwds: [] }, { sessionsRoot: FIXTURES });

    expect(output.sessions).toStrictEqual([]);
  });
});

describe("timestamp ranges", () => {
  it("startTimestamp as a date keeps sessions from the start of that local day", async () => {
    // The day is the host's, and vitest.config.ts pins the host to UTC, so the grid's UTC midnights
    // are the edges asserted here. "reads a naive bound in the host timezone" below shows what
    // another zone does to the same call.
    const root = await makeStore("date-start", DAYS);

    const output = await listSessions({ startTimestamp: "2026-02-01" }, { sessionsRoot: root });

    expect(tags(output.sessions)).toStrictEqual(["0112", "0113", "0114", "0115"]);
  });

  it("endTimestamp as a date keeps the whole local day but not the next one", async () => {
    const root = await makeStore("date-end", DAYS);

    const output = await listSessions({ endTimestamp: "2026-02-05" }, { sessionsRoot: root });

    expect(tags(output.sessions)).toStrictEqual(["0111", "0112", "0113", "0114"]);
  });

  it("endTimestamp as a date-time is an exact instant and keeps a session at that instant", async () => {
    const root = await makeStore("datetime-end", DAYS);

    const output = await listSessions({ endTimestamp: "2026-02-01T12:30:00.000Z" }, { sessionsRoot: root });

    expect(tags(output.sessions)).toStrictEqual(["0111", "0112", "0113"]);
  });

  it("a boundary date-time with an explicit offset compares as the same instant", async () => {
    const root = await makeStore("datetime-offset", DAYS);

    const output = await listSessions({ endTimestamp: "2026-02-01T13:30:00+01:00" }, { sessionsRoot: root });

    expect(tags(output.sessions)).toStrictEqual(["0111", "0112", "0113"]);
  });

  it("a boundary date-time with no timezone is read in the host timezone", async () => {
    const root = await makeStore("datetime-naive", DAYS);

    const naive = await listSessions({ startTimestamp: "2026-02-01T00:30:00" }, { sessionsRoot: root });
    const explicit = await listSessions({ startTimestamp: "2026-02-01T00:30:00Z" }, { sessionsRoot: root });

    // Pinned to UTC, so a naive bound and the same bound written with `Z` are one instant, and the
    // session at 00:00Z is outside a range that starts at 00:30.
    expect(tags(naive.sessions)).toStrictEqual(["0113", "0114", "0115"]);
    expect(naive).toStrictEqual(explicit);

    // Away from the pin the same string is a different instant, and the January session comes back
    // inside the range. That is the documented cost of accepting a naive bound, not a defect.
    const tokyo = await withZone("Asia/Tokyo", () =>
      listSessions({ startTimestamp: "2026-02-01T00:30:00" }, { sessionsRoot: root }),
    );

    expect(tags(tokyo.sessions), "00:30 in Tokyo is 2026-01-31T15:30Z").toStrictEqual([
      "0111",
      "0112",
      "0113",
      "0114",
      "0115",
    ]);
  });

  it("a nonsense timestamp parameter is rejected, not treated as an empty range", async () => {
    const root = await makeStore("nonsense", DAYS);

    await expect(listSessions({ startTimestamp: "yesterday" }, { sessionsRoot: root })).rejects.toThrow(
      /startTimestamp/,
    );
    await expect(listSessions({ endTimestamp: "next week" }, { sessionsRoot: root })).rejects.toThrow(/endTimestamp/);
  });

  it("an impossible calendar date rolls over instead of being refused", async () => {
    const root = await makeStore("impossible-date", DAYS);

    // 2026-02-30 is not a date. One grammar owns this now, and it reads the string as March 2, so
    // the bound is kept: the range it describes is the range 2026-03-02 describes.
    const rolled = await listSessions({ endTimestamp: "2026-02-30" }, { sessionsRoot: root });
    const landed = await listSessions({ endTimestamp: "2026-03-02" }, { sessionsRoot: root });

    expect(tags(rolled.sessions)).toStrictEqual(["0111", "0112", "0113", "0114", "0115"]);
    expect(rolled).toStrictEqual(landed);

    // A month number with no instant behind it is still refused: the shape gate passes it and
    // `Date.parse` has nothing to return.
    await expect(listSessions({ endTimestamp: "2026-13-01" }, { sessionsRoot: root })).rejects.toThrow(
      /endTimestamp/,
    );
  });

  it("a reversed range is rejected, and bad parameters never reach the filesystem", async () => {
    const root = await makeStore("reversed", DAYS);

    await expect(
      listSessions({ startTimestamp: "2026-02-05", endTimestamp: "2026-02-01" }, { sessionsRoot: root }),
    ).rejects.toThrow(/endTimestamp.*before.*startTimestamp|startTimestamp.*after.*endTimestamp/i);

    // A parameter error must outrank the missing-root warning, so this rejects instead of
    // returning empty-plus-warning.
    await expect(
      listSessions({ startTimestamp: "garbage" }, { sessionsRoot: "/definitely/not/here/sessions" }),
    ).rejects.toThrow(/startTimestamp/);
  });

  it("a one-day range from equal dates keeps that whole day", async () => {
    const root = await makeStore("equal-dates", DAYS);

    const output = await listSessions(
      { startTimestamp: "2026-02-01", endTimestamp: "2026-02-01" },
      { sessionsRoot: root },
    );

    expect(tags(output.sessions)).toStrictEqual(["0112", "0113"]);
  });
});

describe("sorting", () => {
  it("sortDirection desc reverses the roots, tie-break included", async () => {
    const output = await listSessions({ sortDirection: "desc" }, { sessionsRoot: FIXTURES });

    const ordered = tags(output.sessions);
    expect(ordered).toStrictEqual(["0005", "0013", "0012", "0003", "0002", "0001", "0004"]);
    expect(
      ordered.indexOf("0002") < ordered.indexOf("0001"),
      "the two 2026-01-01T10:00:00.000Z roots reverse their path tie-break too",
    ).toBe(true);
  });

  it("sortBy cwd groups roots by directory, then by timestamp and path", async () => {
    const output = await listSessions({ sortBy: "cwd" }, { sessionsRoot: FIXTURES });

    expect(tags(output.sessions)).toStrictEqual(["0004", "0001", "0003", "0005", "0002", "0012", "0013"]);
  });

  it("sortBy path orders roots by filename, project directory first", async () => {
    const output = await listSessions({ sortBy: "path" }, { sessionsRoot: FIXTURES });

    expect(tags(output.sessions)).toStrictEqual(["0001", "0003", "0004", "0005", "0002", "0012", "0013"]);
  });

  it("sortBy id orders roots by session id", async () => {
    const output = await listSessions({ sortBy: "id" }, { sessionsRoot: FIXTURES });

    expect(tags(output.sessions)).toStrictEqual(["0001", "0002", "0003", "0004", "0005", "0012", "0013"]);
  });

  it("sorting desc leaves each parent's children in launch order", async () => {
    const output = await listSessions({ sortDirection: "desc" }, { sessionsRoot: FIXTURES });

    const parent = requireSession(output.sessions, "0003");
    expect(tags(parent.subagentSessions)).toStrictEqual(["0030", "0031", "0032"]);
    expect(tags(parent.subagentSessions[0].subagentSessions)).toStrictEqual(["0033"]);
  });
});

describe("limit", () => {
  it("caps top-level sessions after filtering and sorting", async () => {
    const root = await makeStore("limit-desc", DAYS);

    const output = await listSessions({ limit: 2, sortDirection: "desc" }, { sessionsRoot: root });

    expect(tags(output.sessions)).toStrictEqual(["0115", "0114"]);
  });

  it("counts top-level sessions only, keeping each parent's children", async () => {
    const root = await makeStore("limit-children", [
      { id: uuid(121), cwd: "/repo/app", timestamp: "2026-02-01T00:00:00.000Z" },
      { id: uuid(122), cwd: "/repo/app", timestamp: "2026-02-02T00:00:00.000Z" },
      { id: uuid(130), cwd: "/repo/app", timestamp: "2026-02-01T01:00:00.000Z", childOf: uuid(121) },
      { id: uuid(131), cwd: "/repo/app", timestamp: "2026-02-01T02:00:00.000Z", childOf: uuid(121) },
    ]);

    // Ascending, so the kept root is the parent that owns both children.
    const output = await listSessions({ limit: 1 }, { sessionsRoot: root });

    expect(tags(output.sessions)).toStrictEqual(["0121"]);
    expect(tags(output.sessions[0].subagentSessions)).toStrictEqual(["0130", "0131"]);
    expect(flatten(output.sessions).length, "one row kept, its children arrive with it").toBe(3);
  });

  it("a limit larger than the result set changes nothing", async () => {
    const root = await makeStore("limit-generous", DAYS);

    const output = await listSessions({ limit: 99 }, { sessionsRoot: root });

    expect(tags(output.sessions)).toStrictEqual(tags((await listSessions({}, { sessionsRoot: root })).sessions));
  });

  it("limit below one is rejected instead of silently returning nothing", async () => {
    const root = await makeStore("limit-zero", DAYS);

    await expect(listSessions({ limit: 0 }, { sessionsRoot: root })).rejects.toThrow(/limit/);
    await expect(listSessions({ limit: -3 }, { sessionsRoot: root })).rejects.toThrow(/limit/);
  });
});

describe("filters and the whole-scan warnings", () => {
  it("warnings still cover the whole scan when filters keep nothing", async () => {
    const output = await listSessions({ cwds: ["/repo/never"] }, { sessionsRoot: FIXTURES });

    expect(output.sessions).toStrictEqual([]);
    expect(output.warnings.length, "every skipped file is still reported").toBe(12);
  });

  it("filters never descend into subagentSessions", async () => {
    const root = await makeStore("children-survive", [
      { id: uuid(141), cwd: "/repo/app", timestamp: "2026-02-01T00:00:00.000Z" },
      // Child outside the requested window and with a different cwd: still returned with its parent.
      { id: uuid(142), cwd: "/repo/other", timestamp: "2026-04-01T00:00:00.000Z", childOf: uuid(141) },
      { id: uuid(143), cwd: "/repo/app", timestamp: "2026-04-02T00:00:00.000Z" },
    ]);

    const output = await listSessions(
      { cwds: ["/repo/app"], endTimestamp: "2026-02-28" },
      { sessionsRoot: root },
    );

    expect(tags(output.sessions)).toStrictEqual(["0141"]);
    expect(tags(output.sessions[0].subagentSessions)).toStrictEqual(["0142"]);
  });
});

describe("current-session exclusion", () => {
  /** The path `id` is not enough: the row is addressed by path, so look it up by tag first. */
  const pathOfTag = async (root: string, wanted: string): Promise<string> => {
    const { sessions } = await listSessions({}, { sessionsRoot: root });
    return requireSession(sessions, wanted).path;
  };

  it("drops the session the call runs inside, by default", async () => {
    const root = await makeStore("current-default", CURRENT);
    const baseline = await listSessions({}, { sessionsRoot: root });
    const current = await pathOfTag(root, "0162");

    const output = await listSessions({}, { sessionsRoot: root, currentSessionPath: current });

    expect(tags(output.sessions)).toStrictEqual(["0161", "0163"]);
    expect(
      output.warnings,
      "exclusion narrows rows, never the statement about the scan",
    ).toStrictEqual(baseline.warnings);
  });

  it("keeps it when includeCurrentSession is true", async () => {
    const root = await makeStore("current-included", CURRENT);
    const current = await pathOfTag(root, "0162");

    const output = await listSessions(
      { includeCurrentSession: true },
      { sessionsRoot: root, currentSessionPath: current },
    );

    expect(tags(output.sessions)).toStrictEqual(["0161", "0162", "0163"]);
  });

  it("excludes before the cap, so a one-row read still returns the newest other session", async () => {
    const root = await makeStore("current-limit", CURRENT);
    const newest = await pathOfTag(root, "0163");

    const output = await listSessions(
      { limit: 1, sortDirection: "desc" },
      { sessionsRoot: root, currentSessionPath: newest },
    );

    expect(tags(output.sessions)).toStrictEqual(["0162"]);
  });

  it("matches by path, so a copy carrying the same id survives", async () => {
    const { root, current, copy } = await makeCopyStore("current-duplicate-id");

    const output = await listSessions({}, { sessionsRoot: root, currentSessionPath: current });

    expect(output.sessions.map((session) => session.path)).toStrictEqual([copy]);
  });

  it("does nothing when the current session has no file", async () => {
    const root = await makeStore("current-ephemeral", CURRENT);
    const baseline = await listSessions({}, { sessionsRoot: root });

    expect(await listSessions({}, { sessionsRoot: root, currentSessionPath: undefined })).toStrictEqual(baseline);
  });

  it("does nothing for a path outside the store being scanned", async () => {
    const root = await makeStore("current-elsewhere", CURRENT);
    const baseline = await listSessions({}, { sessionsRoot: root });

    // A `--session-dir` run records a file the scan cannot reach. A miss must not become an
    // id fallback, which would silently drop an unrelated session that happened to share the id.
    expect(
      await listSessions({}, { sessionsRoot: root, currentSessionPath: "/elsewhere/0163.jsonl" }),
    ).toStrictEqual(baseline);
  });

  it("compares by normalized path, so an equivalent spelling still matches", async () => {
    const root = await makeStore("current-normalized", CURRENT);
    const current = await pathOfTag(root, "0162");
    // The same file through `..` and a redundant directory segment, which is how a hand-built
    // or relocated path can reach the tool.
    const directory = dirname(current);
    const equivalent = join(root, "..", basename(root), basename(directory), basename(current));

    expect(
      await listSessions({}, { sessionsRoot: root, currentSessionPath: equivalent }),
    ).toStrictEqual(await listSessions({}, { sessionsRoot: root, currentSessionPath: current }));
  });

  it("does nothing when the current path names a file the scan could not read", async () => {
    const root = await makeStore("current-unreadable", CURRENT);
    const baseline = await listSessions({}, { sessionsRoot: root });

    // It is never a row, so excluding it removes nothing, and it is not the caller's session
    // either: the row and the warning stay as the scan produced them.
    const stray = join(root, "--scratch-9--", "stray.jsonl");

    expect(await listSessions({}, { sessionsRoot: root, currentSessionPath: stray })).toStrictEqual(baseline);
  });
});

describe("instantOf", () => {
  it("never hands a comparator a NaN, even for a row no scan could produce", () => {
    // A row reaches a sort only through `validateHeaderLine`, which accepts a timestamp exactly when
    // it names an instant, so the fallback below is unreachable in production. It is exercised here
    // because what it guarantees — a total ordering with no `Invalid Date`, which `docs/tool-api.md`
    // promises a caller — is otherwise only visible as an absence. A hand-built row is the only way
    // to see the guarantee hold rather than merely not be violated.
    const row = (timestamp: string): SessionMetadata => ({
      id: "00000000-0000-4000-8000-000000000001",
      path: "/repo/alpha/0001.jsonl",
      cwd: "/repo/alpha",
      timestamp,
      subagentSessions: [],
    });

    expect(instantOf(row("2026-01-05T09:00:00.000Z"))).toBe(Date.parse("2026-01-05T09:00:00.000Z"));
    expect(Number.isFinite(instantOf(row("no such date")))).toBe(true);
  });
});
