/**
 * Covers `readSessionEntries`: sessions-root confinement, header handling, physical line
 * numbers, arbitrary `raw` passthrough, and the three warning codes.
 *
 * Every fixture is written by the test that asserts on it, under the gitignored
 * `test/tmp/` scratch root, so no assertion depends on leftover state (see AGENTS.md).
 *
 * Contract: docs/tool-api.md
 */

import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { readSessionEntries } from "../src/session-entries.ts";

const TEMP = new URL("tmp/session-entries/", import.meta.url).pathname;

/** Sessions root for a case; session files live at `<root>/--p--/s.jsonl`. */
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
    id: "aaaa1111",
    parentId: null,
    timestamp: "2026-01-01T10:00:01.000Z",
    type: "message",
    message: { role: "user", content: "hello" },
    ...fields,
  });
}

/** Write a session file under the case root, header on line 1, then `lines`. */
async function writeSession(lines: string[], path = SESSION): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [header(), ...lines].map((line) => `${line}\n`).join(""));
  return path;
}

const options = { sessionsRoot: ROOT };

const firstEntry = (params = { sessionPath: SESSION }) =>
  readSessionEntries(params, options);

describe("readSessionEntries sessions-root confinement", () => {
  beforeEach(async () => {
    await rm(TEMP, { recursive: true, force: true });
  });

  it("reads a session file that sits under the sessions root", async () => {
    await writeSession([entry()]);

    const result = await firstEntry();

    expect(result.entries).toHaveLength(1);
    expect(result.warnings).toStrictEqual([]);
  });

  it("rejects a path outside the sessions root", async () => {
    await writeSession([entry()]);
    await writeFile(join(TEMP, "outside.jsonl"), `${header()}\n`);

    await expect(firstEntry({ sessionPath: join(TEMP, "outside.jsonl") })).rejects.toThrow(
      /not under the sessions root/,
    );
  });

  it("rejects a relative path", async () => {
    await writeSession([entry()]);

    await expect(firstEntry({ sessionPath: join("--p--", "s.jsonl") })).rejects.toThrow(
      /must be an absolute path/,
    );
  });

  it("rejects `..` traversal that escapes the root", async () => {
    await writeSession([entry()]);
    await writeFile(join(TEMP, "outside.jsonl"), `${header()}\n${entry()}\n`);

    await expect(
      firstEntry({ sessionPath: join(ROOT, "--p--", "..", "..", "outside.jsonl") }),
    ).rejects.toThrow(/not under the sessions root/);
  });

  it("rejects a symlink inside the root that points outside it", async () => {
    await writeSession([entry()]);
    const outside = join(TEMP, "outside.jsonl");
    await writeFile(outside, `${header()}\n${entry()}\n`);
    const link = join(ROOT, "--p--", "link.jsonl");
    try {
      await symlink(outside, link);
    } catch {
      // Filesystems without symlink support: the escape test is not expressible here.
      return;
    }

    await expect(firstEntry({ sessionPath: link })).rejects.toThrow(/not under the sessions root/);
  });

  it("accepts a symlink that stays inside the root", async () => {
    await writeSession([entry()]);

    const link = join(ROOT, "--p--", "link.jsonl");
    try {
      await symlink(SESSION, link);
    } catch {
      return;
    }

    const result = await firstEntry({ sessionPath: link });

    expect(result.entries).toHaveLength(1);
  });

  it("rejects a path that does not exist", async () => {
    await mkdir(ROOT, { recursive: true });

    await expect(firstEntry()).rejects.toThrow(/could not read session file/);
  });

  it("rejects a missing sessions root", async () => {
    await writeSession([entry()]);

    await expect(
      readSessionEntries({ sessionPath: SESSION }, { sessionsRoot: join(TEMP, "nope") }),
    ).rejects.toThrow(/sessions root/);
  });

  it("rejects a sessionPath that is not a string", async () => {
    await writeSession([entry()]);

    await expect(readSessionEntries({} as never, options)).rejects.toThrow(/sessionPath/);
  });
});

