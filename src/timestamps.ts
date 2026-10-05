/**
 * What a time string means, for the whole package.
 *
 * Pi session files, session entries, and the `startTimestamp` / `endTimestamp` filter bounds are
 * three different sources of time strings with three different trust levels, so this module keeps
 * two functions rather than one permissive parser:
 *
 * - `parseSessionInstant` reads what Pi wrote. Pi always emits `new Date().toISOString()`, so any
 *   string `Date.parse` can read is accepted, and validation is the same call as parsing. Every
 *   sorter and window comparison in `query.ts` and `list-sessions.ts` calls this too, so an accepted
 *   string can never produce a `NaN` comparison downstream — that guarantee is why there is one
 *   function here and not a validator beside each parse.
 * - `parseTimeBoundary` reads what the caller typed, so it gates the shape to ISO 8601 before
 *   handing the string to `Date.parse`. `Date.parse` alone reads `1/2/2026` as January 2, `2 January
 *   2026` as January 2, and `12345` as the year 12344; a filter bound that silently means the wrong
 *   day is worse than one that throws.
 *
 * Neither function builds an error message. Returning `undefined` keeps the grammar here and the
 * user-facing contract in the caller, which is the module that knows what was asked for.
 *
 * Contract: docs/tool-api.md
 */

/**
 * Parse a timestamp from a session file, or `undefined` when it is not a readable date.
 *
 * Doubles as the validator for a session header (`session-metadata.ts`) and for one transcript
 * line (`session-entries.ts`): both reject the row with a warning when this returns `undefined`,
 * and both keep the original string in the output rather than a re-serialized one, so the caller
 * sees what the file really held.
 */
export function parseSessionInstant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;

  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * One resolved filter bound: a whole calendar day, or an exact instant.
 *
 * The two kinds carry their own inclusivity because they mean different things. A day is
 * half-open — `[startMs, endMs)` holds every instant on that local date, including the last
 * millisecond, and excludes the next local midnight. An instant is a point, and the caller decides
 * whether the bound keeps a session sitting exactly on it.
 */
export type TimeBoundary = { kind: "day"; startMs: number; endMs: number } | { kind: "instant"; ms: number };

/**
 * ISO 8601 date, optionally followed by a time.
 *
 * The time part is what separates the two kinds of bound: no time means the caller named a day.
 * Seconds and their fraction are optional, and so is the offset, because a naive date-time now
 * means the host timezone rather than an error. The offset is accepted as `Z`, `+HH:MM`, `+HHMM`,
 * or `+HH`, and `Date.parse` then decides which of those it can actually read.
 *
 * This is a shape gate, not a grammar: `2026-02-30`, `2026-01-05T24:00:00Z`, and `0000-00-00` all
 * match it and are settled by `Date.parse`.
 */
const ISO_BOUND =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d{1,9})?))?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/**
 * Resolve one `startTimestamp` / `endTimestamp` bound, or `undefined` when it is not usable.
 *
 * A bare date names a whole day in the host timezone. The day is built from `new Date(year,
 * month, day)` and `new Date(year, month, day + 1)`, never by adding 24 hours to the start, because
 * a local day is 23 or 25 hours long on a daylight-saving transition and the caller asked for the
 * date, not for 86400000 milliseconds.
 */
export function parseTimeBoundary(value: unknown): TimeBoundary | undefined {
  if (typeof value !== "string") return undefined;

  const parts = ISO_BOUND.exec(value);
  if (!parts) return undefined;

  // Shape first, then the one grammar everything else uses: `2026-13-01` and `0000-00-00` match
  // the shape and have no instant, so they are refused here instead of being rolled forward by the
  // constructor below. `2026-02-30` does have an instant (March 2) and is kept.
  const ms = parseSessionInstant(value);
  if (ms === undefined) return undefined;

  // A time part means the caller named a moment, not a day.
  if (parts[4] !== undefined) return { kind: "instant", ms };

  const year = Number(parts[1]);
  const month = Number(parts[2]) - 1;
  const day = Number(parts[3]);

  // The shape caps the year at four digits, so both midnights are inside the ECMAScript date
  // range and need no finite check.
  const startMs = new Date(year, month, day).getTime();
  const endMs = new Date(year, month, day + 1).getTime();

  return { kind: "day", startMs, endMs };
}
