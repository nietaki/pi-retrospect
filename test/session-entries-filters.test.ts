/**
 * Parameter behavior of `session_entries`: line ranges, id/parent/type/role sets, timestamp
 * windows, and a limit applied after filtering.
 *
 * Filters narrow `entries` only. `warnings` always describe the whole file — a filtered or
 * limited read is still a full scan — so every case here asserts both halves.
 *
 * Every fixture is written by the test that asserts on it, under the gitignored `test/tmp/`
 * scratch root, so no assertion depends on leftover state (see AGENTS.md).
 *
 * Contract: docs/tool-api.md
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { readSessionEntries } from "../src/session-entries.ts";
import type { SessionEntriesParams } from "../src/schemas.ts";

const TEMP = new URL("tmp/session-entries-filters/", import.meta.url).pathname;
const ROOT = join(TEMP, "root");
const SESSION = join(ROOT, "--p--", "s.jsonl");

function header(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: "sess-1",
    timestamp: "2026-01-01T10:00:00.000Z",
    cwd: "/repo/p",
    ...fields,
  });
}

function entry(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "u1",
    parentId: null,
    timestamp: "2026-01-01T10:00:01.000Z",
    type: "message",
    message: { role: "user", content: "hello" },
    ...fields,
  });
}

/** Header on line 1, then `lines`, at the default path. */
async function writeSession(lines: string[], path = SESSION): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [header(), ...lines].map((line) => `${line}\n`).join(""));
  return path;
}

/**
 * The grid every filter case reads.
 *
 * Deliberately not chronological (line 3 sits a day after line 2 while line 6 sits a month
 * later), one broken line (4) so numbering and warnings survive filtering, a non-message
 * entry, a null `parentId` among real ones, and an unknown role on the last row:
 *
 * | line | id   | parentId | type          | messageRole | timestamp             |
 * | ---- | ---- | -------- | ------------- | ----------- | --------------------- |
 * | 2    | u1   | null     | message       | user        | 2026-01-01T10:00:01Z  |
 * | 3    | a1   | u1       | message       | assistant   | 2026-01-02T10:00:02Z  |
 * | 4    | —    | —        | invalid_json  | —           | —                     |
 * | 5    | t1   | a1       | message       | toolResult  | 2026-01-03T10:00:03Z  |
 * | 6    | m1   | null     | model_change  | null        | 2026-02-01T00:00:00Z  |
 * | 7    | c1   | m1       | compaction    | null        | 2026-02-05T23:59:59Z  |
 * | 8    | x1   | c1       | message       | hologram    | 2027-06-01T12:00:00Z  |
 */
const GRID = (): string[] => [
  entry(),
  entry({ id: "a1", parentId: "u1", timestamp: "2026-01-02T10:00:02.000Z", message: { role: "assistant", content: [] } }),
  "{ broken",
  entry({ id: "t1", parentId: "a1", timestamp: "2026-01-03T10:00:03.000Z", message: { role: "toolResult", content: [] } }),
  entry({ id: "m1", parentId: null, timestamp: "2026-02-01T00:00:00.000Z", type: "model_change", message: undefined }),
  entry({ id: "c1", parentId: "m1", timestamp: "2026-02-05T23:59:59.000Z", type: "compaction", message: undefined }),
  entry({ id: "x1", parentId: "c1", timestamp: "2027-06-01T12:00:00.000Z", message: { role: "hologram", content: [] } }),
];

const options = { sessionsRoot: ROOT };

/** Read the grid with `filters`, returning entry line numbers and ids. */
async function readGrid(filters: Omit<SessionEntriesParams, "sessionPath"> = {}) {
  const output = await readSessionEntries({ sessionPath: SESSION, ...filters }, options);

  return {
    ids: output.entries.map((entryRow) => entryRow.id),
    lineNos: output.entries.map((entryRow) => entryRow.lineNo),
    types: output.entries.map((entryRow) => entryRow.type),
    roles: output.entries.map((entryRow) => entryRow.messageRole),
    warnings: output.warnings.map((warning) => [warning.lineNo, warning.code]),
  };
}

beforeEach(async () => {
  await rm(TEMP, { recursive: true, force: true });
});

