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
