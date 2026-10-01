import { migrateSessionEntries, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

const H = { type: "session", id: "01a0e97b", timestamp: "2026-09-28T19:25:51.116Z", cwd: "/tmp/x" };
const cases = {
  "already v3": { ...H, version: 3 },
  "v2": { ...H, version: 2 },
  "v1": { ...H, version: 1 },
  "no version field (=v1)": { ...H },
};
for (const [label, header] of Object.entries(cases)) {
  const before = JSON.stringify(header);
  const ret = migrateSessionEntries([header]);
  console.log(label.padEnd(24), "| ret:", ret, "|", before, "->", JSON.stringify(header));
}

// The dangerous part: header-only migration on a REAL v1 session body.
const v1File = [
  { type: "session", version: 1, id: "s1", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/tmp" },
  { type: "message", message: { role: "user", content: "hi", timestamp: 1 } },
  { type: "compaction", summary: "s", firstKeptEntryIndex: 1, tokensBefore: 10, timestamp: "2024-01-01T00:01:00.000Z" },
  { type: "message", message: { role: "hookMessage", content: "injected", timestamp: 2 } },
];
const whole = structuredClone(v1File);
migrateSessionEntries(whole);
console.log("\nfull-array migration of a v1 file:");
console.log("  header version ->", whole[0].version);
console.log("  entry 2        ->", JSON.stringify(whole[1]).slice(0, 110));
console.log("  entry 3        ->", JSON.stringify(whole[2]).slice(0, 130));
console.log("  entry 4 role   ->", whole[3].message.role);

const headerOnly = structuredClone(v1File);
migrateSessionEntries([headerOnly[0]]);
console.log("\nheader-only migration of the SAME file:");
console.log("  header version ->", headerOnly[0].version, "(claims", CURRENT_SESSION_VERSION + ")");
console.log("  entry 2        ->", JSON.stringify(headerOnly[1]).slice(0, 110));
console.log("  entry 3        ->", JSON.stringify(headerOnly[2]).slice(0, 130));
console.log("  entry 4 role   ->", headerOnly[3].message.role);
