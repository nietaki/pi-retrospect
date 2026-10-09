/**
 * Covers the registered shape of the `session_entries` tool (codemode-only, read-only, one
 * required `sessionPath` parameter beside the optional filters), that its structured result equals
 * `readSessionEntries`, and that the extension entry point registers both tools.
 *
 * `execute`'s fifth argument is typed as Pi's full tool context and `registerTool` as part of
 * `ExtensionAPI`; neither is read here, so the fakes carry just the members used.
 *
 * Contract: docs/tool-api.md
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSessionEntriesTool } from "../src/session-entries-tool.ts";
import { readSessionEntries } from "../src/session-entries.ts";
import type { SessionEntriesOutput } from "../src/schemas.ts";

const TEMP = new URL("tmp/session-entries-tool/", import.meta.url).pathname;
const ROOT = join(TEMP, "root");
const SESSION = join(ROOT, "--p--", "s.jsonl");

const tool = createSessionEntriesTool({ sessionsRoot: ROOT });

const NO_CONTEXT = {} as Parameters<typeof tool.execute>[4];

const firstTextBlock = (result: Awaited<ReturnType<typeof tool.execute>>): string => {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected a text content block");
  return block.text;
};

const structured = (result: Awaited<ReturnType<typeof tool.execute>>): SessionEntriesOutput =>
  result.structuredContent as SessionEntriesOutput;

/** A registered tool, as far as these tests need to see one: `execute` included, so it can be called. */
type RegisteredTool = { name: string; description: string; execute: typeof tool.execute };

const fakeExtensionApi = (
  registered: RegisteredTool[],
  getSettings: () => unknown = () => ({}),
) =>
  ({
    registerTool: (definition: RegisteredTool) => {
      registered.push(definition);
    },
    // `src/index.ts` also subscribes the steering marker to input; these tests only read the tools.
    on: () => () => {},
    getSettings,
  }) as unknown as ExtensionAPI;

beforeAll(async () => {
  await rm(TEMP, { recursive: true, force: true });
  await mkdir(dirname(SESSION), { recursive: true });
  await writeFile(
    SESSION,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "sess-1",
        timestamp: "2026-01-01T10:00:00.000Z",
        cwd: "/repo/p",
      }),
      JSON.stringify({
        id: "aaaa1111",
        parentId: null,
        timestamp: "2026-01-01T10:00:01.000Z",
        type: "message",
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        id: "bbbb2222",
        parentId: "aaaa1111",
        timestamp: "2026-01-01T10:00:02.000Z",
        type: "model_change",
        provider: "openrouter",
        modelId: "some/model",
      }),
    ]
      .map((line) => `${line}\n`)
      .join(""),
  );
});

