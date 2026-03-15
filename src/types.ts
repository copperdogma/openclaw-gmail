import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

// Config type - use any since the exact type may vary between versions
type OpenClawConfig = any;

let _didConfigDebug = false;

export type GmailAccountConfig = {
  enabled?: boolean;
  /** Gmail address this channel is authorized for. */
  gmailAccount?: string;
  /** Polling interval (seconds). */
  pollIntervalSec?: number;
  /** Optional: restrict inbound to specific senders. */
  allowFrom?: string[];
  /** DM policy equivalent for safety. Default: allowlist. */
  dmPolicy?: "allowlist" | "pairing" | "open";
  /** Optional: push config (Pub/Sub pull). */
  push?: {
    enabled?: boolean;
    projectId?: string;
    subscription?: string; // Pub/Sub subscription name
    credentialsPath?: string; // service account JSON path
    pollFallbackSec?: number; // fallback poll interval when push enabled
    watchCommand?: string; // optional shell command to renew Gmail watch
    watchRenewSec?: number; // how often to run watchCommand
  };
};

export type ResolvedGmailAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  config: GmailAccountConfig;
};

export function listGmailAccountIds(cfg: OpenClawConfig): string[] {
  // Core may pass either:
  // - the full OpenClaw config (cfg.channels["openclaw-gmail"])
  // - the channels map (cfg["openclaw-gmail"])
  // - the channel section itself (cfg)
  const base = (cfg?.channels?.["openclaw-gmail"] as any) ?? (cfg as any)?.["openclaw-gmail"] ?? (cfg as any) ?? {};
  const accounts = (base as any)?.accounts;
  if (accounts && typeof accounts === "object") return Object.keys(accounts);
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultGmailAccountId(_cfg: OpenClawConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

export function resolveGmailAccount({
  cfg,
  accountId,
}: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedGmailAccount {
  const aid = normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID);

  // Core may pass different shapes depending on version:
  // - full config: { channels: { "openclaw-gmail": { accounts: { ... }}}}
  // - channels map: { "openclaw-gmail": { accounts: { ... }}}
  // - channel section: { accounts: { ... }}
  // - account section: { gmailAccount: "...", ... }
  const base0 = (cfg?.channels?.["openclaw-gmail"] as any) ?? (cfg as any)?.["openclaw-gmail"] ?? (cfg as any) ?? {};

  let base: any = base0;
  let acct: any = (base0?.accounts?.[aid] ?? {}) as any;

  // If we were handed the account section directly, it won't have .accounts.
  if (!base0?.accounts && (base0?.gmailAccount || base0?.pollIntervalSec || base0?.push)) {
    base = {};
    acct = base0;
  }

  const enabled = Boolean(acct.enabled ?? base.enabled ?? true);
  const gmailAccount = String(acct.gmailAccount ?? base.gmailAccount ?? "").trim();

  if (!_didConfigDebug) {
    _didConfigDebug = true;
    try {
      const keys = (x: any) => (x && typeof x === "object" ? Object.keys(x) : []);
      console.error(
        `[openclaw-gmail][debug] resolveGmailAccount cfgKeys=${keys(cfg)} baseKeys=${keys(base)} acctKeys=${keys(acct)} gmailAccountPresent=${!!gmailAccount}`
      );
    } catch (e) {
      console.error(`[openclaw-gmail][debug] config debug failed: ${String((e as any)?.message ?? e)}`);
    }
  }

  const pollIntervalSec = Number.isFinite(acct.pollIntervalSec)
    ? Number(acct.pollIntervalSec)
    : Number.isFinite(base.pollIntervalSec)
      ? Number(base.pollIntervalSec)
      : 20;

  const dmPolicy = (acct.dmPolicy ?? base.dmPolicy ?? "allowlist") as
    | "allowlist"
    | "pairing"
    | "open";

  const allowFrom = Array.isArray(acct.allowFrom)
    ? acct.allowFrom.map((x: any) => String(x).trim()).filter(Boolean)
    : Array.isArray(base.allowFrom)
      ? base.allowFrom.map((x: any) => String(x).trim()).filter(Boolean)
      : undefined;

  const push = (acct.push ?? base.push ?? undefined) as any;

  const configured = Boolean(gmailAccount);

  return {
    accountId: aid,
    name: typeof acct.name === "string" ? acct.name : typeof base.name === "string" ? base.name : undefined,
    enabled,
    configured,
    config: {
      enabled,
      gmailAccount,
      pollIntervalSec,
      allowFrom,
      dmPolicy,
      push,
    },
  };
}
