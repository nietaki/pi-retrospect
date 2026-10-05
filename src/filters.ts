/**
 * Filtering parameters shared by `list_sessions` and `session_entries`.
 *
 * Both operations take `startTimestamp` / `endTimestamp` bounds and an optional `limit`, and a
 * caller who moves from listing files to reading one of them should not meet two dialects of the
 * same parameter. This module owns the window (through `timestamps.ts`'s shape gate) and the
 * integer cap; each query layer still decides what a row means.
 *
 * Contract: docs/tool-api.md
 */

import { parseTimeBoundary } from "./timestamps.ts";

/**
 * Half-open time window in epoch milliseconds.
 *
 * Both ends are `null` when unbounded. `toInclusive` distinguishes an end date-time (an exact
 * instant, kept) from an end date (the following local midnight, never kept).
 */
export type TimeWindow = { fromMs: number | null; toMs: number | null; toInclusive: boolean };

/** The two bounds a caller may supply. Both filters read them through one window. */
export type TimeBounds = { startTimestamp?: string; endTimestamp?: string };

/**
 * Resolve one timestamp parameter to a bound, or say which parameter was unusable.
 *
 * The grammar is `timestamps.ts`'s business; this layer only names the parameter so the message
 * tells the caller which field it got wrong, and the error text itself stays a tool contract rather
 * than leaking into the shared module.
 */
function parseBoundary(value: string, name: string) {
  const bound = parseTimeBoundary(value);

  if (bound === undefined) {
    throw new Error(
      `${name} must be an ISO 8601 date, or an ISO 8601 date-time (one with no timezone is read in the host timezone): ${value}`,
    );
  }

  return bound;
}

/**
 * Turn the two optional timestamp bounds into one window, or throw.
 *
 * Throws on an unparseable bound and on a range that ends before it starts, so a bad parameter
 * fails the call before any file is opened instead of looking like empty history.
 */
export function timeWindowOf(params: TimeBounds): TimeWindow {
  let fromMs: number | null = null;
  let toMs: number | null = null;
  let toInclusive = true;

  if (params.startTimestamp !== undefined) {
    const bound = parseBoundary(params.startTimestamp, "startTimestamp");

    // A date-only start means that day, so its lower end is the day's local midnight.
    fromMs = bound.kind === "day" ? bound.startMs : bound.ms;
  }

  if (params.endTimestamp !== undefined) {
    const bound = parseBoundary(params.endTimestamp, "endTimestamp");

    // A date-only end means the whole of that local day, so its upper end is the next local
    // midnight and is never kept. It is not `23:59:59.999`, which would drop a row in the last
    // millisecond, and not `+ MS_PER_DAY`, which would stop an hour short of a 25-hour
    // daylight-saving day.
    toMs = bound.kind === "day" ? bound.endMs : bound.ms;
    toInclusive = bound.kind === "instant";
  }

  if (fromMs !== null && toMs !== null && toMs < fromMs) {
    throw new Error(
      `endTimestamp ${params.endTimestamp} resolves before startTimestamp ${params.startTimestamp}`,
    );
  }

  return { fromMs, toMs, toInclusive };
}

/** Is `at` inside `window`? Both filters ask the same question of a row's instant. */
export function withinWindow(window: TimeWindow, at: number): boolean {
  if (window.fromMs !== null && at < window.fromMs) return false;
  if (window.toMs !== null && (window.toInclusive ? at > window.toMs : at >= window.toMs)) return false;

  return true;
}

/**
 * Check a `limit` parameter, or throw. `undefined` means uncapped and is the only non-number
 * this accepts.
 */
export function requireLimit(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new Error(`limit must be a positive integer: ${String(value)}`);
  }

  return value;
}
