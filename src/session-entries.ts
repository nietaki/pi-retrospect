/**
 * Read the entries of one Pi session file, addressed by physical line number, narrowed by filters.
 *
 * Line 1 must be a session header and is never returned. Every later line is parsed on its own,
 * so a malformed line costs a warning and does not shift the numbering of the lines after it.
 * The whole parsed line is returned as `raw`, which is why an unknown entry type, an unknown
 * message role, or a field added by a newer Pi survives into the result unchanged.
 *
 * The optional filter parameters select rows from that full read (`entry-query.ts`): they bound the
 * result, never the scan. Every line is still parsed and every skipped line still warns, so
 * `warnings` describes the file whatever was asked for, and a dropped row costs no warning because
 * it is a row that exists rather than one that failed.
 *
 * The file is streamed line by line, not read whole, and is never opened through Pi's
 * `SessionManager.open()`, which can migrate or append to it. Nothing is written, and nothing is
 * migrated in memory either: `migrateSessionEntries` regenerates version 1 entry ids on every call,
 * which would present an unstable id as a durable reference. A version 1 file therefore returns its
 * entries with `id` and `parentId` null **even when the file stores them** — Pi would replace those
 * bytes on the next open — plus one file-level `legacy_version` warning, and `lineNo` stays the only
 * address that resolves twice. The stored values remain visible in `raw`.
 *
 * Contract: docs/tool-api.md
 */

import { open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import type { JsonObject } from "@earendil-works/pi-ai";

import { parseSessionInstant } from "./timestamps.ts";
import { buildEntryQuery } from "./entry-query.ts";
import type {
  SessionEntriesOutput,
  SessionEntriesParams,
  SessionEntriesWarning,
  SessionFileEntry,
} from "./schemas.ts";

export interface SessionEntriesOptions {
  /** Sessions root, normally `join(getAgentDir(), "sessions")`. Injectable for tests. */
  sessionsRoot: string;
  /** Checked before the file is opened, and again for every line read, so an abort stops the scan. */
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

/** A physical line of the file, with the number the caller addresses it by. */
interface SessionLine {
  lineNo: number;
  line: string;
}

/** A leading byte-order mark is decoration, not part of line 1's JSON. */
function stripBom(line: string): string {
  return line.startsWith("\uFEFF") ? line.slice(1) : line;
}

/**
 * Stream `path` line by line, numbering every line, and close the handle on the way out.
 *
 * The file goes through `FileHandle#readLines` rather than `readFile`, so a long session costs the
 * entries it yields instead of its size in memory: on a 47 MB / 12k-entry session, peak RSS fell from
 * ~246 MB to ~148 MB for ~70 ms to ~106 ms. The retained `raw` objects are what remains, which is why
 * the saving is about two copies of the file rather than the whole of it — and why a session of the
 * size Pi actually stores (1.5 MB) moves by a few MB and a millisecond or two, not by half.
 *
 * Node's readline decides where a line ends, and it counts `\n`, `\r\n`, **and a lone `\r`** as line
 * breaks. Pi writes `\n` only, so the numbering this yields is the physical `\n` numbering for every
 * file the tool is meant to read; a hand-edited file with mixed endings can number a line differently
 * than `wc -l` does, which is the price taken instead of re-implementing the splitting here. A
 * terminating line break never produces a final empty line, and a blank line does yield, so `lineNo`
 * stays aligned with the physical line across skipped rows.
 *
 * A file with no lines at all yields nothing, which is how an empty file is reported: there is no
 * line 1 to inspect, and `readSessionEntries` says so after the loop.
 */
async function* readSessionLines(path: string, signal?: AbortSignal): AsyncGenerator<SessionLine> {
  let handle: FileHandle;
  try {
    handle = await open(path);
  } catch (error) {
    throw new Error(`could not read session file: ${describeError(error)}`);
  }

  try {
    let lineNo = 0;

    for await (const raw of handle.readLines({ signal })) {
      throwIfAborted(signal);
      lineNo += 1;

      yield { lineNo, line: lineNo === 1 ? stripBom(raw) : raw };
    }
  } catch (error) {
    // A caller that aborts mid-file gets its own reason, not the AbortError Node raises on the stream.
    throwIfAborted(signal);
    throw new Error(`could not read session file: ${describeError(error)}`);
  } finally {
    await handle.close();
  }
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

  if (typeof fields.timestamp !== "string" || parseSessionInstant(fields.timestamp) === undefined) {
    return { reason: "entry has no readable timestamp" };
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
 * Read the entries of one session file under `options.sessionsRoot`, narrowed by `params`.
 *
 * `entries` are in physical file order, which is write order rather than timestamp order and keeps
 * every branch of a session tree — abandoned branches included — visible. The optional filters are
 * ANDed (`entry-query.ts`) and applied to rows the reader has already built, so they bound the
 * **result**, not the scan: `warnings` always cover the whole file, which is why a `limit` or an
 * `endLineNo` stops rows being collected while the reader still walks every remaining line. A row
 * dropped by a filter costs no warning — it is a row that exists and was not asked for.
 *
 * A line that cannot become an entry is skipped with a warning naming its code, so `warnings`
 * describes exactly which lines are missing from `entries` apart from the ones filtered out.
 *
 * Throws when a filter parameter is unusable (before the file is opened, so a bad bound cannot look
 * like a missing session), when `sessionPath` is not an absolute path inside the sessions root, when
 * the file cannot be read, and when line 1 is not a session header: those mean the caller did not
 * name a readable Pi session, which no amount of returned entries would fix.
 */
export async function readSessionEntries(
  params: SessionEntriesParams,
  options: SessionEntriesOptions,
): Promise<SessionEntriesOutput> {
  throwIfAborted(options.signal);

  // Before any path work: a nonsense filter is the caller's mistake, and it must outrank both a
  // confinement failure and a missing file.
  const query = buildEntryQuery(params);

  const path = await resolveSessionPath(params.sessionPath, options.sessionsRoot);

  const warnings: SessionEntriesWarning[] = [];
  const entries: SessionFileEntry[] = [];

  // The header line is read with the rest of the file, so the version that gates `addressable` is
  // only known once line 1 arrives. `headerRead` tells a file with no lines at all from a file whose
  // header was rejected, because the two throw different errors.
  let addressable = false;
  let headerRead = false;

  for await (const { lineNo, line } of readSessionLines(path, options.signal)) {
    if (lineNo === 1) {
      const header = inspectHeaderLine(line);

      if (!header.ok) {
        throw new Error(`not a Pi session file: ${header.reason}`);
      }

      addressable = header.version >= ADDRESSED_ENTRY_VERSION;
      headerRead = true;

      if (!addressable) {
        warnings.push({
          lineNo: null,
          code: "legacy_version",
          reason: `session version ${header.version}: entry ids are not durable, so id and parentId are null`,
        });
      }

      continue;
    }

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

    // A filtered row is parsed and then dropped: filters decide what is returned, not what is
    // read, because the scan owes its warnings to the whole file — the same "output cap, not an
    // I/O bound" rule `list_sessions.limit` already follows. Dropping the row here is what keeps
    // its `raw` from being retained: the result is bounded even when the file is not.
    if (query.limit !== undefined && entries.length >= query.limit) continue;
    if (!query.matches(entry)) continue;

    entries.push(entry);
  }

  if (!headerRead) {
    // The file held no line at all, which is an empty file. A file holding nothing but a line break
    // still has a blank line 1, and `inspectHeaderLine` refuses that one with the same message.
    throw new Error("not a Pi session file: first line is empty");
  }

  return { entries, warnings };
}