describe("session_entries tool registration", () => {
  it("is a codemode-only read-only reader with one required parameter", () => {
    expect(tool.name).toBe("session_entries");
    expect(tool.label).toBe("Session Entries");
    expect(tool.exposure).toBe("codemode");
    expect(tool.annotations).toStrictEqual({ readOnlyHint: true });

    expect(Object.keys(tool.parameters.properties)).toStrictEqual([
      "sessionPath",
      "startLineNo",
      "endLineNo",
      "ids",
      "parentIds",
      "startTimestamp",
      "endTimestamp",
      "types",
      "messageRoles",
      "search",
      "limit",
    ]);
    expect(tool.parameters.required).toStrictEqual(["sessionPath"]);
    expect(tool.parameters.additionalProperties).toBe(false);
  });

  it("declares every filter as an optional property, with array filters holding exact strings", () => {
    const { properties } = tool.parameters;

    for (const name of ["ids", "parentIds", "types", "messageRoles"] as const) {
      const array = properties[name] as {
        type: string;
        minItems: number;
        items: { type: string; minLength: number };
      };
      expect(array.type, name).toBe("array");
      expect(array.minItems, `${name} must reject an empty set`).toBe(1);
      expect(array.items.type, name).toBe("string");
      expect(array.items.minLength, `${name} entries are exact, not partial`).toBe(1);
    }

    for (const name of ["startLineNo", "endLineNo", "limit"] as const) {
      const integer = properties[name] as { type: string; minimum: number };
      expect(integer.type, name).toBe("integer");
      expect(integer.minimum, `${name} is a positive integer`).toBe(1);
    }

    // No `offset`: pagination is a physical `startLineNo`, so a page boundary cannot shift when a
    // filter excludes rows.
    expect(properties).not.toHaveProperty("offset");
    expect(properties).not.toHaveProperty("sortBy");
    expect(properties).not.toHaveProperty("sortDirection");
  });

  it("declares search as a literal substring filter over text, with an optional case flag", () => {
    const search = tool.parameters.properties.search as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      description: string;
      properties: {
        terms: { type: string; minItems: number; items: { type: string; minLength: number } };
        caseSensitive: { type: string; default: boolean };
      };
    };

    expect(search.type).toBe("object");
    expect(search.additionalProperties, "a search holds terms and a case flag and nothing else").toBe(false);
    expect(search.required).toStrictEqual(["terms"]);
    expect(search.description).toMatch(/literal/i);

    // Terms follow the same set rules as the exact filters: non-empty array of non-empty strings.
    expect(search.properties.terms.type).toBe("array");
    expect(search.properties.terms.minItems, "an empty term set is refused, not read as every row").toBe(1);
    expect(search.properties.terms.items.type).toBe("string");
    expect(search.properties.terms.items.minLength, "an empty term would match every row").toBe(1);

    // Case-insensitive is the default, and the schema says so rather than leaving it to prose.
    expect(search.properties.caseSensitive.type).toBe("boolean");
    expect(search.properties.caseSensitive.default).toBe(false);
    expect(search.required, "caseSensitive stays optional").not.toContain("caseSensitive");
  });

  it("keeps raw an open object so any entry shape passes validation", () => {
    const entrySchema = (tool.outputSchema as {
      properties: { entries: { items: { properties: Record<string, { additionalProperties?: boolean }> } } };
    }).properties.entries.items.properties.raw;

    expect(entrySchema.additionalProperties).toBe(true);
  });

  it("declares text as a required nullable string on every row", () => {
    const row = tool.outputSchema as {
      properties: { entries: { items: { properties: Record<string, { anyOf?: Array<{ type: string }> }>, required: string[] } } };
    };
    const { properties, required } = row.properties.entries.items;

    // Always a key, never an absent one: the same presence rule `id`, `parentId`, and `messageRole`
    // follow, so a caller can read `entry.text` without first asking whether the row carries it.
    expect(required).toContain("text");
    expect(properties.text?.anyOf?.map((clause) => clause.type)).toStrictEqual(["string", "null"]);
  });

  it("describes confinement, the discarded header, the v1 rule, and the filters", () => {
    expect(tool.description).toContain("sessions root");
    expect(tool.description).toContain("session header");
    expect(tool.description).toContain("version 1");
    expect(tool.description).toMatch(/read-only/i);
    expect(tool.description).toContain("ANDed");
    expect(tool.description).toContain("startLineNo");
    expect(tool.description).toContain("warnings describe the whole file");
  });

  it("describes the access bound a path cannot walk through", () => {
    // Confinement to the root is the old rule; the new one is that a path inside the root is not
    // automatically a readable one, and a caller should learn that before naming a file.
    expect(tool.description).toContain("piRetrospect.allowedProjects");
    expect(tool.description).toMatch(/Knowing a path is not permission/);
  });

  it("describes what search matches and what it cannot reach", () => {
    expect(tool.description).toContain("search");
    expect(tool.description).toMatch(/literal substring/i);
    expect(tool.description).toMatch(/caseInsensitive|folds case/i);
    expect(tool.description).toMatch(/never `raw`|not `raw`/i);
    expect(tool.description).toMatch(/`text` is null|non-null `text`/i);
    // The prompt rows are the surprising hits: a `system` row's text is its rendered prompt.
    expect(tool.description).toMatch(/rendered prompt/i);
  });

  it("names the text projection and what it leaves out", () => {
    expect(tool.description).toContain("text");
    expect(tool.description).toContain("thinking");
    expect(tool.description).toMatch(/never a copy|not a copy|never copies/i);
  });
});

