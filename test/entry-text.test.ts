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
 * - A `system` message contributes its `content` **and** the text of every section it names, in
 *   stored order, joined with `\n\n` — the rule `getSystemMessageText` in `@earendil-works/pi-ai`
 *   defines, pinned by a test below. Its tool loadout never contributes.
 * - Nothing is trimmed or truncated. Whitespace inside a block survives; empty pieces drop out of
 *   the join rather than leaving bare separators behind.
 *
 * Contract: docs/tool-api.md
 */

import { describe, expect, it } from "vitest";

import { getSystemMessageText } from "@earendil-works/pi-ai";

import { entryText } from "../src/entry-text.ts";

const user = (content: unknown) => entryText({ type: "message", message: { role: "user", content } });
const assistant = (content: unknown) => entryText({ type: "message", message: { role: "assistant", content } });
const toolResult = (content: unknown) =>
  entryText({ type: "message", message: { role: "toolResult", toolName: "bash", content } });
const system = (content: unknown) => entryText({ type: "message", message: { role: "system", content } });
const systemMessage = (message: Record<string, unknown>) => entryText({ type: "message", message: { role: "system", ...message } });

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

  it("takes a forced system message's content, which is where Pi puts a section-less prompt", () => {
    expect(system("you are pi")).toBe("you are pi");
    expect(system([text("part one"), text("part two")])).toBe("part one\npart two");
  });

  it("takes the sections of a stored system message, in stored order, verbatim", () => {
    // The shape every real row carries: content is "" and the prompt is the section map, whose
    // values arrive already tag-wrapped from Pi's build step.
    expect(
      systemMessage({
        content: "",
        sections: { preamble: "You are pi.", tools: "<tools>\n- read\n</tools>", cwd: "<cwd>/tmp</cwd>" },
      }),
    ).toBe("You are pi.\n\n<tools>\n- read\n</tools>\n\n<cwd>/tmp</cwd>");
  });

  it("puts content before sections and separates them with a blank line", () => {
    expect(systemMessage({ content: "base prompt", sections: { rules: "<rules>R</rules>" } })).toBe(
      "base prompt\n\n<rules>R</rules>",
    );
    expect(systemMessage({ content: [text("a"), text("b")], sections: { s: "S" } })).toBe("a\nb\n\nS");
  });

  it("renders only the sections a patch row names", () => {
    // A later system row replaces sections by name; its text is the new block, not a prompt.
    expect(systemMessage({ content: "", sections: { skills: "<skills>new list</skills>" } })).toBe(
      "<skills>new list</skills>",
    );
  });

  it("drops a removal marker and leaves nothing when it removes everything", () => {
    expect(systemMessage({ content: "", sections: { skills: null, tools: "<tools>T</tools>" } })).toBe("<tools>T</tools>");
    expect(systemMessage({ content: "", sections: { skills: null } })).toBeNull();
  });

  it("renders nothing for a system row that only changes the tool loadout", () => {
    expect(
      systemMessage({ content: "", toolsAdded: [{ name: "codemode" }], toolsRemoved: [{ name: "subagent" }] }),
    ).toBeNull();
    // Measured: 6 of 168 parent-store system rows had neither content nor sections.
    expect(systemMessage({ content: "" })).toBeNull();
  });

  it("never renders a tool schema as text", () => {
    expect(
      systemMessage({
        content: "",
        sections: { a: "A" },
        toolsAdded: [{ name: "x", description: "TOOL DESCRIPTION MUST NOT APPEAR", parameters: { type: "object" } }],
        toolsRemoved: [{ name: "y" }],
      }),
    ).toBe("A");
  });

  it("keeps section text untrimmed", () => {
    expect(systemMessage({ content: "", sections: { a: "  <a> padded </a>  \n" } })).toBe("  <a> padded </a>  \n");
  });

  it("tolerates malformed system shapes instead of throwing", () => {
    // pi-ai's own renderer iterates `sections` with Object.values, which walks the characters of a
    // string; a non-object `sections` is treated as absent here.
    expect(systemMessage({ content: "c", sections: "nope" })).toBe("c");
    expect(systemMessage({ content: "c", sections: { a: 7, b: "B", c: "" } })).toBe("c\n\nB");
    expect(systemMessage({ content: [null, { type: "text", text: "kept" }] })).toBe("kept");
    expect(systemMessage({ content: null, sections: null })).toBeNull();
    expect(systemMessage({ sections: { only: "S" } })).toBe("S");
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

/**
 * The drift pin: `systemText` mirrors `getSystemMessageText` from `@earendil-works/pi-ai`, and this is
 * the only place that keeps the mirror honest. It compares against the installed package rather than a
 * recorded snapshot, so a Pi upgrade that changes how a system message renders fails here.
 *
 * Pi's renderer throws on input outside its own `SystemMessage` type (a null content block, say), so
 * only well-formed messages are compared here. Malformed shapes are covered by the tolerance test
 * above, where the local rule is deliberately the stricter one — a non-object `sections`, for instance,
 * is absent here and `Object.values` would walk its characters in Pi's renderer.
 */
describe("entryText system rows match pi-ai", () => {
  /** pi-ai's render, with this package's null rule applied so the two are directly comparable. */
  const piRender = (message: { content: string; sections?: Record<string, string | null> }) => {
    const rendered = getSystemMessageText({ role: "system", timestamp: 0, ...message });
    return rendered === "" ? null : rendered;
  };

  const cases: Array<[string, { content: string; sections?: Record<string, string | null> }]> = [
    ["empty content, no sections", { content: "" }],
    ["forced prompt", { content: "you are pi" }],
    ["leading snapshot", { content: "", sections: { preamble: "P", tools: "<tools>T</tools>", cwd: "<cwd>/x</cwd>" } }],
    ["patch row", { content: "", sections: { skills: "<skills>S</skills>" } }],
    ["content plus sections", { content: "base", sections: { rules: "<rules>R</rules>" } }],
    ["removal marker", { content: "", sections: { skills: null, tools: "<tools>T</tools>" } }],
    ["only removals", { content: "", sections: { skills: null } }],
    ["empty section value", { content: "", sections: { a: "", b: "B" } }],
    ["whitespace survives", { content: "", sections: { a: "  \n<x> y </x>\n  " } }],
  ];

  for (const [name, message] of cases) {
    it(`agrees with pi-ai on ${name}`, () => {
      expect(systemMessage(message)).toBe(piRender(message));
    });
  }
});
