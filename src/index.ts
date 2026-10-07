import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createListSessionsTool } from "./list-sessions-tool.ts";
import { createSessionEntriesTool } from "./session-entries-tool.ts";
import { createSteeringInputHandler } from "./steering-messages.ts";

export default function (pi: ExtensionAPI) {
  // Pi exports getAgentDir() but not getSessionsDir(), so the "sessions" segment is ours.
  const sessionsRoot = join(getAgentDir(), "sessions");

  pi.registerTool(createListSessionsTool({ sessionsRoot }));
  pi.registerTool(createSessionEntriesTool({ sessionsRoot }));

  // The switch lives in Pi's effective settings, which are unreadable while this factory is still
  // running, so the handler reads them per input event and `/reload` is what picks up an edit.
  pi.on("input", createSteeringInputHandler(() => pi.getSettings()));
}
