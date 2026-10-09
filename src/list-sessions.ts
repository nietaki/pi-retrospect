/**
 * Walk the Pi sessions directory and return session metadata, with subagent transcripts
 * nested under the session that launched them.
 *
 * Parameter handling — filtering, ordering, limiting — lives in `query.ts`; this module only
 * discovers and validates rows, keeps to the projects `options.policy` allows, drops the current
 * session when the host named one, then applies the prepared query to the top level.
 *
 * Contract: docs/tool-api.md
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { applyQuery, buildQuery, excludeSessionTree, instantOf } from "./query.ts";
import { isProjectAllowed, UNRESTRICTED_POLICY } from "./project-access.ts";
import type { ProjectAccessPolicy } from "./project-access.ts";
import { containerOf, PROJECT_DIRECTORY, SESSION_EXTENSION, SUBAGENT_FILE_NAME } from "./session-layout.ts";
import { readSessionHeader } from "./session-metadata.ts";
import type {
  ListSessionsOutput,
  ListSessionsParams,
  ListSessionsWarning,
  SessionMetadata,
} from "./schemas.ts";

export interface ListSessionsOptions {
  /**
   * Sessions root, normally `join(getAgentDir(), "sessions")`. Injectable for tests.
   * Resolved to an absolute path, because every returned `path` must be absolute.
   */
  sessionsRoot: string;
  /** Aborted between filesystem operations. */
  signal?: AbortSignal;
  /**
   * Absolute path of the session the caller is running in, from `ctx.sessionManager.getSessionFile()`.
   *
   * The host supplies it and `includeCurrentSession` can ask for that session back, so a model can
   * never point the rule at a session it merely names. Omit it, or pass the `undefined` Pi returns
   * for an ephemeral session, and nothing is excluded. A path this scan never produced excludes
   * nothing: the rule is the file, not its id.
   */
  currentSessionPath?: string;
  /**
   * Which session projects the scan may report, read from the caller's effective settings.
   *
   * This is the extension-enforced upper bound, applied while discovering, before a denied session's
   * children are collected or a denied directory's unreadable files are warned about. Omit it — the
   * listing used as a library — and every project the scan finds is reported, which is the behavior
   * from before `piRetrospect.allowedProjects` existed.
   *
   * A caller's `cwds` and `cwdMatch` still choose which of the permitted projects to return; they
   * cannot reach past this bound.
   */
  policy?: ProjectAccessPolicy;
}

type ParsedSession = {
  path: string;
  id: string;
  timestamp: string;
  cwd: string;
  parentSessionPath?: string;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("listSessions was aborted");
  }
}

function containsPath(container: string, path: string): boolean {
  return path.startsWith(`${container}/`);
}

/** Timestamp ascending, oldest first; ties broken by path so the order is total. */
function compareSessions(a: SessionMetadata, b: SessionMetadata): number {
  const left = instantOf(a);
  const right = instantOf(b);

  // Paths are unique among rows, so a path tie-break never has to answer "equal".
  if (left !== right) return left - right;
  return a.path < b.path ? -1 : 1;
}

/** Warnings are sorted by path so a run is reproducible despite readdir order. */
function compareWarnings(a: ListSessionsWarning, b: ListSessionsWarning): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
}

function toMetadata(session: ParsedSession, children: SessionMetadata[]): SessionMetadata {
  const metadata: SessionMetadata = {
    id: session.id,
    path: session.path,
    timestamp: session.timestamp,
    cwd: session.cwd,
    subagentSessions: children,
  };

  if (session.parentSessionPath !== undefined) {
    metadata.parentSessionPath = session.parentSessionPath;
  }

  return metadata;
}

/**
 * Read headers of every `session.jsonl` found at any depth under `directory`.
 *
 * Unreadable files and invalid headers are skipped and warned about, and never returned.
 * Symlinks are not followed, so the walk stays inside the supplied root.
 */
async function collectSubagentTranscripts(
  directory: string,
  warnings: ListSessionsWarning[],
  signal?: AbortSignal,
): Promise<ParsedSession[]> {
  throwIfAborted(signal);

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    // No subagent directory is the normal case, not a failure worth warning about.
    if ((error as { code?: string }).code === "ENOENT") return [];
    warnings.push({
      path: directory,
      reason: `subagent directory not readable: ${(error as Error).message}`,
    });
    return [];
  }

  const found: ParsedSession[] = [];

  for (const entry of entries) {
    throwIfAborted(signal);
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await collectSubagentTranscripts(path, warnings, signal)));
      continue;
    }

    if (!entry.isFile() || entry.name !== SUBAGENT_FILE_NAME) continue;

    const header = await readSessionHeader(path);
    if (!header.ok) {
      warnings.push({ path, reason: header.reason });
      continue;
    }

    found.push({ path, ...header.values });
  }

  return found;
}

/**
 * Attach transcripts to the session whose container directory is their deepest ancestor,
 * so a transcript is never reported under two parents.
 *
 * A session's container is `dirname(path)/basename-without-.jsonl`. When a nested launch
 * does not sit under its parent's container, it stays attached to the nearest session that
 * does — the documented fallback for the unverified grandchild convention.
 */
