import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  MAX_HEADER_LINE_BYTES,
  readFirstLine,
  readSessionHeader,
  validateHeaderLine,
} from "../src/session-metadata.ts";

const TEMP = new URL("tmp/", import.meta.url).pathname;

let written = 0;

/** Write a scratch file under test/tmp/ so bound tests read real bytes off disk. */
async function write(name, contents) {
  const path = join(TEMP, `${written++}-${name}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}

function headerLine(fields) {
  return JSON.stringify({ type: "session", version: 3, ...fields });
}

function padTo(header, bytes) {
  const base = JSON.stringify({ ...header, pad: "" });
  return JSON.stringify({ ...header, pad: "x".repeat(bytes - base.length) });
}

test("readFirstLine returns the first line and drops the rest of the file", async () => {
  const path = await write(
    "two-lines.jsonl",
    `${headerLine({ id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" })}\nsecond line garbage\n`,
  );

  const result = await readFirstLine(path);
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(result.line).id, "a");
  assert.ok(!result.line.includes("second line"));
});

test("readFirstLine accepts a header of exactly MAX_HEADER_LINE_BYTES", async () => {
  const line = padTo(
    { type: "session", id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" },
    MAX_HEADER_LINE_BYTES,
  );
  assert.equal(Buffer.byteLength(line), MAX_HEADER_LINE_BYTES);

  const path = await write("exactly-at-limit.jsonl", `${line}\n{"type":"message"}\n`);
  const result = await readFirstLine(path);

  assert.equal(result.ok, true);
  assert.equal(result.line.length, MAX_HEADER_LINE_BYTES);
});

test("readFirstLine rejects a header one byte past MAX_HEADER_LINE_BYTES", async () => {
  const line = padTo(
    { type: "session", id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" },
    MAX_HEADER_LINE_BYTES + 1,
  );

  const path = await write("over-limit.jsonl", `${line}\n`);
  const result = await readFirstLine(path);

  assert.equal(result.ok, false);
  assert.match(result.reason, /longer than 4096 bytes/);
});

test("readFirstLine accepts a final line with no terminating newline", async () => {
  const line = headerLine({ id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" });
  const path = await write("no-newline.jsonl", line);

  const result = await readFirstLine(path);
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(result.line).id, "a");
});

test("readFirstLine rejects an empty file and a missing file", async () => {
  const empty = await write("empty.jsonl", "");
  const result = await readFirstLine(empty);
  assert.equal(result.ok, false);
  assert.match(result.reason, /file is empty/);

  const missing = await readFirstLine(join(TEMP, "does-not-exist.jsonl"));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /could not open file/);
});

test("validateHeaderLine accepts the fields we promise and copies parentSession verbatim", () => {
  const result = validateHeaderLine(
    headerLine({
      id: "01a0f885-5c7c",
      timestamp: "2026-01-01T10:00:00.000Z",
      cwd: "/repo/alpha",
      parentSession: "/somewhere/older.jsonl",
    }),
  );

  assert.deepEqual(result, {
    ok: true,
    values: {
      id: "01a0f885-5c7c",
      timestamp: "2026-01-01T10:00:00.000Z",
      cwd: "/repo/alpha",
      parentSessionPath: "/somewhere/older.jsonl",
    },
  });
});

test("validateHeaderLine omits parentSessionPath when the header has no parentSession", () => {
  const result = validateHeaderLine(
    headerLine({ id: "a", timestamp: "2026-01-01T10:00:00.000Z", cwd: "/repo" }),
  );

  assert.equal(result.ok, true);
  assert.equal("parentSessionPath" in result.values, false);
});

test("validateHeaderLine ignores unknown extra header fields", () => {
  const result = validateHeaderLine(
    JSON.stringify({
      type: "session",
      id: "a",
      timestamp: "2026-01-01T10:00:00.000Z",
      cwd: "/repo",
      somethingNew: { from: "a future Pi" },
    }),
  );

  assert.equal(result.ok, true);
});

test("validateHeaderLine rejects anything that is not a session header", () => {
  const cases = [
    ["", /empty/],
    ["   ", /empty/],
    ["not json at all", /not valid JSON/],
    ["[1,2,3]", /not a JSON object/],
    ["null", /not a JSON object/],
    [JSON.stringify({ type: "message", id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" }), /not a session header/],
    [JSON.stringify({ type: "session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" }), /no id/],
    [JSON.stringify({ type: "session", id: "", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" }), /no id/],
    [JSON.stringify({ type: "session", id: "a", timestamp: "2026-01-01T00:00:00.000Z" }), /no cwd/],
    [JSON.stringify({ type: "session", id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "" }), /no cwd/],
    [JSON.stringify({ type: "session", id: "a", timestamp: "yesterday", cwd: "/r" }), /ISO 8601/],
    [JSON.stringify({ type: "session", id: "a", timestamp: 1_767_225_600_000, cwd: "/r" }), /ISO 8601/],
    [JSON.stringify({ type: "session", id: "a", timestamp: "2026-02-30T00:00:00.000Z", cwd: "/r" }), /ISO 8601/],
    [JSON.stringify({ type: "session", id: "a", timestamp: "2026-13-01T00:00:00.000Z", cwd: "/r" }), /ISO 8601/],
    [JSON.stringify({ type: "session", id: "a", timestamp: "2026-01-01T25:00:00.000Z", cwd: "/r" }), /ISO 8601/],
    [JSON.stringify({ type: "session", id: "a", timestamp: "2026-01-01 10:00:00.000Z", cwd: "/r" }), /ISO 8601/],
    [JSON.stringify({ type: "session", id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r", parentSession: 42 }), /parentSession is not a string/],
  ];

  for (const [line, expected] of cases) {
    const result = validateHeaderLine(line);
    assert.equal(result.ok, false, `expected rejection for: ${line || "(empty)"}`);
    assert.match(result.reason, expected, `wrong reason for: ${line}`);
  }
});

test("validateHeaderLine accepts leap-day and offset timestamps", () => {
  for (const timestamp of [
    "2028-02-29T10:00:00.000Z",
    "2026-01-01T10:00:00Z",
    "2026-01-01T10:00:00.123456Z",
    "2026-01-01T10:00:00+02:00",
  ]) {
    const result = validateHeaderLine(JSON.stringify({ type: "session", id: "a", timestamp, cwd: "/r" }));
    assert.equal(result.ok, true, `expected acceptance for: ${timestamp}`);
  }

  // 2026 is not a leap year.
  const rejected = validateHeaderLine(
    JSON.stringify({ type: "session", id: "a", timestamp: "2026-02-29T10:00:00.000Z", cwd: "/r" }),
  );
  assert.equal(rejected.ok, false);
});

test("readSessionHeader combines reading and validation", async () => {
  const path = await write(
    "combined.jsonl",
    `${headerLine({ id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" })}\n`,
  );

  const good = await readSessionHeader(path);
  assert.equal(good.ok, true);
  assert.equal(good.values.id, "a");

  const broken = await write("broken.jsonl", "nope\n");
  const bad = await readSessionHeader(broken);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not valid JSON/);
});
