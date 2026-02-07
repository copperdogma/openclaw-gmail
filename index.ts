import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk";

import { gmailPlugin } from "./src/channel.js";
import { setGmailRuntime } from "./src/runtime.js";

const plugin = {
  id: "gmail",
  name: "Gmail",
  description: "OpenClaw Gmail channel plugin (gog) — per-thread sessions",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setGmailRuntime(api.runtime);
    api.registerChannel({ plugin: gmailPlugin });
  },
};

export default plugin;
