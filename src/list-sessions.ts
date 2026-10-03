/**
 * Walk the Pi sessions directory and return session metadata, with subagent transcripts
 * nested under the session that launched them.
 *
 * Parameter handling — filtering, ordering, limiting — lives in `query.ts`; this module only
 * discovers and validates rows, then applies the prepared query to the top level.
 *
 * Contract: docs/tool-api.md
 */

import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { applyQuery, buildQuery } from "./query.ts";
import { readSessionHeader } from "./session-metadata.ts";
import type {
  ListSessionsOutput,
  ListSessionsParams,
  ListSessionsWarning,
  SessionMetadata,
} from "./schemas.ts";

/** Pi encodes a cwd into `--<slug>--`; anything else at that level is not a project. */
const PROJECT_DIRECTORY = /^--.*--$/;

/** Extension-written name of a subagent transcript. Top-level sessions are `<stem>.jsonl`. */
const SUBAGENT_FILE_NAME = "session.jsonl";

const SESSION_EXTENSION = ".jsonl";

export interface ListSessionsOptions {
  /**
   * Sessions root, normally `join(getAgentDir(), "sessions")`. Injectable for tests.
   * Resolved to an absolute path, because every returned `path` must be absolute.
   */
  sessionsRoot: string;
  /** Aborted between filesystem operations. */
  signal?: AbortSignal;
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

/** `dir/file.jsonl` -> `dir/file`, the directory that holds this session's subagent trees. */
function containerOf(path: string): string {
  return join(dirname(path), basename(path, SESSION_EXTENSION));
}

function containsPath(container: string, path: string): boolean {
  return path.startsWith(`${container}/`);
}

/** Timestamp ascending, oldest first; ties broken by path so the order is total. */
function compareSessions(a: SessionMetadata, b: SessionMetadata): number {
  const left = Date.parse(a.timestamp);
  const right = Date.parse(b.timestamp);

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
 * List discoverable sessions under `options.sessionsRoot`, after the query built from
 * `params` is applied to the top level.
 *
 * Without parameters the result is every session, ordered by `timestamp` ascending — oldest
 * first, so a parent's subagent children appear in launch order. Files that cannot be read or
 * whose header is invalid are skipped and reported in `warnings` instead; `warnings` always
 * describe the whole scan, even for files a filter would have excluded.
 */
export async function listSessions(
  params: ListSessionsParams,
  options: ListSessionsOptions,
): Promise<ListSessionsOutput> {
  // Reject bad parameters before touching the filesystem.
  const query = buildQuery(params);

  const sessionsRoot = resolve(options.sessionsRoot);
  const { signal } = options;
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

    for (const file of projectEntries) {
      throwIfAborted(signal);
      if (!file.isFile() || !file.name.endsWith(SESSION_EXTENSION)) continue;

      const path = join(projectDir, file.name);
      const header = await readSessionHeader(path);
      if (!header.ok) {
        warnings.push({ path, reason: header.reason });
        continue;
      }

      const transcripts = await collectSubagentTranscripts(containerOf(path), warnings, signal);
      sessions.push(toMetadata({ path, ...header.values }, nestTranscripts(containerOf(path), transcripts, signal)));
    }
  }

  warnings.sort(compareWarnings);

  return { sessions: applyQuery(sessions, query), warnings };
}
