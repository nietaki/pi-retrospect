// Read every genuine session in the live store with `readSessionEntries`.
// Run: node --experimental-strip-types scratch/entries-store.mts
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { readSessionEntries } from "../src/session-entries.ts";

const sessionsRoot = join(getAgentDir(), "sessions");
const paths: string[] = [];
for (const dir of await readdir(sessionsRoot, { withFileTypes: true })) {
  if (!dir.isDirectory() || !/^--.*--$/.test(dir.name)) continue;
  const project = join(sessionsRoot, dir.name);
  for (const file of await readdir(project, { withFileTypes: true })) {
    if (file.isFile() && file.name.endsWith(".jsonl")) paths.push(join(project, file.name));
  }
  const children = join(project, "subagent-artifacts");
  void children;
}

let ok = 0;
let threw = 0;
let totalEntries = 0;
let totalWarnings = 0;
const codes = new Map<string, number>();
const start = Date.now();

for (const p of paths) {
  try {
    const out = await readSessionEntries({ sessionPath: p }, { sessionsRoot });
    ok++;
    totalEntries += out.entries.length;
    totalWarnings += out.warnings.length;
    for (const w of out.warnings) codes.set(w.code, (codes.get(w.code) ?? 0) + 1);
  } catch (error) {
    threw++;
    console.log(`threw: ${(error as Error).message.slice(0, 80)}`);
  }
}

console.log(`files=${paths.length} read=${ok} threw=${threw} entries=${totalEntries} warnings=${totalWarnings} codes=${[...codes].map(([k, v]) => `${k}=${v}`).join(" ") || "none"} ms=${Date.now() - start}`);

console.log(`files=${paths.length} ok=${ok} threw=${threw} entries=${totalEntries} warnings=${totalWarnings} codes=${JSON.stringify([...codes])} ms=${Date.now() - start}`);
