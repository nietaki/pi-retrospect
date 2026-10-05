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
import { beforeAll, describe, expect, it } from "vitest";

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

const fakeExtensionApi = (registered: Array<{ name: string; description: string }>) =>
  ({
    registerTool: (definition: { name: string; description: string }) => {
      registered.push(definition);
    },
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

  it("keeps raw an open object so any entry shape passes validation", () => {
    const entrySchema = (tool.outputSchema as {
      properties: { entries: { items: { properties: Record<string, { additionalProperties?: boolean }> } } };
    }).properties.entries.items.properties.raw;

    expect(entrySchema.additionalProperties).toBe(true);
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

describe("extension entry point", () => {
  it("registers list_sessions and session_entries", async () => {
    const registered: Array<{ name: string; description: string }> = [];
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
});
