/**
 * TypeBox schemas and derived TypeScript types for the operations this package exposes.
 *
 * Contract: docs/tool-api.md
 */

import { Type, type JsonObject, type Static } from "@earendil-works/pi-ai";

/**
 * Top-level session field the result is ordered by. Children always stay timestamp ascending.
 */
export const SessionSortFieldSchema = Type.Union(
  [Type.Literal("timestamp"), Type.Literal("cwd"), Type.Literal("path"), Type.Literal("id")],
  {
    default: "timestamp",
    description:
      "Field the top-level sessions are ordered by. Ties fall back to timestamp, then path.",
  },
);

export const SortDirectionSchema = Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
  default: "asc",
  description:
    'Order direction for top-level sessions. "desc" reverses the whole comparison, tie-breaks included.',
});

/**
 * How a value in `cwds` is matched against a session `cwd`.
 *
 * `sibling-prefix` is aimed at git worktrees created next to the main checkout
 * (`/repo/app` also matching `/repo/app-fix`); it reads no git metadata.
 */
export const CwdMatchSchema = Type.Union([Type.Literal("exact"), Type.Literal("sibling-prefix")], {
  default: "exact",
  description:
    'How a value in cwds is matched against a session cwd. "sibling-prefix" also matches a sibling directory whose basename starts with the requested basename followed by "-", mainly for git worktrees placed next to the main checkout. Lexical path rule: no git metadata is read.',
});

/**
 * Parameters for `listSessions`.
 *
 * Every filter selects **top-level** sessions. A top-level session that matches keeps its
 * complete `subagentSessions` tree, whatever the children's own cwd or timestamp is.
 */
export const ListSessionsParamsSchema = Type.Object(
  {
    cwds: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description:
          "Absolute working directories to keep. Omitted means every working directory. Compared literally: a relative or ~-prefixed entry matches nothing.",
      }),
    ),
    startTimestamp: Type.Optional(
      Type.String({
        description:
          "Inclusive lower bound. An ISO 8601 date means the start of that day in the host timezone; a date-time means that instant, also read in the host timezone when it carries no offset.",
      }),
    ),
    endTimestamp: Type.Optional(
      Type.String({
        description:
          "Inclusive upper bound. An ISO 8601 date covers that whole day in the host timezone; a date-time means that instant, also read in the host timezone when it carries no offset.",
      }),
    ),
    cwdMatch: Type.Optional(CwdMatchSchema),
    sortBy: Type.Optional(SessionSortFieldSchema),
    sortDirection: Type.Optional(SortDirectionSchema),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Maximum number of top-level sessions to return, applied after filtering and sorting. An output cap only: the scan still reads every header.",
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Metadata for one session file, with its subagent children nested underneath.
 *
 * Recursive schemas in this TypeBox release use `Type.Cyclic` + `Type.Ref`. `id` stays an
 * unformatted string on purpose: Pi mints UUIDv7 by default, but only constrains the id
 * character set, so a custom session id is valid data and must not be rejected here.
 */
export const SessionMetadataSchema = Type.Cyclic(
  {
    SessionMetadata: Type.Object(
      {
        id: Type.String({ description: "Session id from the file header" }),
        path: Type.String({ description: "Absolute path to the session .jsonl file" }),
        timestamp: Type.String({
          format: "date-time",
          description: "Header timestamp as stored; a row is returned only when the session parser can read it",
        }),
        cwd: Type.String({ description: "Absolute working directory from the header" }),
        parentSessionPath: Type.Optional(
          Type.String({
            description: "Header parentSession value, copied verbatim (fork/clone lineage)",
          }),
        ),
        subagentSessions: Type.Array(Type.Ref("SessionMetadata"), {
          description: "Subagent transcripts launched from this session, in timestamp order",
        }),
      },
      { additionalProperties: false },
    ),
  },
  "SessionMetadata",
);

