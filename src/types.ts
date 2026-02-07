import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

// Config type - use any since the exact type may vary between versions
type OpenClawConfig = any;

export type GmailAccountConfig = {
  enabled?: boolean;
  /** Gmail address gog is authorized for. */
  gogAccount?: string;
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
  const accounts = (cfg.channels?.gmail as any)?.accounts;
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
  const base = (cfg.channels?.gmail as any) ?? {};
  const acct = (base.accounts?.[aid] ?? {}) as any;

  const enabled = Boolean(acct.enabled ?? base.enabled ?? true);
  const gogAccount = String(acct.gogAccount ?? base.gogAccount ?? "").trim();
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

  const configured = Boolean(gogAccount);

  return {
    accountId: aid,
    name: typeof acct.name === "string" ? acct.name : typeof base.name === "string" ? base.name : undefined,
    enabled,
    configured,
    config: {
      enabled,
      gogAccount,
      pollIntervalSec,
      allowFrom,
      dmPolicy,
      push,
    },
  };
}
