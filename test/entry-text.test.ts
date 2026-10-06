/**
 * Covers `entryText`: the primary human-readable text projected from one parsed entry line.
 *
 * The rules under test are the mapping agreed for the `text` field of a `session_entries` row:
 *
 * - Only a recognized source produces text. An unknown type, an unknown role, or a type whose
 *   payload is state rather than prose (`model_change`, `thinking_level_change`, `custom`) yields
 *   `null`, and so does a recognized source that carries no text.
 * - Content arrays contribute their `type: "text"` blocks joined with `\n`. Images, thinking, and
 *   tool calls contribute nothing: `text` is the entry's displayable body, not its full content,
 *   and reasoning is deliberately not searchable through it.
 * - Nothing is trimmed or truncated. Whitespace inside a block survives; empty pieces drop out of
 *   the join rather than leaving bare separators behind.
 *
 * Contract: docs/tool-api.md
 */

import { describe, expect, it } from "vitest";

import { entryText } from "../src/entry-text.ts";

const user = (content: unknown) => entryText({ type: "message", message: { role: "user", content } });
const assistant = (content: unknown) => entryText({ type: "message", message: { role: "assistant", content } });
const toolResult = (content: unknown) =>
  entryText({ type: "message", message: { role: "toolResult", toolName: "bash", content } });
const system = (content: unknown) => entryText({ type: "message", message: { role: "system", content } });

const text = (value: string) => ({ type: "text", text: value });
const image = () => ({ type: "image", data: "AAAA", mimeType: "image/png" });
const thinking = (value: string) => ({ type: "thinking", thinking: value });
const toolCall = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: { command: "ls" } });

describe("entryText message entries", () => {
  it("takes a user message's string content verbatim", () => {
    expect(user("hello")).toBe("hello");
    expect(user("  keep the padding \n")).toBe("  keep the padding \n");
  });

  it("joins a user message's text blocks with a newline", () => {
    expect(user([text("one"), text("two")])).toBe("one\ntwo");
    expect(user([text("a"), text("b"), text("c")])).toBe("a\nb\nc");
  });

  it("ignores images in a user message", () => {
    expect(user([image(), text("after")])).toBe("after");
    expect(user([image()])).toBeNull();
  });

  it("keeps only the visible text of an assistant message", () => {
    expect(assistant([thinking("private chain"), text("shown"), toolCall("t1")])).toBe("shown");
    expect(assistant([text("first"), toolCall("t1"), text("second")])).toBe("first\nsecond");
  });

  it("returns null for an assistant message with no visible text", () => {
    expect(assistant([thinking("only reasoning"), toolCall("t1")])).toBeNull();
    expect(assistant([])).toBeNull();
  });

  it("never leaks thinking into text", () => {
    expect(assistant([thinking("SECRET REASONING"), text("public")])).toBe("public");
  });

  it("never renders a tool call's arguments as text", () => {
    expect(assistant([toolCall("t1")])).toBeNull();
  });

  it("joins a tool result's text blocks and ignores its images", () => {
    expect(toolResult([text("output line 1"), text("output line 2")])).toBe("output line 1\noutput line 2");
    expect(toolResult([image()])).toBeNull();
  });

  it("reports a tool result's text whether or not it errored", () => {
    expect(
      entryText({ type: "message", message: { role: "toolResult", toolName: "bash", content: [text("boom")], isError: true } }),
    ).toBe("boom");
  });

  it("takes a system message's content without its sections or tool loadout", () => {
    expect(system("you are pi")).toBe("you are pi");
    expect(system([text("part one"), text("part two")])).toBe("part one\npart two");
    expect(
      entryText({
        type: "message",
        message: { role: "system", content: "body", sections: { preamble: "SECRET SECTION" }, toolsAdded: [{ name: "x" }] },
      }),
    ).toBe("body");
  });

  it("takes an extension custom message's content", () => {
    expect(entryText({ type: "message", message: { role: "custom", customType: "note", content: [text("hi")] } })).toBe("hi");
    expect(entryText({ type: "message", message: { role: "custom", customType: "note", content: "plain" } })).toBe("plain");
  });

  it("uses only the command of a bash execution", () => {
    expect(
      entryText({ type: "message", message: { role: "bashExecution", command: "ls -la", output: "a\nb", exitCode: 0 } }),
    ).toBe("ls -la");
  });

  it("returns null for a bash execution with no command", () => {
    expect(entryText({ type: "message", message: { role: "bashExecution", output: "gone" } })).toBeNull();
  });

  it("takes the derived summary roles", () => {
    expect(entryText({ type: "message", message: { role: "branchSummary", summary: "took the other fork", fromId: null } })).toBe(
      "took the other fork",
    );
    expect(entryText({ type: "message", message: { role: "compactionSummary", summary: "compressed", tokensBefore: 10 } })).toBe(
      "compressed",
    );
  });

  it("drops empty pieces instead of leaving separators behind", () => {
    expect(user([text(""), text("real")])).toBe("real");
    expect(user([text("real"), text("")])).toBe("real");
    expect(user([text(""), text("")])).toBeNull();
    expect(user("")).toBeNull();
  });

  it("tolerates malformed content shapes", () => {
    expect(user(null)).toBeNull();
    expect(user(42)).toBeNull();
    expect(user([{ type: "text" }, {}, { text: "no type" }, null])).toBeNull();
    expect(user([{ type: "text", text: 7 }, text("kept")])).toBe("kept");
    expect(user("string")).toBe("string");
  });

  it("returns null for a message entry whose message is missing or not an object", () => {
    expect(entryText({ type: "message" })).toBeNull();
    expect(entryText({ type: "message", message: "nope" })).toBeNull();
    expect(entryText({ type: "message", message: null })).toBeNull();
  });

  it("returns null for an unknown message role", () => {
    expect(entryText({ type: "message", message: { role: "hologram", content: [text("visible to nobody yet")] } })).toBeNull();
    expect(entryText({ type: "message", message: { content: [text("no role at all")] } })).toBeNull();
  });
});