/** One skipped file: its path and a free-form reason. Not an enum. */
export const ListSessionsWarningSchema = Type.Object(
  {
    path: Type.String({ description: "Absolute path of the file or directory that was skipped" }),
    reason: Type.String({ description: "Why the file was not returned as a session" }),
  },
  { additionalProperties: false },
);

/**
 * Result of `listSessions`. With default parameters `sessions` is ordered by timestamp
 * ascending, oldest first, with ties broken by path; `sortDirection` and `sortBy` change the
 * top-level order only. `subagentSessions` is always timestamp ascending, ties by path.
 */
export const ListSessionsOutputSchema = Type.Object(
  {
    sessions: Type.Array(SessionMetadataSchema),
    warnings: Type.Array(ListSessionsWarningSchema),
  },
  { additionalProperties: false },
);

/** This TypeBox release has no `Type.Nullable`; a nullable string is this union. */
const NullableString = (description: string) =>
  Type.Union([Type.String(), Type.Null()], { description });

/**
 * The parsed line, unchanged: Pi's own fields plus whatever a newer Pi or an extension wrote.
 *
 * Open on purpose. `Type.Unsafe` carries the TypeScript type because TypeBox infers `{}` from
 * empty `properties`, which would drop every field the reader just preserved.
 */
export const JsonObjectSchema = Type.Unsafe<JsonObject>({
  type: "object",
  additionalProperties: true,
  description:
    "The whole JSON object from that physical line, verbatim: every Pi field, and every unknown field a newer Pi or an extension wrote.",
});

/**
 * One session entry with the metadata needed to cite it.
 *
 * `lineNo` is the durable handle. `id` and `parentId` describe what a caller may cite, not what the
 * bytes say: Pi writes them from session version 2 on, and `migrateV1ToV2` overwrites every id in a
 * version 1 file — stored ones included — so a version 1 row reports `null` and `raw` keeps the text.
 */
export const SessionFileEntrySchema = Type.Object(
  {
    lineNo: Type.Integer({
      minimum: 2,
      description: "Physical 1-based line number; line 1 is the header and is never returned",
    }),
    id: NullableString("Entry id, or null when the file carries none or carries one that a version 1 migration would replace"),
    parentId: NullableString("Entry parentId; null for a root, an absent value, or a non-string"),
    timestamp: Type.String({
      format: "date-time",
      description: "Entry timestamp, copied verbatim only when the session parser can read it",
    }),
    type: Type.String({
      description: "Entry type, verbatim: unknown future types are preserved, not rejected",
    }),
    messageRole: NullableString('Message role of a "message" entry, else null'),
    raw: JsonObjectSchema,
  },
  { additionalProperties: false, description: "One session entry, with its raw JSON" },
);

/**
 * A line or a file that did not become an entry. `code` is machine-readable, `reason` is prose.
 * `lineNo` is null only for `legacy_version`, which describes the whole file.
 */
export const SessionEntriesWarningSchema = Type.Object(
  {
    lineNo: Type.Union([Type.Integer({ minimum: 2 }), Type.Null()], {
      description: "Physical line number, or null when the warning describes the whole file",
    }),
    code: Type.Union(
      [Type.Literal("invalid_json"), Type.Literal("invalid_entry"), Type.Literal("legacy_version")],
      {
        description:
          '"invalid_json": the line is blank or does not parse. "invalid_entry": it parsed but has no usable type or timestamp. "legacy_version": the session predates version 2, so entry ids are not durable and are returned null even when the line stores them.',
      },
    ),
    reason: Type.String({ description: "Human-readable detail; not an enum" }),
  },
  { additionalProperties: false, description: "One skipped line, or one whole-file condition" },
);

/**
 * A non-empty set of exact values for one field, matched with OR inside the set and AND across
 * sets. An empty array would select nothing while looking like "no filter", so the schema refuses
 * it; `minLength: 1` keeps `types: [""]` from being a silent way of asking for a nameless row.
 */
const ValueSet = (item: string, description: string) =>
  Type.Array(Type.String({ minLength: 1, description: item }), { minItems: 1, description });

