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

/** A registered tool, as far as these tests need to see one: `execute` included, so it can be called. */
type RegisteredTool = { name: string; description: string; execute: typeof tool.execute };

/** The members `src/index.ts` calls: it reads the effective settings, registers tools, subscribes. */
const fakeExtensionApi = (
  registered: RegisteredTool[],
  getSettings: () => unknown = () => ({}),
) =>
  ({
    registerTool: (definition: RegisteredTool) => {
      registered.push(definition);
    },
    on: () => () => {},
    getSettings,
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

  it("describes the access bound the caller cannot widen", () => {
    // The setting is not a parameter, so the only place a caller meets it is the description: that
    // `cwds` selects within the operator's bound, and that an omitted bound changes nothing.
    expect(tool.description).toContain("piRetrospect.allowedProjects");
    expect(tool.description).toMatch(/can never widen it/);
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

/**
 * The `piRetrospect.allowedProjects` boundary as the tool sees it.
 *
 * Pi cannot be asked for its effective settings while an extension factory is still running, and
 * `/reload` replaces them afterwards, so the tool holds a reader rather than a value: it asks on
 * every call, and a settings snapshot that cannot be read fails the call. Both halves of that are
 * behavior a caller can see, and neither needs a real Pi.
 */
describe("list_sessions project access", () => {
  it("never reads settings while the tool is being built", () => {
    const readSettings = vi.fn(() => ({}));

    createListSessionsTool({ sessionsRoot: FIXTURES, readSettings });

    expect(readSettings).not.toHaveBeenCalled();
  });

  it("asks for the effective settings on every call, so a reload takes effect", async () => {
    const snapshots = [{}, { piRetrospect: { allowedProjects: ["*"] } }];
    const readSettings = vi.fn(() => snapshots.shift());
    const gated = createListSessionsTool({ sessionsRoot: FIXTURES, readSettings });

    await gated.execute("access-1", {}, undefined, undefined, NO_SESSION_FILE);
    await gated.execute("access-2", {}, undefined, undefined, NO_SESSION_FILE);

    expect(readSettings).toHaveBeenCalledTimes(2);
  });

  it("fails a call whose allowlist cannot be read, without naming what it holds", async () => {
    const gated = createListSessionsTool({
      sessionsRoot: FIXTURES,
      readSettings: () => ({ piRetrospect: { allowedProjects: "/repo/hidden-project" } }),
    });

    const message = await gated
      .execute("access-3", {}, undefined, undefined, NO_SESSION_FILE)
      .then(() => "")
      .catch((error: unknown) => (error as Error).message);

    expect(message).toContain("piRetrospect.allowedProjects");
    // The refusal says nothing about the settings, the sessions, or where either lives.
    expect(message).not.toContain("hidden-project");
    expect(message).not.toContain(FIXTURES);
  });

  it("re-decides which projects to report from the snapshot it reads on each call", async () => {
    // The two halves meet here: a reader asked per call, and a listing that answers to the policy it
    // returned. One tool instance, two effective settings, and no re-registration in between.
    const snapshots = [{}, { piRetrospect: { allowedProjects: ["beta"] } }];
    const gated = createListSessionsTool({ sessionsRoot: FIXTURES, readSettings: () => snapshots.shift() });

    const unrestricted = structured(await gated.execute("access-5", {}, undefined, undefined, NO_SESSION_FILE));
    const restricted = structured(await gated.execute("access-6", {}, undefined, undefined, NO_SESSION_FILE));

    expect(new Set(unrestricted.sessions.map((session) => session.cwd))).toStrictEqual(
      new Set(["/repo/alpha", "/repo/beta"]),
    );
    expect(new Set(restricted.sessions.map((session) => session.cwd))).toStrictEqual(new Set(["/repo/beta"]));
    // The denied projects are gone, and so is everything the scan would have said about them: the
    // committed fixtures hold their unreadable files inside the same directories.
    expect(restricted.warnings).toStrictEqual([]);
  });

  it("lists the same sessions as the listing does when no settings reader was supplied", async () => {
    // The default is the access that existed before the setting did, so a tool built the way the
    // library is used directly keeps returning every discoverable session.
    const ungated = createListSessionsTool({ sessionsRoot: FIXTURES });
    const expected = await listSessions({}, { sessionsRoot: FIXTURES });

    expect(structured(await ungated.execute("access-4", {}, undefined, undefined, NO_SESSION_FILE))).toStrictEqual(
      expected,
    );
  });
});

describe("extension entry point", () => {
  it("registers list_sessions and session_entries", async () => {
    const registered: RegisteredTool[] = [];
    const { default: extension } = await import("../src/index.ts");

    extension(fakeExtensionApi(registered));

    expect(registered.map((definition) => definition.name)).toStrictEqual([
      "list_sessions",
      "session_entries",
    ]);
    expect(typeof registered[0]?.description).toBe("string");
    expect(registered[0]?.description.length).toBeGreaterThan(0);
  });

  it("gives both tools the effective settings without reading them while it registers", async () => {
    const registered: RegisteredTool[] = [];
    // A malformed allowlist is the shape that proves the reader really is `pi.getSettings`: the only
    // way a registered tool can fail on it is by having asked.
    const getSettings = vi.fn(() => ({ piRetrospect: { allowedProjects: 42 } }));
    const { default: extension } = await import("../src/index.ts");

    extension(fakeExtensionApi(registered, getSettings));

    expect(getSettings, "settings are unreadable while the factory runs").not.toHaveBeenCalled();

    await expect(
      registered[0]?.execute("entry-1", {}, undefined, undefined, NO_SESSION_FILE),
    ).rejects.toThrow(/piRetrospect\.allowedProjects/);
  });
});
