/**
 * Turning `listSessions` parameters into a filter, an order, and a cap.
 *
 * Kept separate from the filesystem walk: this module only ever sees already-validated
 * session rows, so every rule here is testable through `listSessions` without touching disk.
 *
 * Contract: docs/tool-api.md
 */

import { basename, dirname } from "node:path";

import { parseSessionInstant, parseTimeBoundary } from "./timestamps.ts";
import type { TimeBoundary } from "./timestamps.ts";
import type { CwdMatch, ListSessionsParams, SessionMetadata, SessionSortField } from "./schemas.ts";

/**
 * Half-open session-time window in epoch milliseconds.
 *
 * Both ends are `null` when unbounded. `toInclusive` distinguishes an end date-time (an exact
 * instant, kept) from an end date (the following local midnight, never kept).
 */
type TimeWindow = { fromMs: number | null; toMs: number | null; toInclusive: boolean };

/** A prepared query: what to keep, how to order what remains, and how many to return. */
export type SessionQuery = {
  matchesRoot: (session: SessionMetadata) => boolean;
  compareRoots: (a: SessionMetadata, b: SessionMetadata) => number;
  limit: number | undefined;
};

/**
 * Resolve one timestamp parameter to a bound, or say which parameter was unusable.
 *
 * The grammar is `timestamps.ts`'s business; this layer only names the parameter so the message
 * tells the caller which field it got wrong, and the error text itself stays a `list_sessions`
 * contract rather than leaking into the shared module.
 */
function parseBoundary(value: string, name: string): TimeBoundary {
  const bound = parseTimeBoundary(value);

  if (bound === undefined) {
    throw new Error(
      `${name} must be an ISO 8601 date, or an ISO 8601 date-time (one with no timezone is read in the host timezone): ${value}`,
    );
  }

  return bound;
}

function timeWindowOf(params: ListSessionsParams): TimeWindow {
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
    // midnight and is never kept. It is not `23:59:59.999`, which would drop a session in the last
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

/**
 * The instant a row sorts and filters by, in epoch milliseconds.
 *
 * Ordering lives here, so `list_sessions` takes its timestamp comparator from this module too.
 * Every row was validated before it could reach a sort (`validateHeaderLine` for a session header,
 * the entry checks in `session-entries.ts`), and both read through `parseSessionInstant`, so this
 * re-reads the same string by the same grammar. The `?? 0` exists to satisfy the type: it is
 * unreachable for a row that made it into a result set.
 */
export function instantOf(session: SessionMetadata): number {
  return parseSessionInstant(session.timestamp) ?? 0;
}

function compareByField(a: SessionMetadata, b: SessionMetadata, sortBy: SessionSortField): number {
  switch (sortBy) {
    case "timestamp":
      return instantOf(a) - instantOf(b);
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
      result = instantOf(a) - instantOf(b);
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

    const at = instantOf(session);
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
