/**
 * Covers the registered shape of the `list_sessions` tool (codemode-only, read-only, every
 * parameter optional), that its structured result equals `listSessions`, that it excludes the
 * session Pi reports as current, and that the extension entry point registers exactly that
 * one tool.
 *
 * The two casts below exist because Pi types `execute`'s fifth argument as
 * `ExtensionToolContext` and `registerTool` as part of the full `ExtensionAPI`. Of the context
 * this tool reads only `sessionManager.getSessionFile()`, and the extension entry point only
 * calls `registerTool`, so the fakes carry just those members.
 *
 * Contract: docs/tool-api.md
 */

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createListSessionsTool } from "../src/list-sessions-tool.ts";
import { listSessions } from "../src/list-sessions.ts";
import type { ListSessionsOutput } from "../src/schemas.ts";

const FIXTURES = new URL("./fixtures/sessions/", import.meta.url).pathname;

const tool = createListSessionsTool({ sessionsRoot: FIXTURES });

/**
 * A Pi tool context that reports `sessionFile` as the running session.
 *
 * `undefined` is the ephemeral case: Pi has a session, but no file for it to name.
 */
const contextWithSessionFile = (sessionFile: string | undefined) =>
  ({
    sessionManager: { getSessionFile: () => sessionFile },
  }) as unknown as Parameters<typeof tool.execute>[4];

/** Pi reports no session file, so nothing is current and nothing is excluded. */
const NO_SESSION_FILE = contextWithSessionFile(undefined);

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

    // `currentSessionPath` is deliberately absent from this list: which session is current is a fact
    // only Pi has, so a caller cannot point the exclusion rule at a session it merely names.
    expect(Object.keys(tool.parameters.properties).sort()).toStrictEqual([
      "cwdMatch",
      "cwds",
      "endTimestamp",
      "includeCurrentSession",
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

  it("describes the current-session rule the caller cannot infer from the parameter name", () => {
    expect(tool.description).toContain("current session");
    expect(tool.description).toContain("includeCurrentSession");
  });
});

describe("list_sessions tool execution", () => {
  it("returns structured content matching its output schema", async () => {
    const expected = await listSessions({}, { sessionsRoot: FIXTURES });
    const result = await tool.execute("call-1", {}, undefined, undefined, NO_SESSION_FILE);

    expect(result.structuredContent).toStrictEqual(expected);
    expect(result.details).toStrictEqual(expected);
    expect(result.isError).toBeUndefined();

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(firstTextBlock(result)).toMatch(/^Sessions \(7\)/m);
  });

  it("passes parameters through to the listing", async () => {
    const expected = await listSessions({ cwds: ["/repo/beta"] }, { sessionsRoot: FIXTURES });
    const result = await tool.execute(
      "call-3",
      { cwds: ["/repo/beta"] },
      undefined,
      undefined,
      NO_SESSION_FILE,
    );

    expect(structured(result).sessions).toStrictEqual(expected.sessions);
    expect(firstTextBlock(result)).toMatch(/^Sessions \(3\)/m);
  });

  it("honors an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool.execute("call-2", {}, controller.signal, undefined, NO_SESSION_FILE),
    ).rejects.toThrow();
  });
});

describe("list_sessions current session", () => {
  /** Two committed fixture rows, used as stand-ins for the running session. */
  const alpha = join(
    FIXTURES,
    "--fixture-alpha--",
    "2026-01-01T10-00-00-000Z_00000000-0000-4000-8000-000000000001.jsonl",
  );
  const beta = join(
    FIXTURES,
    "--fixture-beta--",
    "2026-01-01T10-00-00-000Z_00000000-0000-4000-8000-000000000002.jsonl",
  );
  const pathsOf = (output: ListSessionsOutput): string[] => output.sessions.map((session) => session.path);

  it("excludes the session Pi reports as current, by default", async () => {
    const expected = await listSessions({}, { sessionsRoot: FIXTURES, currentSessionPath: alpha });
    const result = await tool.execute("call-4", {}, undefined, undefined, contextWithSessionFile(alpha));

    expect(structured(result)).toStrictEqual(expected);
    expect(pathsOf(structured(result))).not.toContain(alpha);
    expect(pathsOf(structured(result))).toContain(beta);
    expect(firstTextBlock(result)).toMatch(/^Sessions \(6\)/m);
  });

  it("keeps it when includeCurrentSession is true", async () => {
    const expected = await listSessions(
      { includeCurrentSession: true },
      { sessionsRoot: FIXTURES, currentSessionPath: alpha },
    );
    const result = await tool.execute(
      "call-5",
      { includeCurrentSession: true },
      undefined,
      undefined,
      contextWithSessionFile(alpha),
    );

    expect(structured(result)).toStrictEqual(expected);
    expect(pathsOf(structured(result))).toContain(alpha);
  });

  it("reads the session file on every call, so a switched session is never stale", async () => {
    const reported = [alpha, beta];
    const getSessionFile = vi.fn(() => reported.shift());
    const ctx = { sessionManager: { getSessionFile } } as unknown as Parameters<typeof tool.execute>[4];

    const first = structured(await tool.execute("call-6", {}, undefined, undefined, ctx));
    const second = structured(await tool.execute("call-7", {}, undefined, undefined, ctx));

    expect(getSessionFile).toHaveBeenCalledTimes(2);
    expect(pathsOf(first)).toStrictEqual(pathsOf(await listSessions({}, { sessionsRoot: FIXTURES, currentSessionPath: alpha })));
    expect(pathsOf(second)).toStrictEqual(pathsOf(await listSessions({}, { sessionsRoot: FIXTURES, currentSessionPath: beta })));
    expect(pathsOf(first)).not.toContain(alpha);
    expect(pathsOf(second)).not.toContain(beta);
  });

  it("excludes nothing when the session is ephemeral and Pi reports no file", async () => {
    const expected = await listSessions({}, { sessionsRoot: FIXTURES });
    const result = await tool.execute("call-8", {}, undefined, undefined, NO_SESSION_FILE);

    expect(structured(result)).toStrictEqual(expected);
  });
});

describe("extension entry point", () => {
  it("registers list_sessions and session_entries", async () => {
    const registered: Array<{ name: string; description: string }> = [];
    const { default: extension } = await import("../src/index.ts");

    extension(fakeExtensionApi(registered));

    expect(registered.map((definition) => definition.name)).toStrictEqual([
      "list_sessions",
      "session_entries",
    ]);
    expect(typeof registered[0]?.description).toBe("string");
    expect(registered[0]?.description.length).toBeGreaterThan(0);
  });
});