describe("session_entries line ranges", () => {
  it("an absent bound means unbounded on that side", async () => {
    await writeSession(GRID());

    const result = await readGrid();

    expect(result.lineNos).toStrictEqual([2, 3, 5, 6, 7, 8]);
    expect(result.warnings).toStrictEqual([[4, "invalid_json"]]);
  });

  it("startLineNo is inclusive", async () => {
    await writeSession(GRID());

    expect((await readGrid({ startLineNo: 2 })).ids).toStrictEqual(["u1", "a1", "t1", "m1", "c1", "x1"]);
    expect((await readGrid({ startLineNo: 5 })).ids).toStrictEqual(["t1", "m1", "c1", "x1"]);
  });

  it("endLineNo is inclusive", async () => {
    await writeSession(GRID());

    expect((await readGrid({ endLineNo: 3 })).ids).toStrictEqual(["u1", "a1"]);
    // The bound lands on the broken line: it keeps every entry up to and including line 4.
    expect((await readGrid({ endLineNo: 4 })).ids).toStrictEqual(["u1", "a1"]);
    expect((await readGrid({ endLineNo: 8 })).ids).toStrictEqual(["u1", "a1", "t1", "m1", "c1", "x1"]);
  });

  it("a line range keeps the entries inside it and nothing else", async () => {
    await writeSession(GRID());

    const result = await readGrid({ startLineNo: 5, endLineNo: 6 });

    expect(result.lineNos).toStrictEqual([5, 6]);
    expect(result.types).toStrictEqual(["message", "model_change"]);
  });

  it("a range past the end of the file returns no entries and still reports whole-file warnings", async () => {
    await writeSession(GRID());

    const result = await readGrid({ startLineNo: 99 });

    expect(result.ids).toStrictEqual([]);
    expect(result.warnings, "the scan still covered the broken line 4").toStrictEqual([[4, "invalid_json"]]);
  });

  it("a range that ends before it starts throws", async () => {
    await writeSession(GRID());

    await expect(readGrid({ startLineNo: 6, endLineNo: 3 })).rejects.toThrow(/endLineNo.*before.*startLineNo/);
  });

  it("a line bound that is not a positive integer throws", async () => {
    await writeSession(GRID());

    await expect(readGrid({ startLineNo: 0 })).rejects.toThrow(/startLineNo/);
    await expect(readGrid({ startLineNo: -2 })).rejects.toThrow(/startLineNo/);
    await expect(readGrid({ startLineNo: 2.5 })).rejects.toThrow(/startLineNo/);
    await expect(readGrid({ endLineNo: 0 })).rejects.toThrow(/endLineNo/);
  });

  it("a line bound outranks the filesystem: a bad parameter never opens a file", async () => {
    await mkdir(ROOT, { recursive: true });

    await expect(
      readSessionEntries({ sessionPath: join(ROOT, "--p--", "missing.jsonl"), limit: 0 }, options),
    ).rejects.toThrow(/limit/);

    await expect(
      readSessionEntries({ sessionPath: "/definitely/not/here/sessions/x.jsonl", startLineNo: 0 }, options),
    ).rejects.toThrow(/startLineNo/);
  });
});

describe("session_entries id and parent filters", () => {
  it("ids keeps the listed entries, in file order", async () => {
    await writeSession(GRID());

    const result = await readGrid({ ids: ["t1", "u1"] });

    expect(result.lineNos, "the request order does not reorder the result").toStrictEqual([2, 5]);
    expect(result.ids).toStrictEqual(["u1", "t1"]);
  });

  it("ids matches whole values, not substrings", async () => {
    await writeSession(GRID());

    expect((await readGrid({ ids: ["u"] })).ids).toStrictEqual([]);
    expect((await readGrid({ ids: ["1"] })).ids).toStrictEqual([]);
  });

  it("ids is case-sensitive", async () => {
    await writeSession(GRID());

    expect((await readGrid({ ids: ["U1"] })).ids).toStrictEqual([]);
  });

  it("parentIds keeps the children of the listed parents", async () => {
    await writeSession(GRID());

    const result = await readGrid({ parentIds: ["a1", "m1"] });

    expect(result.lineNos).toStrictEqual([5, 7]);
    expect(result.ids).toStrictEqual(["t1", "c1"]);
  });

  it("an entry with a null parentId is not selected by any parentIds value", async () => {
    await writeSession(GRID());

    const result = await readGrid({ parentIds: ["null"] });

    expect(result.ids).toStrictEqual([]);
  });

  it("an id filter matches the citable field, so a version 1 file selects nothing", async () => {
    // A v1 header forces `id` and `parentId` to null because Pi rewrites them on migration, and
    // the filter reads the field, not `raw`. So the row is still returned by an unfiltered read
    // and still invisible to an id filter.
    await writeSession([entry({ id: "u1", parentId: "root" })]);
    const content = await readFile(SESSION, "utf8");
    await writeFile(SESSION, content.replace('"version":3', '"version":1'));

    const filtered = await readGrid({ ids: ["u1"] });
    const unfiltered = await readGrid();

    expect(filtered.ids).toStrictEqual([]);
    expect(unfiltered.lineNos, "the row is there; only its citable id is null").toStrictEqual([2]);
    expect(unfiltered.ids).toStrictEqual([null]);
    expect(filtered.warnings).toStrictEqual([[null, "legacy_version"]]);
  });

  it("an entry whose id is absent reads as null and is not selected by any ids value", async () => {
    await writeSession([entry({ id: undefined })]);

    const result = await readGrid({ ids: ["", "u1"] });

    expect(result.ids).toStrictEqual([]);
  });
});

