import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createListSessionsTool } from "./list-sessions-tool.ts";
import { createSessionEntriesTool } from "./session-entries-tool.ts";
import { createSteeringInputHandler } from "./steering-messages.ts";

export default function (pi: ExtensionAPI) {
  // Pi exports getAgentDir() but not getSessionsDir(), so the "sessions" segment is ours.
  const sessionsRoot = join(getAgentDir(), "sessions");

  // Both tools read the effective settings through this one reader, and ask it per call: they are
  // unreadable while this factory is still running, and `/reload` replaces them afterwards. Same
  // reason the steering handler below is handed a reader rather than a value.
  const readSettings = () => pi.getSettings();

  pi.registerTool(createListSessionsTool({ sessionsRoot, readSettings }));
  pi.registerTool(createSessionEntriesTool({ sessionsRoot, readSettings }));

  // The switch lives in Pi's effective settings, which are unreadable while this factory is still
  // running, so the handler reads them per input event and `/reload` is what picks up an edit.
  pi.on("input", createSteeringInputHandler(readSettings));
}
