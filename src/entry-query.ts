/**
 * Turning `sessionEntries` parameters into a row filter and a cap.
 *
 * The sibling of `query.ts` for one session file instead of the whole store: it only ever sees
 * rows the reader has already built, so every rule here is testable through `readSessionEntries`
 * without touching disk. The timestamp window and the `limit` check come from `filters.ts`, so
 * `list_sessions` and `session_entries` cannot drift into two dialects of the same parameter.
 *
 * Two properties are deliberate and load-bearing:
 *
 * - **Filtering never ends the scan.** `warnings` describe the file, not the page, so a `limit` or
 *   an `endLineNo` stops rows from being collected while the reader still walks every line.
 * - **Parameter errors are raised before any file is opened**, so a bad bound cannot be mistaken
 *   for a confinement failure or a missing session.
 *
 * Contract: docs/tool-api.md
 */

import { parseSessionInstant } from "./timestamps.ts";
import { requireLimit, timeWindowOf, withinWindow } from "./filters.ts";
import type { TimeWindow } from "./filters.ts";
import type { SessionEntriesParams, SessionFileEntry } from "./schemas.ts";

/** A prepared entry query: which rows to keep, and how many to return. */
export type EntryQuery = {
  matches: (entry: SessionFileEntry) => boolean;
  limit: number | undefined;
};

/**
 * Check one line bound, or throw.
 *
 * Bounds are physical line numbers, so `1` is legal even though line 1 is the header and can never
 * be a row: it is the caller's half of the same numbering, and rejecting it would only make
 * `startLineNo: 1` look like a mistake rather than the "from the beginning" it means.
 */
function requireLineNo(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer: ${String(value)}`);
  }

  return value;
}

/**
 * Prepare the query described by `params`, or throw on the first unusable parameter.
 *
 * Categories are ANDed; the values inside one array are ORed, so `types: ["message", "compaction"]`
 * keeps either type and adds no other constraint. An omitted filter constrains nothing, and an
 * array filter is matched against the **returned field**: `ids` and `parentIds` can never select a
 * version 1 row, because its `id` and `parentId` are null, and `messageRoles` can never select a
 * non-message entry, because its `messageRole` is null.
 */
export function buildEntryQuery(params: SessionEntriesParams): EntryQuery {
  const startLineNo = requireLineNo(params.startLineNo, "startLineNo");
  const endLineNo = requireLineNo(params.endLineNo, "endLineNo");

  if (startLineNo !== undefined && endLineNo !== undefined && endLineNo < startLineNo) {
    throw new Error(`endLineNo ${endLineNo} is before startLineNo ${startLineNo}`);
  }

  // Built here even when no bound is given: an unparseable timestamp must throw on the same
  // footing as a bad line bound, before anything is opened.
  const window: TimeWindow = timeWindowOf(params);

  const { ids, parentIds, types, messageRoles } = params;

  const matches = (entry: SessionFileEntry): boolean => {
    if (startLineNo !== undefined && entry.lineNo < startLineNo) return false;
    if (endLineNo !== undefined && entry.lineNo > endLineNo) return false;
    if (ids !== undefined && (entry.id === null || !ids.includes(entry.id))) return false;
    if (parentIds !== undefined && (entry.parentId === null || !parentIds.includes(entry.parentId))) {
      return false;
    }
    if (types !== undefined && !types.includes(entry.type)) return false;
    if (messageRoles !== undefined && (entry.messageRole === null || !messageRoles.includes(entry.messageRole))) {
      return false;
    }

    // Every row that reached a filter has a timestamp `parseSessionInstant` already accepted, so
    // the fallback is a type obligation rather than a reachable value.
    return withinWindow(window, parseSessionInstant(entry.timestamp) ?? 0);
  };

  return { matches, limit: requireLimit(params.limit) };
}
