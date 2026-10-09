/**
 * The `piRetrospect.allowedProjects` policy as direct transcript access applies it.
 *
 * `session_entries` takes a path, and a caller that knows a path should not thereby have access to
 * it. So a restricted policy is authorized from the containing top-level session: the transcript is
 * resolved under the sessions root as always, the top-level session that owns its directory is read
 * for a header, and that header's cwd is what the policy answers. A nested run inherits its parent's
 * permission, including when its own cwd names a project that is not allowed, and a path the policy
 * cannot place inside an allowed project is refused before its file is opened.
 *
 * An unrestricted policy changes nothing, including paths that discovery would never report: the
 * bound is the operator's configuration, and a caller who never configured one keeps the read that
 * confinement alone allowed.
 *
 * Contract: docs/tool-api.md, "Restricting session access"
 */

import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { readSessionEntries } from "../src/session-entries.ts";
import { parseProjectAccessPolicy, UNRESTRICTED_POLICY } from "../src/project-access.ts";
import type { ProjectAccessPolicy } from "../src/project-access.ts";

const TEMP = new URL("tmp/session-entries-policy/", import.meta.url).pathname;
const ROOT = join(TEMP, "root");

/** The policy one `allowedProjects` list describes, read the way a tool reads it. */
const policyFor = (...allowedProjects: string[]): ProjectAccessPolicy =>
  parseProjectAccessPolicy({ piRetrospect: { allowedProjects } });

const header = (cwd: string, fields: Record<string, unknown> = {}): string =>
  `${JSON.stringify({
    type: "session",
    version: 3,
    id: "sess-1",
    timestamp: "2026-01-01T10:00:00.000Z",
    cwd,
    ...fields,
  })}\n`;

const entry = (text = "hello"): string =>
  `${JSON.stringify({
    id: "aaaa1111",
    parentId: null,
    timestamp: "2026-01-01T10:00:01.000Z",
    type: "message",
    message: { role: "user", content: text },
  })}\n`;

/**
 * Write `<root>/--bar--/s.jsonl` as the allowed top-level session, with the delegated run
 * `<root>/--bar--/s/launch-1/run-0/session.jsonl` under it.
 *
 * The child's own cwd is deliberately a project no allowlist names, because that is the case the
 * inheritance rule decides: the parent's permission is what reaches a nested transcript.
 */
async function writeBarTree(childCwd = "/repo/secret-child"): Promise<{ top: string; child: string }> {
  const top = join(ROOT, "--bar--", "s.jsonl");
  const child = join(ROOT, "--bar--", "s", "launch-1", "run-0", "session.jsonl");

  await mkdir(dirname(top), { recursive: true });
  await writeFile(top, header("/repo/bar") + entry("from the top level"));
  await mkdir(dirname(child), { recursive: true });
  await writeFile(child, header(childCwd, { id: "sess-2" }) + entry("from the child"));

  return { top, child };
}

/** Write `<root>/--denied--/t.jsonl`, a whole project the policy will not name. */
async function writeDeniedTree(): Promise<{ top: string; child: string }> {
  const top = join(ROOT, "--denied--", "t.jsonl");
  const child = join(ROOT, "--denied--", "t", "launch-2", "run-0", "session.jsonl");

  await mkdir(dirname(top), { recursive: true });
  await writeFile(top, header("/repo/denied") + entry("secret top level"));
  await mkdir(dirname(child), { recursive: true });
  await writeFile(child, header("/repo/denied", { id: "sess-3" }) + entry("secret child"));

  return { top, child };
}

const read = (sessionPath: string, policy?: ProjectAccessPolicy) =>
  readSessionEntries({ sessionPath }, policy === undefined ? { sessionsRoot: ROOT } : { sessionsRoot: ROOT, policy });

/** The message of a rejection, or `""` when the read succeeded. */
const rejectionOf = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(() => "").catch((error: unknown) => (error as Error).message);

