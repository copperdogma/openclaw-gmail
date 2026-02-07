# openclaw-gmail

Gmail channel plugin for OpenClaw (via **gog**). Supports per-thread sessions, allowlist filtering, and optional Pub/Sub push for near‑real‑time inbox updates.

> Status: community plugin (not bundled with OpenClaw core)

## Features
- Gmail as a **first‑class OpenClaw channel** (`channels.openclaw-gmail`)
- Per‑thread sessions (each Gmail thread is its own session)
- Allowlist / DM policy enforcement
- Polling by default; **optional Pub/Sub push** for fast delivery
- Multi‑account support (`channels.openclaw-gmail.accounts.<id>`) with per‑account settings

## Requirements
- **OpenClaw** `>=2026.1.0`
- **gog** CLI installed + authenticated for the Gmail account
  - Install: https://gogcli.sh/
  - Auth: `gog auth login` (or your preferred gog auth flow)
- (Optional for push) **Google Cloud Pub/Sub** project + service account JSON
  - OpenClaw Gmail Pub/Sub guide: https://docs.openclaw.ai/automation/gmail-pubsub

## Install

### Recommended (extensions directory)
Because OpenClaw's config schema validation can block npm‑installed channel plugins, the most reliable path today is to clone/copy into an extensions folder.

```bash
# 1. Clone (or copy) into your extensions directory
git clone https://github.com/copperdogma/openclaw-gmail.git \
  /path/to/your/openclaw-workspace/extensions/openclaw-gmail

# 2. Install dependencies
cd /path/to/your/openclaw-workspace/extensions/openclaw-gmail
npm install

# 3. Register the plugin path in your OpenClaw config (openclaw.json)
#    Add to plugins.load.paths:
#      "/path/to/your/openclaw-workspace/extensions/openclaw-gmail"
#    Add to plugins.entries:
#      "openclaw-gmail": { "enabled": true }

# 4. Add channel config (see Configuration section below)

# 5. Restart the gateway
openclaw gateway restart
```

### npm (experimental)
```bash
openclaw plugins install openclaw-gmail
```

If you hit schema validation errors for `channels.openclaw-gmail`, use the extensions path above.

## Configuration

Minimum (single account):
```json5
{
  channels: {
    "openclaw-gmail": {
      enabled: true,
      gogAccount: "your@gmail.com",
      dmPolicy: "allowlist",
      allowFrom: ["you@example.com"],
      pollIntervalSec: 20
    }
  }
}
```

Multi‑account:
```json5
{
  channels: {
    "openclaw-gmail": {
      accounts: {
        default: {
          enabled: true,
          gogAccount: "your@gmail.com",
          dmPolicy: "allowlist",
          allowFrom: ["you@example.com"],
          pollIntervalSec: 20
        },
        work: {
          enabled: true,
          gogAccount: "you@work.com",
          dmPolicy: "allowlist",
          allowFrom: ["boss@work.com"],
          pollIntervalSec: 30
        }
      }
    }
  }
}
```

### Pub/Sub Push (optional)
Add a `push` block under `channels.openclaw-gmail` or per account. Example:
```json5
{
  channels: {
    "openclaw-gmail": {
      enabled: true,
      gogAccount: "your@gmail.com",
      push: {
        enabled: true,
        projectId: "your-gcp-project",
        subscription: "gmail-push-sub",
        credentialsPath: "/path/to/service-account.json",
        pollFallbackSec: 60,
        watchRenewSec: 21600
      }
    }
  }
}
```

See: https://docs.openclaw.ai/automation/gmail-pubsub

## Security Notes
- **Allowlist is strongly recommended** (`dmPolicy: "allowlist"`).
- `credentialsPath` points at a service account JSON (protect it, don't commit it).
- State files store Gmail message IDs and last history ID (no email bodies).
- gog manages its own OAuth credentials; treat your local gog cache as sensitive.

## Verification checklist
- [ ] OpenClaw restarted after install
- [ ] `gog` authenticated for the configured `gogAccount`
- [ ] Send a new email from an allowlisted sender → appears in OpenClaw
- [ ] Reply from OpenClaw → appears in Gmail thread
- [ ] (If push enabled) Pub/Sub subscription receives updates and `watchRenewSec` renews

## Troubleshooting
- **No messages**: confirm `gog` is authenticated for the same Gmail account as `gogAccount`.
- **Schema validation error** after npm install: use the extensions install path.
- **Push not working**: verify Pub/Sub subscription + service account permissions; check `watchRenewSec` and `pollFallbackSec` settings.

## License
MIT
