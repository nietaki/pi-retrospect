/**
 * Turning `listSessions` parameters into a filter, an order, and a cap.
 *
 * Kept separate from the filesystem walk: this module only ever sees already-validated
 * session rows, so every rule here is testable through `listSessions` without touching disk.
 * The timestamp window and the `limit` check are shared with `session_entries` through
 * `filters.ts`. Current-session exclusion is here too: it is a rule over rows, and it runs
 * before the query so that dropping one row lets the next one take its place under `limit`.
 *
 * Contract: docs/tool-api.md
 */

import { basename, dirname, resolve } from "node:path";

import { parseSessionInstant } from "./timestamps.ts";
import { requireLimit, timeWindowOf, withinWindow } from "./filters.ts";
import type { TimeWindow } from "./filters.ts";
import type { CwdMatch, ListSessionsParams, SessionMetadata, SessionSortField } from "./schemas.ts";

/** A prepared query: what to keep, how to order what remains, and how many to return. */
export type SessionQuery = {
  matchesRoot: (session: SessionMetadata) => boolean;
  compareRoots: (a: SessionMetadata, b: SessionMetadata) => number;
  limit: number | undefined;
};

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

    return withinWindow(window, instantOf(session));
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

  return {
    matchesRoot: matchesRootOf(params, window),
    compareRoots: comparatorOf(params),
    limit: requireLimit(params.limit),
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

/**
 * Remove the session the caller is running in, with every transcript nested under it.
 *
 * Paths are compared after `resolve()`, so one spelling is enough: Pi hands the tool the absolute
 * session file and the scan builds its paths from a resolved root, yet a hand-written or relocated
 * path can still differ by a `..` or a redundant segment.
 *
 * There is no fallback to `id`. Two files can carry the same header id — a copy, a fork, a custom
 * id — and dropping an unrelated transcript because it happens to share an id is worse than keeping
 * the current one, so a current path the scan never produced excludes nothing.
 *
 * A matched node loses its whole subtree. The transcripts under it were launched by it, so promoting
 * them to its parent would invent a delegation that never happened.
 *
 * Rows are copied rather than mutated: the caller's tree keeps its shape even when a caller hands
 * the same rows to two calls.
 */
export function excludeSessionTree(sessions: SessionMetadata[], currentPath: string): SessionMetadata[] {
  const wanted = resolve(currentPath);

  const prune = (rows: SessionMetadata[]): SessionMetadata[] =>
    rows
      .filter((row) => resolve(row.path) !== wanted)
      .map((row) => ({ ...row, subagentSessions: prune(row.subagentSessions) }));

  return prune(sessions);
}
