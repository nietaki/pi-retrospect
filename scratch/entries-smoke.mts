// Smoke test of `readSessionEntries` against the live session store (read-only).
// Run: node --experimental-strip-types scratch/entries-smoke.mts
//
// Not part of the suite: it reads the operator's real history, so its numbers are machine
// state, not assertions. It answers one question — does the reader survive real Pi data?

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { readSessionEntries } from "../src/session-entries.ts";

const sessionsRoot = join(getAgentDir(), "sessions");

async function firstParentSession(): Promise<string> {
  const dirs = await readdir(sessionsRoot, { withFileTypes: true });
  for (const dir of dirs) {
    if (!dir.isDirectory() || !/^--.*--$/.test(dir.name)) continue;
    const files = await readdir(join(sessionsRoot, dir.name), { withFileTypes: true });
    const file = files.find((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
    if (file) return join(sessionsRoot, dir.name, file.name);
  }
  throw new Error("no session file found");
}

const path = await firstParentSession();
const output = await readSessionEntries({ sessionPath: path }, { sessionsRoot });

const types = new Map<string, number>();
const roles = new Map<string, number>();
for (const entry of output.entries) {
  types.set(entry.type, (types.get(entry.type) ?? 0) + 1);
  if (entry.messageRole) roles.set(entry.messageRole, (roles.get(entry.messageRole) ?? 0) + 1);
}

const bytes = (await readFile(path)).byteLength;
const rawBytes = output.entries.reduce((sum, entry) => sum + JSON.stringify(entry.raw).length, 0);

console.log(`file: ${path}`);
console.log(`bytes: ${bytes}  entries: ${output.entries.length}  warnings: ${output.warnings.length}`);
console.log(`raw bytes returned: ${rawBytes}`);
console.log(`types: ${[...types].map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`roles: ${[...roles].map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`lineNos contiguous from 2: ${output.entries.every((e, i) => e.lineNo === i + 2)}`);
console.log(`ids all present: ${output.entries.every((e) => e.id !== null)}`);

// A non-session .jsonl that lives inside the root must be refused, not parsed: the
// `subagent-artifacts/*_transcript.jsonl` copies use `recordType` lines and have no header.
const projectDir = path.slice(0, path.lastIndexOf("/"));
const artifactFiles = await readdir(join(projectDir, "subagent-artifacts")).catch(() => []);
const artifact = artifactFiles.find((name) => name.endsWith("_transcript.jsonl"));
if (artifact) {
  try {
    await readSessionEntries({ sessionPath: join(projectDir, "subagent-artifacts", artifact) }, { sessionsRoot });
    console.log(`artifact ${artifact}: PARSED (bug)`);
  } catch (error) {
    console.log(`artifact ${artifact}: rejected -> ${(error as Error).message.slice(0, 70)}`);
  }
} else {
  console.log("no subagent-artifacts transcript in this project directory");
}

// Escape check: a path outside the root must throw.
try {
  await readSessionEntries({ sessionPath: "/etc/hosts" }, { sessionsRoot });
  console.log("ESCAPE: ALLOWED (bug)");
} catch (error) {
  console.log(`escape rejected: ${(error as Error).message.slice(0, 70)}`);
}
