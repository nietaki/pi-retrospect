/**
 * Covers `src/project-access.ts`, the one reading of the `piRetrospect.allowedProjects` setting that
 * both retrospective tools share.
 *
 * A policy is a pure interpretation of an `unknown` settings snapshot: no filesystem, no Pi. Three
 * shapes come out of it — unrestricted (omitted setting, or a list holding the exact `"*"`),
 * deny-all (an explicit empty list), and a named allowlist of project basenames — and a value that
 * is none of those is a policy error that fails closed rather than an accidentally wide-open
 * allowlist.
 *
 * Matching is lexical and case-sensitive on the final non-empty segment of a cwd, which is what
 * makes a committed configuration portable between machines: `"bar"` admits `/repo/bar` and the
 * sibling worktree `/repo/bar-issue-7`, and refuses `/repo/barista`.
 *
 * Contract: docs/tool-api.md, "Restricting session access"
 */

import { describe, expect, it, vi } from "vitest";

import {
  isProjectAllowed,
  parseProjectAccessPolicy,
  ProjectAccessError,
  readProjectAccessPolicy,
} from "../src/project-access.ts";

/** The shapes a policy can have, spelled once so each test names only what it expects. */
const UNRESTRICTED = { mode: "unrestricted" };
const DENY_ALL = { mode: "deny-all" };
const allowlist = (...projects: string[]) => ({ mode: "allowlist", projects });

/** The one sentence every policy error uses, so a refusal cannot describe what it refused. */
const INVALID = "piRetrospect.allowedProjects is not a valid project allowlist";

const settingsFor = (allowedProjects: unknown) => ({ piRetrospect: { allowedProjects } });

describe("parseProjectAccessPolicy: the setting's shape", () => {
  it("reads an omitted allowedProjects as unrestricted", () => {
    expect(parseProjectAccessPolicy({ piRetrospect: { markSteeringMessages: true } })).toStrictEqual(
      UNRESTRICTED,
    );
    expect(parseProjectAccessPolicy({ piRetrospect: {} })).toStrictEqual(UNRESTRICTED);
    expect(parseProjectAccessPolicy({})).toStrictEqual(UNRESTRICTED);
  });

  it("reads a key that is present but holds nothing as omitted", () => {
    const namespace: Record<string, unknown> = { markSteeringMessages: true };
    namespace.allowedProjects = undefined;

    expect(parseProjectAccessPolicy({ piRetrospect: namespace })).toStrictEqual(UNRESTRICTED);
  });

  it("reads an explicit empty list as deny-all, not as an omitted setting", () => {
    expect(parseProjectAccessPolicy(settingsFor([]))).toStrictEqual(DENY_ALL);
  });

  it("reads a list holding the exact wildcard as unrestricted, alone or beside named projects", () => {
    expect(parseProjectAccessPolicy(settingsFor(["*"]))).toStrictEqual(UNRESTRICTED);
    expect(parseProjectAccessPolicy(settingsFor(["bar", "*"]))).toStrictEqual(UNRESTRICTED);
  });

  it("keeps a named list as an allowlist of the configured basenames, in configured order", () => {
    expect(parseProjectAccessPolicy(settingsFor(["bar", "baz"]))).toStrictEqual(
      allowlist("bar", "baz"),
    );
  });

  it("does not read a wildcard out of a basename that merely contains a star", () => {
    expect(parseProjectAccessPolicy(settingsFor(["ba*R"]))).toStrictEqual(allowlist("ba*R"));
  });
});

/**
 * A setting that cannot be read never becomes the absence of a setting.
 *
 * `list_sessions` and `session_entries` ask for the policy on every call, so a snapshot that is not
 * an object means the effective settings could not be read: the safe reading is a refusal, not the
 * unrestricted access an unreadable snapshot might have hidden. The error is one fixed sentence,
 * because it goes back to whoever asked, and the configured value, a cwd, or a session path in it
 * would say more than an allowlist should.
 */
describe("parseProjectAccessPolicy: a value that is not a policy fails closed", () => {
  it("refuses a settings snapshot that is not an object", () => {
    for (const settings of [undefined, null, "bar", 42, [{ piRetrospect: {} }]]) {
      expect(() => parseProjectAccessPolicy(settings), String(settings)).toThrow(ProjectAccessError);
    }
  });

  it("refuses a namespace that is not an object", () => {
    for (const piRetrospect of ["bar", 42, null, ["*"]]) {
      expect(() => parseProjectAccessPolicy({ piRetrospect }), String(piRetrospect)).toThrow(
        ProjectAccessError,
      );
    }
  });

  it("refuses a value that is not a list", () => {
    for (const allowedProjects of ["bar", 42, true, {}, null]) {
      expect(() => parseProjectAccessPolicy(settingsFor(allowedProjects)), String(allowedProjects)).toThrow(
        ProjectAccessError,
      );
    }
  });

  it("refuses a list item that is not a string", () => {
    for (const item of [42, null, true, {}, ["bar"]]) {
      expect(() => parseProjectAccessPolicy(settingsFor(["bar", item]))).toThrow(ProjectAccessError);
    }
  });

  it("refuses an item that cannot name a project: empty, a path, or a traversal", () => {
    for (const item of ["", "bar/", "/bar", "a/b", "a\\b", ".", "..", "../escape"]) {
      expect(() => parseProjectAccessPolicy(settingsFor([item])), item).toThrow(ProjectAccessError);
    }
  });

  it("says only which setting is wrong, never what it would have named", () => {
    const messages = [
      () => parseProjectAccessPolicy("bar"),
      () => parseProjectAccessPolicy(settingsFor("bar")),
      () => parseProjectAccessPolicy(settingsFor([42])),
      () => parseProjectAccessPolicy(settingsFor(["/repo/secret"])),
    ].map((run) => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectAccessError);
        return (error as Error).message;
      }

      throw new Error("expected a policy error");
    });

    expect(messages).toStrictEqual([INVALID, INVALID, INVALID, INVALID]);
  });
});

