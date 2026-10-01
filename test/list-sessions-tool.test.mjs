import assert from "node:assert/strict";
import { test } from "node:test";

import { createListSessionsTool } from "../src/list-sessions-tool.ts";
import { listSessions } from "../src/list-sessions.ts";

const FIXTURES = new URL("./fixtures/sessions/", import.meta.url).pathname;

const tool = createListSessionsTool({ sessionsRoot: FIXTURES });

test("the tool is registered as a codemode-only read-only listing", () => {
  assert.equal(tool.name, "list_sessions");
  assert.equal(tool.label, "List Sessions");
  assert.equal(tool.exposure, "codemode");
  assert.deepEqual(tool.annotations, { readOnlyHint: true });
  assert.deepEqual(tool.parameters, { type: "object", properties: {}, additionalProperties: false });
  assert.equal(tool.outputSchema.type, "object");
  assert.ok(tool.description.includes("newest last"));
});

test("the tool returns structured content matching its output schema", async () => {
  const expected = await listSessions({}, { sessionsRoot: FIXTURES });
  const result = await tool.execute("call-1", {}, undefined, undefined, {});

  assert.deepEqual(result.structuredContent, expected);
  assert.deepEqual(result.details, expected);
  assert.equal(result.isError, undefined);

  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /^Sessions \(7\)/m);
});

test("the tool honors an aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(tool.execute("call-2", {}, controller.signal, undefined, {}));
});

test("the extension registers exactly the list_sessions tool", async () => {
  const registered = [];
  const { default: extension } = await import("../src/index.ts");

  extension({ registerTool: (definition) => registered.push(definition) });

  assert.deepEqual(
    registered.map((definition) => definition.name),
    ["list_sessions"],
  );
  assert.equal(typeof registered[0].description, "string");
  assert.ok(registered[0].description.length > 0);
});
