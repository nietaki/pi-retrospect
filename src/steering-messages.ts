/**
 * The opt-in `STEERING: ` input marker.
 *
 * A steering message usually means the agent was understood wrong, so marking it in the message
 * itself makes the correction findable later through `session_entries` text search. Whether marking
 * happens is a caller-supplied settings decision: this module reads a settings object and never
 * touches Pi's settings storage, so tests can hand it plain objects.
 *
 * Contract: docs/tool-api.md, "Marking steering messages"
 */

import type { InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The prefix stored in the message text; also the marker this transform never doubles. */
const STEERING_MARKER = "STEERING: ";

/**
 * Whether the operator enabled steering marking in the `piRetrospect` settings namespace.
 *
 * Pi's documented `Settings` type has no extension namespace, so the settings object arrives as
 * `unknown` and anything unexpected — absent namespace, absent key, a non-`true` value — reads as
 * disabled rather than throwing.
 */
export function isSteeringMarkingEnabled(settings: unknown): boolean {
  if (!isPlainRecord(settings)) return false;
  const namespace = settings.piRetrospect;
  return isPlainRecord(namespace) && namespace.markSteeringMessages === true;
}

/**
 * Whether this input is a correction of the run in progress, as opposed to something the marker
 * would break or duplicate.
 *
 * Pi sets `streamingBehavior` only for input actually queued while the agent is streaming, so an
 * idle prompt and a follow-up both fall out here. A slash-prefixed message is left alone because
 * the prefix would stop commands, skills, and prompt templates from expanding.
 */
function isSteeringCorrection(event: InputEvent): boolean {
  return (
    event.streamingBehavior === "steer" &&
    event.source !== "extension" &&
    !event.text.startsWith("/") &&
    !event.text.startsWith(STEERING_MARKER)
  );
}

/**
 * Reads the marking switch, treating an unreadable settings snapshot as disabled.
 *
 * An `input` handler that throws is reported as an extension error and its message passes through
 * untransformed; catching here keeps a settings failure from looking like a broken marker.
 */
function markingEnabled(readSettings: () => unknown): boolean {
  try {
    return isSteeringMarkingEnabled(readSettings());
  } catch {
    return false;
  }
}

/**
 * An `input` event handler that marks steering messages, gated on a settings snapshot.
 *
 * `readSettings` is called per event because Pi's settings are not readable while an extension
 * factory is still loading; `pi.getSettings` is the intended argument in production.
 */
export function createSteeringInputHandler(
  readSettings: () => unknown,
): (event: InputEvent) => InputEventResult {
  return (event) => {
    if (!markingEnabled(readSettings) || !isSteeringCorrection(event)) {
      return { action: "continue" };
    }

    return {
      action: "transform",
      text: `${STEERING_MARKER}${event.text}`,
      images: event.images,
    };
  };
}
