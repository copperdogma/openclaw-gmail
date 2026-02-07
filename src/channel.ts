import {
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";

import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";
import { GoogleAuth } from "google-auth-library";

import { getGmailRuntime } from "./runtime.js";
import { gogJson } from "./gog.js";
import { extractBody, headerValue, parseEmailAddress } from "./utils.js";
// (schema inlined in channel.ts)
import {
  listGmailAccountIds,
  resolveDefaultGmailAccountId,
  resolveGmailAccount,
  type ResolvedGmailAccount,
} from "./types.js";

export const gmailPlugin: ChannelPlugin<ResolvedGmailAccount> = {
  id: "openclaw-gmail",
  meta: {
    id: "openclaw-gmail",
    label: "Gmail",
    detailLabel: "Gmail (gog)",
    selectionLabel: "Gmail (gog)",
    systemImage: "envelope",
    docsPath: "/channels/openclaw-gmail",
    docsLabel: "openclaw-gmail",
    blurb: "Gmail channel (gog) — per-thread sessions.",
    order: 91,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },

  reload: { configPrefixes: ["channels.openclaw-gmail"] },
  // External plugin: provide JSON Schema directly (avoid extra deps).
  // Control UI expects `{ schema: <json-schema> }`.
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        name: { type: "string" },
        gogAccount: { type: "string" },
        pollIntervalSec: { type: "number" },
        dmPolicy: { enum: ["allowlist", "pairing", "open"] },
        allowFrom: { type: "array", items: { type: "string" } },
        push: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            projectId: { type: "string" },
            subscription: { type: "string" },
            credentialsPath: { type: "string" },
            pollFallbackSec: { type: "number" },
            watchCommand: { type: "string" },
            watchRenewSec: { type: "number" },
          },
        },
        accounts: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              name: { type: "string" },
              gogAccount: { type: "string" },
              pollIntervalSec: { type: "number" },
              dmPolicy: { enum: ["allowlist", "pairing", "open"] },
              allowFrom: { type: "array", items: { type: "string" } },
              push: {
                type: "object",
                additionalProperties: false,
                properties: {
                  enabled: { type: "boolean" },
                  projectId: { type: "string" },
                  subscription: { type: "string" },
                  credentialsPath: { type: "string" },
                  pollFallbackSec: { type: "number" },
                  watchCommand: { type: "string" },
                  watchRenewSec: { type: "number" },
                },
              },
            },
          },
        },
      },
    },
  },

  config: {
    listAccountIds: (cfg) => listGmailAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveGmailAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultGmailAccountId(cfg),

    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "openclaw-gmail",
        accountId,
        enabled,
        allowTopLevel: true,
      }),

    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "openclaw-gmail",
        accountId,
        clearBaseFields: ["gogAccount", "pollIntervalSec", "allowFrom", "dmPolicy", "name"],
      }),

    isEnabled: (account) => account.enabled !== false,
    disabledReason: () => "disabled",

    isConfigured: (account) => account.configured,
    unconfiguredReason: () => "not configured",

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      gogAccount: account.config.gogAccount,
      pollIntervalSec: account.config.pollIntervalSec,
    }),

    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveGmailAccount({ cfg, accountId }).config.allowFrom ?? []).map((x) => String(x)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((x) => String(x).trim().toLowerCase())
        .filter(Boolean)
        .filter((x, i, a) => a.indexOf(x) === i),
  },

  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({ cfg, sectionKey: "openclaw-gmail", accountId, name }),
    applyAccountConfig: ({ cfg, accountId }) =>
      migrateBaseNameToDefaultAccount({ cfg, sectionKey: "openclaw-gmail", accountId }),
  },

  pairing: {
    idLabel: "gmailSenderId",
    normalizeAllowEntry: (entry) => String(entry).trim().toLowerCase(),
  },

  security: {
    resolveDmPolicy: ({ account }) => {
      return {
        policy: account.config.dmPolicy ?? "allowlist",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `channels.openclaw-gmail.accounts.${account.accountId}.dmPolicy`,
        // Core convention: allowFromPath points at the config prefix (".") not the array itself.
        allowFromPath: `channels.openclaw-gmail.accounts.${account.accountId}.`,
        approveHint: formatPairingApproveHint("openclaw-gmail"),
        normalizeEntry: (raw) => String(raw ?? "").trim().toLowerCase(),
      };
    },
  },

  messaging: {
    normalizeTarget: (target) => String(target ?? "").trim(),
    targetResolver: {
      looksLikeId: (input) => input.trim().includes("@") || input.trim().startsWith("thread:"),
      hint: "<email|thread:<threadId>>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 12000,
    // NOTE: core outbound loader currently requires BOTH sendText and sendMedia to exist.
    // Gmail channel is text-only, so sendMedia explicitly throws.
    sendMedia: async () => {
      throw new Error("Gmail channel does not support media");
    },
    sendText: async ({ to, text, accountId }) => {
      const runtime = getGmailRuntime();
      const cfg = runtime.config.loadConfig();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const account = resolveGmailAccount({ cfg, accountId: aid });
      if (!account.configured) {
        throw new Error(
          `Gmail account ${aid} not configured (missing channels.openclaw-gmail.accounts.${aid}.gogAccount)`
        );
      }

      const normalizedTarget = String(to ?? "").trim();
      if (!normalizedTarget) throw new Error("Missing target");

      const body = String(text ?? "");

      // Mode A: reply within an existing thread
      const threadId = normalizedTarget.replace(/^thread:/i, "").trim();
      const looksLikeThreadId = /^[0-9a-f]{10,}$/i.test(threadId);
      if (looksLikeThreadId) {
        let replySubject = "(no subject)";
        try {
          const thread = await gogJson(["gmail", "thread", "get", threadId, "--json"], {
            account: account.config.gogAccount,
          });
          const messages = (thread as any)?.messages ?? (thread as any)?.thread?.messages ?? [];
          const pick = messages?.[0] ?? messages?.[messages.length - 1];
          const headers = pick?.payload?.headers ?? [];
          const rawSubject = headers.find((h: any) => String(h?.name ?? "").toLowerCase() === "subject")?.value;
          const subject = String(rawSubject ?? "").trim();
          if (subject) {
            replySubject = subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`;
          }
        } catch {
          // fall back to (no subject)
        }

        await gogJson(
          [
            "gmail",
            "send",
            "--thread-id",
            threadId,
            "--reply-all",
            "--subject",
            replySubject,
            "--body",
            body,
            "--no-input",
            "--force",
          ],
          { account: account.config.gogAccount }
        );
        return { channel: "openclaw-gmail", to: `thread:${threadId}` };
      }

      // Mode B: start a new thread (treat `to` as email address)
      await gogJson(
        [
          "gmail",
          "send",
          "--to",
          normalizedTarget,
          "--subject",
          "(no subject)",
          "--body",
          body,
          "--no-input",
          "--force",
        ],
        { account: account.config.gogAccount }
      );

      return { channel: "openclaw-gmail", to: normalizedTarget };
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: "openclaw-gmail",
            accountId: account.accountId,
            kind: "runtime" as const,
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      gogAccount: account.config.gogAccount,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({ accountId: account.accountId, configured: account.configured });

      if (!account.enabled) {
        ctx.log?.info(`[${account.accountId}] gmail disabled`);
        return { stop: () => {} };
      }

      if (!account.configured) {
        throw new Error("Gmail account not configured (missing gogAccount)");
      }

      // Profile-scoped state dir (e.g. ~/.openclaw/state)
      // NOTE: ctx.runtime in gateway.startAccount is *not* the full PluginRuntime;
      // use the plugin runtime we stored during register().
      const pluginRuntime = getGmailRuntime();
      const stateBase = pluginRuntime.state.resolveStateDir();
      const stateDir = path.join(stateBase, "gmail");
      const statePath = path.join(stateDir, `${account.accountId}.json`);

      await fs.mkdir(stateDir, { recursive: true });

      type GmailState = {
        lastHistoryId?: string;
        // Small, lossy dedupe to avoid double-processing when history pages overlap.
        seenMessageIds?: string[];
      };

      async function readState(): Promise<GmailState> {
        try {
          const raw = await fs.readFile(statePath, "utf8");
          return JSON.parse(raw) as GmailState;
        } catch {
          return {};
        }
      }

      async function writeState(next: GmailState): Promise<void> {
        await fs.writeFile(statePath, JSON.stringify(next, null, 2) + "\n", "utf8");
      }

      function parseEmailAddress(fromHeader: string): string {
        const m = fromHeader.match(/<([^>]+)>/);
        const email = (m?.[1] ?? fromHeader).trim();
        return email.toLowerCase();
      }

      function headerValue(headers: any[] | undefined, name: string): string {
        if (!Array.isArray(headers)) return "";
        const h = headers.find((x) => String(x?.name ?? "").toLowerCase() === name.toLowerCase());
        return String(h?.value ?? "");
      }

      async function ensureCursorInitialized(): Promise<string> {
        const st = await readState();
        if (st.lastHistoryId) return st.lastHistoryId;

        // Initialize cursor “near now” to avoid backfilling the mailbox.
        const init = await gogJson(["gmail", "history", "--since", "1", "--max", "1"], {
          account: account.config.gogAccount,
        });
        const hid = String(init?.historyId ?? "").trim();
        if (!hid) throw new Error("gmail: failed to initialize history cursor (missing historyId)");
        await writeState({ lastHistoryId: hid, seenMessageIds: [] });
        return hid;
      }

      async function pollOnce(): Promise<void> {
        const st = await readState();
        const since = await ensureCursorInitialized();
        const seen = new Set((st.seenMessageIds ?? []).map((x) => String(x)));

        // Cross-process dedupe: if two pollers run concurrently,
        // we still want at-most-once processing per Gmail messageId.
        const lockDir = path.join(stateBase, "gmail-locks");
        await fs.mkdir(lockDir, { recursive: true });

        const archiveBase = path.join(stateBase, "gmail-archive", "blocked", account.accountId);

        const hist = await gogJson(["gmail", "history", "--since", since, "--max", "50"], {
          account: account.config.gogAccount,
        });

        const newHistoryId = String(hist?.historyId ?? "").trim();
        const messages: string[] = Array.isArray(hist?.messages) ? hist.messages.map(String) : [];
        if (!newHistoryId) return;

        for (const messageId of messages) {
          if (!messageId || seen.has(messageId)) continue;

          // Try to acquire a messageId lock. If it already exists, another worker already handled it.
          const lockPath = path.join(lockDir, `${messageId}.lock`);
          try {
            const fh = await fs.open(lockPath, "wx");
            await fh.close();
          } catch (e: any) {
            if (String(e?.code ?? "") === "EEXIST") continue;
            // If we can't lock for some other reason, fall back to best-effort processing.
          }

          seen.add(messageId);

          const msg = await gogJson(
            [
              "gmail",
              "get",
              messageId,
              // IMPORTANT: use full format so we can extract the full body.
              // Using metadata relies on `snippet` which is frequently truncated.
              "--format",
              "full",
              "--headers",
              "From,To,Cc,Subject,Date",
            ],
            { account: account.config.gogAccount }
          );

          // `gog gmail get --json` returns `{ message: { threadId, payload, snippet, ... }, headers: {...} }`.
          const gmsg = (msg as any)?.message ?? msg;


          const threadId = String(gmsg?.threadId ?? "").trim();
          if (!threadId) continue;

          const headers = gmsg?.payload?.headers;
          const from = headerValue(headers, "From");
          const subject = headerValue(headers, "Subject");
          const date = headerValue(headers, "Date");
          const senderId = parseEmailAddress(from);

          // Skip self-sent messages.
          const self = String(account.config.gogAccount ?? "").trim().toLowerCase();
          if (senderId && self && senderId === self) continue;

          // Enforce dmPolicy allowlist locally (defense-in-depth).
          const dmPolicy = account.config.dmPolicy ?? "allowlist";
          const allowFrom = (account.config.allowFrom ?? [])
            .map((x) => String(x).trim().toLowerCase())
            .filter(Boolean);
          const sender = String(senderId ?? "").trim().toLowerCase();
          if (dmPolicy === "allowlist") {
            if (!sender || !allowFrom.includes(sender)) {
              ctx.log?.info(
                `[${account.accountId}] gmail blocked sender (not allowlisted): ${sender || "<unknown>"}`
              );
              try {
                const day = new Date().toISOString().slice(0, 10);
                const dir = path.join(archiveBase, day);
                await fs.mkdir(dir, { recursive: true });
                const archivePath = path.join(dir, `${messageId}.json`);
                const payload = {
                  archivedAt: new Date().toISOString(),
                  accountId: account.accountId,
                  messageId,
                  threadId,
                  senderId: sender || null,
                  from,
                  subject,
                  date,
                  snippet: String(gmsg?.snippet ?? "").trim(),
                };
                await fs.writeFile(archivePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
              } catch (e) {
                ctx.log?.error(
                  `[${account.accountId}] gmail archive blocked sender failed: ${(e as Error)?.message ?? String(e)}`
                );
              }
              continue;
            }
          }

          const snippet = String(gmsg?.snippet ?? "").trim();
          const body = extractBody(gmsg?.payload);
          let bodyText = (body || snippet).trim();

          // Best-practice reply extraction: use email-reply-parser when available.
          // We intentionally keep this optional to avoid hard dependency/runtime surprises.
          try {
            const mod: any = await import("email-reply-parser");
            const ERPClass = mod?.EmailReplyParser ?? mod?.default ?? mod;
            if (typeof ERPClass === "function") {
              const parser = new ERPClass();
              if (parser?.parseReply) {
                const parsed = String(parser.parseReply(bodyText) ?? "").trim();
                if (parsed) bodyText = parsed;
              }
            }
          } catch {
            // ignore; fall back to raw bodyText
          }

          const text = [
            `From: ${from}`,
            subject ? `Subject: ${subject}` : null,
            date ? `Date: ${date}` : null,
            "",
            bodyText,
          ]
            .filter(Boolean)
            .join("\n");

          // Forward to OpenClaw inbound pipeline via plugin runtime's dispatcher helper.
          const pluginRuntime = getGmailRuntime() as any;

          const sessionKey = `agent:main:gmail:dm:${threadId}`;

          const cfg = pluginRuntime.config.loadConfig();

          const inboundCtx = {
            Body: text,
            RawBody: bodyText,
            CommandBody: bodyText,
            From: `gmail:${senderId}`,
            To: `thread:${threadId}`,
            SessionKey: sessionKey,
            AccountId: account.accountId,
            ChatType: "direct" as const,
            SenderId: senderId,
            SenderName: from,
            Provider: "openclaw-gmail",
            Surface: "openclaw-gmail",
            OriginatingChannel: "openclaw-gmail",
            OriginatingTo: `thread:${threadId}`,
            MessageSid: messageId,
            MessageThreadId: threadId,
          };

          // Persist session metadata so it appears in Control UI Sessions list.
          try {
            const finalized = pluginRuntime.channel.reply.finalizeInboundContext(inboundCtx);
            const storePath = pluginRuntime.channel.session.resolveStorePath(cfg.session?.store, { agentId: "main" });
            ctx.log?.info(`[${account.accountId}] gmail session storePath=${storePath}`);
            await fs.mkdir(path.dirname(storePath), { recursive: true });
            await pluginRuntime.channel.session.recordInboundSession({
              storePath,
              sessionKey,
              ctx: finalized,
              createIfMissing: true,
              updateLastRoute: {
                sessionKey,
                channel: "openclaw-gmail",
                to: `thread:${threadId}`,
                accountId: account.accountId,
                threadId,
              },
              onRecordError: (err: any) => {
                ctx.log?.error(`[${account.accountId}] gmail recordInboundSession failed: ${String(err)}`);
              },
            });
          } catch (e) {
            ctx.log?.error(`[${account.accountId}] gmail recordInboundSession exception: ${(e as Error)?.message ?? String(e)}`);
          }

          await pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            cfg,
            ctx: inboundCtx,
            dispatcherOptions: {
              deliver: async (payload: any) => {
                const outText = String(payload?.text ?? "").trim();
                if (!outText) return;
                const replySubject = subject
                  ? subject.toLowerCase().startsWith("re:")
                    ? subject
                    : `Re: ${subject}`
                  : "(no subject)";
                await gogJson(
                  [
                    "gmail",
                    "send",
                    "--thread-id",
                    threadId,
                    "--reply-all",
                    "--subject",
                    replySubject,
                    "--body",
                    outText,
                  ],
                  { account: account.config.gogAccount }
                );
              },
              onError: (err: any, info: any) => {
                ctx.log?.error(
                  `[${account.accountId}] gmail dispatch ${String(info?.kind ?? "?")} failed: ${String(err?.message ?? err)}`
                );
              },
            },
          });
        }

        // Persist cursor + bounded dedupe list
        const nextSeen = Array.from(seen).slice(-500);
        await writeState({ lastHistoryId: newHistoryId, seenMessageIds: nextSeen });
      }

      const pushCfg = (account.config as any)?.push ?? {};
      const pushEnabled = Boolean(pushCfg?.enabled);
      const pollFallbackSec = Number.isFinite(pushCfg?.pollFallbackSec)
        ? Number(pushCfg.pollFallbackSec)
        : 60;
      const pollIntervalMs = Math.max(5, Number(account.config.pollIntervalSec ?? (pushEnabled ? pollFallbackSec : 20))) * 1000;
      ctx.log?.info(
        `[${account.accountId}] gmail provider started (poll ${Math.round(pollIntervalMs / 1000)}s; inbound+outbound; state=${statePath}; push=${pushEnabled ? "on" : "off"})`
      );

      let timer: NodeJS.Timeout | null = null;
      let running = false;
      let pushTask: Promise<void> | null = null;
      let watchTimer: NodeJS.Timeout | null = null;
      const execAsync = promisify(cpExec);

      const tick = async () => {
        if (ctx.abortSignal.aborted) return;
        if (running) return;
        running = true;
        try {
          await pollOnce();
        } catch (e) {
          ctx.setStatus({ accountId: account.accountId, lastError: (e as Error)?.message ?? String(e) });
          ctx.log?.error(`[${account.accountId}] gmail poll error: ${(e as Error)?.message ?? String(e)}`);
        } finally {
          running = false;
        }
      };

      const startPushPuller = async () => {
        const projectId = String(pushCfg?.projectId ?? "").trim();
        const subscription = String(pushCfg?.subscription ?? "").trim();
        const credentialsPath = String(pushCfg?.credentialsPath ?? "").trim();
        if (!projectId || !subscription || !credentialsPath) {
          ctx.log?.warn(
            `[${account.accountId}] gmail push enabled but missing projectId/subscription/credentialsPath; falling back to polling`
          );
          return;
        }

        const auth = new GoogleAuth({
          scopes: ["https://www.googleapis.com/auth/pubsub"],
          keyFile: credentialsPath,
        });

        const pullUrl = `https://pubsub.googleapis.com/v1/projects/${projectId}/subscriptions/${subscription}:pull`;
        const ackUrl = `https://pubsub.googleapis.com/v1/projects/${projectId}/subscriptions/${subscription}:acknowledge`;

        const watchCommand = String(pushCfg?.watchCommand ?? "").trim();
        const watchRenewSec = Number.isFinite(pushCfg?.watchRenewSec)
          ? Math.max(300, Number(pushCfg.watchRenewSec))
          : 6 * 60 * 60; // 6h default

        const runWatch = async () => {
          if (!watchCommand) return;
          try {
            await execAsync(watchCommand, { timeout: 60_000 });
            ctx.log?.info(`[${account.accountId}] gmail watch renew ok`);
          } catch (e) {
            ctx.log?.warn(
              `[${account.accountId}] gmail watch renew failed: ${(e as Error)?.message ?? String(e)}`
            );
          }
        };

        if (watchCommand) {
          await runWatch();
          watchTimer = setInterval(() => void runWatch(), watchRenewSec * 1000);
        }

        ctx.log?.info(`[${account.accountId}] gmail push puller started (subscription=${subscription})`);

        while (!ctx.abortSignal.aborted) {
          try {
            const token = await auth.getAccessToken();
            const res = await fetch(pullUrl, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ maxMessages: 10 }),
            });
            if (!res.ok) {
              const errText = await res.text().catch(() => "");
              ctx.log?.warn(
                `[${account.accountId}] gmail push pull failed: ${res.status} ${res.statusText} ${errText}`
              );
              await delay(5000);
              continue;
            }
            const data = (await res.json().catch(() => ({}))) as any;
            const msgs = Array.isArray(data?.receivedMessages) ? data.receivedMessages : [];
            if (msgs.length === 0) {
              await delay(5000);
              continue;
            }

            const ackIds = msgs.map((m: any) => m?.ackId).filter(Boolean);
            if (ackIds.length) {
              await fetch(ackUrl, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ ackIds }),
              }).catch(() => null);
            }

            // Trigger a poll to fetch new messages; dedupe handles overlaps.
            await tick();
          } catch (e) {
            ctx.log?.warn(
              `[${account.accountId}] gmail push loop error: ${(e as Error)?.message ?? String(e)}`
            );
            await delay(5000);
          }
        }
      };

      if (pushEnabled) {
        pushTask = startPushPuller();
      }

      timer = setInterval(() => void tick(), pollIntervalMs);
      setTimeout(() => void tick(), 250);

      return {
        stop: () => {
          if (timer) clearInterval(timer);
          if (watchTimer) clearInterval(watchTimer);
          ctx.log?.info(`[${account.accountId}] gmail provider stopped`);
        },
      };
    },
  },
};