describe("readSessionEntries header handling", () => {
  beforeEach(async () => {
    await rm(TEMP, { recursive: true, force: true });
  });

  it("never returns the session header line", async () => {
    await writeSession([entry()]);

    const result = await firstEntry();

    expect(result.entries.map((row) => row.lineNo)).toStrictEqual([2]);
    expect(result.entries.some((row) => row.raw.type === "session")).toBe(false);
  });

  it("reads a header-only file as no entries and no warnings", async () => {
    await writeSession([]);

    const result = await firstEntry();

    expect(result).toStrictEqual({ entries: [], warnings: [] });
  });

  it("refuses a second header row below line 1", async () => {
    await writeSession([entry({ id: "a1" }), header()]);

    const result = await firstEntry();

    expect(result.entries.map((row) => row.lineNo)).toStrictEqual([2]);
    expect(result.warnings).toStrictEqual([
      {
        lineNo: 3,
        code: "invalid_entry",
        reason: "a session header belongs on line 1, not line 3",
      },
    ]);
  });

  it("rejects an empty file", async () => {
    await mkdir(dirname(SESSION), { recursive: true });
    await writeFile(SESSION, "");

    await expect(firstEntry()).rejects.toThrow(/not a Pi session file/);
  });

  it("rejects a file whose first line is not a session header", async () => {
    await writeSession([entry()]);
    const content = await readFile(SESSION, "utf8");
    await writeFile(SESSION, content.replace('"type":"session"', '"type":"message"'));

    await expect(firstEntry()).rejects.toThrow(/not a Pi session file/);
  });

  it("rejects a first line that is not JSON", async () => {
    await mkdir(dirname(SESSION), { recursive: true });
    await writeFile(SESSION, `nope\n${entry()}\n`);

    await expect(firstEntry()).rejects.toThrow(/not a Pi session file/);
  });

  it("rejects a first line that is JSON but not an object", async () => {
    await mkdir(dirname(SESSION), { recursive: true });
    await writeFile(SESSION, `[1,2,3]\n${entry()}\n`);

    await expect(firstEntry()).rejects.toThrow(/first line is not a JSON object/);
  });

  it("rejects a directory instead of a session file", async () => {
    await writeSession([entry()]);

    await expect(firstEntry({ sessionPath: join(ROOT, "--p--") })).rejects.toThrow(
      /could not read session file/,
    );
  });

  it("rejects a non-numeric session header version", async () => {
    await writeSession([entry()]);
    const content = await readFile(SESSION, "utf8");
    await writeFile(SESSION, content.replace('"version":3', '"version":"3"'));

    await expect(firstEntry()).rejects.toThrow(/version/);
  });

  it("drops a header line that is only a BOM plus valid JSON", async () => {
    await writeSession([entry()]);
    const content = await readFile(SESSION, "utf8");
    await writeFile(SESSION, `\uFEFF${content}`);

    const result = await firstEntry();

    expect(result.entries).toHaveLength(1);
  });
});

