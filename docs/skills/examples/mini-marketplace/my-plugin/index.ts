// @ts-nocheck — example file; install @open-agents/coding-agent before running
import type { ExtensionAPI } from "@open-agents/coding-agent";

export default function myPlugin(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("my-plugin loaded from example marketplace!", "info");
  });
}