/**
 * Parameters for `readSessionEntries`: the single session file to read, plus optional filters.
 *
 * Every filter is optional and the result is their AND; values inside one array are ORed. Filters
 * narrow `entries` only — `warnings` still describe the whole file, because a limited read is still
 * a full scan. Ordering is not configurable: rows come back in physical file order.
 */
export const SessionEntriesParamsSchema = Type.Object(
  {
    sessionPath: Type.String({
      minLength: 1,
      description:
        "Absolute path to a session .jsonl file under the sessions root. A path outside the root, a relative path, a `..` traversal, and a symlink whose target leaves the root all throw.",
    }),
    startLineNo: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Inclusive lower bound on the physical line number. Line 1 is the session header and is never a row, so 1 and 2 both mean \"from the first entry\". Pagination continues from the last returned lineNo plus one.",
      }),
    ),
    endLineNo: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Inclusive upper bound on the physical line number. A bound that is below startLineNo throws.",
      }),
    ),
    ids: Type.Optional(
      ValueSet(
        "Entry id to keep, matched exactly and case-sensitively",
        "Entry ids to keep. Compared against the returned `id`, so a version 1 file — where every id is null — is never selected.",
      ),
    ),
    parentIds: Type.Optional(
      ValueSet(
        "Parent entry id to keep, matched exactly and case-sensitively",
        "Keep entries whose `parentId` is one of these. A root (null parentId) is never selected, and a version 1 file never is either.",
      ),
    ),
    startTimestamp: Type.Optional(
      Type.String({
        description:
          "Inclusive lower bound on each entry's own timestamp. An ISO 8601 date means the start of that day in the host timezone; an ISO 8601 date-time with no offset is read in the host timezone.",
      }),
    ),
    endTimestamp: Type.Optional(
      Type.String({
        description:
          "Inclusive upper bound on each entry's own timestamp. A bare date covers that whole day; a date-time is an exact instant. A range ending before it starts throws.",
      }),
    ),
    types: Type.Optional(
      ValueSet(
        "Entry type to keep, matched exactly and case-sensitively",
        "Entry types to keep, compared verbatim against `type` — an unknown type from a newer Pi is filterable if it is named exactly.",
      ),
    ),
    messageRoles: Type.Optional(
      ValueSet(
        "Message role to keep, matched exactly and case-sensitively",
        "Roles to keep, compared against `messageRole`. Only a `type: \"message\"` entry carries one, so a non-message row is never selected by any value here.",
      ),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Maximum number of entries to return, applied after filtering. An output cap, not an I/O bound: the file is still scanned to the end so warnings stay whole-file.",
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Result of `readSessionEntries`: entries in physical file order, plus one warning per line or
 * file that produced none.
 */
export const SessionEntriesOutputSchema = Type.Object(
  {
    entries: Type.Array(SessionFileEntrySchema),
    warnings: Type.Array(SessionEntriesWarningSchema),
  },
  { additionalProperties: false },
);

export type ListSessionsParams = Static<typeof ListSessionsParamsSchema>;
export type CwdMatch = Static<typeof CwdMatchSchema>;
export type SessionSortField = Static<typeof SessionSortFieldSchema>;
export type SortDirection = Static<typeof SortDirectionSchema>;
export type SessionMetadata = Static<typeof SessionMetadataSchema>;
export type ListSessionsWarning = Static<typeof ListSessionsWarningSchema>;
export type ListSessionsOutput = Static<typeof ListSessionsOutputSchema>;
export type SessionFileEntry = Static<typeof SessionFileEntrySchema>;
export type SessionEntriesWarning = Static<typeof SessionEntriesWarningSchema>;
export type SessionEntriesWarningCode = SessionEntriesWarning["code"];
export type SessionEntriesParams = Static<typeof SessionEntriesParamsSchema>;
export type SessionEntriesOutput = Static<typeof SessionEntriesOutputSchema>;
