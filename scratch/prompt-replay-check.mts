/**
 * Checks the caller-side prompt replay quoted in docs/tool-api.md.
 *
 * The doc recipe folds a session's `system` rows into the prompt the model ends up with: later content
 * appends to the base, `sections` patch by name, and a `null` value removes one. This runs that fold
 * over a real store and compares it with `getCurrentSystemPrompt` from `@earendil-works/pi-ai`, which
 * is Pi's own replay (`getCurrentSystemMessage` + `getSystemMessageText`). A disagreement means the doc
 * recipe is wrong, not the projection — `systemText` itself is pinned by `pi-render-drift.mts`.
 *
 * It also checks the shape the docs claim for the sequence: the first system row that names sections
 * declares every name a later row patches, and a leading row may name none at all (a pure tool
 * loadout change, which projects `null`).
 *
 * Read-only. Run: node --experimental-strip-types scratch/prompt-replay-check.mts
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";

import { readSessionEntries } from "../src/session-entries.ts";

const root = join(homedir(), ".pi", "agent", "sessions");

const dirs = (await readdir(root, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && d.name.startsWith("--"))
  .map((d) => join(root, d.name));

const files: string[] = [];
for (const dir of dirs) {
  for (const name of await readdir(dir)) if (name.endsWith(".jsonl")) files.push(join(dir, name));
}

/** The fold exactly as docs/tool-api.md prints it. */
function replay(messages: Array<Record<string, unknown>>): string {
  const contents: string[] = [];
  const sections = new Map<string, string>();

  for (const message of messages) {
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((b) => (b as { type?: string })?.type === "text")
              .map((b) => (b as { text: string }).text)
              .join("\n")
          : "";
    if (text !== "") contents.push(text);

    const named = message.sections as Record<string, string | null> | undefined;
    for (const [name, value] of Object.entries(named ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }

  return [...contents, ...sections.values()].join("\n\n");
}

const failures: string[] = [];
const shapeNotes: string[] = [];
let sessions = 0;
let multiRow = 0;
let rows = 0;
let removals = 0;
let emptyPrompt = 0;
let foldedBytes = 0;
let leadingDeclaresAll = 0;

for (const sessionPath of files) {
  const { entries } = await readSessionEntries({ sessionPath, messageRoles: ["system"] }, { sessionsRoot: root });
  if (entries.length === 0) continue;
  sessions += 1;
  rows += entries.length;

  const messages = entries.map((e) => e.raw.message as Record<string, unknown>);
  const mine = replay(messages);
  const piSide = getCurrentSystemPrompt(
    messages.map((m) => ({ ...m, role: "system", timestamp: m.timestamp ?? 0 })) as Parameters<typeof getCurrentSystemPrompt>[0],
  );
  if (mine !== piSide) {
    failures.push(`${sessionPath.slice(root.length + 1)}: doc fold ${mine.length} B vs pi-ai ${piSide.length} B`);
  }
  if (mine === "") emptyPrompt += 1;
  foldedBytes += mine.length;
  for (const m of messages) for (const v of Object.values((m.sections ?? {}) as Record<string, unknown>)) if (v === null) removals += 1;

  if (entries.length > 1) {
    multiRow += 1;
    // The claim: the first row that names sections declares the set every later patch draws from.
    const declaring = messages.findIndex((m) => Object.keys((m.sections ?? {}) as object).length > 0);
    if (declaring < 0) {
      shapeNotes.push(`${sessionPath.slice(root.length + 1)}: no row names a section (loadout rows only)`);
    } else {
      if (declaring > 0) shapeNotes.push(`${sessionPath.slice(root.length + 1)}: ${declaring} loadout-only row(s) precede the first section row`);
      const declared = new Set(Object.keys((messages[declaring].sections ?? {}) as Record<string, unknown>));
      const patched = new Set<string>();
      for (const m of messages.slice(declaring + 1)) for (const n of Object.keys((m.sections ?? {}) as Record<string, unknown>)) patched.add(n);
      for (const n of patched)
        if (!declared.has(n))
          failures.push(`${sessionPath.slice(root.length + 1)}: a row after the declaring one introduces "${n}"`);
      if (patched.size < declared.size) leadingDeclaresAll += 1;
    }
  }
}

console.log(`sessions with system rows : ${sessions} (${multiRow} holding more than one row)`);
console.log(`system rows              : ${rows}, of which ${removals} carry a null removal marker`);
console.log(`folded prompt bytes      : total ${foldedBytes}, mean ${Math.round(foldedBytes / Math.max(sessions, 1))}`);
console.log(`sessions folding to ""   : ${emptyPrompt}`);
console.log(`sessions where the declaring row covers every later patch: ${leadingDeclaresAll}/${multiRow} multi-row`);
console.log(`\ndoc fold vs pi-ai replay: ${failures.length === 0 ? "MATCH on every session" : `${failures.length} MISMATCH(ES):`}`);
for (const f of failures.slice(0, 15)) console.log(`  ${f}`);
console.log(`shape notes: ${shapeNotes.length}`);
for (const n of shapeNotes.slice(0, 8)) console.log(`  ${n}`);
process.exit(failures.length === 0 ? 0 : 1);
