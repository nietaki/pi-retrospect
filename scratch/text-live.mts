/**
 * Live end-to-end smoke for the `text` projection: read real sessions through the same path the tool
 * uses, and report what `text` came back as for each kind of row.
 *
 * Read-only. Run: node --experimental-strip-types scratch/text-live.mts
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readSessionEntries } from "../src/session-entries.ts";

const root = join(homedir(), ".pi", "agent", "sessions");

const dirs = (await readdir(root, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && d.name.startsWith("--"))
  .map((d) => join(root, d.name));

const files: string[] = [];
for (const dir of dirs) {
  for (const name of await readdir(dir)) if (name.endsWith(".jsonl")) files.push(join(dir, name));
}

let checked = 0;
let warnings = 0;
const kinds = new Map<string, { n: number; text: number }>();

for (const sessionPath of files.slice(0, 12)) {
  const { entries, warnings: fileWarnings } = await readSessionEntries(
    { sessionPath, limit: 300 },
    { sessionsRoot: root },
  );

  warnings += fileWarnings.length;

  for (const e of entries) {
    const key = `${e.type}/${e.messageRole ?? "-"}`;
    const row = kinds.get(key) ?? { n: 0, text: 0 };
    row.n += 1;
    if (typeof e.text === "string") row.text += 1;
    kinds.set(key, row);

    // The projection must never contradict raw for a user message: that is the case the field
    // exists for.
    if (e.messageRole === "user") {
      const content = (e.raw as { message: { content: unknown } }).message.content;
      const rawText =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((b) => (b as { type?: string }).type === "text")
                .map((b) => (b as { text: string }).text)
                .filter((t) => t !== "")
                .join("\n")
            : "";
      if (rawText === "") {
        if (e.text !== null) throw new Error(`line ${e.lineNo}: expected null, got ${JSON.stringify(e.text)}`);
      } else if (e.text !== rawText) {
        throw new Error(`line ${e.lineNo}: text does not match raw`);
      }
      checked += 1;
    }
  }
}

console.log(`sessions=${files.slice(0, 12).length} warnings=${warnings} user rows cross-checked against raw: ${checked}`);
console.log("kind".padEnd(30) + "rows".padStart(6) + "withText".padStart(10));
for (const [k, v] of [...kinds.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(k.padEnd(30) + String(v.n).padStart(6) + String(v.text).padStart(10));
}
