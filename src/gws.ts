/**
 * gws.ts — Google Workspace CLI adapter for openclaw-gmail.
 *
 * Drop-in replacement for gog.ts: same function signature (gwsJson),
 * but shells out to `gws` (googleworkspace/cli) instead of `gog` (gogcli).
 *
 * The openclaw-gmail plugin calls gogJson() with gog-specific CLI args.
 * This module provides gwsJson() with the same contract, plus a
 * gogJson-compatible shim that translates gog args → gws args at call time.
 *
 * Environment requirements:
 *   - `gws` binary on PATH (npm install -g @googleworkspace/cli)
 *   - GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file (headless)
 *   - GOOGLE_WORKSPACE_CLI_CLIENT_ID + GOOGLE_WORKSPACE_CLI_CLIENT_SECRET
 *     (or ~/.config/gws/client_secret.json)
 *   - Authenticated via `gws auth login -s gmail`
 */

import { spawn } from "node:child_process";

// Circuit breaker state: track consecutive failures and back off
let consecutiveFailures = 0;
let lastFailureTime = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
const BASE_BACKOFF_MS = 5_000; // 5 seconds
const MAX_BACKOFF_MS = 300_000; // 5 minutes

function getBackoffMs(): number {
  if (consecutiveFailures === 0) return 0;
  const backoff = Math.min(
    BASE_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1),
    MAX_BACKOFF_MS
  );
  return backoff;
}

function shouldCircuitBreak(): { blocked: boolean; reason?: string } {
  if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) return { blocked: false };
  const elapsed = Date.now() - lastFailureTime;
  const backoff = getBackoffMs();
  if (elapsed < backoff) {
    return {
      blocked: true,
      reason: `Circuit breaker open: ${consecutiveFailures} consecutive failures. Next retry in ${Math.round((backoff - elapsed) / 1000)}s`,
    };
  }
  return { blocked: false }; // Allow retry after backoff
}

function recordSuccess(): void {
  consecutiveFailures = 0;
}

function recordFailure(): void {
  consecutiveFailures++;
  lastFailureTime = Date.now();
}

/**
 * Run a gws command and return parsed JSON output.
 * gws writes "Using keyring backend: file" to stderr, and JSON to stdout.
 * Includes circuit breaker to prevent process storms on auth/API failures.
 */
export async function gwsJson(
  args: string[],
  opts?: { env?: Record<string, string> }
): Promise<any> {
  // Circuit breaker check
  const cb = shouldCircuitBreak();
  if (cb.blocked) {
    throw new Error(cb.reason);
  }

  const env = {
    ...process.env,
    ...(opts?.env ?? {}),
    // Ensure file-based keyring for headless operation
    GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file",
  };

  return await new Promise<any>((resolve, reject) => {
    const child = spawn("gws", args, { env, stdio: ["pipe", "pipe", "pipe"] });

    let out = "";
    let err = "";

    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));

    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code !== 0) {
        recordFailure();
        reject(new Error(`gws ${args.join(" ")} exited ${code}: ${err.trim() || out.trim()}`));
        return;
      }
      recordSuccess();
      // gws may prepend status lines to stdout (e.g. "Using keyring backend: file").
      // Find the first line that starts with '{' or '[' and parse from there.
      const lines = out.split("\n");
      let jsonStart = -1;
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          jsonStart = i;
          break;
        }
      }
      if (jsonStart === -1) {
        // No JSON found — return null (some commands produce no output)
        resolve(null);
        return;
      }
      const jsonStr = lines.slice(jsonStart).join("\n").trim();
      try {
        resolve(JSON.parse(jsonStr));
      } catch (e) {
        reject(
          new Error(
            `Failed to parse gws JSON output: ${(e as Error).message}\nOutput: ${out.slice(0, 2000)}`
          )
        );
      }
    });
  });
}

/**
 * Translate a gog-style gogJson() call to a gws gwsJson() call.
 *
 * This is the compatibility shim: the channel.ts code calls gogJson(args, opts)
 * with gog CLI args. This function maps those args to equivalent gws commands.
 *
 * Supported gog command patterns:
 *   gog gmail history --since <id> --max <n>
 *   gog gmail get <messageId> --format <fmt> --headers <list>
 *   gog gmail thread get <threadId>
 *   gog gmail send --to <addr> --subject <s> --body <b> [--thread-id <tid>] [--reply-all] [--no-input] [--force]
 */
