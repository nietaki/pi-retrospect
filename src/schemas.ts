/**
 * TypeBox schemas and derived TypeScript types for the operations this package exposes.
 *
 * Contract: docs/tool-api.md
 */

import { Type, type Static } from "@earendil-works/pi-ai";

/**
 * Parameters for `listSessions`. Empty by design; filtering arguments are deferred.
 */
export const ListSessionsParamsSchema = Type.Object({}, { additionalProperties: false });

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
 * Result of `listSessions`. `sessions` is ordered by timestamp ascending, oldest first,
 * at every nesting level, with ties broken by path.
 */
export const ListSessionsOutputSchema = Type.Object(
  {
    sessions: Type.Array(SessionMetadataSchema),
    warnings: Type.Array(ListSessionsWarningSchema),
  },
  { additionalProperties: false },
);

export type ListSessionsParams = Static<typeof ListSessionsParamsSchema>;
export type SessionMetadata = Static<typeof SessionMetadataSchema>;
export type ListSessionsWarning = Static<typeof ListSessionsWarningSchema>;
export type ListSessionsOutput = Static<typeof ListSessionsOutputSchema>;
