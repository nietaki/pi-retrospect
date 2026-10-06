/**
 * The primary human-readable text of one parsed session entry.
 *
 * `text` is a *projection*, not a serialization: it names the one field on an entry that carries its
 * displayable body, and answers `null` for every entry that has no such body. It exists so a caller
 * reading `session_entries` rows does not have to re-derive Pi's content-block shapes per role, and
 * does not have to walk `raw` at all for the common case.
 *
 * What is deliberately **not** here, and why:
 *
 * - **Assistant thinking.** It is natural language and would be findable, but mixing it into a
 *   single unqualified `text` erases the line between what the model said and how it got there, and
 *   measured on one store thinking blocks outnumber visible text blocks — so a consumer that displays
 *   `text` would be showing reasoning it never asked for. Reasoning stays in `raw`, where a caller can
 *   opt into it per block type; searching it is a separate decision with its own surface.
 * - **Tool calls.** Their payload is `arguments`, a structured object per tool, with no canonical
 *   prose form. Inventing one here would put a rendering in the data layer.
 * - **Images.** `ImageContent.data` is base64; the useful projection of an image block is `null`, not
 *   a megabyte.
 * - **State fields.** `provider`, `modelId`, `thinkingLevel`, and a `custom` entry's `data` are real
 *   values with no text form. Serializing them would make `text` a second, worse copy of `raw`.
 * - **`bashExecution.output`.** The entry's initiating content is the command; the output can be
 *   hundreds of kilobytes and already lives in `raw`.
 *
 * The join rule is fixed rather than configurable because the field's contract is one string per row:
 * `type: "text"` blocks are joined with `"\n"`, empty pieces are dropped so they cannot leave bare
 * separators, strings pass through untouched (no trim, no truncation), and a source that yields
 * nothing at all is `null` rather than `""`.
 *
 * Contract: docs/tool-api.md
 */

/** A JSON object, or `null` for anything that is not one (including arrays). */
function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A stored string that has something in it, or `null`. Never trimmed: whitespace is content. */
function stringOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The text carried by a content value: a bare string, or an array of content blocks.
 *
 * Only `type: "text"` blocks count, which is what excludes images, thinking, and tool calls from an
 * assistant message in one rule shared with every other role. A block whose `text` is missing or not
 * a string is a malformed block, not a piece of text, so it drops out rather than poisoning the join
 * with `undefined`.
 */
function contentText(value: unknown): string | null {
  const direct = stringOf(value);
  if (direct !== null) return direct;
  if (!Array.isArray(value)) return null;

  const parts = value
    .map((block) => {
      const record = objectOf(block);
      return record && record.type === "text" ? stringOf(record.text) : null;
    })
    .filter((part): part is string => part !== null);

  return parts.length === 0 ? null : parts.join("\n");
}

/** Roles whose whole message *is* its `content`, whatever blocks it holds. */
const CONTENT_ROLES = new Set(["system", "user", "assistant", "toolResult", "custom"]);

/**
 * The text of a persisted `message` entry, by role.
 *
 * The three derived roles (`branchSummary`, `compactionSummary`, `custom`) are handled even though a
 * `branchSummary`/`compactionSummary` message is built during context rather than stored: the role is
 * part of the union Pi may persist, and reading the summary here is what keeps a hand-built or
 * future-persisted row from silently projecting to `null`. An unknown role projects to `null` because
 * `@earendil-works/pi-agent-core`'s `CustomAgentMessages` is open to declaration merging by any host
 * extension, so a role this file has never seen is expected data, not an error.
 */
function messageText(message: Record<string, unknown> | null): string | null {
  if (message === null) return null;

  const role = message.role;

  if (typeof role === "string" && CONTENT_ROLES.has(role)) return contentText(message.content);

  switch (role) {
    case "bashExecution":
      return stringOf(message.command);
    case "branchSummary":
    case "compactionSummary":
      return stringOf(message.summary);
    default:
      return null;
  }
}

/**
 * The text of a non-message entry, by type.
 *
 * `context_edit` is the entry's own statement, not the target's effective content: it projects the
 * replacement that was written, and `replacement: null` — which omits the target — has no text to
 * project. Reconstructing what the model would see after the edit needs Pi's projection functions,
 * which this package does not call.
 */
function entryLevelText(entry: Record<string, unknown>): string | null {
  switch (entry.type) {
    case "custom_message":
      return contentText(entry.content);
    case "compaction":
    case "branch_summary":
      return stringOf(entry.summary);
    case "context_edit":
      return contentText(objectOf(entry.replacement)?.content);
    case "session_info":
      return stringOf(entry.name);
    case "usage":
      return stringOf(entry.note);
    case "label":
      return stringOf(entry.label);
    default:
      // `custom` (opaque extension state), `model_change`, `thinking_level_change`, the header, and
      // every type from a newer Pi.
      return null;
  }
}

/**
 * The primary human-readable text of one parsed entry line, or `null` when it has none.
 *
 * Takes the raw parsed line rather than a built row so the projection depends on the stored bytes and
 * not on the addressing decisions made around it (`id`, `parentId`, the version gate). It never
 * throws: every field it reads is checked for the type it expects, because the line may come from an
 * older Pi, a hand-edited file, or an extension. The line itself is already known to be a JSON object
 * — `session-entries.ts` refuses an array or scalar line before it asks this question.
 */
export function entryText(entry: Record<string, unknown>): string | null {
  return entry.type === "message" ? messageText(objectOf(entry.message)) : entryLevelText(entry);
}
