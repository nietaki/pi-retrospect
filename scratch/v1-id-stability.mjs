import { migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
const text = [
  '{"type":"session","version":1,"id":"s1","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/tmp"}',
  '{"type":"message","message":{"role":"user","content":"a","timestamp":1}}',
  '{"type":"message","message":{"role":"user","content":"b","timestamp":2}}',
].join("\n");
for (const run of [1, 2]) {
  const f = parseSessionEntries(text);
  migrateSessionEntries(f);
  console.log(`run ${run}:`, f.slice(1).map((e) => `${e.id}<-${e.parentId}`).join("  "));
}
