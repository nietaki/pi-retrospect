/**
 * Covers `src/timestamps.ts`, the one module that decides what a time string means.
 *
 * Two functions, two policies, and the split is the point:
 *
 * - `parseSessionInstant` reads a timestamp that Pi wrote into a session file. Pi always writes
 *   `new Date().toISOString()`, so this path takes whatever `Date.parse` can read and rejects the
 *   rest. It is deliberately liberal: validation and parsing are the same call, so an accepted
 *   string is guaranteed to produce a finite instant for every sorter and filter downstream.
 * - `parseTimeBoundary` reads a bound the *caller* typed (`startTimestamp` / `endTimestamp`). The
 *   caller is a model, so the shape is gated to ISO 8601: `Date.parse` alone would read `1/2/2026`
 *   as January 2 and `12345` as the year 12344, and a wrong filter window fails silently.
 *
 * Both ends are read in the host timezone unless the string carries an explicit offset, which is
 * the operator's chosen policy: a naive `2026-01-05T09:00` means the caller's local morning, and
 * the price is that the same filter can select different sessions on different machines.
 *
 * Tests that care about the host zone set `process.env.TZ` around the call and restore it, so this
 * file is true under any zone; everything else computes expectations from local `new Date(...)`
 * rather than hardcoded instants for the same reason.
 *
 * Contract: docs/tool-api.md
 */

import { describe, expect, it } from "vitest";

import { parseSessionInstant, parseTimeBoundary } from "../src/timestamps.ts";

/**
 * Run `body` with the host timezone forced to `zone`, then put the variable back.
 *
 * The zone is what the behavior under test is, so it cannot be assumed from wherever the suite
 * happens to run.
 */
