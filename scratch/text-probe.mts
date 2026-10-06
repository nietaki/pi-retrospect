/**
 * Numbers quoted in docs/tool-api.md for the `text` projection: coverage per role, how many
 * assistant rows carry thinking but no visible text, and whether persisted `system` content is ever
 * non-empty.
 *
 * Read-only. Run: node --experimental-strip-types scratch/text-probe.mts
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { readSessionEntries } from "../src/session-entries.ts";

const root = join(process.env.HOME ?? "", ".pi", "agent", "sessions");

const dirs = (await readdir(root, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && d.name.startsWith("--"))
  .map((d) => join(root, d.name));

const files: string[] = [];
for (const dir of dirs) {
  for (const name of await readdir(dir)) if (name.endsWith(".jsonl")) files.push(join(dir, name));
}

const seen = new Set<string>();
const rows = new Map<string, { n: number; hit: number; len: number }>();
let assistant = 0;
let assistantThinkingNoText = 0;
let systemNonEmpty = 0;
let systemRows = 0;
let maxLen = 0;
let total = 0;
let totalHit = 0;
let totalLen = 0;

const bump = (key: string, hit: boolean, len: number) => {
  const s = rows.get(key) ?? { n: 0, hit: 0, len: 0 };
  s.n += 1;
  if (hit) {
    s.hit += 1;
    s.len += len;
  }
  rows.set(key, s);
};

for (const sessionPath of files) {
  if (seen.has(sessionPath)) continue;
  seen.add(sessionPath);

  const { entries } = await readSessionEntries({ sessionPath }, { sessionsRoot: root });

  for (const e of entries) {
    const has = typeof e.text === "string";
    const key = `${e.type}/${e.messageRole ?? "-"}`;
    bump(key, has, has ? e.text.length : 0);
    total += 1;

    if (has) {
      totalHit += 1;
      totalLen += e.text.length;
      maxLen = Math.max(maxLen, e.text.length);
    }

    const content = ((e.raw as Record<string, unknown>).message as Record<string, unknown> | undefined)?.content;

    if (e.messageRole === "assistant") {
      assistant += 1;
      const blocks = Array.isArray(content) ? content : [];
      const hasThinking = blocks.some((b) => (b as Record<string, unknown>)?.type === "thinking");
      if (hasThinking && !has) assistantThinkingNoText += 1;
    }

    if (e.messageRole === "system") {
      systemRows += 1;
      if (typeof content === "string" && content !== "") systemNonEmpty += 1;
    }
  }
}

console.log(`files=${seen.size} rows=${total} withText=${totalHit} (${((totalHit / total) * 100).toFixed(0)}%) mean=${Math.round(totalLen / Math.max(totalHit, 1))} max=${maxLen}`);
console.log(`assistant rows=${assistant} thinking-without-visible-text=${assistantThinkingNoText}`);
console.log(`system rows=${systemRows} non-empty persisted content=${systemNonEmpty}`);
console.log("\nkey                          rows   withText  meanLen");
for (const [k, s] of [...rows.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(k.padEnd(28) + String(s.n).padStart(6) + String(s.hit).padStart(9) + String(s.hit ? Math.round(s.len / s.hit) : 0).padStart(10));
}