/**
 * Which project a session cwd belongs to, and whether the policy admits it.
 *
 * A basename is compared to a basename, so no parent directory is ever consulted: that is what lets
 * one committed list work on every machine, and the price is that `/other/bar` is the same project
 * as `/repo/bar` as far as this rule can tell.
 */
describe("isProjectAllowed: the project a cwd names", () => {
  it("admits every project when unrestricted and none when the list is empty", () => {
    const unrestricted = parseProjectAccessPolicy(settingsFor(["*"]));
    const denyAll = parseProjectAccessPolicy(settingsFor([]));

    expect(isProjectAllowed(unrestricted, "/repo/anything")).toBe(true);
    expect(isProjectAllowed(unrestricted, "")).toBe(true);
    expect(isProjectAllowed(denyAll, "/repo/anything")).toBe(false);
    expect(isProjectAllowed(denyAll, "")).toBe(false);
  });

  it("admits the configured basename, wherever it sits, and its sibling worktree names", () => {
    const policy = parseProjectAccessPolicy(settingsFor(["bar"]));

    expect(isProjectAllowed(policy, "/repo/bar")).toBe(true);
    expect(isProjectAllowed(policy, "/elsewhere/bar")).toBe(true);
    expect(isProjectAllowed(policy, "/repo/bar-issue-7")).toBe(true);
  });

  it("refuses a near match, another project, and a cwd that names no project", () => {
    const policy = parseProjectAccessPolicy(settingsFor(["bar"]));

    expect(isProjectAllowed(policy, "/repo/barista")).toBe(false);
    expect(isProjectAllowed(policy, "/repo/foo-bar")).toBe(false);
    expect(isProjectAllowed(policy, "/repo/ba")).toBe(false);
    // A cwd with no final segment cannot be classified, so an allowlist cannot admit it.
    expect(isProjectAllowed(policy, "/")).toBe(false);
    expect(isProjectAllowed(policy, "")).toBe(false);
  });

  it("takes the final non-empty segment, so a trailing separator changes nothing", () => {
    const policy = parseProjectAccessPolicy(settingsFor(["bar"]));

    expect(isProjectAllowed(policy, "/repo/bar/")).toBe(true);
    expect(isProjectAllowed(policy, "/repo/bar//")).toBe(true);
    // Only the tail is decoration: a segment after it is the project, whatever it is named.
    expect(isProjectAllowed(policy, "/repo/bar//baz")).toBe(false);
    expect(isProjectAllowed(policy, "/repo/bar//baz-work")).toBe(false);
  });

  it("matches case-sensitively in both directions", () => {
    expect(isProjectAllowed(parseProjectAccessPolicy(settingsFor(["bar"])), "/repo/Bar")).toBe(false);
    expect(isProjectAllowed(parseProjectAccessPolicy(settingsFor(["Bar"])), "/repo/bar")).toBe(false);
  });

  it("admits a cwd belonging to any configured project", () => {
    const policy = parseProjectAccessPolicy(settingsFor(["bar", "baz"]));

    expect(isProjectAllowed(policy, "/x/bar")).toBe(true);
    expect(isProjectAllowed(policy, "/x/baz-1")).toBe(true);
    expect(isProjectAllowed(policy, "/x/qux")).toBe(false);
  });
});

/**
 * The boundary the tools stand in: a settings reader, not a settings object.
 *
 * Pi's effective settings are unreadable while an extension factory is still loading, and `/reload`
 * replaces them afterwards, so a tool holds the reader and asks it per call. Two consequences are
 * worth pinning: a reader that fails is a policy failure rather than a free pass, and nothing here
 * caches a snapshot.
 */
describe("readProjectAccessPolicy: reading the settings per call", () => {
  it("is unrestricted when the caller supplied no settings reader", () => {
    // The core operations and the factory tests that never mention settings live in a world without
    // a policy, which is the behavior from before the setting existed.
    expect(readProjectAccessPolicy()).toStrictEqual(UNRESTRICTED);
    expect(readProjectAccessPolicy(undefined)).toStrictEqual(UNRESTRICTED);
  });

  it("parses whatever the reader returns", () => {
    expect(readProjectAccessPolicy(() => settingsFor(["bar"]))).toStrictEqual(allowlist("bar"));
  });

  it("asks the reader again on every call, so a reloaded setting takes effect", () => {
    const snapshots = [settingsFor(["bar"]), settingsFor(["bar", "baz"]), settingsFor(["*"])];
    const readSettings = vi.fn(() => snapshots.shift());

    expect(readProjectAccessPolicy(readSettings)).toStrictEqual(allowlist("bar"));
    expect(readProjectAccessPolicy(readSettings)).toStrictEqual(allowlist("bar", "baz"));
    expect(readProjectAccessPolicy(readSettings)).toStrictEqual(UNRESTRICTED);
    expect(readSettings).toHaveBeenCalledTimes(3);
  });

  it("treats a reader that fails as a policy failure", () => {
    const readSettings = vi.fn(() => {
      throw new Error("/repo/private/settings.json is unreadable");
    });

    expect(() => readProjectAccessPolicy(readSettings)).toThrow(ProjectAccessError);
    // The reader's own message named a path, and a failing call hands its message to the caller.
    expect(() => readProjectAccessPolicy(readSettings)).not.toThrow("unreadable");
  });
});