export function translateGogToGws(
  gogArgs: string[],
  opts?: { account?: string; env?: Record<string, string> }
): { gwsArgs: string[]; env?: Record<string, string> } {
  // Strip --json and --account flags (gws always outputs JSON; account is handled differently)
  const args = gogArgs.filter(
    (a, i) =>
      a !== "--json" &&
      !(a === "--account" && i + 1 < gogArgs.length) &&
      !(gogArgs[i - 1] === "--account")
  );

  // Parse the command structure
  // gog gmail history --since <id> --max <n>
  // gog gmail get <messageId> --format <fmt> --headers <list>
  // gog gmail thread get <threadId>
  // gog gmail send ...

  if (args[0] !== "gmail") {
    throw new Error(`translateGogToGws: unsupported service '${args[0]}' (only 'gmail' supported)`);
  }

  const subcommand = args[1];

  switch (subcommand) {
    case "history": {
      // gog: gmail history --since <historyId> --max <maxResults>
      // gws: gmail users history list --params '{"userId":"me","startHistoryId":"<id>","maxResults":<n>}'
      //
      // Special case: --since 1 is gog's cursor initialization trick.
      // It doesn't work with the raw Gmail API (returns 404 "entity not found").
      // Instead, use getProfile to get the current historyId.
      const params: Record<string, any> = { userId: "me" };
      let sinceValue = "";
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--since" && args[i + 1]) {
          sinceValue = args[++i];
          params.startHistoryId = sinceValue;
        } else if (args[i] === "--max" && args[i + 1]) {
          params.maxResults = parseInt(args[++i], 10);
        }
      }

      // Cursor initialization: when --since is "1" (or very small),
      // use getProfile instead to get the current historyId without
      // hitting the 404 that caused process storms.
      if (sinceValue === "1" || sinceValue === "0") {
        return {
          gwsArgs: [
            "gmail",
            "users",
            "getProfile",
            "--params",
            JSON.stringify({ userId: "me" }),
          ],
          env: opts?.env,
          _cursorInit: true,
        } as any;
      }

      return {
        gwsArgs: [
          "gmail",
          "users",
          "history",
          "list",
          "--params",
          JSON.stringify(params),
        ],
        env: opts?.env,
      };
    }

    case "get": {
      // gog: gmail get <messageId> --format <fmt> --headers <headerList>
      // gws: gmail users messages get --params '{"userId":"me","id":"<messageId>","format":"<fmt>"}'
      // Note: gws doesn't have a --headers filter; format=full returns all headers
      const messageId = args[2];
      const params: Record<string, any> = { userId: "me", id: messageId };
      for (let i = 3; i < args.length; i++) {
        if (args[i] === "--format" && args[i + 1]) {
          params.format = args[++i];
        }
        // --headers is ignored for gws (full format includes all headers)
      }
      return {
        gwsArgs: [
          "gmail",
          "users",
          "messages",
          "get",
          "--params",
          JSON.stringify(params),
        ],
        env: opts?.env,
      };
    }

    case "thread": {
      // gog: gmail thread get <threadId>
      // gws: gmail users threads get --params '{"userId":"me","id":"<threadId>"}'
      if (args[2] === "get") {
        const threadId = args[3];
        return {
          gwsArgs: [
            "gmail",
            "users",
            "threads",
            "get",
            "--params",
            JSON.stringify({ userId: "me", id: threadId }),
          ],
          env: opts?.env,
        };
      }
      throw new Error(`translateGogToGws: unsupported thread subcommand '${args[2]}'`);
    }

    case "send": {
      // gog: gmail send [--to <addr>] [--thread-id <tid>] [--reply-all] [--subject <s>] [--body <b>] [--in-reply-to <msgid>] [--references <msgids>] [--no-input] [--force]
      // gws: gmail users messages send --params '{"userId":"me"}' --json '{"raw":"<base64>"}'
      //
      // gws uses raw RFC 2822 message format. We need to construct the email.
      let to = "";
      let threadId = "";
      let subject = "";
      let body = "";
      let inReplyTo = "";
      let references = "";
      let replyAll = false;

      for (let i = 2; i < args.length; i++) {
        switch (args[i]) {
          case "--to":
            to = args[++i] ?? "";
            break;
          case "--thread-id":
            threadId = args[++i] ?? "";
            break;
          case "--subject":
            subject = args[++i] ?? "";
            break;
          case "--body":
            body = args[++i] ?? "";
            break;
          case "--in-reply-to":
            inReplyTo = args[++i] ?? "";
            break;
          case "--references":
            references = args[++i] ?? "";
            break;
          case "--reply-all":
            replyAll = true;
            break;
          case "--no-input":
          case "--force":
            // Ignored for gws
            break;
        }
      }

      // Build RFC 2822 message
      // In-Reply-To and References headers are critical for email threading.
      // Gmail API's threadId only files the message into a thread on the server side;
      // email clients use In-Reply-To/References to visually group messages.
      const decodeMojibakeOnce = (s: string): string => {
        try {
          // Common case: UTF-8 bytes were previously mis-decoded as Latin-1/Windows-1252.
          const repaired = Buffer.from(s, "latin1").toString("utf8");
          return repaired.includes("�") ? s : repaired;
        } catch {
          return s;
        }
      };

      const repairSubject = (s: string): string => {
        let cur = String(s ?? "").trim();
        if (!cur) return cur;
        for (let i = 0; i < 3; i++) {
          const next = decodeMojibakeOnce(cur).trim();
          if (!next || next === cur) break;
          cur = next;
        }
        return cur;
      };

      const encodeHeaderUtf8 = (value: string): string => {
        const v = String(value ?? "");
        // RFC 2047 encoded-word for non-ASCII header values.
        return /^[\x00-\x7F]*$/.test(v)
          ? v
          : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
      };

      const normalizedSubject = repairSubject(subject);
      const lines: string[] = [];
      if (to) lines.push(`To: ${to}`);
      if (normalizedSubject) lines.push(`Subject: ${encodeHeaderUtf8(normalizedSubject)}`);
      if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
      if (references) lines.push(`References: ${references}`);
      lines.push(`Content-Type: text/plain; charset="UTF-8"`);
      lines.push(""); // blank line separates headers from body
      lines.push(body);

      const rawMessage = lines.join("\r\n");
      // Gmail API expects URL-safe base64
      const raw = Buffer.from(rawMessage)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      const params: Record<string, any> = { userId: "me" };
      const jsonBody: Record<string, any> = { raw };
      if (threadId) {
        jsonBody.threadId = threadId;
      }

      return {
        gwsArgs: [
          "gmail",
          "users",
          "messages",
          "send",
          "--params",
          JSON.stringify(params),
          "--json",
          JSON.stringify(jsonBody),
        ],
        env: opts?.env,
      };
    }

    default:
      throw new Error(`translateGogToGws: unsupported gmail subcommand '${subcommand}'`);
  }
}