function nestTranscripts(
  rootContainer: string,
  transcripts: ParsedSession[],
  signal?: AbortSignal,
): SessionMetadata[] {
  const parentOf = new Map<string, string | null>();

  for (const transcript of transcripts) {
    throwIfAborted(signal);

    let best: { key: string; depth: number } | null = { key: rootContainer, depth: rootContainer.length };

    for (const candidate of transcripts) {
      if (candidate.path === transcript.path) continue;

      const container = containerOf(candidate.path);
      if (!containsPath(container, transcript.path)) continue;
      if (container.length > best.depth) best = { key: candidate.path, depth: container.length };
    }

    parentOf.set(transcript.path, best.key === rootContainer ? null : best.key);
  }

  const build = (key: string | null): SessionMetadata[] => {
    const children = transcripts
      .filter((transcript) => parentOf.get(transcript.path) === key)
      .map((transcript) => toMetadata(transcript, build(transcript.path)))
      .sort(compareSessions);

    return children;
  };

  return build(null);
}

/**
 * List discoverable sessions under `options.sessionsRoot`, after the query described by
 * `params` is applied to the top level.
 *
 * Without parameters the result is every session, ordered by `timestamp` ascending — oldest
 * first, so a parent's subagent children appear in launch order. Files that cannot be read or
 * whose header is invalid are skipped and reported in `warnings` instead; `warnings` always
 * describe the whole scan, even for files a filter would have excluded.
 *
 * When `options.currentSessionPath` names the caller's own session it is excluded first, unless
 * `params.includeCurrentSession` asks for it: the whole-scan rule behind `warnings` is exactly why
 * dropping a row is a step of its own rather than part of the walk.
 *
 * `options.policy` is the upper bound on which projects any of this may describe. It is asked of each
 * validated top-level header, before that session's container is walked, so a denied project
 * contributes no row, no nested transcript, and no warning; the caller's own filters then select
 * within what the policy permitted.
 */
export async function listSessions(
  params: ListSessionsParams,
  options: ListSessionsOptions,
): Promise<ListSessionsOutput> {
  // Reject bad parameters before touching the filesystem.
  const query = buildQuery(params);

  const sessionsRoot = resolve(options.sessionsRoot);
  const { signal } = options;
  const policy = options.policy ?? UNRESTRICTED_POLICY;
  const warnings: ListSessionsWarning[] = [];
  const sessions: SessionMetadata[] = [];

  throwIfAborted(signal);

  let rootEntries;
  try {
    rootEntries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    // A fresh install has no history yet: empty plus one warning, not an error.
    return {
      sessions: [],
      warnings: [
        {
          path: sessionsRoot,
          reason: `sessions root not readable: ${(error as Error).message}`,
        },
      ],
    };
  }

  for (const entry of rootEntries) {
    throwIfAborted(signal);

    // `isDirectory()` is false for symlinks, so links are never followed.
    if (!entry.isDirectory() || !PROJECT_DIRECTORY.test(entry.name)) continue;

    const projectDir = join(sessionsRoot, entry.name);

    let projectEntries;
    try {
      projectEntries = await readdir(projectDir, { withFileTypes: true });
    } catch (error) {
      warnings.push({
        path: projectDir,
        reason: `project directory not readable: ${(error as Error).message}`,
      });
      continue;
    }

    // A file with no readable header cannot name its own project, so saying whether its warning
    // belongs to a denied project is a question about the whole directory: it is answered after the
    // directory's valid headers have been asked, and a directory that holds nothing readable keeps
    // its warning, because nothing here ever established that it was denied.
    const unreadable: ListSessionsWarning[] = [];
    let admitted = 0;
    let refused = 0;

    for (const file of projectEntries) {
      throwIfAborted(signal);
      if (!file.isFile() || !file.name.endsWith(SESSION_EXTENSION)) continue;

      const path = join(projectDir, file.name);
      const header = await readSessionHeader(path);
      if (!header.ok) {
        unreadable.push({ path, reason: header.reason });
        continue;
      }

      // Denied before its container is walked: a child transcript of a session nobody may see is
      // neither a row nor a warning, and the tree under it never becomes observable metadata.
      if (!isProjectAllowed(policy, header.values.cwd)) {
        refused += 1;
        continue;
      }

      admitted += 1;
      const transcripts = await collectSubagentTranscripts(containerOf(path), warnings, signal);
      sessions.push(
        toMetadata({ path, ...header.values }, nestTranscripts(containerOf(path), transcripts, signal)),
      );
    }

    if (refused === 0 || admitted > 0) warnings.push(...unreadable);
  }

  warnings.sort(compareWarnings);

  // The current session is a fact about the host, so the scan stays a scan and the rule applies to
  // the rows it produced: before filtering, ordering, and the cap, so a dropped root leaves its place
  // to the next one rather than shortening the result by one. An unset path — no context, an
  // ephemeral session, or `includeCurrentSession: true` — excludes nothing.
  const currentPath = params.includeCurrentSession === true ? undefined : options.currentSessionPath;
  const roots = currentPath ? excludeSessionTree(sessions, currentPath) : sessions;

  return { sessions: applyQuery(roots, query), warnings };
}
