/**
 * Live-store spot-check for the `session_entries` filter parameters. Not part of the suite and
 * never asserted on: run with
 * `node --experimental-strip-types scratch/entries-filters-check.mts [path]`.
 *
 * Reads the newest session in this project's own store, then proves each parameter selects the
 * rows the contract says it does, and that a filtered read keeps whole-file `warnings`.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { readSessionEntries } from "../src/session-entries.ts";

const sessionsRoot = join(getAgentDir(), "sessions");
const projectRoot = join(sessionsRoot, "--Users-nietaki-repos-pi-retrospect--");

const newest = async (): Promise<string> => {
  const names = (await readdir(projectRoot)).filter((name) => name.endsWith(".jsonl"));
  const timed = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await stat(join(projectRoot, name))).mtimeMs })),
  );
  timed.sort((a, b) => b.mtime - a.mtime);
  if (!timed[0]) throw new Error(`no session .jsonl under ${projectRoot}`);
  return join(projectRoot, timed[0].name);
};

const path = process.argv[2] ?? (await newest());
const base = { sessionsRoot };
const lines = (rows: Array<{ lineNo: number }>): number[] => rows.map((row) => row.lineNo);

const all = await readSessionEntries({ sessionPath: path }, base);
console.log(`file: ${path.split("/").pop()}`);
console.log(`entries: ${all.entries.length}, warnings: ${all.warnings.length}`);
console.log(
  `largest raw: ${(Math.max(...all.entries.map((e) => JSON.stringify(e.raw).length)) / 1024).toFixed(1)} KB`,
);

const range = await readSessionEntries({ sessionPath: path, startLineNo: 40, endLineNo: 60 }, base);
console.log(
  `startLineNo 40 endLineNo 60 -> ${lines(range.entries).join(",")} (all inside: ${range.entries.every(
    (e) => e.lineNo >= 40 && e.lineNo <= 60,
  )})`,
);

const roles = await readSessionEntries({ sessionPath: path, messageRoles: ["user"], limit: 3 }, base);
console.log(`messageRoles [user] limit 3 -> ${lines(roles.entries).join(",")}`);
console.log(`  warnings still whole-file: ${roles.warnings.length} (unfiltered ${all.warnings.length})`);

const ids = all.entries.slice(2, 5).map((entry) => entry.id as string);
const byIds = await readSessionEntries({ sessionPath: path, ids }, base);
console.log(`ids ${ids.join(",")} -> ${byIds.entries.map((e) => e.id).join(",")}`);

const parents = [all.entries.find((e) => e.parentId !== null)?.parentId as string];
const byParent = await readSessionEntries({ sessionPath: path, parentIds: parents }, base);
console.log(`parentIds ${parents.join(",")} -> ${lines(byParent.entries).join(",")}`);

const types = await readSessionEntries({ sessionPath: path, types: ["model_change"] }, base);
console.log(`types [model_change] -> ${types.entries.map((e) => e.type).join(",") || "(none)"}`);

const window = await readSessionEntries(
  { sessionPath: path, startTimestamp: "2026-01-01", endTimestamp: "2026-12-31" },
  base,
);
console.log(`2026 window -> ${window.entries.length} entries, file order kept: ${
  lines(window.entries).every((line, index, all2) => index === 0 || line > all2[index - 1])
}`);

// Pages by physical bound: no overlap, no gap, and the union is the whole transcript.
const pages: number[][] = [];
let from = 2;
for (;;) {
  const page = await readSessionEntries({ sessionPath: path, startLineNo: from, limit: 50 }, base);
  if (page.entries.length === 0) break;
  pages.push(lines(page.entries));
  from = page.entries[page.entries.length - 1]!.lineNo + 1;
  if (page.entries.length < 50) break;
}
const paged = pages.flat();
console.log(`paged in ${pages.length} pages: ${paged.length} rows, matches unfiltered: ${
  JSON.stringify(paged) === JSON.stringify(lines(all.entries))
}`);

for (const bad of [
  { startLineNo: 6, endLineNo: 3 },
  { startTimestamp: "yesterday" },
  { startTimestamp: "2026-05-01", endTimestamp: "2026-02-01" },
  { limit: 0 },
  { startLineNo: 2.5 },
]) {
  try {
    await readSessionEntries({ sessionPath: path, ...bad }, base);
    console.log(`REJECTED? ${JSON.stringify(bad)} did not throw`);
  } catch (error) {
    console.log(`${JSON.stringify(bad)} -> ${(error as Error).message.slice(0, 90)}`);
  }
}
