/**
 * Drift probe for the `system` branch of the `text` projection.
 *
 * Compares this package's projection, read through the real `readSessionEntries` path, against
 * `getSystemMessageText` from `@earendil-works/pi-ai` — the function whose rule `systemText` mirrors.
 * Two bodies of input:
 *
 * 1. **Every `role: "system"` row in the real session store.** Read-only, and the case that matters:
 *    if Pi changes its renderer or the stored shape drifts, that shows up here.
 * 2. **Synthetic rows** from well-shaped cases, plus malformed shapes that Pi's own renderer throws
 *    on and this package must tolerate.
 *
 * Any difference is an error except the agreed local rule: Pi returns `""` where this package returns
 * `null`, so `piText` maps one to the other before comparing.
 *
 * Run: node --experimental-strip-types scratch/pi-render-drift.mts
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getSystemMessageText } from "@earendil-works/pi-ai";

import { entryText } from "../src/entry-text.ts";
import { readSessionEntries } from "../src/session-entries.ts";

const root = join(homedir(), ".pi", "agent", "sessions");

/** Pi's renderer, with this package's null rule applied so the two are directly comparable. */
const piText = (message) => {
  const rendered = getSystemMessageText({ role: "system", timestamp: 0, ...message });
  return rendered === "" ? null : rendered;
};

const systemRow = (message) => entryText({ type: "message", message: { role: "system", ...message } });

const failures = [];
const compare = (where, message, { expectPiThrow = false } = {}) => {
  let fromPi;
  try {
    fromPi = piText(message);
  } catch (error) {
    if (!expectPiThrow) failures.push(`${where}: pi-ai threw ${error.message} where the projection did not`);
    return;
  }
  if (expectPiThrow) {
    console.log(`  note: pi-ai did not throw on ${where}; comparison still held`);
  }
  const mine = systemRow(message);
  if (mine !== fromPi) {
    failures.push(`${where}: projected ${JSON.stringify(trunc(mine))} vs pi-ai ${JSON.stringify(trunc(fromPi))}`);
  }
};

const trunc = (value) => (typeof value === "string" && value.length > 70 ? `${value.slice(0, 70)}…` : value);

// ------------------------------------------------------ 1. the real store
const dirs = (await readdir(root, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && d.name.startsWith("--"))
  .map((d) => join(root, d.name));

const files = [];
for (const dir of dirs) {
  for (const name of await readdir(dir)) if (name.endsWith(".jsonl")) files.push(join(dir, name));
}

let rows = 0;
let withText = 0;
let nullRows = 0;
let bytes = 0;
let max = { len: 0, where: "" };
let patchedFiles = 0;

for (const sessionPath of files) {
  const { entries } = await readSessionEntries({ sessionPath, messageRoles: ["system"] }, { sessionsRoot: root });
  if (entries.length > 1) patchedFiles += 1;
  for (const e of entries) {
    rows += 1;
    const where = `${sessionPath.slice(root.length + 1)}:line ${e.lineNo}`;
    compare(where, e.raw.message);
    const mine = e.text;
    if (mine === null) {
      nullRows += 1;
    } else {
      withText += 1;
      bytes += mine.length;
      if (mine.length > max.len) max = { len: mine.length, where };
    }
  }
}

// ------------------------------------------------------ 2. synthetic shapes
const cases = [
  ["forced prompt in content", { content: "you are pi" }, false],
  ["content text blocks", { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }, false],
  ["sections only", { content: "", sections: { preamble: "P", tools: "<tools>T</tools>" } }, false],
  ["content plus sections", { content: "base", sections: { rules: "<rules>R</rules>" } }, false],
  ["removal marker", { content: "", sections: { skills: null, tools: "<tools>T</tools>" } }, false],
  ["every section removed", { content: "", sections: { skills: null } }, false],
  ["loadout only, no prose", { content: "", toolsAdded: [{ name: "x" }], toolsRemoved: [{ name: "y" }] }, false],
  ["empty section value", { content: "", sections: { a: "", b: "B" } }, false],
  // Shapes outside Pi's SystemMessage type: pi-ai dereferences what it assumes is a string block.
  ["text block with no text", { content: [{ type: "text" }] }, true],
  ["null content block", { content: [null] }, true],
  ["non-string section", { content: "c", sections: { a: 7 } }, true],
];

for (const [name, message, expectPiThrow] of cases) compare(name, message, { expectPiThrow });

console.log(`\nfiles scanned          : ${files.length}`);
console.log(`system rows            : ${rows} in ${patchedFiles} files with more than one system row`);
console.log(`projected to text      : ${withText}`);
console.log(`projected to null      : ${nullRows}`);
console.log(`projected bytes        : total ${bytes}, mean ${Math.round(bytes / Math.max(withText, 1))}, max ${max.len} (${max.where})`);
console.log(failures.length === 0 ? "\nNO DRIFT: the projection matches pi-ai on every comparable row" : `\n${failures.length} DIFFERENCE(S):`);
for (const f of failures.slice(0, 20)) console.log(`  ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
