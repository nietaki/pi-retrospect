// Measure what `readSessionEntries` returns for the largest sessions in the live store.
// Run: node --experimental-strip-types scratch/entries-size.mts
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readdir, stat } from "node:fs/promises";
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
}

const sized = await Promise.all(paths.map(async (p) => ({ p, size: (await stat(p)).size })));
sized.sort((a, b) => b.size - a.size);

for (const { p } of sized.slice(0, 3)) {
  const out = await readSessionEntries({ sessionPath: p }, { sessionsRoot });
  const rawBytes = out.entries.reduce((s, e) => s + JSON.stringify(e.raw).length, 0);
  console.log(`${p.split("/").slice(-2).join("/")}  fileKB=${Math.round(p && sized.find((x) => x.p === p)!.size / 1024)} entries=${out.entries.length} warnings=${out.warnings.length} rawKB=${Math.round(rawBytes / 1024)}`);
}