describe("readSessionEntries project access", () => {
  beforeEach(async () => {
    await rm(TEMP, { recursive: true, force: true });
  });

  it("changes nothing for an omitted or wildcard policy, not even for a path discovery would never report", async () => {
    const { top, child } = await writeBarTree();
    await writeDeniedTree();
    // A file at the root itself: `list_sessions` never walks there, and an unconfigured caller can
    // still read it, because the bound was never set.
    const stray = join(ROOT, "stray.jsonl");
    await mkdir(ROOT, { recursive: true });
    await writeFile(stray, header("/repo/stray") + entry());

    for (const policy of [undefined, UNRESTRICTED_POLICY, policyFor("*"), policyFor("bar", "*")]) {
      expect((await read(top, policy)).entries.map((row) => row.lineNo)).toStrictEqual([2]);
      expect((await read(child, policy)).entries.map((row) => row.lineNo)).toStrictEqual([2]);

      const strayRead = await read(stray, policy);
      expect(strayRead.entries).toHaveLength(1);
      expect(strayRead.warnings).toStrictEqual([]);
    }
  });

  it("refuses a denied project's own session, and says nothing about it", async () => {
    const { top } = await writeDeniedTree();
    await writeBarTree();

    const message = await rejectionOf(read(top, policyFor("bar")));

    expect(message).toContain("piRetrospect.allowedProjects");
    // The path was the caller's own argument, but the reason stays the reason: no project, no file.
    expect(message).not.toContain("denied");
    expect(message).not.toContain(ROOT);
  });

  it("refuses a transcript nested under a denied project", async () => {
    const { child } = await writeDeniedTree();
    await writeBarTree();

    expect(await rejectionOf(read(child, policyFor("denied-sibling")))).toContain("allowedProjects");
  });

  it("admits a nested transcript of an allowed project whose own cwd is not allowed", async () => {
    const { child } = await writeBarTree("/repo/not-on-the-list");
    await writeDeniedTree();

    const result = await read(child, policyFor("bar"));

    expect(result.entries.map((row) => row.text)).toStrictEqual(["from the child"]);
    expect(result.warnings).toStrictEqual([]);
  });

  it("refuses a guessed path that no header places in an allowed project", async () => {
    await writeBarTree();
    await writeDeniedTree();

    // A file the caller invented, sitting directly under the root: confinement accepts it, discovery
    // would never have reported it, and there is no top-level parent to authorize it.
    const guessed = join(ROOT, "guessed.jsonl");
    await mkdir(ROOT, { recursive: true });
    await writeFile(guessed, header("/repo/bar") + entry("guessed"));

    expect(await rejectionOf(read(guessed, policyFor("bar")))).toContain("allowedProjects");

    // A directory under the project that is nobody's container: `--bar--/s.jsonl` would make `s` one,
    // and `tools` matches no session file, so nothing here inherits from an allowed top level.
    const unparented = join(ROOT, "--bar--", "tools", "other.jsonl");
    await mkdir(dirname(unparented), { recursive: true });
    await writeFile(unparented, header("/repo/bar") + entry());

    expect(await rejectionOf(read(unparented, policyFor("bar")))).toContain("allowedProjects");
  });

  it("admits any transcript inside an allowed top level's own container", async () => {
    // The tree under `<stem>/` belongs to that session, whatever a run left inside it, so
    // authorization is the parent's and the file keeps its own reading rules.
    await writeBarTree();
    const extra = join(ROOT, "--bar--", "s", "launch-1", "run-0", "artifacts.jsonl");
    await mkdir(dirname(extra), { recursive: true });
    await writeFile(extra, header("/repo/bar", { id: "sess-9" }) + entry("artifact row"));

    expect((await read(extra, policyFor("bar"))).entries.map((row) => row.text)).toStrictEqual([
      "artifact row",
    ]);

    // Unrestricted, the same path needs no parent at all.
    expect((await read(extra)).entries).toHaveLength(1);
  });

  it("refuses a readable session the other tool could never have discovered", async () => {
    // A directory Pi did not name from a cwd holds no project's sessions, so a restricted policy does
    // not read what lives in it, even though the file's own header is perfectly valid. `list_sessions`
    // does not report this path either: the two tools answer to one bound.
    await writeBarTree();
    const offLayout = join(ROOT, "not-a-project", "ignored.jsonl");
    await mkdir(dirname(offLayout), { recursive: true });
    await writeFile(offLayout, header("/repo/bar") + entry("off layout"));

    expect(await rejectionOf(read(offLayout, policyFor("bar")))).toContain("allowedProjects");
    expect((await read(offLayout)).entries).toHaveLength(1);
  });

  it("refuses a transcript whose top-level header cannot be read, because nothing establishes its project", async () => {
    await writeBarTree();

    // A file with perfectly readable entries and a header `list_sessions` would never have accepted:
    // no `cwd`, so no project to check, and the restricted read fails closed.
    const headless = join(ROOT, "--bar--", "h.jsonl");
    await mkdir(dirname(headless), { recursive: true });
    await writeFile(headless, header("/repo/bar", { id: undefined }).replace('"id":"sess-1",', "") + entry());

    expect(await rejectionOf(read(headless, policyFor("bar")))).toContain("allowedProjects");
    // Unrestricted, the same file is still readable: this is the bound talking, not the format.
    expect((await read(headless)).entries).toHaveLength(1);
  });

  it("keeps root confinement ahead of the policy, and the policy ahead of the read", async () => {
    await writeBarTree();
    await writeDeniedTree();
    const outside = join(TEMP, "outside.jsonl");
    await writeFile(outside, header("/repo/bar") + entry());

    // A path that is not under the root at all stays the confinement failure it has always been.
    expect(await rejectionOf(read(outside, policyFor("bar")))).toMatch(/not under the sessions root/);

    // A usable filter mistake still outranks both.
    expect(
      await rejectionOf(
        readSessionEntries(
          { sessionPath: join(ROOT, "--denied--", "t.jsonl"), limit: 0 },
          { sessionsRoot: ROOT, policy: policyFor("bar") },
        ),
      ),
    ).toMatch(/limit/);
  });

  it("reports the same entries and warnings for an allowed transcript as an unbound read does", async () => {
    const { top } = await writeBarTree();

    // A malformed middle line: authorization must not change what the file itself reports.
    await writeFile(top, header("/repo/bar") + entry() + "not json\n" + entry("last"));

    const bound = await read(top, policyFor("bar"));
    const unbound = await read(top);

    expect(bound).toStrictEqual(unbound);
    expect(bound.entries.map((row) => row.text)).toStrictEqual(["hello", "last"]);
    expect(bound.warnings.map((warning) => warning.code)).toStrictEqual(["invalid_json"]);
  });

  it("follows a symlink inside the root to the project its bytes really live in", async () => {
    const { top } = await writeBarTree();
    const { child } = await writeDeniedTree();

    const link = join(ROOT, "--bar--", "link.jsonl");
    await symlink(child, link);

    // The link sits in an allowed directory and names itself as one, but it resolves into the denied
    // project, and the policy follows the bytes, not the spelling.
    expect(await rejectionOf(read(link, policyFor("bar")))).toContain("allowedProjects");

    // The reverse stays readable: a link into an allowed project is that project's transcript.
    const inward = join(ROOT, "--denied--", "inward.jsonl");
    await symlink(top, inward);
    expect((await read(inward, policyFor("bar"))).entries.map((row) => row.text)).toStrictEqual([
      "from the top level",
    ]);
  });

  it("refuses everything when the allowlist is explicitly empty", async () => {
    const { top, child } = await writeBarTree();

    expect(await rejectionOf(read(top, policyFor()))).toContain("allowedProjects");
    expect(await rejectionOf(read(child, policyFor()))).toContain("allowedProjects");
  });
});
