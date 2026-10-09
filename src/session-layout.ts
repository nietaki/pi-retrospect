/**
 * The shape of Pi's session store, in path arithmetic.
 *
 * Two operations read that store and must agree about what it holds: discovery reports the sessions
 * under a root, and a direct read has to know which session a requested transcript belongs to before
 * anything is opened. Duplicating the layout would let those two drift — one would report a session
 * the other could not place — so the convention lives here, once, and neither operation re-declares it.
 *
 * Nothing here touches the filesystem, and nothing here decides who may read what: a policy question
 * is answered by `project-access.ts` from the cwd a validated header reports.
 *
 * Contract: docs/tool-api.md, "Restricting session access"
 */

import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** Pi encodes a cwd into `--<slug>--`; anything else at that level is not a project. */
export const PROJECT_DIRECTORY = /^--.*--$/;

/** Top-level sessions are `<stem>.jsonl`, written by Pi under the name of their start time and id. */
export const SESSION_EXTENSION = ".jsonl";

/** Extension-written name of a subagent transcript. */
export const SUBAGENT_FILE_NAME = "session.jsonl";

/** `dir/file.jsonl` -> `dir/file`, the directory that holds this session's subagent trees. */
export function containerOf(path: string): string {
  return join(dirname(path), basename(path, SESSION_EXTENSION));
}

/**
 * The top-level session whose directory tree holds `file`, or nothing when no discoverable one does.
 *
 * A top-level session sits at `<root>/<project>/<stem>.jsonl`, and every transcript delegated from it
 * lives under the `<stem>` directory beside it, at whatever depth a launch chain reached. So the first
 * segment below the project directory names the top-level session a transcript belongs to, whether
 * the request is that session or a run nested ten directories inside it — and it stays the top-level
 * ancestor for a grandchild, which is the point: the question is which project owns the tree, not
 * which launcher is nearest.
 *
 * A file at the root itself has no project directory, and a directory Pi did not name from a cwd holds
 * no session tree, so neither yields a parent. `list_sessions` reports nothing from either shape, and
 * this says the same thing.
 *
 * `file` arrives already resolved, so a symlink inside the root is placed by the project its target
 * really sits in.
 */
export function topLevelSessionOf(file: string, root: string): string | undefined {
  const segments = relative(root, file).split(sep);
  const project = segments[0];
  const first = segments[1];

  if (project === undefined || first === undefined || !PROJECT_DIRECTORY.test(project)) {
    return undefined;
  }

  // The request is the top-level session when it is a session file directly in the project; any other
  // shape names a container, and its session is the same name with the suffix back on.
  const stem = first.endsWith(SESSION_EXTENSION) ? first : `${first}${SESSION_EXTENSION}`;

  return resolve(root, project, stem);
}
