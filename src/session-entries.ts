/**
 * Read the entries of one Pi session file, addressed by physical line number.
 *
 * Line 1 must be a session header and is never returned. Every later line is parsed on its own,
 * so a malformed line costs a warning and does not shift the numbering of the lines after it.
 * The whole parsed line is returned as `raw`, which is why an unknown entry type, an unknown
 * message role, or a field added by a newer Pi survives into the result unchanged.
 *
 * The file is read directly and never through Pi's `SessionManager.open()`, which can migrate or
 * append to it. Nothing is written, and nothing is migrated in memory either: `migrateSessionEntries`
 * regenerates version 1 entry ids on every call, which would present an unstable id as a durable
 * reference. A version 1 file therefore returns its entries with `id` and `parentId` null **even when
 * the file stores them** — Pi would replace those bytes on the next open — plus one file-level
 * `legacy_version` warning, and `lineNo` stays the only address that resolves twice. The stored
 * values remain visible in `raw`.
 *
 * Contract: docs/tool-api.md
 */

import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import type { JsonObject } from "@earendil-works/pi-ai";

import { isRealTimestamp } from "./session-metadata.ts";
import type {
  SessionEntriesOutput,
  SessionEntriesParams,
  SessionEntriesWarning,
  SessionFileEntry,
} from "./schemas.ts";

export interface SessionEntriesOptions {
  /** Sessions root, normally `join(getAgentDir(), "sessions")`. Injectable for tests. */
  sessionsRoot: string;
  /** Checked before opening the file and again while mapping lines. */
  signal?: AbortSignal;
}

/** Session format versions before this one carry no `id`/`parentId` on their entries. */
const ADDRESSED_ENTRY_VERSION = 2;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("readSessionEntries was aborted");
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Is `path` inside `container`? Equal paths are not inside: a session file is not the root. */
function within(container: string, path: string): boolean {
  return path.startsWith(`${container}${sep}`);
}

/**
 * Turn `sessionPath` into a real path that is guaranteed to sit under the sessions root.
 *
 * Containment is decided by `realpath` on both sides, so a symlink planted inside the root and
 * pointing out of it resolves to its target and fails: the restriction follows the bytes, not the
 * spelling. A path that cannot be resolved is still reported by where it claims to be — outside the
 * root as a containment failure, inside it as a read failure — because the realpath of a missing
 * file says nothing about which of the two the caller got wrong.
 */
async function resolveSessionPath(sessionPath: unknown, sessionsRoot: string): Promise<string> {
  if (typeof sessionPath !== "string" || sessionPath === "") {
    throw new TypeError("sessionPath must be a non-empty string");
  }

  if (!isAbsolute(sessionPath)) {
    throw new Error(`sessionPath must be an absolute path: ${sessionPath}`);
  }

  const escape = () => new Error(`sessionPath is not under the sessions root: ${sessionPath}`);

  let root: string;
  try {
    root = await realpath(sessionsRoot);
  } catch (error) {
    throw new Error(`sessions root is not readable: ${describeError(error)}`);
  }

  let file: string;
  try {
    file = await realpath(sessionPath);
  } catch (error) {
    // Unresolvable: the spelling still says whether this is a confinement problem or a missing file.
    if (!within(root, resolve(sessionPath))) throw escape();
    throw new Error(`could not read session file: ${describeError(error)}`);
  }

  if (!within(root, file)) throw escape();

  return file;
}

type HeaderInfo = { ok: true; version: number } | { ok: false; reason: string };

/**
 * Validate line 1 as a session header and read the version that decides entry addressing.
 *
 * Only the fields this operation depends on are checked. `list_sessions` additionally requires a
 * non-empty `id` and `cwd` because it returns them; here an old or partial header must not hide
 * entries that are perfectly readable.
 */
function inspectHeaderLine(line: string): HeaderInfo {
  if (line.trim() === "") {
    return { ok: false, reason: "first line is empty" };
  }

  let header: unknown;
  try {
    header = JSON.parse(line);
  } catch (error) {
    return { ok: false, reason: `first line is not valid JSON: ${describeError(error)}` };
  }

  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    return { ok: false, reason: "first line is not a JSON object" };
  }

  const record = header as Record<string, unknown>;

  if (record.type !== "session") {
    return { ok: false, reason: `first line is not a session header (type: ${String(record.type)})` };
  }

  if (record.version === undefined) {
    return { ok: true, version: 1 };
  }

  if (typeof record.version !== "number" || !Number.isInteger(record.version) || record.version < 1) {
    return { ok: false, reason: `session header version is not a positive integer: ${String(record.version)}` };
  }

  return { ok: true, version: record.version };
}

/** The header is line 1; a trailing newline produces no final line. */
function splitLines(content: string): string[] {
  const lines = content.split("\n");

  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  return lines.map((line) => line.replace(/\r$/, ""));
}