describe("readSessionEntries entry mapping", () => {
  beforeEach(async () => {
    await rm(TEMP, { recursive: true, force: true });
  });

  it("maps base fields and the message role", async () => {
    await writeSession([
      entry({ id: "1111aaaa", parentId: "aaaa1111", message: { role: "assistant", content: [] } }),
    ]);

    const [row] = await readSessionEntries({ sessionPath: SESSION }, options).then((r) => r.entries);

    expect(row).toStrictEqual({
      lineNo: 2,
      id: "1111aaaa",
      parentId: "aaaa1111",
      timestamp: "2026-01-01T10:00:01.000Z",
      type: "message",
      messageRole: "assistant",
      raw: JSON.parse(entry({ id: "1111aaaa", parentId: "aaaa1111", message: { role: "assistant", content: [] } })),
    });
  });

  it("keeps messageRole null for non-message entries", async () => {
    await writeSession([entry({ type: "model_change", message: undefined, provider: "p", modelId: "m" })]);

    const [row] = await firstEntry().then((r) => r.entries);

    expect(row?.type).toBe("model_change");
    expect(row?.messageRole).toBeNull();
  });

  it("keeps messageRole null for a message entry without a usable role", async () => {
    await writeSession([entry({ message: { content: "x" } })]);

    const [row] = await firstEntry().then((r) => r.entries);

    expect(row?.type).toBe("message");
    expect(row?.messageRole).toBeNull();
  });

  it("preserves an unknown entry type and reads messageRole only from a message entry", async () => {
    await writeSession([entry({ type: "quantum_flux", message: { role: "hologram" } })]);

    const [row] = await firstEntry().then((r) => r.entries);

    expect(row?.type).toBe("quantum_flux");
    expect(row?.messageRole, "messageRole is scoped to type message").toBeNull();
  });

  it("preserves an unknown message role verbatim", async () => {
    await writeSession([entry({ message: { role: "hologram" } })]);

    const [row] = await firstEntry().then((r) => r.entries);

    expect(row?.type).toBe("message");
    expect(row?.messageRole).toBe("hologram");
  });

  it("returns raw untouched, including arbitrary nested shapes", async () => {
    const raw = {
      id: "cafe1234",
      parentId: null,
      timestamp: "2026-01-01T10:00:02.000Z",
      type: "custom",
      customType: "state",
      data: { list: [1, "two", { three: null }], nested: { deep: [{ deeper: true }] } },
      "ünïcøde": "ok",
    };
    await writeSession([JSON.stringify(raw)]);

    const [row] = await firstEntry().then((r) => r.entries);

    expect(row?.raw).toStrictEqual(raw);
  });

  it("reports physical line numbers across skipped lines", async () => {
    await writeSession([entry({ id: "a1" }), "{ broken", "", entry({ id: "a2" })]);

    const result = await firstEntry();

    expect(result.entries.map((row) => [row.lineNo, row.id])).toStrictEqual([
      [2, "a1"],
      [5, "a2"],
    ]);
    expect(result.warnings.map((warning) => [warning.lineNo, warning.code])).toStrictEqual([
      [3, "invalid_json"],
      [4, "invalid_json"],
    ]);
  });

  it("keeps entries in file order, not timestamp order", async () => {
    await writeSession([
      entry({ id: "late", timestamp: "2027-01-01T00:00:00.000Z" }),
      entry({ id: "early", timestamp: "2020-01-01T00:00:00.000Z" }),
    ]);

    const result = await firstEntry();

    expect(result.entries.map((row) => row.id)).toStrictEqual(["late", "early"]);
  });

  it("tolerates CRLF line endings", async () => {
    await mkdir(dirname(SESSION), { recursive: true });
    await writeFile(SESSION, `${header()}\r\n${entry({ id: "crlf" })}\r\n`);

    const result = await firstEntry();

    expect(result.entries.map((row) => row.id)).toStrictEqual(["crlf"]);
    expect(result.warnings).toStrictEqual([]);
  });

  it("reads a header line longer than the discovery read bound", async () => {
    await mkdir(dirname(SESSION), { recursive: true });
    await writeFile(SESSION, `${header({ pad: "x".repeat(5000) })}\n${entry()}\n`);

    const result = await firstEntry();

    expect(result.entries).toHaveLength(1);
  });
});

describe("readSessionEntries version handling", () => {
  beforeEach(async () => {
    await rm(TEMP, { recursive: true, force: true });
  });

  it("returns v2 entries with their ids", async () => {
    await writeSession([entry({ id: "v2a" })]);
    const content = await readFile(SESSION, "utf8");
    await writeFile(SESSION, content.replace('"version":3', '"version":2'));

    const result = await firstEntry();

    expect(result.entries.map((row) => row.id)).toStrictEqual(["v2a"]);
    expect(result.warnings).toStrictEqual([]);
  });

  it("returns v1 entries with null ids and one file-level warning", async () => {
    await writeSession([
      entry({ id: undefined, parentId: undefined, message: { role: "user", content: "x" } }),
      entry({ id: undefined, parentId: undefined, type: "model_change", message: undefined }),
    ]);
    const content = await readFile(SESSION, "utf8");
    await writeFile(SESSION, content.replace('"version":3', '"version":1'));

    const result = await firstEntry();

    expect(result.entries.map((row) => [row.id, row.parentId])).toStrictEqual([
      [null, null],
      [null, null],
    ]);
    expect(result.entries.map((row) => row.messageRole)).toStrictEqual(["user", null]);
    expect(result.warnings).toStrictEqual([
      {
        lineNo: null,
        code: "legacy_version",
        reason: "session version 1: entry ids are not durable, so id and parentId are null",
      },
    ]);
  });

  it("nulls the ids a version 1 file already carries, and keeps them in raw", async () => {
    // Pi's `migrateV1ToV2` assigns `entry.id = generateId(ids)` unconditionally, so a stored v1 id
    // is replaced the next time Pi opens the file. Returning it would hand out a citation that
    // resolves to nothing, even though the file does contain one.
    await writeSession([entry({ id: "persisted", parentId: "older", message: undefined })]);
    const content = await readFile(SESSION, "utf8");
    await writeFile(SESSION, content.replace('"version":3', '"version":1'));

    const result = await firstEntry();

    expect(result.entries.map((row) => [row.lineNo, row.id, row.parentId])).toStrictEqual([
      [2, null, null],
    ]);
    expect(result.entries[0]?.raw).toMatchObject({ id: "persisted", parentId: "older" });
    expect(result.warnings.map((warning) => warning.code)).toStrictEqual(["legacy_version"]);
  });

  it("keeps ids in a version 2 file that are absent from a version 1 one", async () => {
    await writeSession([entry({ id: "kept", parentId: "root" })]);
    const content = await readFile(SESSION, "utf8");
    await writeFile(SESSION, content.replace('"version":3', '"version":2'));

    const result = await firstEntry();

    expect(result.entries.map((row) => [row.id, row.parentId])).toStrictEqual([["kept", "root"]]);
  });

  it("treats a header with no version field as v1", async () => {
    await writeSession([entry({ id: undefined })]);
    const content = await readFile(SESSION, "utf8");
    await writeFile(SESSION, content.replace('"version":3,', ""));

    const result = await firstEntry();

    expect(result.entries.map((row) => row.id)).toStrictEqual([null]);
    expect(result.warnings.map((warning) => warning.code)).toStrictEqual(["legacy_version"]);
  });

  it("still returns entries whose id is absent in a v3 file", async () => {
    await writeSession([entry({ id: undefined })]);

    const result = await firstEntry();

    expect(result.entries.map((row) => row.id)).toStrictEqual([null]);
    expect(result.warnings).toStrictEqual([]);
  });

  it("nulls a parentId that is neither a string nor null", async () => {
    await writeSession([entry({ parentId: 42 })]);

    const result = await firstEntry();

    expect(result.entries.map((row) => row.parentId)).toStrictEqual([null]);
  });
});