describe("entryText non-message entries", () => {
  it("joins the text content of a custom_message entry", () => {
    expect(entryText({ type: "custom_message", customType: "note", content: [text("a"), text("b")], display: true })).toBe("a\nb");
    expect(entryText({ type: "custom_message", customType: "note", content: "whole string", display: true })).toBe("whole string");
  });

  it("ignores images in a custom_message entry whatever it displays", () => {
    expect(entryText({ type: "custom_message", customType: "n", content: [image()], display: false })).toBeNull();
    expect(
      entryText({ type: "custom_message", customType: "n", content: [image(), text("kept")], display: false }),
    ).toBe("kept");
  });

  it("takes the summary of a compaction entry, not its system message or details", () => {
    expect(
      entryText({
        type: "compaction",
        summary: "everything so far",
        firstKeptEntryId: "aaaa1111",
        tokensBefore: 1200,
        systemMessage: { role: "system", content: "FULL PROMPT" },
        details: { notes: "PRIVATE" },
        usage: { totalTokens: 10 },
      }),
    ).toBe("everything so far");
  });

  it("takes the summary of a branch_summary entry, not its details", () => {
    expect(entryText({ type: "branch_summary", fromId: "aaaa1111", summary: "where we branched", details: { x: 1 } })).toBe(
      "where we branched",
    );
  });

  it("takes the replacement content of a context_edit, and nothing when it removes", () => {
    expect(entryText({ type: "context_edit", targetId: "bbbb2222", replacement: { content: [text("rewritten")] } })).toBe(
      "rewritten",
    );
    expect(entryText({ type: "context_edit", targetId: "bbbb2222", replacement: { content: "plain" } })).toBe("plain");
    expect(entryText({ type: "context_edit", targetId: "bbbb2222", replacement: null })).toBeNull();
    expect(entryText({ type: "context_edit", targetId: "bbbb2222" })).toBeNull();
    expect(entryText({ type: "context_edit", targetId: "bbbb2222", replacement: { content: [image()] } })).toBeNull();
  });

  it("takes the name of a session_info entry", () => {
    expect(entryText({ type: "session_info", name: "refactor the parser" })).toBe("refactor the parser");
    expect(entryText({ type: "session_info" })).toBeNull();
    expect(entryText({ type: "session_info", name: "" })).toBeNull();
  });

  it("takes only the note of a usage entry", () => {
    expect(
      entryText({ type: "usage", kind: "assistant", provider: "p", model: "m", usage: { totalTokens: 5 }, note: "quota warning" }),
    ).toBe("quota warning");
    expect(entryText({ type: "usage", kind: "assistant", provider: "p", model: "m", usage: { totalTokens: 5 } })).toBeNull();
  });

  it("takes the label text, and nothing when the label clears", () => {
    expect(entryText({ type: "label", targetId: "bbbb2222", label: "milestone" })).toBe("milestone");
    expect(entryText({ type: "label", targetId: "bbbb2222" })).toBeNull();
    expect(entryText({ type: "label", targetId: "bbbb2222", label: "" })).toBeNull();
  });

  it("returns null for entries whose payload is state, not prose", () => {
    expect(entryText({ type: "model_change", provider: "openrouter", modelId: "some/model" })).toBeNull();
    expect(entryText({ type: "thinking_level_change", thinkingLevel: "high" })).toBeNull();
    expect(entryText({ type: "custom", customType: "todo-state", data: { list: ["keep", "me"] } })).toBeNull();
    expect(entryText({ type: "custom", customType: "stringly", data: "looks like text" })).toBeNull();
  });

  it("returns null for an entry type this package has never seen", () => {
    expect(entryText({ type: "quantum_flux", content: [text("future prose")] })).toBeNull();
    expect(entryText({})).toBeNull();
  });
});
