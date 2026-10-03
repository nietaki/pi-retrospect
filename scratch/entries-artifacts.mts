// Confirm every non-session .jsonl under the root is refused by the header check.
// Run: node --experimental-strip-types scratch/entries-artifacts.mts
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { readSessionEntries } from "../src/session-entries.ts";

const sessionsRoot = join(getAgentDir(), "sessions");
const paths: string[] = [];

async function walk(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await walk(p);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(p);
  }
}
await walk(sessionsRoot);

let refused = 0;
let parsed = 0;
for (const p of paths) {
  try {
    const out = await readSessionEntries({ sessionPath: p }, { sessionsRoot });
    parsed++;
    if (out.warnings.length) console.log(`warn ${p.slice(-60)}: ${JSON.stringify(out.warnings.slice(0, 2))}`);
  } catch (error) {
    refused++;
    const m = (error as Error).message;
    if (!/not a Pi session file/.test(m)) console.log(`OTHER ERROR ${p.slice(-50)}: ${m.slice(0, 60)}`);
  }
}
console.log(`jsonlUnderRoot=${paths.length} parsed=${parsed} refusedByHeader=${refused}`);
