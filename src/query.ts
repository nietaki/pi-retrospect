/**
 * Turning `listSessions` parameters into a filter, an order, and a cap.
 *
 * Kept separate from the filesystem walk: this module only ever sees already-validated
 * session rows, so every rule here is testable through `listSessions` without touching disk.
 *
 * Contract: docs/tool-api.md
 */

import { basename, dirname } from "node:path";

import { isRealTimestamp } from "./session-metadata.ts";
import type { CwdMatch, ListSessionsParams, SessionMetadata, SessionSortField } from "./schemas.ts";

const MS_PER_DAY = 86_400_000;

/** ISO 8601 calendar date with no time part. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ISO 8601 date-time carrying `Z` or a numeric offset, so it denotes one instant. */
const ISO_DATE_TIME_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Half-open session-time window in epoch milliseconds.
 *
 * Both ends are `null` when unbounded. `toInclusive` distinguishes an end date-time (an exact
 * instant, kept) from an end date (the following UTC midnight, never kept).
 */
type TimeWindow = { fromMs: number | null; toMs: number | null; toInclusive: boolean };

/** A prepared query: what to keep, how to order what remains, and how many to return. */
export type SessionQuery = {
  matchesRoot: (session: SessionMetadata) => boolean;
  compareRoots: (a: SessionMetadata, b: SessionMetadata) => number;
  limit: number | undefined;
};

/**
 * Start of a UTC calendar day, or `undefined` when the string is not a real date.
 *
 * The round trip rejects impossible dates: `Date.UTC` rolls `2026-02-30` over to March and
 * the components then disagree.
 */
function utcDayStartMs(date: string): number | undefined {
  const parts = ISO_DATE.exec(date);
  if (!parts) return undefined;

  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);

  const ms = Date.UTC(year, month - 1, day);
  const probe = new Date(ms);

  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return undefined;
  }

  return ms;
}

/**
 * Resolve one timestamp parameter to epoch milliseconds.
 *
 * A naive date-time is refused rather than read in the machine's local zone: the same filter
 * string must select the same sessions on every machine. An impossible calendar date is
 * refused for the same reason `Date.parse` is not trusted — it rolls over instead of failing.
 */
function parseBoundary(value: string, name: string): number {
  if (ISO_DATE.test(value)) {
    const ms = utcDayStartMs(value);
    if (ms === undefined) throw new Error(`${name} is not a real ISO 8601 date: ${value}`);
    return ms;
  }

  if (!ISO_DATE_TIME_WITH_OFFSET.test(value) || !isRealTimestamp(value)) {
    throw new Error(
      `${name} must be an ISO 8601 date, or a date-time with an explicit timezone (Z or +HH:MM): ${value}`,
    );
  }

  return Date.parse(value);
}

function timeWindowOf(params: ListSessionsParams): TimeWindow {
  let fromMs: number | null = null;
  let toMs: number | null = null;
  let toInclusive = true;

  if (params.startTimestamp !== undefined) {
    fromMs = parseBoundary(params.startTimestamp, "startTimestamp");
  }

  if (params.endTimestamp !== undefined) {
    const value = params.endTimestamp;

    if (ISO_DATE.test(value)) {
      // A date-only end means "the whole of that day", so it becomes the next midnight
      // exclusively rather than 23:59:59.999, which would drop a session in the last
      // millisecond.
      toMs = parseBoundary(value, "endTimestamp") + MS_PER_DAY;
      toInclusive = false;
    } else {
      toMs = parseBoundary(value, "endTimestamp");
    }
  }

  if (fromMs !== null && toMs !== null && toMs < fromMs) {
    throw new Error(
      `endTimestamp ${params.endTimestamp} resolves before startTimestamp ${params.startTimestamp}`,
    );
  }

  return { fromMs, toMs, toInclusive };
}

/**
 * Absolute path without a trailing separator, so `/repo/app` and `/repo/app/` compare equal.
 * The root `/` is left alone because stripping it would produce an empty string.
 */
function normalizeCwd(cwd: string): string {
  return cwd.length > 1 ? cwd.replace(/\/+$/, "") : cwd;
}

/**
 * One requested cwd against one session cwd.
 *
 * `sibling-prefix` additionally accepts a sibling directory whose basename starts with the
 * requested basename plus a dash — the shape of a git worktree created next to the main
 * checkout. It is a lexical path rule: no git metadata is read, and nothing else about the
 * directory is checked, so a plain `/repo/app-backup` matches too, and a worktree placed
 * anywhere else does not.
 */
function matchesCwd(candidate: string, requested: string, mode: CwdMatch): boolean {
  const left = normalizeCwd(candidate);
  const right = normalizeCwd(requested);

  if (left === right) return true;
  if (mode !== "sibling-prefix") return false;
  if (dirname(left) !== dirname(right)) return false;

  return basename(left).startsWith(`${basename(right)}-`);
}

/** Lexicographic, codepoint order — never locale-sensitive, so runs are reproducible. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareByField(a: SessionMetadata, b: SessionMetadata, sortBy: SessionSortField): number {
  switch (sortBy) {
    case "timestamp":
      return Date.parse(a.timestamp) - Date.parse(b.timestamp);
    case "cwd":
      return compareStrings(a.cwd, b.cwd);
    case "path":
      return compareStrings(a.path, b.path);
    case "id":
      return compareStrings(a.id, b.id);
  }
}

function comparatorOf(params: ListSessionsParams): (a: SessionMetadata, b: SessionMetadata) => number {
  const sortBy = params.sortBy ?? "timestamp";
  const descending = params.sortDirection === "desc";

  return (a, b) => {
    let result = compareByField(a, b, sortBy);
    if (result === 0 && sortBy !== "timestamp") {
      result = Date.parse(a.timestamp) - Date.parse(b.timestamp);
    }
    // `path` is the documented unique handle, so it is the final tie-break and the order is total.
    if (result === 0) result = compareStrings(a.path, b.path);

    return descending ? -result : result;
  };
}

function matchesRootOf(params: ListSessionsParams, window: TimeWindow): (session: SessionMetadata) => boolean {
  const cwds = params.cwds;
  const mode = params.cwdMatch ?? "exact";

  return (session) => {
    if (cwds !== undefined && !cwds.some((requested) => matchesCwd(session.cwd, requested, mode))) {
      return false;
    }

    const at = Date.parse(session.timestamp);
    if (window.fromMs !== null && at < window.fromMs) return false;
    if (window.toMs !== null && (window.toInclusive ? at > window.toMs : at >= window.toMs)) return false;

    return true;
  };
}

/**
 * Prepare the query described by `params`.
 *
 * Throws on an unparseable timestamp, a range that ends before it starts, or a limit below
 * one, so a bad call fails before any file is opened rather than looking like empty history.
 */
export function buildQuery(params: ListSessionsParams): SessionQuery {
  const window = timeWindowOf(params);

  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) {
    throw new Error(`limit must be a positive integer: ${String(params.limit)}`);
  }

  return {
    matchesRoot: matchesRootOf(params, window),
    compareRoots: comparatorOf(params),
    limit: params.limit,
  };
}

/**
 * Apply the query to the discovered top-level sessions.
 *
 * Children are never filtered or re-ordered: a matching parent arrives with its whole tree in
 * launch order, which is why this takes and returns roots only.
 */
export function applyQuery(roots: SessionMetadata[], query: SessionQuery): SessionMetadata[] {
  const kept = roots.filter(query.matchesRoot);
  kept.sort(query.compareRoots);

  return query.limit === undefined ? kept : kept.slice(0, query.limit);
}