describe("session_entries type and role filters", () => {
  it("types keeps the listed entry types, verbatim and case-sensitively", async () => {
    await writeSession(GRID());

    const result = await readGrid({ types: ["message", "compaction"] });

    expect(result.lineNos).toStrictEqual([2, 3, 5, 7, 8]);
    expect(result.types).toStrictEqual(["message", "message", "message", "compaction", "message"]);
    expect((await readGrid({ types: ["Message"] })).types).toStrictEqual([]);
  });

  it("an unknown type is filterable because it is preserved verbatim", async () => {
    await writeSession([entry({ type: "quantum_flux" })]);

    expect((await readGrid({ types: ["quantum_flux"] })).types).toStrictEqual(["quantum_flux"]);
  });

  it("messageRoles keeps only message entries carrying the listed role", async () => {
    await writeSession(GRID());

    const result = await readGrid({ messageRoles: ["user", "assistant"] });

    expect(result.lineNos).toStrictEqual([2, 3]);
    expect(result.roles).toStrictEqual(["user", "assistant"]);
  });

  it("messageRoles never selects a non-message entry, even on a matching name", async () => {
    await writeSession(GRID());

    // `compaction` sits on line 7; its `messageRole` is null, so the role filter cannot reach it.
    expect((await readGrid({ messageRoles: ["compaction"] })).ids).toStrictEqual([]);
  });

  it("an entry with a null messageRole is not selected by any role value", async () => {
    await writeSession(GRID());

    expect((await readGrid({ messageRoles: ["null"] })).ids).toStrictEqual([]);
  });

  it("messageRoles preserves an unknown role verbatim", async () => {
    await writeSession(GRID());

    const result = await readGrid({ messageRoles: ["hologram"] });

    expect(result.lineNos).toStrictEqual([8]);
    expect(result.roles).toStrictEqual(["hologram"]);
  });
});