describe("session_entries tool execution", () => {
  it("returns structured content matching the reader", async () => {
    const expected = await readSessionEntries({ sessionPath: SESSION }, { sessionsRoot: ROOT });
    const result = await tool.execute(
      "call-1",
      { sessionPath: SESSION },
      undefined,
      undefined,
      NO_CONTEXT,
    );

    expect(result.structuredContent).toStrictEqual(expected);
    expect(result.details).toStrictEqual(expected);
    expect(result.isError).toBeUndefined();

    expect(structured(result).entries.map((row) => row.lineNo)).toStrictEqual([2, 3]);
    expect(structured(result).entries[0]?.messageRole).toBe("user");
    expect(structured(result).entries[1]?.messageRole).toBeNull();
    expect(structured(result).warnings).toStrictEqual([]);
  });

  it("passes the filters through to the reader", async () => {
    const params = { sessionPath: SESSION, types: ["message"], limit: 1 };
    const expected = await readSessionEntries(params, { sessionsRoot: ROOT });
    const result = await tool.execute("call-5", params, undefined, undefined, NO_CONTEXT);

    expect(result.structuredContent).toStrictEqual(expected);
    expect(
      structured(result).entries.map((row) => row.lineNo),
      "the fixture holds one message row and one model_change row",
    ).toStrictEqual([2]);

    // A search reaches the reader through the same door as the exact filters, and a `model_change`
    // row is never a hit even when the word lives in its `raw`, because only `text` is searched.
    const searched = await tool.execute(
      "call-7",
      { sessionPath: SESSION, search: { terms: ["hellO"] } },
      undefined,
      undefined,
      NO_CONTEXT,
    );

    expect(structured(searched).entries.map((row) => row.lineNo)).toStrictEqual([2]);

    const exact = await tool.execute(
      "call-8",
      { sessionPath: SESSION, search: { terms: ["hellO"], caseSensitive: true } },
      undefined,
      undefined,
      NO_CONTEXT,
    );

    expect(structured(exact).entries).toStrictEqual([]);

    // A row dropped by the search still leaves the whole-file scan and its warnings intact.
    const provider = await tool.execute(
      "call-9",
      { sessionPath: SESSION, search: { terms: ["provider"] } },
      undefined,
      undefined,
      NO_CONTEXT,
    );

    expect(structured(provider).entries).toStrictEqual([]);
    expect(structured(provider).warnings).toStrictEqual([]);

    // A bound that excludes the only matching row is an empty result, not an error.
    const outside = await tool.execute(
      "call-6",
      { sessionPath: SESSION, types: ["message"], startLineNo: 3 },
      undefined,
      undefined,
      NO_CONTEXT,
    );

    expect(structured(outside).entries).toStrictEqual([]);
    expect(firstTextBlock(outside)).toMatch(/^Entries \(0\)/m);
  });

  it("renders an index of entries without raw payloads", async () => {
    const result = await tool.execute("call-2", { sessionPath: SESSION }, undefined, undefined, NO_CONTEXT);
    const text = firstTextBlock(result);

    expect(text).toMatch(/^Entries \(2\)/m);
    expect(text).toContain("- 2 message user aaaa1111");
    expect(text).toContain("- 3 model_change bbbb2222");
    expect(result.content).toHaveLength(1);
    expect(text).not.toContain("hello");
    expect(text).not.toContain("raw");
  });

  it("throws a plain error for a path outside the sessions root", async () => {
    await expect(
      tool.execute("call-3", { sessionPath: "/tmp/elsewhere.jsonl" }, undefined, undefined, NO_CONTEXT),
    ).rejects.toThrow(/not under the sessions root/);
  });

  it("honors an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool.execute("call-4", { sessionPath: SESSION }, controller.signal, undefined, NO_CONTEXT),
    ).rejects.toThrow();
  });
});

/**
 * The `piRetrospect.allowedProjects` boundary as this tool sees it.
 *
 * Pi cannot be asked for its effective settings while an extension factory is still running, and
 * `/reload` replaces them afterwards, so the tool holds a reader rather than a value: it asks on
 * every call, and a settings snapshot that cannot be read fails the call. `session_entries` is the
 * tool a caller can point at one transcript by path, so it has to answer to the same settings as
 * `list_sessions` does, and reading them the same way is the precondition for that.
 */
