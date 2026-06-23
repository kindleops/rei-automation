# Critical Suite Failure Manifest

Last refreshed: 2026-06-23 (post `c1180ad` feed-candidates + partial misc)

## Baseline (pre-repair full suite @ `77441a0` ancestor)

| Metric | Value |
|--------|-------|
| Files | 183 |
| Tests | 2420 |
| Pass | 2048 |
| Fail | 372 |
| Skipped | 0 |
| Unique failing files | 57 |
| Parsed failing tests | 369 |

Source log: `/tmp/canonical-full-critical.log`

## Fixed indirectly by `77441a0` (do not re-triage)

| Files | Tests | Domain |
|-------|------:|--------|
| 9 queue/template/textgrid files | 78 | Queue (71), Template (170), TextGrid provider (54) — subsets of full cluster counts |

## Post-repair targeted cluster status (@ `7e975c3`)

| Cluster | Files run | Tests | Pass | Fail | Status |
|---------|----------:|------:|-----:|-----:|--------|
| Classification (3-file gate) | 3 | 82 | 82 | 0 | **GREEN** |
| Discord (3-file spot gate) | 3 | 117 | 117 | 0 | **GREEN** (full 302/302 @ `ca697ef`) |
| Seller autopilot | 2 | 70 | 70 | 0 | **GREEN** |
| Feed-candidates | 1 | 91 | 91 | 0 | **GREEN** @ `b58f287` |
| Misc batch (23 files @ `c1180ad` partial) | 23 | 358 | 305 | 53 | IN PROGRESS |

### Remaining after green clusters (evidence @ `c1180ad` misc batch)

| Metric | Value |
|--------|------:|
| Remaining failing files (misc batch spot run) | ~15 unique files |
| Remaining failing tests (misc batch spot run) | 53 |

> Exact post-repair full-suite count requires one final 183-file run after all targeted clusters are green.

## Failing files by domain (remaining work)

### Outbound feeder / routing (`feed-candidates.test.mjs` — 22 fail)

- Template rotation/render lint (S1 guards, persona flags, property group)
- Schedule spread / cap tests (supabase chain mocks for outreach history)
- `renderOutboundTemplate` prospect-routing blocks for identity_unknown rows

**Signatures:** `TEMPLATE_RENDER_LINT_FAILURE`, `OUTREACH_HISTORY_UNAVAILABLE`, `no_safe_template_for_identity_unknown`

### Inbound lifecycle / idempotency

- `inbound-stage-lifecycle.test.mjs` — missing injected supabase in webhook path
- `inbound-failure-idempotency.test.mjs` — `CRITICAL_TEST_NETWORK_BLOCKED: placeholder.supabase.co`
- `message-events-noise-prevention.test.mjs` — same network guard

**Classification:** environment isolation / stale supabase chain mocks

### Inbox / cockpit

- `inbox-live-v2-service.test.mjs` — thread ordering + supabase view mocks
- `inbox-bucket-counting.test.mjs` — `.in is not a function`
- `inbox-compact-row-regression.test.mjs` — `THREAD_SOURCE` constant drift
- `dashboard-ops-service.test.mjs` — needsReply direction filter
- `deal-intelligence-dossier.test.mjs` / `universal-deal-dossier-service.test.mjs` — `.then` chain on supabase mock

### Discord (extended console — not in 3-file spot gate)

- `discord-targeting-console.test.mjs`, `discord-command-center.test.mjs`, `discord-alerts.test.mjs`, `discord-daily-briefing.test.mjs` — env/deferred routing (may be green after `ca697ef`; verify full discord batch)

### Replay / webhooks

- `replay-handlers.test.mjs` — label drift (`wrong_person` vs legacy string), inbound replay deps

### Acquisition / risk / misc routes

- `risk-003-feeder-lock.test.mjs`, `risk-010-auto-reply-dedup.test.mjs`
- `default-acquisition-engine.test.mjs`, `property-hydration-feeder.test.mjs`
- `email-layer-brevo-discord.test.mjs`, `wfv2-runtime-proof.test.mjs`
- `feed-master-owners-route.test.mjs` — **syntax fixed** @ `7e975c3` (`toTimestamp`); re-run required

## Unique root-cause signatures (evidence-based)

| Signature | Classification | Repair |
|-----------|----------------|--------|
| `CRITICAL_TEST_NETWORK_BLOCKED: placeholder.supabase.co` | Harness isolation | Inject `deps.supabase`; strip `SUPABASE_*` in critical-test-environment |
| `Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY` | Harness isolation | Same + `hasSupabaseConfig()` short-circuit in system-control |
| `supabase.from(...).select(...).in is not a function` | Stale mock chain | Chainable supabase helper |
| `supabase.from(...).select(...).eq(...).then is not a function` | Stale mock chain | Return thenable from terminal builder |
| `selling_interest` vs `consider_selling` | Production regression | **Fixed** @ `7e975c3` via `SELLER_FLOW_SAFETY_POLICY` routing |
| `outbound_gate_unsafe_seller_name_blank_greeting` | Test fixture | Use `safeRenderedMessage()` — no `Hi,` prefix |
| `NO_VALID_LOCAL_TEXTGRID_NUMBER` on regional routing | Production default | **Fixed** — routing-only calls default `first_touch=false` |
| `Function statements require a function name` @ feed-master-owners-request | Production syntax | **Fixed** `toTimestamp` @ `7e975c3` |

## Tests fixed indirectly by `77441a0`

Queue cluster (71), template cluster (170), textgrid provider cluster (54) — **do not rewrite**.

## Tests fixed in this closure branch (post-`77441a0`)

| Commit | Domain | Tests restored (targeted runs) |
|--------|--------|-------------------------------|
| `ed2ce51` | Classification | 98/98 |
| `ca697ef` | Discord interactions | 302/302 |
| `7e975c3` | Harness + feeder + seller flow | 70/70 autopilot; 69/91 feeder (+51 vs pre-fix) |

## Commands

```bash
cd apps/api && NODE_ENV=test PODIO_CLIENT_ID=test PODIO_CLIENT_SECRET=test \
  PODIO_USERNAME=test PODIO_PASSWORD=test INTERNAL_API_SECRET=test \
  BUYER_WEBHOOK_SECRET=test OPS_DASHBOARD_SECRET=test APP_BASE_URL=http://localhost:3000 \
  node --import ./tests/register-aliases.mjs --test tests/critical/<file>.test.mjs
```