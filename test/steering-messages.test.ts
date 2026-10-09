/**
 * Covers the opt-in steering-message marker: the namespaced `piRetrospect.markSteeringMessages`
 * setting that enables it, which input events gain the `STEERING: ` prefix and which are left
 * unchanged, image preservation, and the fail-safe when the effective settings cannot be read.
 *
 * Settings are always supplied as plain objects here, never read from the operator's
 * `settings.json`, so the suite stays independent of local Pi configuration.
 *
 * Contract: docs/tool-api.md, "Marking steering messages"
 */

import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";

import {
  createSteeringInputHandler,
  isSteeringMarkingEnabled,
} from "../src/steering-messages.ts";

/** The image element type Pi uses on input events, taken from the event contract itself. */
type InputImage = NonNullable<InputEvent["images"]>[number];

/** Input Pi would hand an `input` handler while an agent is streaming. */
const steering = (overrides: Partial<InputEvent> = {}): InputEvent => ({
  type: "input",
  text: "that is not what I meant",
  source: "interactive",
  streamingBehavior: "steer",
  ...overrides,
});

/** The settings snapshot used by every marking test; no operator configuration is involved. */
const markingEnabled = () => ({ piRetrospect: { markSteeringMessages: true } });

describe("steering marking settings", () => {
  it("is enabled by the namespaced boolean set to exactly true", () => {
    expect(
      isSteeringMarkingEnabled({
        piRetrospect: { markSteeringMessages: true },
      }),
    ).toBe(true);
  });

  it("is disabled when the setting is absent, false, or not exactly true", () => {
    expect(isSteeringMarkingEnabled({})).toBe(false);
    expect(isSteeringMarkingEnabled({ piRetrospect: {} })).toBe(false);
    expect(isSteeringMarkingEnabled({ piRetrospect: { markSteeringMessages: false } })).toBe(false);
    expect(isSteeringMarkingEnabled({ piRetrospect: { markSteeringMessages: "true" } })).toBe(false);
    expect(isSteeringMarkingEnabled({ piRetrospect: true })).toBe(false);
    expect(isSteeringMarkingEnabled(undefined)).toBe(false);
  });
});

describe("steering input handler", () => {
  it("prepends the marker to eligible steering while the setting is enabled", () => {
    const handler = createSteeringInputHandler(markingEnabled);

    expect(handler(steering())).toStrictEqual({
      action: "transform",
      text: "STEERING: that is not what I meant",
      images: undefined,
    });
  });

  it("marks only input Pi delivers as steering", () => {
    const handler = createSteeringInputHandler(markingEnabled);

    // An idle prompt carries no streaming behavior.
    expect(handler(steering({ streamingBehavior: undefined }))).toStrictEqual({
      action: "continue",
    });
    // A queued follow-up arrives after the run, so it is not a correction of it.
    expect(handler(steering({ streamingBehavior: "followUp" }))).toStrictEqual({
      action: "continue",
    });
    // Another extension owns its own message text.
    expect(handler(steering({ source: "extension" }))).toStrictEqual({ action: "continue" });
  });

  it("marks RPC steering like interactive steering", () => {
    const handler = createSteeringInputHandler(markingEnabled);

    expect(handler(steering({ source: "rpc" }))).toStrictEqual({
      action: "transform",
      text: "STEERING: that is not what I meant",
      images: undefined,
    });
  });

  it("leaves slash-prefixed and already-marked input unchanged", () => {
    const handler = createSteeringInputHandler(markingEnabled);

    // Prefixing a command would stop it from expanding.
    expect(handler(steering({ text: "/yolo" }))).toStrictEqual({ action: "continue" });
    // Re-applying the marker to an already-marked message would double it.
    expect(handler(steering({ text: "STEERING: already marked" }))).toStrictEqual({
      action: "continue",
    });
  });

  it("carries attached images through unchanged", () => {
    const handler = createSteeringInputHandler(markingEnabled);
    const images = [{ type: "image", data: "Zm9v", mimeType: "image/png" }] satisfies InputImage[];

    const result = handler(steering({ images }));
    if (result.action !== "transform") throw new Error(`expected a transform, got ${result.action}`);

    expect(result.images).toBe(images);
  });

  it("is disabled by every other settings value", () => {
    const handler = createSteeringInputHandler(() => ({}));

    expect(handler(steering())).toStrictEqual({ action: "continue" });
  });

  it("leaves input unchanged when settings cannot be read", () => {
    const handler = createSteeringInputHandler(() => {
      throw new Error("settings unavailable");
    });

    expect(handler(steering())).toStrictEqual({ action: "continue" });
  });
});

/** A fake Pi API that records the `input` handlers the extension registers and answers `getSettings`. */
const fakeExtensionApi = (settings: () => unknown) => {
  const handlers: Array<(event: InputEvent) => InputEventResult> = [];
  const getSettings = vi.fn(settings);
  const api = {
    registerTool: () => {},
    on: (_event: string, handler: (event: InputEvent) => InputEventResult) => {
      handlers.push(handler);
      return () => {};
    },
    getSettings,
  } as unknown as ExtensionAPI;

  return { api, handlers, getSettings };
};

describe("extension entry point", () => {
  // The timeout is this test's, not the assertion's. It is the first test in the suite that reaches
  // `src/index.ts` at runtime — every other file imports a tool factory statically and so has Pi's
  // graph loaded before a test runs — and that first import is a cold transform of Pi and both tools
  // that costs seconds, not milliseconds, and does not scale with this machine's load. Under the
  // default 5s per-test budget the suite fails according to how busy the run is.
  it(
    "marks steering through the handler it registers on Pi",
    async () => {
      const { api, handlers, getSettings } = fakeExtensionApi(markingEnabled);
      const { default: extension } = await import("../src/index.ts");

      extension(api);

      expect(handlers, "the extension registers exactly one input handler").toHaveLength(1);
      // Pi's settings are not readable while a factory is loading, so registration must not read them.
      expect(getSettings).not.toHaveBeenCalled();

      expect(handlers[0]!(steering())).toStrictEqual({
        action: "transform",
        text: "STEERING: that is not what I meant",
        images: undefined,
      });
      expect(getSettings).toHaveBeenCalledTimes(1);
    },
    20_000,
  );

  it("leaves steering unmarked when Pi's effective settings do not enable it", async () => {
    const { api, handlers } = fakeExtensionApi(() => ({}));
    const { default: extension } = await import("../src/index.ts");

    extension(api);

    expect(handlers[0]!(steering())).toStrictEqual({ action: "continue" });
  });
});
