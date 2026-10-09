/**
 * The `piRetrospect.allowedProjects` policy as session discovery applies it.
 *
 * Discovery is where the bound has to land. A caller narrows results with `cwds`; only the extension
 * knows what the operator allowed. So the policy is asked of each validated top-level session before
 * its nested transcripts are collected and before it becomes a row, which is what keeps a denied
 * project from contributing anything at all — not a session, not a child, not a warning about a file
 * it could not read.
 *
 * Each case writes its own small store under `test/tmp/policy/` (gitignored), because the committed
 * fixtures hold one shape of tree and this needs several at once: a worktree sibling, a `barista`
 * near match, a denied project with unreadable descendants, and a delegated run whose own cwd is not
 * on the list its parent is on.
 *
 * Contract: docs/tool-api.md, "Restricting session access"
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { listSessions } from "../src/list-sessions.ts";
import { parseProjectAccessPolicy, UNRESTRICTED_POLICY } from "../src/project-access.ts";
import type { ProjectAccessPolicy } from "../src/project-access.ts";
import type { ListSessionsOutput, SessionMetadata } from "../src/schemas.ts";

/** Scratch stores for the access boundary, never committed. */
const TMP = new URL("tmp/policy/", import.meta.url).pathname;

/** The policy one `allowedProjects` list describes, read the way a tool reads it. */
const policyFor = (...allowedProjects: string[]): ProjectAccessPolicy =>
  parseProjectAccessPolicy({ piRetrospect: { allowedProjects } });

/** A session id built from its row number, so a test can name a row by that number. */
const idOf = (n: number): string => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const tag = (id: string): string => id.slice(-2);
const tags = (sessions: SessionMetadata[]): string[] => sessions.map((session) => tag(session.id));

const headerLine = (n: number, cwd: string, timestamp = "2026-01-01T10:00:00.000Z"): string =>
  `${JSON.stringify({ type: "session", version: 3, id: idOf(n), timestamp, cwd })}\n`;

/** A first line that cannot be a session header, so the file can only ever become a warning. */
const UNREADABLE = "this is not a header\n";

type Row = {
  /** Row number, and the file name and session id it builds. */
  n: number;
  cwd: string;
  /** Which `--scratch-<p>--` project directory holds this top-level session. */
  p?: number;
  /** Store this row as a delegated run of that row instead, at any depth. */
  childOf?: number;
  /** Write an unreadable line where the header belongs, so the file can only warn. */
  broken?: boolean;
  /** Only for ordering: moves a row in the result without changing anything else about it. */
  timestamp?: string;
};

/**
 * Write the store Pi's layout describes: sessions in `--slug--` directories, delegated runs in a
 * container named after the launcher's file, a grandchild under its own launcher again.
 *
 * Rows are placed by `p`, so several files can share one project directory, which is what the
 * warning questions below are about.
 */
async function makeStore(name: string, rows: Row[]): Promise<string> {
  const root = join(TMP, name);
  await rm(root, { recursive: true, force: true });

  const fileOf = new Map<number, string>();

  const sessionFileOf = (n: number): string => {
    const path = fileOf.get(n);
    if (path === undefined) throw new Error(`no scratch session recorded for row ${n}`);
    return path;
  };

  for (const row of rows) {
    if (row.childOf !== undefined) continue;

    const directory = join(root, `--scratch-${row.p ?? row.n}--`);
    fileOf.set(row.n, join(directory, `${row.n}.jsonl`));
  }

  for (const row of rows) {
    if (row.childOf === undefined) continue;

    const launcher = sessionFileOf(row.childOf).replace(/\.jsonl$/, "");
    fileOf.set(row.n, join(launcher, `launch-${row.n}`, "run-0", "session.jsonl"));
  }

  for (const row of rows) {
    const path = sessionFileOf(row.n);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, row.broken ? UNREADABLE : headerLine(row.n, row.cwd, row.timestamp));
  }

  return root;
}

/** Every row in the tree, top level and nested, flattened in discovery order. */
function flatten(sessions: SessionMetadata[], found: SessionMetadata[] = []): SessionMetadata[] {
  for (const session of sessions) {
    found.push(session);
    flatten(session.subagentSessions, found);
  }

  return found;
}

const pathsOf = (output: ListSessionsOutput): string[] => output.warnings.map((warning) => warning.path);

/**
 * The store every case below shares, one line per row:
 *
 * - `1` `/repo/bar`, with the delegated run `2`, whose own cwd is nowhere on the list;
 * - `3` `/repo/bar-issue-7`, the linked worktree of an allowed basename;
 * - `4` `/repo/barista`, a near match that is not that worktree's parent, and unreadable `5` beside it;
 * - `6` `/repo/other` with the unreadable delegated run `7` under it;
 * - `8` unreadable in a directory holding nothing else, so no project is ever established there.
 */
const ROWS: Row[] = [
  { n: 1, cwd: "/repo/bar", p: 0, timestamp: "2026-01-01T10:00:00.000Z" },
  { n: 2, cwd: "/repo/elsewhere", childOf: 1 },
  { n: 3, cwd: "/repo/bar-issue-7", p: 1, timestamp: "2026-01-02T10:00:00.000Z" },
  { n: 4, cwd: "/repo/barista", p: 2, timestamp: "2026-01-03T10:00:00.000Z" },
  { n: 5, cwd: "/unused", p: 2, broken: true },
  { n: 6, cwd: "/repo/other", p: 3, timestamp: "2026-01-04T10:00:00.000Z" },
  { n: 7, cwd: "/unused", childOf: 6, broken: true },
  { n: 8, cwd: "/unused", p: 4, broken: true },
];

