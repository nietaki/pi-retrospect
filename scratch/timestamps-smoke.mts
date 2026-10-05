// Smoke: the new day-boundary semantics against the genuine sessions store.
// Run: node --experimental-strip-types scratch/timestamps-smoke.mts
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import { listSessions } from "../src/list-sessions.ts";
import { parseTimeBoundary } from "../src/timestamps.ts";

const sessionsRoot = join(getAgentDir(), "sessions");

const all = await listSessions({}, { sessionsRoot });
const dates = all.sessions.map((session) => session.timestamp.slice(0, 10));
const today = new Date().toISOString().slice(0, 10);

console.log(`rows: ${all.sessions.length}, warnings: ${all.warnings.length}`);
console.log(`distinct dates in store: ${[...new Set(dates)].sort().join(" ")}`);

for (const zone of ["UTC", "Asia/Tokyo", "America/New_York"]) {
  process.env.TZ = zone;
  const bound = parseTimeBoundary(today)!;
  const kept = await listSessions({ startTimestamp: today, endTimestamp: today }, { sessionsRoot });
  console.log(
    `${zone.padEnd(17)} day=[${new Date(bound.startMs).toISOString()} .. ${new Date(bound.endMs).toISOString()}) ` +
      `sessions today: ${kept.sessions.length}`,
  );
}

// Naive bound must equal the same zone's explicit bound; a rolled date must equal its landing date.
process.env.TZ = "UTC";
const naive = await listSessions({ startTimestamp: `${today}T00:00:00` }, { sessionsRoot });
const explicit = await listSessions({ startTimestamp: `${today}T00:00:00Z` }, { sessionsRoot });
console.log("naive === explicit under UTC:", naive.sessions.length === explicit.sessions.length);

try {
  await listSessions({ startTimestamp: "1/2/2026" }, { sessionsRoot });
  console.log("legacy shape: ACCEPTED (unexpected)");
} catch (error) {
  console.log(`legacy shape throws: ${(error as Error).message.slice(0, 78)}`);
}
