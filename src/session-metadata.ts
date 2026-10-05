/**
 * Read and validate the session header (line 1) of a Pi session file.
 *
 * Only the first line is ever read, bounded to MAX_HEADER_LINE_BYTES. This module never
 * opens a file through Pi's `SessionManager.open()`, which can migrate or repair history.
 *
 * Contract: docs/tool-api.md
 */

import { open } from "node:fs/promises";

import { parseSessionInstant } from "./timestamps.ts";

/** Maximum accepted length, in bytes, of a session header line. */
export const MAX_HEADER_LINE_BYTES = 4096;

export type HeaderFailure = { ok: false; reason: string };

/** Field values taken from a validated header, before the caller adds `path`. */
export type SessionHeaderValues = {
  id: string;
  timestamp: string;
  cwd: string;
  parentSessionPath?: string;
};

export type HeaderResult = { ok: true; values: SessionHeaderValues } | HeaderFailure;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the first line of a file, at most MAX_HEADER_LINE_BYTES long.
 *
 * A final line without a terminating newline is still returned. A first line longer than
 * the bound fails rather than being truncated, so an over-long header can never be
 * mistaken for a valid one.
 */
export async function readFirstLine(path: string): Promise<{ ok: true; line: string } | HeaderFailure> {
  let handle;
  try {
    handle = await open(path);
  } catch (error) {
    return { ok: false, reason: `could not open file: ${describeError(error)}` };
  }

  try {
    const limit = MAX_HEADER_LINE_BYTES + 1;
    const buffer = Buffer.allocUnsafe(limit);
    let filled = 0;

    while (filled < limit) {
      const { bytesRead } = await handle.read(buffer, filled, limit - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }

    const data = buffer.subarray(0, filled);

    if (filled === 0) {
      return { ok: false, reason: "file is empty" };
    }

    // The read buffer holds one byte past the bound, so a first line that reaches the end
    // of it without a newline is too long. A newline at index 4096 means a 4096-byte line,
    // which is exactly at the bound and accepted.
    const newline = data.indexOf(0x0a);

    if (newline === -1 && filled === limit) {
      return { ok: false, reason: `first line is longer than ${MAX_HEADER_LINE_BYTES} bytes` };
    }

    // A file whose only line has no trailing newline: `filled` is within the bound here.
    const line = newline === -1 ? data : data.subarray(0, newline);
    return { ok: true, line: line.toString("utf8").replace(/^\uFEFF/, "") };
  } catch (error) {
    return { ok: false, reason: `could not read file: ${describeError(error)}` };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Turn a header line into session field values.
 *
 * Every returned row is trustworthy: `id`, `cwd`, and `timestamp` must be present and
 * well-formed, and `parentSessionPath` must be a string when present. Anything else is a
 * skip-with-warning, so callers never handle a partial row and sorting never meets an
 * invalid date.
 */
export function validateHeaderLine(line: string): HeaderResult {
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

  if (typeof record.id !== "string" || record.id === "") {
    return { ok: false, reason: "session header has no id" };
  }

  if (typeof record.cwd !== "string" || record.cwd === "") {
    return { ok: false, reason: "session header has no cwd" };
  }

  if (typeof record.timestamp !== "string" || parseSessionInstant(record.timestamp) === undefined) {
    return { ok: false, reason: "session header has no readable timestamp" };
  }

  if ("parentSession" in record && typeof record.parentSession !== "string") {
    return { ok: false, reason: "session header parentSession is not a string" };
  }

  const values: SessionHeaderValues = {
    id: record.id,
    timestamp: record.timestamp,
    cwd: record.cwd,
  };

  if (typeof record.parentSession === "string" && record.parentSession !== "") {
    values.parentSessionPath = record.parentSession;
  }

  return { ok: true, values };
}

/** Read line 1 of a session file and validate it as a session header. */
export async function readSessionHeader(path: string): Promise<HeaderResult> {
  const line = await readFirstLine(path);
  if (!line.ok) return line;
  return validateHeaderLine(line.line);
}