describe("readSessionEntries warnings", () => {
  beforeEach(async () => {
    await rm(TEMP, { recursive: true, force: true });
  });

  it("warns invalid_json for an unparseable line", async () => {
    await writeSession([entry({ id: "ok" }), "{ nope"]);

    const result = await firstEntry();

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.lineNo).toBe(3);
    expect(result.warnings[0]?.code).toBe("invalid_json");
    expect(result.warnings[0]?.reason).toMatch(/not valid JSON/);
  });

  it("warns invalid_entry for a line that parses but is not an object", async () => {
    await writeSession(["[1,2,3]", '"a string"', "null", "42"]);

    const result = await firstEntry();

    expect(result.entries).toStrictEqual([]);
    expect(result.warnings.map((warning) => [warning.lineNo, warning.code])).toStrictEqual([
      [2, "invalid_entry"],
      [3, "invalid_entry"],
      [4, "invalid_entry"],
      [5, "invalid_entry"],
    ]);
    expect(result.warnings[0]?.reason).toMatch(/not a JSON object/);
  });

  it("warns invalid_entry when type is missing or not a string", async () => {
    await writeSession([entry({ type: undefined }), entry({ type: 7 })]);

    const result = await firstEntry();

    expect(result.entries).toStrictEqual([]);
    expect(result.warnings.map((warning) => warning.reason)).toStrictEqual([
      "entry has no type",
      "entry has no type",
    ]);
  });

  it("warns invalid_entry when timestamp is missing or has no instant", async () => {
    await writeSession([
      entry({ timestamp: undefined }),
      entry({ timestamp: "yesterday" }),
      entry({ timestamp: "2026-01-05T09:00:60Z" }),
    ]);

    const result = await firstEntry();

    expect(result.entries).toStrictEqual([]);
    expect(result.warnings.map((warning) => warning.reason)).toStrictEqual([
      "entry has no readable timestamp",
      "entry has no readable timestamp",
      "entry has no readable timestamp",
    ]);
  });

  it("warns a file-level entry only once", async () => {
    await writeSession([entry(), entry({ id: "b" })]);

    const result = await firstEntry();

    expect(result.entries).toHaveLength(2);
    expect(result.warnings).toStrictEqual([]);
  });

  it("keeps line-level warnings ordered by line", async () => {
    await writeSession(["{ bad", entry({ id: "a" }), "{ worse"]);

    const result = await firstEntry();

    expect(result.warnings.map((warning) => warning.lineNo)).toStrictEqual([2, 4]);
  });

  it("honors an aborted signal", async () => {
    await writeSession([entry()]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      readSessionEntries({ sessionPath: SESSION }, { sessionsRoot: ROOT, signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("re-throws a non-Error abort reason as an Error", async () => {
    await writeSession([entry()]);
    const controller = new AbortController();
    controller.abort("stopped by caller");

    await expect(
      readSessionEntries({ sessionPath: SESSION }, { sessionsRoot: ROOT, signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
  });
});