describe("session_entries project access", () => {
  it("never reads settings while the tool is being built", () => {
    const readSettings = vi.fn(() => ({}));

    createSessionEntriesTool({ sessionsRoot: ROOT, readSettings });

    expect(readSettings).not.toHaveBeenCalled();
  });

  it("asks for the effective settings on every call, so a reload takes effect", async () => {
    const snapshots = [{}, { piRetrospect: { allowedProjects: ["p"] } }];
    const readSettings = vi.fn(() => snapshots.shift());
    const gated = createSessionEntriesTool({ sessionsRoot: ROOT, readSettings });

    await gated.execute("access-1", { sessionPath: SESSION }, undefined, undefined, NO_CONTEXT);
    await gated.execute("access-2", { sessionPath: SESSION }, undefined, undefined, NO_CONTEXT);

    expect(readSettings).toHaveBeenCalledTimes(2);
  });

  it("fails a call whose allowlist cannot be read, without naming what it holds", async () => {
    const gated = createSessionEntriesTool({
      sessionsRoot: ROOT,
      readSettings: () => ({ piRetrospect: { allowedProjects: "/repo/hidden-project" } }),
    });

    const message = await gated
      .execute("access-3", { sessionPath: SESSION }, undefined, undefined, NO_CONTEXT)
      .then(() => "")
      .catch((error: unknown) => (error as Error).message);

    expect(message).toContain("piRetrospect.allowedProjects");
    expect(message).not.toContain("hidden-project");
    expect(message).not.toContain(ROOT);
    expect(message).not.toContain(SESSION);
  });

  it("re-decides which transcript to open from the snapshot it reads on each call", async () => {
    // The reader is asked per call and the answer decides the read: the same tool instance, the same
    // path, and two effective settings that disagree about the project that path lives in.
    const snapshots = [{ piRetrospect: { allowedProjects: ["p"] } }, { piRetrospect: { allowedProjects: ["no-p"] } }];
    const gated = createSessionEntriesTool({ sessionsRoot: ROOT, readSettings: () => snapshots.shift() });

    expect(structured(await gated.execute("access-3", { sessionPath: SESSION }, undefined, undefined, NO_CONTEXT)).entries).toHaveLength(
      2,
    );

    const message = await gated
      .execute("access-4", { sessionPath: SESSION }, undefined, undefined, NO_CONTEXT)
      .then(() => "")
      .catch((error: unknown) => (error as Error).message);

    expect(message).toContain("piRetrospect.allowedProjects");
    expect(message).not.toContain(ROOT);
    expect(message).not.toContain("--p--");
  });

  it("reads the same entries as the reader does when no settings reader was supplied", async () => {
    const ungated = createSessionEntriesTool({ sessionsRoot: ROOT });
    const expected = await readSessionEntries({ sessionPath: SESSION }, { sessionsRoot: ROOT });

    expect(
      structured(await ungated.execute("access-4", { sessionPath: SESSION }, undefined, undefined, NO_CONTEXT)),
    ).toStrictEqual(expected);
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
    for (const definition of registered) {
      expect(typeof definition.description).toBe("string");
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });

  it("gives both tools the effective settings without reading them while it registers", async () => {
    const registered: RegisteredTool[] = [];
    // A malformed allowlist is the shape that proves the reader really is `pi.getSettings`: the only
    // way a registered tool can fail on it is by having asked for it.
    const getSettings = vi.fn(() => ({ piRetrospect: { allowedProjects: 42 } }));
    const { default: extension } = await import("../src/index.ts");

    extension(fakeExtensionApi(registered, getSettings));

    expect(getSettings, "settings are unreadable while the factory runs").not.toHaveBeenCalled();

    // `list_sessions` and `session_entries` answer to one policy, so the same snapshot refuses both;
    // this file can call only the reader's own `execute` without a cast, and `list_sessions` proves
    // its half in its own test.
    await expect(
      registered[1]?.execute("entry-2", { sessionPath: SESSION }, undefined, undefined, NO_CONTEXT),
    ).rejects.toThrow(/piRetrospect\.allowedProjects/);

    expect(getSettings).toHaveBeenCalledTimes(1);
  });
});
