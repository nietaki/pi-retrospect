import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createListSessionsTool } from "./list-sessions-tool.ts";

export default function (pi: ExtensionAPI) {
  // Pi exports getAgentDir() but not getSessionsDir(), so the "sessions" segment is ours.
  const sessionsRoot = join(getAgentDir(), "sessions");

  pi.registerTool(createListSessionsTool({ sessionsRoot }));
}
