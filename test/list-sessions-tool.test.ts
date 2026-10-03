/**
 * Covers the registered shape of the `list_sessions` tool (codemode-only, read-only, every
 * parameter optional), that its structured result equals `listSessions`, and that the
 * extension entry point registers exactly that one tool.
 *
 * The two casts below exist because Pi types `execute`'s fifth argument as
 * `ExtensionToolContext` and `registerTool` as part of the full `ExtensionAPI`. Neither is
 * read by this tool: `execute` only uses the tool-call id, the params, and the signal, and
 * the extension entry point only calls `registerTool`. The fakes carry just those members.
 *
 * Contract: docs/tool-api.md
 */

import { describe, expect, it } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createListSessionsTool } from "../src/list-sessions-tool.ts";
import { listSessions } from "../src/list-sessions.ts";
import type { ListSessionsOutput } from "../src/schemas.ts";

const FIXTURES = new URL("./fixtures/sessions/", import.meta.url).pathname;

const tool = createListSessionsTool({ sessionsRoot: FIXTURES });

/** Pi's full tool context, which this tool never touches. */
const NO_CONTEXT = {} as Parameters<typeof tool.execute>[4];

/** The single member `src/index.ts` calls. */
const fakeExtensionApi = (registered: Array<{ name: string; description: string }>) =>
  ({
    registerTool: (definition: { name: string; description: string }) => {
      registered.push(definition);
    },
  }) as unknown as ExtensionAPI;

/** Pull the text out of a tool result without pretending the union is a text block. */
const firstTextBlock = (result: Awaited<ReturnType<typeof tool.execute>>): string => {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error(`expected a text content block`);
  return block.text;
};

/** `structuredContent` is typed `unknown` by Pi; this is the shape this tool promises. */
const structured = (result: Awaited<ReturnType<typeof tool.execute>>): ListSessionsOutput =>
  result.structuredContent as ListSessionsOutput;

describe("list_sessions tool registration", () => {
  it("is registered as a codemode-only read-only listing", () => {
    expect(tool.name).toBe("list_sessions");
    expect(tool.label).toBe("List Sessions");
    expect(tool.exposure).toBe("codemode");
    expect(tool.annotations).toStrictEqual({ readOnlyHint: true });

    expect(Object.keys(tool.parameters.properties).sort()).toStrictEqual([
      "cwdMatch",
      "cwds",
      "endTimestamp",
      "limit",
      "sortBy",
      "sortDirection",
      "startTimestamp",
    ]);

    expect(tool.parameters.required, "every parameter is optional").toBeUndefined();
    expect(tool.parameters.additionalProperties).toBe(false);
    // Pi types `outputSchema` as the bare `TSchema`, which carries no `type` member; the
    // emitted TypeBox object does, which is what this asserts.
    expect((tool.outputSchema as { type?: unknown } | undefined)?.type).toBe("object");
  });

  it("describes the ordering, the filter scope, and the worktree heuristic", () => {
    expect(tool.description).toContain("the newest session is last");
    expect(tool.description).toContain("TOP-LEVEL sessions only");
    expect(tool.description).toContain("reads no git metadata");
  });
});

describe("list_sessions tool execution", () => {
  it("returns structured content matching its output schema", async () => {
    const expected = await listSessions({}, { sessionsRoot: FIXTURES });
    const result = await tool.execute("call-1", {}, undefined, undefined, NO_CONTEXT);

    expect(result.structuredContent).toStrictEqual(expected);
    expect(result.details).toStrictEqual(expected);
    expect(result.isError).toBeUndefined();

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(firstTextBlock(result)).toMatch(/^Sessions \(7\)/m);
  });

  it("passes parameters through to the listing", async () => {
    const expected = await listSessions({ cwds: ["/repo/beta"] }, { sessionsRoot: FIXTURES });
    const result = await tool.execute("call-3", { cwds: ["/repo/beta"] }, undefined, undefined, NO_CONTEXT);

    expect(structured(result).sessions).toStrictEqual(expected.sessions);
    expect(firstTextBlock(result)).toMatch(/^Sessions \(3\)/m);
  });

  it("honors an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(tool.execute("call-2", {}, controller.signal, undefined, NO_CONTEXT)).rejects.toThrow();
  });
});

describe("extension entry point", () => {
  it("registers exactly the list_sessions tool", async () => {
    const registered: Array<{ name: string; description: string }> = [];
    const { default: extension } = await import("../src/index.ts");

    extension(fakeExtensionApi(registered));

    expect(registered.map((definition) => definition.name)).toStrictEqual(["list_sessions"]);
    expect(typeof registered[0]?.description).toBe("string");
    expect(registered[0]?.description.length).toBeGreaterThan(0);
  });
});
