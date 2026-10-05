/**
 * Covers `readFirstLine` (bounded first-line read), `validateHeaderLine` (the field checks
 * behind every trustworthy row), and `readSessionHeader` (the two composed).
 *
 * The src result types are discriminated unions (`{ ok: true; line } | { ok: false; reason }`),
 * and an `expect(result.ok).toBe(true)` does not narrow them, so the `lineOf` / `valuesOf` /
 * `reasonOf` helpers below unwrap after asserting. The helpers only satisfy strict TypeScript;
 * every assertion is made where the case needs it.
 *
 * Contract: docs/tool-api.md
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAX_HEADER_LINE_BYTES,
  readFirstLine,
  readSessionHeader,
  validateHeaderLine,
} from "../src/session-metadata.ts";
import type { HeaderResult, SessionHeaderValues } from "../src/session-metadata.ts";
import { parseSessionInstant } from "../src/timestamps.ts";

type FirstLineResult = Awaited<ReturnType<typeof readFirstLine>>;

const TEMP = new URL("tmp/", import.meta.url).pathname;

let written = 0;

/** Write a scratch file under test/tmp/ so bound tests read real bytes off disk. */
async function write(name: string, contents: string): Promise<string> {
  const path = join(TEMP, `${written++}-${name}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}

function headerLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "session", version: 3, ...fields });
}

function padTo(header: Record<string, unknown>, bytes: number): string {
  const base = JSON.stringify({ ...header, pad: "" });
  return JSON.stringify({ ...header, pad: "x".repeat(bytes - base.length) });
}

const lineOf = (result: FirstLineResult): string => {
  if (result.ok) return result.line;
  throw new Error(`expected a readable line, got failure: ${result.reason}`);
};

const valuesOf = (result: HeaderResult): SessionHeaderValues => {
  if (result.ok) return result.values;
  throw new Error(`expected a valid header, got failure: ${result.reason}`);
};

const reasonOf = (result: HeaderResult | FirstLineResult): string => {
  if (!result.ok) return result.reason;
  throw new Error("expected a failure, got ok");
};

describe("readFirstLine", () => {
  it("returns the first line and drops the rest of the file", async () => {
    const path = await write(
      "two-lines.jsonl",
      `${headerLine({ id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" })}\nsecond line garbage\n`,
    );

    const result = await readFirstLine(path);

    expect(result.ok).toBe(true);
    expect(JSON.parse(lineOf(result)).id).toBe("a");
    expect(lineOf(result)).not.toContain("second line");
  });

  it("accepts a header of exactly MAX_HEADER_LINE_BYTES", async () => {
    const line = padTo(
      { type: "session", id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" },
      MAX_HEADER_LINE_BYTES,
    );
    expect(Buffer.byteLength(line)).toBe(MAX_HEADER_LINE_BYTES);

    const path = await write("exactly-at-limit.jsonl", `${line}\n{"type":"message"}\n`);
    const result = await readFirstLine(path);

    expect(result.ok).toBe(true);
    expect(lineOf(result)).toHaveLength(MAX_HEADER_LINE_BYTES);
  });

  it("rejects a header one byte past MAX_HEADER_LINE_BYTES", async () => {
    const line = padTo(
      { type: "session", id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" },
      MAX_HEADER_LINE_BYTES + 1,
    );

    const path = await write("over-limit.jsonl", `${line}\n`);
    const result = await readFirstLine(path);

    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/longer than 4096 bytes/);
  });

  it("accepts a final line with no terminating newline", async () => {
    const line = headerLine({ id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" });
    const path = await write("no-newline.jsonl", line);

    const result = await readFirstLine(path);

    expect(result.ok).toBe(true);
    expect(JSON.parse(lineOf(result)).id).toBe("a");
  });

  it("rejects an empty file and a missing file", async () => {
    const empty = await write("empty.jsonl", "");
    const result = await readFirstLine(empty);

    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/file is empty/);

    const missing = await readFirstLine(join(TEMP, "does-not-exist.jsonl"));

    expect(missing.ok).toBe(false);
    expect(reasonOf(missing)).toMatch(/could not open file/);
  });
});

describe("validateHeaderLine", () => {
  it("accepts the fields we promise and copies parentSession verbatim", () => {
    const result = validateHeaderLine(
      headerLine({
        id: "01a0f885-5c7c",
        timestamp: "2026-01-01T10:00:00.000Z",
        cwd: "/repo/alpha",
        parentSession: "/somewhere/older.jsonl",
      }),
    );

    expect(result).toStrictEqual({
      ok: true,
      values: {
        id: "01a0f885-5c7c",
        timestamp: "2026-01-01T10:00:00.000Z",
        cwd: "/repo/alpha",
        parentSessionPath: "/somewhere/older.jsonl",
      },
    });
  });

  it("omits parentSessionPath when the header has no parentSession", () => {
    const result = validateHeaderLine(
      headerLine({ id: "a", timestamp: "2026-01-01T10:00:00.000Z", cwd: "/repo" }),
    );

    expect(result.ok).toBe(true);
    expect("parentSessionPath" in valuesOf(result)).toBe(false);
  });

  it("ignores unknown extra header fields", () => {
    const result = validateHeaderLine(
      JSON.stringify({
        type: "session",
        id: "a",
        timestamp: "2026-01-01T10:00:00.000Z",
        cwd: "/repo",
        somethingNew: { from: "a future Pi" },
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("rejects anything that is not a session header", () => {
    const cases: Array<[string, RegExp]> = [
      ["", /empty/],
      ["   ", /empty/],
      ["not json at all", /not valid JSON/],
      ["[1,2,3]", /not a JSON object/],
      ["null", /not a JSON object/],
      [
        JSON.stringify({ type: "message", id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" }),
        /not a session header/,
      ],
      [JSON.stringify({ type: "session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" }), /no id/],
      [JSON.stringify({ type: "session", id: "", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" }), /no id/],
      [JSON.stringify({ type: "session", id: "a", timestamp: "2026-01-01T00:00:00.000Z" }), /no cwd/],
      [JSON.stringify({ type: "session", id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "" }), /no cwd/],
      [JSON.stringify({ type: "session", id: "a", timestamp: "yesterday", cwd: "/r" }), /readable timestamp/],
      [
        JSON.stringify({ type: "session", id: "a", timestamp: 1_767_225_600_000, cwd: "/r" }),
        /readable timestamp/,
      ],
      // A month number with no instant behind it.
      [
        JSON.stringify({ type: "session", id: "a", timestamp: "2026-13-01T00:00:00.000Z", cwd: "/r" }),
        /readable timestamp/,
      ],
      // Hour 25: `Date.parse` reads 24:00 as the next midnight and refuses 25:00 outright.
      [
        JSON.stringify({ type: "session", id: "a", timestamp: "2026-01-01T25:00:00.000Z", cwd: "/r" }),
        /readable timestamp/,
      ],
      // Second 60 has the right shape and no instant, which is why the impossible-timestamp fixture
      // uses it rather than a February 30th.
      [
        JSON.stringify({ type: "session", id: "a", timestamp: "2026-01-05T09:00:60Z", cwd: "/r" }),
        /readable timestamp/,
      ],
      [JSON.stringify({ type: "session", id: "a", timestamp: "", cwd: "/r" }), /readable timestamp/],
      // Trailing whitespace defeats the ISO branch, and there is no fallback that reads it.
      [
        JSON.stringify({ type: "session", id: "a", timestamp: "2026-01-01T00:00:00.000Z ", cwd: "/r" }),
        /readable timestamp/,
      ],
      [
        JSON.stringify({ type: "session", id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r", parentSession: 42 }),
        /parentSession is not a string/,
      ],
    ];

    for (const [line, expected] of cases) {
      const result = validateHeaderLine(line);

      expect(result.ok, `expected rejection for: ${line || "(empty)"}`).toBe(false);
      expect(reasonOf(result), `wrong reason for: ${line}`).toMatch(expected);
    }
  });

  it("accepts whatever the session parser can read, because the data path is liberal", () => {
    // Pi writes `new Date().toISOString()` and nothing else, so this path keeps whatever
    // `Date.parse` resolves to a finite instant and rejects the rest. That deliberately admits
    // shapes the filter bounds refuse: a naive time read in the host zone, a date that rolled over,
    // and a legacy string. A corrupt header is Pi's file, and refusing a rollover would mean
    // maintaining a second grammar beside the one that sorts the rows.
    for (const timestamp of [
      "2028-02-29T10:00:00.000Z",
      "2026-01-01T10:00:00Z",
      "2026-01-01T10:00:00.123456Z",
      "2026-01-01T10:00:00+02:00",
      "2026-01-01T10:00:00",
      "2026-02-30T00:00:00.000Z",
      "2026-02-29T10:00:00.000Z",
      "2026-01-01T24:00:00.000Z",
      "2026-01-01 10:00:00.000Z",
      "Jan 2 2026",
      "2026-01-05",
    ]) {
      const result = validateHeaderLine(JSON.stringify({ type: "session", id: "a", timestamp, cwd: "/r" }));
      expect(result.ok, `expected acceptance for: ${timestamp}`).toBe(true);
    }

    // The rolled-over reading is the one the sorters and windows use, so a February 30th lands on
    // March 2nd rather than being dropped from the result set.
    const rolled = validateHeaderLine(
      JSON.stringify({ type: "session", id: "a", timestamp: "2026-02-30T00:00:00.000Z", cwd: "/r" }),
    );

    expect(valuesOf(rolled).timestamp).toBe("2026-02-30T00:00:00.000Z");
    expect(parseSessionInstant(valuesOf(rolled).timestamp)).toBe(Date.parse("2026-03-02T00:00:00.000Z"));
  });
});

describe("readSessionHeader", () => {
  it("combines reading and validation", async () => {
    const path = await write(
      "combined.jsonl",
      `${headerLine({ id: "a", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/r" })}\n`,
    );

    const good = await readSessionHeader(path);

    expect(good.ok).toBe(true);
    expect(valuesOf(good).id).toBe("a");

    const broken = await write("broken.jsonl", "nope\n");
    const bad = await readSessionHeader(broken);

    expect(bad.ok).toBe(false);
    expect(reasonOf(bad)).toMatch(/not valid JSON/);
  });
});
