/**
 * Regenerate the committed synthetic fixtures under test/fixtures/sessions/.
 *
 * Run: node test/fixtures/generate.mjs
 *
 * The tree reproduces Pi's real layout — `--<slug>--` project directories, parent
 * `<stem>.jsonl` files, `<stem>/<launch-uuid>/run-<n>/session.jsonl` subagent transcripts —
 * plus one deliberately broken file per warning branch. Headers are hand-written; no real
 * session data lives here. See docs/tool-api.md (Testing policy).
 */

import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("./sessions/", import.meta.url).pathname;

const uuid = (n) => `00000000-0000-4000-8000-00000000${String(n).padStart(4, "0")}`;

function header(fields) {
  return JSON.stringify({ type: "session", version: 3, ...fields });
}

/** Header whose serialized line is exactly `bytes` long, to test the read bound. */
function headerSized(fields, bytes) {
  const base = header({ ...fields, pad: "" });
  const padLength = bytes - Buffer.byteLength(base);
  if (padLength < 0) throw new Error(`cannot pad header down to ${bytes} bytes`);
  return header({ ...fields, pad: "x".repeat(padLength) });
}

const STEM_3 = "2026-01-02T09-00-00-000Z_00000000-0000-4000-8000-000000000003";

const SESSIONS = [
  // ---- project alpha -------------------------------------------------------------
  { path: "--fixture-alpha--/2026-01-01T10-00-00-000Z_00000000-0000-4000-8000-000000000001.jsonl",
    line: header({ id: uuid(1), timestamp: "2026-01-01T10:00:00.000Z", cwd: "/repo/alpha" }) },

  // Same timestamp as the alpha session above, different path: exercises the tie-break.
  { path: "--fixture-beta--/2026-01-01T10-00-00-000Z_00000000-0000-4000-8000-000000000002.jsonl",
    line: header({ id: uuid(2), timestamp: "2026-01-01T10:00:00.000Z", cwd: "/repo/beta" }) },

  // Forked session (parentSession copied verbatim) that owns the subagent tree below.
  { path: `--fixture-alpha--/${STEM_3}.jsonl`,
    line: header({
      id: uuid(3),
      timestamp: "2026-01-02T09:00:00.000Z",
      cwd: "/repo/alpha",
      parentSession: "/elsewhere/2025-12-31T00-00-00-000Z_00000000-0000-4000-8000-000000000099.jsonl",
    }) },

  // Children of session 003: two launches, one of them resumed (run-0 + run-1 = two rows).
  { path: `--fixture-alpha--/${STEM_3}/launch-aaaa/run-0/session.jsonl`,
    line: header({ id: uuid(30), timestamp: "2026-01-02T09:05:00.000Z", cwd: "/repo/alpha" }) },
  { path: `--fixture-alpha--/${STEM_3}/launch-bbbb/run-0/session.jsonl`,
    line: header({ id: uuid(31), timestamp: "2026-01-02T09:10:00.000Z", cwd: "/repo/alpha" }) },
  { path: `--fixture-alpha--/${STEM_3}/launch-bbbb/run-1/session.jsonl`,
    line: header({ id: uuid(32), timestamp: "2026-01-02T09:20:00.000Z", cwd: "/repo/alpha" }) },

  // Grandchild of launch-aaaa, under the container derived for a child named
  // `session.jsonl`: exercises the deepest-container grouping.
  { path: `--fixture-alpha--/${STEM_3}/launch-aaaa/run-0/session/launch-cccc/run-0/session.jsonl`,
    line: header({ id: uuid(33), timestamp: "2026-01-02T09:30:00.000Z", cwd: "/repo/alpha" }) },

  // Broken child: skipped, warned, and absent from its parent's list.
  { path: `--fixture-alpha--/${STEM_3}/launch-dddd/run-0/session.jsonl`,
    line: header({ id: uuid(34), timestamp: "not-a-date", cwd: "/repo/alpha" }) },

  // A file inside a subagent directory that is not named session.jsonl: never a child.
  { path: `--fixture-alpha--/${STEM_3}/launch-aaaa/run-0/artifacts.jsonl`,
    line: header({ id: uuid(90), timestamp: "2026-01-02T09:40:00.000Z", cwd: "/repo/alpha" }) },

  // Artifacts dump: copies of child transcripts, never sessions in their own right.
  { path: "--fixture-alpha--/subagent-artifacts/deadbeef_retro-scout_transcript.jsonl",
    line: header({ id: uuid(91), timestamp: "2026-01-02T09:45:00.000Z", cwd: "/repo/alpha" }) },

  // Newest file name holding the oldest timestamp: proves ordering is not readdir order.
  { path: "--fixture-alpha--/2026-01-05T08-00-00-000Z_00000000-0000-4000-8000-000000000004.jsonl",
    line: header({ id: uuid(4), timestamp: "2025-12-25T08:00:00.000Z", cwd: "/repo/alpha" }) },

  // Header exactly at the 4096-byte read bound: accepted.
  { path: "--fixture-alpha--/2026-01-06T08-00-00-000Z_00000000-0000-4000-8000-000000000005.jsonl",
    line: headerSized({ id: uuid(5), timestamp: "2026-01-06T08:00:00.000Z", cwd: "/repo/alpha" }, 4096) },

  // Header one byte past the bound: skipped with a warning.
  { path: "--fixture-alpha--/2026-01-06T09-00-00-000Z_00000000-0000-4000-8000-000000000006.jsonl",
    line: headerSized({ id: uuid(6), timestamp: "2026-01-06T09:00:00.000Z", cwd: "/repo/alpha" }, 4097) },

  // One broken file per warning branch.
  { path: "--fixture-alpha--/bad-zero-byte.jsonl", line: "", noNewline: true },
  { path: "--fixture-alpha--/bad-empty-line.jsonl", line: "" },
  { path: "--fixture-alpha--/bad-nonjson.jsonl", line: "{ this is not json" },
  { path: "--fixture-alpha--/bad-array.jsonl", line: "[1,2,3]" },
  { path: "--fixture-alpha--/bad-wrong-type.jsonl",
    line: header({ id: uuid(7), timestamp: "2026-01-07T08:00:00.000Z", cwd: "/repo/alpha" })
      .replace('"type":"session"', '"type":"message"') },
  { path: "--fixture-alpha--/bad-missing-id.jsonl",
    line: header({ timestamp: "2026-01-07T08:00:00.000Z", cwd: "/repo/alpha" }) },
  { path: "--fixture-alpha--/bad-empty-cwd.jsonl",
    line: header({ id: uuid(8), timestamp: "2026-01-07T08:00:00.000Z", cwd: "" }) },
  { path: "--fixture-alpha--/bad-timestamp.jsonl",
    line: header({ id: uuid(9), timestamp: "yesterday", cwd: "/repo/alpha" }) },
  // Impossible, not malformed: the shape is a clean ISO 8601 date-time, and there is no instant
  // for it, because the parser refuses second 60. `2026-02-30T08:00:00.000Z` would not serve as a
  // fixture for this branch — `Date.parse` rolls that over to March 2, and the session-entry path
  // accepts any rollover it can read (see `src/timestamps.ts`).
  { path: "--fixture-alpha--/bad-impossible-timestamp.jsonl",
    line: header({ id: uuid(10), timestamp: "2026-01-05T09:00:60Z", cwd: "/repo/alpha" }) },
  { path: "--fixture-alpha--/bad-parent-session.jsonl",
    line: header({ id: uuid(11), timestamp: "2026-01-07T09:00:00.000Z", cwd: "/repo/alpha", parentSession: 42 }) },

  // ---- project beta --------------------------------------------------------------
  // Header with no terminating newline at end of file: still a valid session.
  { path: "--fixture-beta--/2026-01-03T08-00-00-000Z_00000000-0000-4000-8000-000000000012.jsonl",
    line: header({ id: uuid(12), timestamp: "2026-01-03T08:00:00.000Z", cwd: "/repo/beta" }),
    noNewline: true },

  { path: "--fixture-beta--/2026-01-04T08-00-00-000Z_00000000-0000-4000-8000-000000000013.jsonl",
    line: header({ id: uuid(13), timestamp: "2026-01-04T08:00:00.000Z", cwd: "/repo/beta" }) },

  // A stem directory with no matching parent file: never visited, so neither row nor warning.
  { path: "--fixture-beta--/2026-01-09T08-00-00-000Z_00000000-0000-4000-8000-000000000094/launch-eeee/run-0/session.jsonl",
    line: header({ id: uuid(94), timestamp: "2026-01-09T08:00:00.000Z", cwd: "/repo/beta" }) },

  // ---- things the walk must ignore ----------------------------------------------
  // A .jsonl file at the sessions root: not inside a project directory.
  { path: "stray-at-root.jsonl",
    line: header({ id: uuid(92), timestamp: "2026-01-08T08:00:00.000Z", cwd: "/repo/stray" }) },

  // A valid session inside a non-slug directory: ignored by the project-directory rule.
  { path: "permission-forwarding/ignored.jsonl",
    line: header({ id: uuid(93), timestamp: "2026-01-08T09:00:00.000Z", cwd: "/repo/ignored" }) },

  // Not a .jsonl extension.
  { path: "--fixture-beta--/notes.txt", line: "not a session file" },
];

/** Symlinks must never be followed; some environments refuse to make them. */
const LINKS = [
  { target: "--fixture-alpha--", path: "--fixture-link--" },
  { target: "2026-01-01T10-00-00-000Z_00000000-0000-4000-8000-000000000001.jsonl",
    path: "--fixture-alpha--/linked-session.jsonl" },
];

async function main() {
  await rm(ROOT, { recursive: true, force: true });

  for (const file of SESSIONS) {
    const target = join(ROOT, file.path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, file.noNewline ? file.line : `${file.line}\n`);
  }

  for (const link of LINKS) {
    const target = join(ROOT, link.path);
    await mkdir(join(target, ".."), { recursive: true });
    try {
      await symlink(link.target, target);
    } catch (error) {
      console.warn(`skipped symlink ${link.path}: ${error.message}`);
    }
  }

  console.log(`wrote ${SESSIONS.length} fixture files and ${LINKS.length} symlinks under ${ROOT}`);
}

await main();
