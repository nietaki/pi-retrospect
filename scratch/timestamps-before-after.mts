// Before/after against the genuine store: portable queries must agree exactly.
//
// Prerequisite, then run:
//   mkdir -p .tmp-old && git archive HEAD src | tar -x -C .tmp-old
//   node --experimental-strip-types scratch/timestamps-before-after.mts
//   rm -rf .tmp-old
//
// `../.tmp-old/src` is a snapshot of HEAD, kept out of `src/` so the suite never collects it.
// Run: node --experimental-strip-types scratch/timestamps-before-after.mts
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import { listSessions as before } from "../.tmp-old/src/list-sessions.ts";
import { listSessions as after } from "../src/list-sessions.ts";

const sessionsRoot = join(getAgentDir(), "sessions");
process.env.TZ = "UTC";

const cases: Array<Record<string, string>> = [
  { startTimestamp: "2026-09-30", endTimestamp: "2026-10-01" },
  { endTimestamp: "2026-09-30T23:59:59Z" },
  { startTimestamp: "2026-09-01", endTimestamp: "2026-09-30T12:00:00+02:00" },
];

for (const params of cases) {
  const oldRun = await before(params, { sessionsRoot });
  const newRun = await after(params, { sessionsRoot });
  const pathsOf = (rows: Array<{ path: string }>): string[] => rows.map((row) => row.path);
  const same = JSON.stringify(pathsOf(oldRun.sessions)) === JSON.stringify(pathsOf(newRun.sessions));

  console.log(`${JSON.stringify(params)} -> old: ${oldRun.sessions.length}, new: ${newRun.sessions.length}, identical order: ${same}`);
}

try {
  await before({ startTimestamp: "2026-09-30T12:00:00" }, { sessionsRoot });
  console.log("old naive bound: accepted");
} catch (error) {
  console.log(`old naive bound: throws -> ${(error as Error).message.slice(0, 64)}`);
}

const naive = await after({ startTimestamp: "2026-09-30T12:00:00" }, { sessionsRoot });
console.log(`new naive bound: accepted, rows: ${naive.sessions.length}`);
