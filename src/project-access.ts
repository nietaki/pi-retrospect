/**
 * Which session projects a caller may reach, as one shared policy.
 *
 * The `piRetrospect.allowedProjects` setting is an extension-enforced upper bound on what
 * `list_sessions` and `session_entries` can touch. It lives here, apart from both the filesystem
 * walk and Pi's settings storage, so the two tools cannot drift into different interpretations of
 * one configuration, and so a test can hand it a plain object instead of a Pi session.
 *
 * Values are project **basenames** — the final non-empty segment of a session cwd — not absolute
 * paths, which is what makes a committed configuration portable between machines. Matching is
 * lexical and case-sensitive, and it borrows the worktree convention `cwdMatch: "sibling-prefix"`
 * already uses: an allowed `bar` also covers the sibling `bar-<anything>` a linked worktree gets,
 * but never `barista`.
 *
 * Three shapes are valid, and everything else is a policy error:
 *
 * - omitted, or any list holding the exact `"*"` → unrestricted, the pre-setting behavior;
 * - an explicit empty list → deny-all;
 * - a list of basenames → only those projects.
 *
 * A malformed value fails closed. Silently ignoring an operator's typo would hand back the
 * unrestricted access the typo was meant to prevent, so the parse throws instead, and the error
 * names the setting — never a cwd, a session path, or a discovered project — because even a refusal
 * can leak what a scan found.
 *
 * Contract: docs/tool-api.md, "Restricting session access"
 */

/** One parsed `piRetrospect.allowedProjects` value, ready to authorize a project. */
export type ProjectAccessPolicy =
  | { readonly mode: "unrestricted" }
  | { readonly mode: "deny-all" }
  | { readonly mode: "allowlist"; readonly projects: readonly string[] };

/** What an installation gets when the setting says nothing, and what a tool gets without a reader. */
export const UNRESTRICTED_POLICY: ProjectAccessPolicy = { mode: "unrestricted" };

/** The settings namespace this extension owns, and the key inside it that holds the allowlist. */
const SETTINGS_NAMESPACE = "piRetrospect";
const SETTING_KEY = "allowedProjects";

/** The one list entry that means "every project", and that no basename may imitate. */
const WILDCARD = "*";

/** A settings object Pi carries arbitrary values in, so nothing here may trust its shape. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one sentence every policy failure uses.
 *
 * Naming the setting is enough to act on; naming the offending value, a cwd, or a session path
 * would tell a caller what the allowlist was hiding, and a failed call returns its message.
 */
const POLICY_ERROR_MESSAGE = "piRetrospect.allowedProjects is not a valid project allowlist";

/**
 * A configured access policy this module cannot read.
 *
 * Both tools throw this instead of guessing: treating an unusable allowlist as no allowlist would
 * turn an operator's typo into the unrestricted access the typo was meant to prevent.
 */
export class ProjectAccessError extends Error {
  constructor() {
    super(POLICY_ERROR_MESSAGE);
    this.name = "ProjectAccessError";
  }
}

/**
 * One configured list item as a project basename.
 *
 * The portable shape is a bare name, so anything that looks like a path is refused rather than
 * quietly kept as an entry that can never match: an operator who wrote `/repo/bar` meant a
 * restriction, and the wrong reading of that value is the wide-open one.
 */
function projectBasenameOf(item: unknown): string {
  if (typeof item !== "string" || item === "") throw new ProjectAccessError();
  if (item.includes("/") || item.includes("\\")) throw new ProjectAccessError();
  if (item === "." || item === "..") throw new ProjectAccessError();

  return item;
}

/** Parse the effective settings object into the policy it describes. */
export function parseProjectAccessPolicy(settings: unknown): ProjectAccessPolicy {
  if (!isPlainRecord(settings)) throw new ProjectAccessError();

  const namespace = settings[SETTINGS_NAMESPACE];

  // The namespace is absent, so nothing was configured. A snapshot that cannot be read is a
  // different thing, and it is the operator's value that has to be well formed.
  if (namespace === undefined) return UNRESTRICTED_POLICY;
  if (!isPlainRecord(namespace)) throw new ProjectAccessError();

  const configured = namespace[SETTING_KEY];
  if (configured === undefined) return UNRESTRICTED_POLICY;

  if (!Array.isArray(configured)) throw new ProjectAccessError();
  if (configured.length === 0) return { mode: "deny-all" };
  if (configured.includes(WILDCARD)) return UNRESTRICTED_POLICY;

  return { mode: "allowlist", projects: configured.map(projectBasenameOf) };
}

/**
 * The policy behind a settings reader, read now.
 *
 * A tool asks this on every call because Pi's effective settings are unreadable while an extension
 * factory is still loading, and `/reload`, a project change, or a new session replaces them
 * afterwards — so the reader is the dependency, never its result.
 *
 * With no reader at all, the caller is the core operation rather than a registered tool, and the
 * answer is the access that existed before this setting did.
 *
 * A reader that throws fails the same way a malformed value does. Its own message is dropped, not
 * chained: a failed call hands its message to whoever called it, and a settings-file error tends to
 * name the file it could not read.
 */
export function readProjectAccessPolicy(readSettings?: () => unknown): ProjectAccessPolicy {
  if (readSettings === undefined) return UNRESTRICTED_POLICY;

  let snapshot: unknown;

  try {
    snapshot = readSettings();
  } catch {
    throw new ProjectAccessError();
  }

  return parseProjectAccessPolicy(snapshot);
}

/**
 * The project a cwd belongs to: its final non-empty segment.
 *
 * Only trailing separators are removed, so `/repo/bar` and `/repo/bar/` name one project. Nothing
 * else is normalized: no `.` or `..` collapsing, no `realpath`, no case folding, because a policy
 * that read the filesystem would answer differently on two machines that hold the same committed
 * configuration.
 *
 * `""` is what a bare `/` leaves, and no allowlist can name it.
 */
function projectOf(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  const separator = trimmed.lastIndexOf("/");

  return separator === -1 ? trimmed : trimmed.slice(separator + 1);
}

/**
 * Whether `policy` admits the project `cwd` belongs to.
 *
 * An allowed basename covers the project itself and the `-`-suffixed siblings a linked worktree is
 * conventionally given — the same rule `cwdMatch: "sibling-prefix"` applies to a caller's filter —
 * and nothing else, so `barista` stays out while `bar-issue-7` is in.
 */
export function isProjectAllowed(policy: ProjectAccessPolicy, cwd: string): boolean {
  switch (policy.mode) {
    case "unrestricted":
      return true;

    case "deny-all":
      return false;

    case "allowlist": {
      const project = projectOf(cwd);
      if (project === "") return false;

      return policy.projects.some((allowed) => project === allowed || project.startsWith(`${allowed}-`));
    }
  }
}
