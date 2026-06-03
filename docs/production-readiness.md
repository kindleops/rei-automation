# Production Readiness Proofs

Run the health proof against local, preview, or production by setting `COCKPIT_PROOF_BASE_URL`.
The proof is production-safe: it reads cockpit health/inbox/metrics and only calls feeder preview with `dry_run=true`.

```bash
COCKPIT_PROOF_BASE_URL=https://your-preview-or-production-api.vercel.app \
OPS_DASHBOARD_SECRET=... \
npm run proof:health
```

Readiness audit:

```bash
npm run proof:production-readiness
```

The readiness proof checks required API/dashboard env names, Vercel project linkage, restored inbox v2 migration/view reachability, safe queue/auto-reply/campaign defaults, and emergency-stop wiring. The live emergency-stop POST is disabled by default; to verify it against the selected API, run:

```bash
PRODUCTION_READINESS_ALLOW_EMERGENCY_STOP=true \
COCKPIT_PROOF_BASE_URL=https://your-preview-or-production-api.vercel.app \
OPS_DASHBOARD_SECRET=... \
npm run proof:production-readiness
```

Internal live TextGrid proof remains locked to `+16127433952` and is skipped unless explicitly enabled:

```bash
AUTO_REPLY_INTERNAL_LIVE_SEND_PROOF_ENABLED=true \
node scripts/proof/auto-reply-internal-live-send-proof.mjs
```

## Vercel Env Safety Defaults

Preview and production should default live activation booleans to false unless a named operator is intentionally activating a live window:

```bash
OUTBOUND_SMS_ENABLED=false
QUEUE_RUNNER_ENABLED=false
AUTO_REPLY_ENABLED=false
AUTO_REPLY_LIVE_ENABLED=false
```

These legacy env booleans must never be treated as sufficient for live sends. Runtime `system_control` brakes remain authoritative:

- `queue_emergency_stop_at` set blocks live queue creation and live sends.
- `queue_processor_mode=off` or `paused` blocks live sends.
- `campaign_mode=paused` or `dry_run` blocks live queue creation.
- `auto_reply_mode=disabled` blocks auto replies, even if env booleans are true.

## First Live-Limited Batch Checklist

Scope:

- One market or one state filter only.
- One sender number pool or one selected sender number.
- 5 sellers first, 10 sellers maximum.
- Auto replies disabled, or `auto_reply_mode=dry_run`.
- `queue_processor_mode=safe` for operator-controlled execution; no global cron queue run.
- `campaign_mode=live_limited` only for the batch window, then return to `paused`.
- Emergency stop route and dashboard control ready before queue creation.

Before:

```bash
npm run build:api
npm run build:dashboard
npm run proof:production-readiness
PROOF_USE_VERCEL_CURL=true COCKPIT_PROOF_BASE_URL=https://your-preview-or-production-api.vercel.app OPS_DASHBOARD_SECRET=... npm run proof:health
PROOF_USE_VERCEL_CURL=true COCKPIT_PROOF_BASE_URL=https://your-preview-or-production-api.vercel.app OPS_DASHBOARD_SECRET=... node scripts/proof/campaign-dry-run-proof.mjs
```

Batch creation must use the live-limited rails: explicit market/state, hard cap, max batch size, daily cap, market cap, per-number cap, and limit of 5 or 10.

After:

```bash
npm run proof:production-readiness
PROOF_USE_VERCEL_CURL=true COCKPIT_PROOF_BASE_URL=https://your-preview-or-production-api.vercel.app OPS_DASHBOARD_SECRET=... npm run proof:health
```

Then set runtime controls back to `queue_processor_mode=off`, `campaign_mode=paused`, `queue_auto_send_enabled=false`, `queue_auto_enqueue_enabled=false`, and keep auto replies disabled unless a separate activation proof is run.