describe("listSessions project access", () => {
  it("changes nothing when no policy was supplied", async () => {
    const root = await makeStore("omitted", ROWS);

    const output = await listSessions({}, { sessionsRoot: root });

    expect(tags(output.sessions)).toStrictEqual(["01", "03", "04", "06"]);
    expect(pathsOf(output)).toStrictEqual([
      join(root, "--scratch-2--", "5.jsonl"),
      join(root, "--scratch-3--", "6", "launch-7", "run-0", "session.jsonl"),
      join(root, "--scratch-4--", "8.jsonl"),
    ]);
    expect(output).toStrictEqual(
      await listSessions({}, { sessionsRoot: root, policy: UNRESTRICTED_POLICY }),
    );
  });

  it("reports every project for the wildcard, listed alone or beside a name", async () => {
    const root = await makeStore("wildcard", ROWS);
    const unfiltered = await listSessions({}, { sessionsRoot: root });

    expect(await listSessions({}, { sessionsRoot: root, policy: policyFor("*") })).toStrictEqual(
      unfiltered,
    );
    expect(await listSessions({}, { sessionsRoot: root, policy: policyFor("bar", "*") })).toStrictEqual(
      unfiltered,
    );
  });

  it("reports nothing at all for an explicit empty list", async () => {
    const root = await makeStore("deny-all", ROWS);
    const output = await listSessions({}, { sessionsRoot: root, policy: policyFor() });

    expect(output.sessions).toStrictEqual([]);
    // Every established project here was denied, so its unreadable files go unreported too. What is
    // left is the directory with no valid header anywhere: nothing proved it was a denied project.
    expect(pathsOf(output)).toStrictEqual([join(root, "--scratch-4--", "8.jsonl")]);
  });

  it("reports the allowed project, its worktree sibling, and no near match", async () => {
    const root = await makeStore("named", ROWS);
    const output = await listSessions({}, { sessionsRoot: root, policy: policyFor("bar") });

    expect(tags(output.sessions)).toStrictEqual(["01", "03"]);
    expect(flatten(output.sessions).map((session) => session.cwd).sort()).toStrictEqual([
      "/repo/bar",
      "/repo/bar-issue-7",
      "/repo/elsewhere",
    ]);
  });

  it("says nothing about a denied project, including what it could not read", async () => {
    const root = await makeStore("leakage", ROWS);
    const output = await listSessions({}, { sessionsRoot: root, policy: policyFor("bar") });

    // `--scratch-2--` holds `/repo/barista` and an unreadable file, and `--scratch-3--` holds
    // `/repo/other` and an unreadable delegated run: neither directory contributes a warning.
    expect(pathsOf(output)).toStrictEqual([join(root, "--scratch-4--", "8.jsonl")]);
    expect(JSON.stringify(output)).not.toContain("barista");
    expect(JSON.stringify(output)).not.toContain("other");
  });

  it("keeps the whole nested tree of an allowed project, child cwds included", async () => {
    const root = await makeStore("nested", ROWS);
    const output = await listSessions({}, { sessionsRoot: root, policy: policyFor("bar") });
    const parent = output.sessions[0]!;

    expect(tag(parent.id)).toBe("01");
    expect(tags(parent.subagentSessions)).toStrictEqual(["02"]);
    expect(parent.subagentSessions[0]!.cwd).toBe("/repo/elsewhere");
  });

  it("narrows what the policy allowed, and never reaches past it", async () => {
    const root = await makeStore("filters", ROWS);
    const policy = policyFor("bar");

    // Asking by path for a denied project yields nothing: `cwds` selects within the bound.
    const deniedAsk = await listSessions({ cwds: ["/repo/barista"] }, { sessionsRoot: root, policy });
    expect(deniedAsk.sessions).toStrictEqual([]);

    const permittedAsk = await listSessions({ cwds: ["/repo/bar"] }, { sessionsRoot: root, policy });
    expect(tags(permittedAsk.sessions)).toStrictEqual(["01"]);

    // The caller's own worktree rule still works inside the bound.
    const siblingAsk = await listSessions(
      { cwds: ["/repo/bar"], cwdMatch: "sibling-prefix" },
      { sessionsRoot: root, policy },
    );
    expect(tags(siblingAsk.sessions)).toStrictEqual(["01", "03"]);

    // Ordering, the cap, and the top-level-only scope are untouched by the boundary.
    const capped = await listSessions({ limit: 1, sortDirection: "desc" }, { sessionsRoot: root, policy });
    expect(tags(capped.sessions)).toStrictEqual(["03"]);
  });

  it("prunes the current session from what the policy allowed", async () => {
    const root = await makeStore("current", ROWS);
    const current = join(root, "--scratch-0--", "1.jsonl");

    const output = await listSessions(
      {},
      { sessionsRoot: root, policy: policyFor("bar"), currentSessionPath: current },
    );

    expect(tags(output.sessions)).toStrictEqual(["03"]);
    expect(flatten(output.sessions).some((session) => tag(session.id) === "02")).toBe(false);
  });
});
