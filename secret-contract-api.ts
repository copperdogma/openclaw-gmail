import {
  collectNestedChannelFieldAssignments,
  getChannelSurface,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

const CHANNEL_KEY = "openclaw-gmail";

export const secretTargetRegistryEntries = [
  {
    id: "channels.openclaw-gmail.push.credentialsPath",
    targetType: "channels.openclaw-gmail.push.credentialsPath",
    configFile: "openclaw.json" as const,
    pathPattern: "channels.openclaw-gmail.push.credentialsPath",
    secretShape: "secret_input" as const,
    expectedResolvedValue: "string" as const,
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "channels.openclaw-gmail.accounts.*.push.credentialsPath",
    targetType: "channels.openclaw-gmail.accounts.*.push.credentialsPath",
    configFile: "openclaw.json" as const,
    pathPattern: "channels.openclaw-gmail.accounts.*.push.credentialsPath",
    secretShape: "secret_input" as const,
    expectedResolvedValue: "string" as const,
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, CHANNEL_KEY);
  if (!resolved) return;

  collectNestedChannelFieldAssignments({
    channelKey: CHANNEL_KEY,
    nestedKey: "push",
    field: "credentialsPath",
    channel: resolved.channel,
    surface: resolved.surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActive: true,
    topInactiveReason: "top-level Gmail push credentialsPath is inactive.",
    accountActive: ({ enabled, account }) => {
      const push = account.push;
      const pushEnabled = typeof push === "object" && push !== null
        ? (push as { enabled?: unknown }).enabled !== false
        : true;
      return enabled && pushEnabled;
    },
    accountInactiveReason: "Gmail account or account push config is disabled.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
