/**
 * TypeBox schemas and derived TypeScript types for the operations this package exposes.
 *
 * Contract: docs/tool-api.md
 */

import { Type, type Static } from "@earendil-works/pi-ai";

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
          "Inclusive lower bound. An ISO 8601 date means the start of that UTC day; a date-time with an explicit timezone means that exact instant.",
      }),
    ),
    endTimestamp: Type.Optional(
      Type.String({
        description:
          "Inclusive upper bound. An ISO 8601 date covers that whole UTC day; a date-time with an explicit timezone means that exact instant.",
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
          description: "Header timestamp, ISO 8601, validated before the row is returned",
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

export type ListSessionsParams = Static<typeof ListSessionsParamsSchema>;
export type CwdMatch = Static<typeof CwdMatchSchema>;
export type SessionSortField = Static<typeof SessionSortFieldSchema>;
export type SortDirection = Static<typeof SortDirectionSchema>;
export type SessionMetadata = Static<typeof SessionMetadataSchema>;
export type ListSessionsWarning = Static<typeof ListSessionsWarningSchema>;
export type ListSessionsOutput = Static<typeof ListSessionsOutputSchema>;