describe("session_entries timestamp windows", () => {
  it("both bounds are inclusive instants", async () => {
    await writeSession(GRID());

    const result = await readGrid({
      startTimestamp: "2026-01-02T10:00:02.000Z",
      endTimestamp: "2026-02-05T23:59:59.000Z",
    });

    expect(result.ids).toStrictEqual(["a1", "t1", "m1", "c1"]);
  });

  it("a start bound as a bare date is the start of that local day", async () => {
    await writeSession(GRID());

    const result = await readGrid({ startTimestamp: "2026-02-01" });

    expect(result.ids).toStrictEqual(["m1", "c1", "x1"]);
  });

  it("an end bound as a bare date covers that whole day, not its last millisecond", async () => {
    await writeSession(GRID());

    const result = await readGrid({ endTimestamp: "2026-02-05" });

    expect(result.ids).toStrictEqual(["u1", "a1", "t1", "m1", "c1"]);
  });

  it("a naive bound is read in the host timezone", async () => {
    await writeSession(GRID());
    const previous = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      // `2026-01-01T10:00:00` in Tokyo is 2026-01-01T01:00:00Z, so the user entry at
      // 10:00:01Z stays inside the window. In the suite's pinned UTC the same bound would
      // exclude it by one second.
      const result = await readGrid({ startTimestamp: "2026-01-01T10:00:00" });

      expect(result.ids).toContain("u1");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("a window that keeps nothing returns no entries and whole-file warnings", async () => {
    await writeSession(GRID());

    const result = await readGrid({ startTimestamp: "2030-01-01" });

    expect(result.ids).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([[4, "invalid_json"]]);
  });

  it("an unparseable bound throws, naming the parameter", async () => {
    await writeSession(GRID());

    await expect(readGrid({ startTimestamp: "yesterday" })).rejects.toThrow(/startTimestamp/);
    await expect(readGrid({ endTimestamp: "next week" })).rejects.toThrow(/endTimestamp/);
    await expect(readGrid({ endTimestamp: "2026-13-01" })).rejects.toThrow(/endTimestamp/);
  });

  it("a reversed window throws", async () => {
    await writeSession(GRID());

    await expect(
      readGrid({ startTimestamp: "2026-02-05", endTimestamp: "2026-02-01" }),
    ).rejects.toThrow(/endTimestamp.*before.*startTimestamp/);
  });

  it("the window reads each entry's own timestamp, not the header's", async () => {
    // The header sits on 2026-01-01. A window opening in March keeps only the entry that is
    // itself dated after that bound, and the header is never a row to compare.
    await writeSession([
      entry({ id: "in", timestamp: "2026-05-01T00:00:00.000Z" }),
      entry({ id: "out", timestamp: "2026-01-01T00:00:00.000Z" }),
    ]);

    const result = await readGrid({ startTimestamp: "2026-03-01" });

    expect(result.ids).toStrictEqual(["in"]);
  });
});

describe("session_entries limit", () => {
  it("is a positive integer applied after filtering", async () => {
    await writeSession(GRID());

    const result = await readGrid({ limit: 2 });

    expect(result.lineNos).toStrictEqual([2, 3]);
    expect((await readGrid({ types: ["message"], limit: 2 })).ids).toStrictEqual(["u1", "a1"]);
    expect((await readGrid({ limit: 99 })).ids).toStrictEqual(["u1", "a1", "t1", "m1", "c1", "x1"]);
  });

  it("does not shorten the scan: warnings still cover the whole file", async () => {
    await writeSession([...GRID(), "{ also broken"]);

    const result = await readGrid({ limit: 1 });

    expect(result.ids).toStrictEqual(["u1"]);
    expect(result.warnings).toStrictEqual([
      [4, "invalid_json"],
      [9, "invalid_json"],
    ]);
  });

  it("a limit below one or not an integer throws", async () => {
    await writeSession(GRID());

    await expect(readGrid({ limit: 0 })).rejects.toThrow(/limit/);
    await expect(readGrid({ limit: -3 })).rejects.toThrow(/limit/);
    await expect(readGrid({ limit: 1.5 })).rejects.toThrow(/limit/);
  });
});

describe("session_entries filter composition", () => {
  it("categories are ANDed and values inside one array are ORed", async () => {
    await writeSession(GRID());

    const result = await readGrid({
      types: ["message", "model_change"],
      messageRoles: ["user", "assistant"],
      startLineNo: 2,
      endLineNo: 6,
      limit: 5,
    });

    // `types` alone would keep lines 2, 3, 5, 6; `messageRoles` drops the model_change row.
    expect(result.lineNos).toStrictEqual([2, 3]);
  });

  it("every filter can select nothing without an error", async () => {
    await writeSession(GRID());

    const result = await readGrid({
      types: ["message"],
      messageRoles: ["assistant"],
      ids: ["m1"],
    });

    expect(result.ids).toStrictEqual([]);
  });

  it("results stay in file order, never timestamp order", async () => {
    await writeSession(GRID());

    const result = await readGrid({ types: ["message"] });

    expect(result.lineNos, "ascending by line while their timestamps are not monotonic").toStrictEqual([
      2, 3, 5, 8,
    ]);
  });

  it("filtering is independent of which lines were skipped", async () => {
    await writeSession(GRID());

    const result = await readGrid({ ids: ["c1", "x1"] });

    expect(result.lineNos, "the broken line 4 shifts nothing").toStrictEqual([7, 8]);
  });

  it("paginates by advancing startLineNo past the last line already read", async () => {
    await writeSession(GRID());

    const first = await readGrid({ limit: 2 });
    const lastSeen = first.lineNos[first.lineNos.length - 1];
    const second = await readGrid({ startLineNo: lastSeen + 1, limit: 2 });
    const third = await readGrid({ startLineNo: (second.lineNos.at(-1) ?? 0) + 1, limit: 2 });

    expect(first.ids).toStrictEqual(["u1", "a1"]);
    expect(second.ids).toStrictEqual(["t1", "m1"]);
    expect(third.ids).toStrictEqual(["c1", "x1"]);
    expect(
      [...first.ids, ...second.ids, ...third.ids],
      "no gap and no overlap across pages",
    ).toStrictEqual(["u1", "a1", "t1", "m1", "c1", "x1"]);
  });
});