function messageRoleOf(entry: Record<string, unknown>): string | null {
  if (entry.type !== "message") return null;

  const message = entry.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;

  const role = (message as Record<string, unknown>).role;

  return typeof role === "string" && role !== "" ? role : null;
}

/**
 * Map one parsed line to a row, or say why it is not an entry.
 *
 * `addressable` is whether the file's own `id`/`parentId` can be trusted as a handle. It comes from
 * the header version, not from the line: `migrateV1ToV2` assigns `entry.id = generateId(ids)`
 * unconditionally, so a version 1 file replaces **every** id — including one it already stores — the
 * next time Pi opens it. A version 1 line therefore reports null ids even when `raw` shows values,
 * because the field promises a re-resolvable citation and those bytes do not survive a migration.
 * Absent ids in a v2+ file are also simply null rather than a rejected line: they cannot be fixed by
 * inventing one, and the row is still readable and addressable by `lineNo`.
 *
 * `type` and `timestamp` are required, because a row without them cannot be described or ordered.
 */
function toEntry(
  lineNo: number,
  parsed: unknown,
  addressable: boolean,
): SessionFileEntry | { reason: string } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { reason: "line is not a JSON object" };
  }

  const fields = parsed as Record<string, unknown>;

  if (typeof fields.type !== "string" || fields.type === "") {
    return { reason: "entry has no type" };
  }

  // A header row is not an entry, wherever it appears: line 1 is the only place one belongs, and
  // Pi writes no others, so a second one is either a grafted file or a corrupt line. Either way it
  // describes the file rather than a turn in it, and returning it as an entry would put a `type:
  // "session"` row in the middle of a transcript.
  if (fields.type === "session") {
    return { reason: `a session header belongs on line 1, not line ${lineNo}` };
  }

  if (typeof fields.timestamp !== "string" || !isRealTimestamp(fields.timestamp)) {
    return { reason: "entry has no valid ISO 8601 timestamp" };
  }

  return {
    lineNo,
    id: addressable && typeof fields.id === "string" && fields.id !== "" ? fields.id : null,
    parentId:
      addressable && typeof fields.parentId === "string" && fields.parentId !== "" ? fields.parentId : null,
    timestamp: fields.timestamp,
    type: fields.type,
    messageRole: messageRoleOf(fields),
    // Safe by construction: `parsed` came out of `JSON.parse`, so it is JSON.
    raw: parsed as JsonObject,
  };
}

/**
 * Read every entry of one session file under `options.sessionsRoot`.
 *
 * `entries` are in physical file order, which is write order rather than timestamp order and keeps
 * every branch of a session tree — abandoned branches included — visible. A line that cannot become
 * an entry is skipped with a warning naming its code, so `warnings` describes exactly what is
 * missing from `entries`.
 *
 * Throws when `sessionPath` is not an absolute path inside the sessions root, when the file cannot
 * be read, and when line 1 is not a session header: those mean the caller did not name a readable
 * Pi session, which no amount of returned entries would fix.
 */
export async function readSessionEntries(
  params: SessionEntriesParams,
  options: SessionEntriesOptions,
): Promise<SessionEntriesOutput> {
  throwIfAborted(options.signal);

  const path = await resolveSessionPath(params.sessionPath, options.sessionsRoot);

  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`could not read session file: ${describeError(error)}`);
  }

  throwIfAborted(options.signal);

  const lines = splitLines(content.replace(/^\uFEFF/, ""));
  // `splitLines` always yields at least one line — an empty file is one empty line — so line 1
  // exists to be inspected, and the header check reports an empty file as "first line is empty".
  const header = inspectHeaderLine(lines[0]);

  if (!header.ok) {
    throw new Error(`not a Pi session file: ${header.reason}`);
  }

  const warnings: SessionEntriesWarning[] = [];
  const addressable = header.version >= ADDRESSED_ENTRY_VERSION;

  if (!addressable) {
    warnings.push({
      lineNo: null,
      code: "legacy_version",
      reason: `session version ${header.version}: entry ids are not durable, so id and parentId are null`,
    });
  }

  const entries: SessionFileEntry[] = [];

  // Line 1 is the header and never a row, so physical numbering resumes at line 2.
  for (const [offset, line] of lines.slice(1).entries()) {
    throwIfAborted(options.signal);
    const lineNo = offset + 2;

    if (line.trim() === "") {
      warnings.push({ lineNo, code: "invalid_json", reason: "line is blank" });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      warnings.push({
        lineNo,
        code: "invalid_json",
        reason: `line is not valid JSON: ${describeError(error)}`,
      });
      continue;
    }

    const entry = toEntry(lineNo, parsed, addressable);

    if ("reason" in entry) {
      warnings.push({ lineNo, code: "invalid_entry", reason: entry.reason });
      continue;
    }

    entries.push(entry);
  }

  return { entries, warnings };
}
