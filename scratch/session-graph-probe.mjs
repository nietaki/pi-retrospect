// Probe: does SessionManager discover pi-subagents child sessions, and how do
// they link to their parent? Run: node --experimental-strip-types scratch/session-graph-probe.mjs
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const PARENT_ID = "01a0e979-6b32-72e2-86b5-e456fbaa42b0";
const DOTFILES = "/Users/nietaki/.homesick/repos/dotfiles";
// Mirrors getDefaultSessionDirPath(): `--<cwd with / and : replaced by ->--`
const dotfilesDir = join(
  process.env.HOME,
  ".pi/agent/sessions",
  `--${DOTFILES.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
);

// 1. What does listAll() return, and does the nested child transcript appear?
const all = await SessionManager.listAll();
const parentStemDir = readdirSync(dotfilesDir).find(
  (f) => f.startsWith("2026-09-28T19-24-03-762Z") && !f.endsWith(".jsonl"),
);
const childPath = join(dotfilesDir, parentStemDir);

console.log("listAll total sessions:", all.length);
console.log("parent in listAll:", all.some((s) => s.id === PARENT_ID));

// Every child transcript under the parent-stem directory:
const slotDirs = readdirSync(childPath);
const children = [];
for (const slot of slotDirs) {
  const slotDir = join(childPath, slot);
  if (!existsSync(slotDir)) continue;
  for (const run of readdirSync(slotDir)) {
    const file = join(slotDir, run, "session.jsonl");
    if (existsSync(file)) children.push(file);
  }
}
console.log("child transcripts on disk:", children.length);

const listedPaths = new Set(all.map((s) => s.path));
console.log("children visible to listAll:", children.filter((p) => listedPaths.has(p)).length);

// 2. SessionManager.list() for the parent cwd: same answer?
const scoped = await SessionManager.list(DOTFILES);
console.log("list(cwd) count:", scoped.length, "| children visible:", children.filter((p) => new Set(scoped.map((s) => s.path)).has(p)).length);

// 3. Can we open a child by path anyway? What does its header/SessionInfo say about parents?
const child = SessionManager.open(children[0]);
const header = child.getHeader();
console.log("child header:", JSON.stringify(header));
console.log("child entries:", child.getEntries().length, "| name:", child.getSessionName());
console.log("child cwd:", child.getCwd(), "| sessionDir:", child.getSessionDir());

// 4. Compare with a real fork (parentSession set in header) to show the difference.
const forked = all.find((s) => s.parentSessionPath);
console.log("listAll entry with parentSessionPath:", forked ? { id: forked.id, parent: forked.parentSessionPath } : "none found");

// 5. Does the child transcript mention the parent id anywhere in its entries?
const raw = child.getEntries().map((e) => JSON.stringify(e)).join("\n");
console.log("child entries mention parent id:", raw.includes(PARENT_ID));

// 6. How is a child identifiable at all? Look at its session_info entries.
const info = child.getEntries().filter((e) => e.type === "session_info");
console.log("child session_info entries:", JSON.stringify(info));
