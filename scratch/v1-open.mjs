import { readFileSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
const p = "/tmp/v1session.jsonl";
writeFileSync(p, [
  '{"type":"session","version":1,"id":"s1","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/tmp"}',
  '{"type":"message","message":{"role":"user","content":"hi","timestamp":1}}',
  '{"type":"compaction","summary":"s","firstKeptEntryIndex":1,"tokensBefore":10,"timestamp":"2024-01-01T00:01:00.000Z"}',
  '{"type":"message","message":{"role":"hookMessage","content":"injected","timestamp":2}}',
].join("\n") + "\n");
console.log("--- on disk BEFORE open() ---");
console.log(readFileSync(p, "utf8").trim());
SessionManager.open(p);
console.log("\n--- on disk AFTER a bare open() (no append, no write call) ---");
console.log(readFileSync(p, "utf8").trim());
