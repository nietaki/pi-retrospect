import assert from "node:assert/strict";
import test from "node:test";
import { exploreSessions } from "../src/explore-sessions.ts";

test("exploreSessions starts with an empty result", () => {
  assert.deepEqual(exploreSessions(), []);
});
