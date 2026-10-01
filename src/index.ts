import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exploreSessions } from "./explore-sessions.ts";

const exploreSessionsTool = defineTool({
  name: "explore_sessions",
  label: "Explore Sessions",
  description:
    "Explore past Pi sessions. This placeholder currently does not return session data.",
  parameters: Type.Object({}),

  async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
    exploreSessions();

    return {
      content: [{ type: "text", text: "Session exploration is not implemented yet." }],
      details: undefined,
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(exploreSessionsTool);
}
