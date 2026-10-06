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

/**
 * A prepared `search`: ask it of one row's `text`.
 *
 * It is a predicate over `text` alone, never over `raw`, because `text` is the field this tool
 * documents as the human-readable body of an entry: searching `raw` would match tool names, JSON
 * keys, base64 image payloads, and — if thinking were ever folded in — reasoning.
 */
export type TextSearch = (text: string | null) => boolean;

/**
 * Turn the `search` parameter into a predicate, or throw on the first unusable value.
 *
 * Terms are literal substrings matched with OR, which is the rule every other set filter follows, and
 * the reason is escaping: an agent that writes `["C:\\path"]` or `["price("]` means those bytes, not a
 * pattern. An empty set or an empty term is refused rather than silently meaning "every row" — a
 * `terms: [""]` read as a match-all would look like a working filter while returning everything.
 *
 * Case-insensitive is the default because ordinary search is what a caller means by "search", and
 * folding is `String.prototype.toLowerCase`: locale-independent, so an `İ` in a Turkish log line is
 * not folded the way a Turkish speaker's collation would fold it.
 */
function requireSearch(search: SessionEntriesParams["search"]): TextSearch | undefined {
  if (search === undefined) return undefined;

  const { terms, caseSensitive } = search;

  if (!Array.isArray(terms) || terms.length === 0) {
    throw new Error("search.terms must hold at least one term");
  }

  // Folded once here rather than per row: a scan of a 2.4 MB session asks the same question of
  // every line, and the terms never change.
  const needles = terms.map((term, index) => {
    if (typeof term !== "string" || term === "") {
      throw new Error(`search.terms[${index}] must be a non-empty string`);
    }

    return caseSensitive === true ? term : term.toLowerCase();
  });

  return (text) => {
    // A row with no projected text cannot match, whatever its `raw` holds. This is the same rule a
    // null field already follows in `ids` and `messageRoles`.
    if (text === null) return false;

    const haystack = caseSensitive === true ? text : text.toLowerCase();

    return needles.some((needle) => haystack.includes(needle));
  };
}

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
 * non-message entry, because its `messageRole` is null. `search` reads `text` the same way: it is
 * the projected body, not the stored line, so a row whose `text` is null is never a hit.
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

  const search = requireSearch(params.search);

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
    if (!withinWindow(window, parseSessionInstant(entry.timestamp) ?? 0)) return false;

    // The text search runs last because it is the only filter that reads a field as large as the row
    // — measured mean 2.1 KB and max 51 KB of `text` — so every cheap exact test has already dropped
    // what it could before a row is folded and scanned.
    return search === undefined || search(entry.text);
  };

  return { matches, limit: requireLimit(params.limit) };
}