/**
 * Drop-in replacement for gogJson() from gog.ts.
 * Translates gog CLI args to gws CLI args and executes via gwsJson().
 *
 * The response format from gws Gmail API is the raw Google API JSON,
 * which is what the plugin already handles (it reads .payload.headers,
 * .threadId, .snippet, etc.).
 *
 * Special handling for history responses:
 * - gog returns { historyId, messages: [messageId, ...] }
 * - gws returns { history: [{messagesAdded: [{message: {id, threadId}}]}], historyId }
 * - We normalize gws output to match gog's format.
 */
export async function gogJsonCompat(
  args: string[],
  opts?: { account?: string; env?: Record<string, string> }
): Promise<any> {
  const translated = translateGogToGws(args, opts);
  const { gwsArgs, env } = translated;
  const result = await gwsJson(gwsArgs, { env });

  // Normalize history response to match gog format
  if (args[0] === "gmail" && args[1] === "history") {
    // Cursor init case: getProfile returns { historyId, emailAddress, ... }
    // Normalize to match gog's { historyId, messages: [] } format
    if ((translated as any)._cursorInit) {
      return {
        historyId: String(result?.historyId ?? ""),
        messages: [],
      };
    }
    return normalizeHistoryResponse(result);
  }

  // Normalize message get response to match gog format
  // gog returns { message: { threadId, payload, snippet, ... }, headers: { from, subject, ... } }
  // gws returns the raw Gmail API message directly { threadId, payload, snippet, ... }
  if (args[0] === "gmail" && args[1] === "get") {
    return normalizeMessageResponse(result);
  }

  // Normalize thread get response
  // gog may return { thread: { messages: [...] } } or { messages: [...] }
  // gws returns { id, messages: [...] } (raw Gmail API format)
  // The plugin handles both, so we pass through.

  return result;
}

function normalizeHistoryResponse(gwsResult: any): any {
  if (!gwsResult) return { historyId: "" };

  const historyId = String(gwsResult.historyId ?? "");
  const history = Array.isArray(gwsResult.history) ? gwsResult.history : [];

  // Extract all message IDs from history entries
  const messageIds = new Set<string>();
  for (const entry of history) {
    // messagesAdded is the most common for new incoming mail
    const added = Array.isArray(entry.messagesAdded) ? entry.messagesAdded : [];
    for (const item of added) {
      const id = String(item?.message?.id ?? "").trim();
      if (id) messageIds.add(id);
    }
    // Also check labelsAdded (messages that got INBOX label)
    const labelsAdded = Array.isArray(entry.labelsAdded) ? entry.labelsAdded : [];
    for (const item of labelsAdded) {
      const id = String(item?.message?.id ?? "").trim();
      if (id) messageIds.add(id);
    }
  }

  return {
    historyId,
    messages: Array.from(messageIds),
  };
}

function normalizeMessageResponse(gwsResult: any): any {
  if (!gwsResult) return null;

  // gws returns raw Gmail API message format, which is what channel.ts
  // mostly expects. But gog wraps it in { message: ..., headers: ... }.
  // The plugin code does: `const gmsg = (msg as any)?.message ?? msg;`
  // So it handles both — but also reads `(msg as any)?.headers` for
  // top-level simplified headers.
  //
  // We wrap to match gog's format for maximum compatibility.
  const headers: Record<string, string> = {};
  const payloadHeaders = gwsResult?.payload?.headers;
  if (Array.isArray(payloadHeaders)) {
    for (const h of payloadHeaders) {
      const name = String(h?.name ?? "").toLowerCase();
      const value = String(h?.value ?? "");
      if (name && !headers[name]) {
        headers[name] = value;
      }
    }
  }

  return {
    message: gwsResult,
    headers,
  };
}