function withZone<T>(zone: string, body: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

describe("parseSessionInstant: the timestamp Pi wrote", () => {
  it("accepts the UTC shape Pi writes and returns its instant", () => {
    const value = "2026-01-05T09:00:00.000Z";
    expect(parseSessionInstant(value)).toBe(Date.parse(value));
  });

  it("accepts a date-time carrying a numeric offset", () => {
    expect(parseSessionInstant("2026-01-05T09:00:00+02:00")).toBe(Date.parse("2026-01-05T07:00:00Z"));
  });

  it("rejects a value that is not a string, because Date.parse would coerce it", () => {
    expect(parseSessionInstant(1767000000000)).toBeUndefined();
    expect(parseSessionInstant(null)).toBeUndefined();
    expect(parseSessionInstant(undefined)).toBeUndefined();
    expect(parseSessionInstant({ timestamp: "2026-01-05T09:00:00.000Z" })).toBeUndefined();
    expect(parseSessionInstant("")).toBeUndefined();
  });

  it("rejects a string Date.parse cannot read", () => {
    expect(parseSessionInstant("yesterday")).toBeUndefined();
    expect(parseSessionInstant("not a date")).toBeUndefined();
    // Second 60 is a leap second, which Date.parse refuses even though the shape looks right.
    expect(parseSessionInstant("2026-01-05T09:00:60Z")).toBeUndefined();
    // A trailing space defeats the ISO branch of the parser.
    expect(parseSessionInstant("2026-01-05T09:00:00Z ")).toBeUndefined();
  });

  it("returns a finite instant for every accepted string, so no comparator ever sees NaN", () => {
    const accepted = [
      "2026-01-05T09:00:00.000Z",
      "2026-01-05T09:00:00",
      "2026-01-05",
      "2026-02-30T08:00:00.000Z",
      "Jan 2 2026",
    ];

    for (const value of accepted) {
      const ms = parseSessionInstant(value);
      expect(Number.isFinite(ms), `${value} -> ${String(ms)}`).toBe(true);
    }
  });

  it("accepts what Date.parse reads as a rollover rather than a calendar error", () => {
    // The cost of one parser: `2026-02-30` is not a date, so it sorts as March 2. Pi cannot write
    // this, and rejecting it would mean a second grammar to keep in sync.
    expect(parseSessionInstant("2026-02-30T08:00:00.000Z")).toBe(Date.parse("2026-03-02T08:00:00.000Z"));
  });

  it("accepts a non-ISO shape for the same reason, though Pi never writes one", () => {
    // Measured, not guessed: Date.parse reads this as the year 12344. The filter path gates it
    // out; the data path does not, because a corrupt header is Pi's file, not our problem to
    // diagnose.
    expect(parseSessionInstant("12345")).toBe(Date.parse("12345"));
  });
});

describe("parseTimeBoundary: a bare date is one whole local day", () => {
  it("returns the day as a half-open range of local midnights", () => {
    const bound = parseTimeBoundary("2026-01-05");

    expect(bound).toEqual({
      kind: "day",
      startMs: new Date(2026, 0, 5).getTime(),
      endMs: new Date(2026, 0, 6).getTime(),
    });
  });

  it("reads the day in the host timezone, not UTC", () => {
    const bound = withZone("Asia/Tokyo", () => parseTimeBoundary("2026-01-05"));

    expect(bound).toEqual({
      kind: "day",
      startMs: Date.parse("2026-01-04T15:00:00Z"),
      endMs: Date.parse("2026-01-05T15:00:00Z"),
    });
  });

  it("spans the real local day, so a 25-hour daylight-saving day is 25 hours long", () => {
    // Chile ends daylight saving on 2026-04-04, making that local day 25 hours. A window built
    // by adding MS_PER_DAY to the start would stop an hour early and drop the last hour of the
    // day the caller asked for.
    const bound = withZone("America/Santiago", () => parseTimeBoundary("2026-04-04"));
    expect(bound).toBeDefined();

    const { startMs, endMs } = bound as { kind: "day"; startMs: number; endMs: number };
    expect((endMs - startMs) / 3_600_000).toBe(25);
  });

  it("rolls an impossible calendar date over instead of rejecting it", () => {
    // One grammar, and it is Date.parse's: 2026-02-30 is not a date, so it names March 2. The
    // caller still gets a whole day, just not the one it meant — accepted as the cost of not
    // maintaining a calendar table beside the parser.
    expect(parseTimeBoundary("2026-02-30")).toEqual(parseTimeBoundary("2026-03-02"));
  });

  it("rejects a month or day that has no instant to roll over to", () => {
    expect(parseTimeBoundary("2026-13-01")).toBeUndefined();
    expect(parseTimeBoundary("0000-00-00")).toBeUndefined();
  });

  it("rejects a value that is not a string", () => {
    expect(parseTimeBoundary(undefined)).toBeUndefined();
    expect(parseTimeBoundary(new Date(2026, 0, 5))).toBeUndefined();
  });
});

describe("parseTimeBoundary: a date-time is one instant", () => {
  it("reads a UTC date-time as that instant", () => {
    expect(parseTimeBoundary("2026-01-05T09:00:00.000Z")).toEqual({
      kind: "instant",
      ms: Date.parse("2026-01-05T09:00:00.000Z"),
    });
  });

  it("reads a numeric offset as the instant it names, in either written form", () => {
    const expected = { kind: "instant", ms: Date.parse("2026-01-05T07:00:00Z") };

    expect(parseTimeBoundary("2026-01-05T09:00:00+02:00")).toEqual(expected);
    expect(parseTimeBoundary("2026-01-05T09:00:00+0200")).toEqual(expected);
  });

  it("reads a date-time with no offset in the host timezone", () => {
    // The chosen policy, and the reason a naive bound is not portable: 09:00 in Tokyo is the
    // midnight before 09:00 UTC. A bound carrying `Z` or an offset is portable and means the
    // same instant everywhere.
    expect(withZone("Asia/Tokyo", () => parseTimeBoundary("2026-01-05T09:00"))).toEqual({
      kind: "instant",
      ms: Date.parse("2026-01-05T00:00:00Z"),
    });
  });

  it("treats seconds and the fraction of a second as optional", () => {
    const ms = Date.parse("2026-01-05T09:00:00Z");

    expect(parseTimeBoundary("2026-01-05T09:00Z")).toEqual({ kind: "instant", ms });
    expect(parseTimeBoundary("2026-01-05T09:00:00.000000001Z")).toBeDefined();
  });

  it("classifies by whether a time part is present at all", () => {
    expect(parseTimeBoundary("2026-01-05")?.kind).toBe("day");
    expect(parseTimeBoundary("2026-01-05T00:00:00Z")?.kind).toBe("instant");
  });

  it("refuses shapes Date.parse would read in a way the caller did not write", () => {
    // The gate exists for these: each one below is readable, and readable wrongly. `1/2/2026` is
    // January 2 in the US order, `2 January 2026` is the same date in the opposite order, and
    // `12345` is the year 12344.
    for (const value of [
      "1/2/2026",
      "2 January 2026",
      "Jan 2 2026",
      "12345",
      "2026",
      "2026-01",
      "2026-01-05 09:00:00",
      "2026-01-05 ",
      "",
    ]) {
      expect(parseTimeBoundary(value), value).toBeUndefined();
    }
  });

  it("refuses an ISO-shaped bound that has no instant", () => {
    expect(parseTimeBoundary("2026-01-05T09:00:00+99:99")).toBeUndefined();
    expect(parseTimeBoundary("2026-01-05T09:00:60Z")).toBeUndefined();
    expect(parseTimeBoundary("2026-01-05T09:00:00+02")).toBeUndefined();
  });

  it("accepts hour 24 as the next midnight, which the old calendar check refused", () => {
    // Intentional: the gate is shape, the grammar is Date.parse's, and Date.parse reads 24:00.
    expect(parseTimeBoundary("2026-01-05T24:00:00Z")).toEqual({
      kind: "instant",
      ms: Date.parse("2026-01-06T00:00:00Z"),
    });
  });
});
