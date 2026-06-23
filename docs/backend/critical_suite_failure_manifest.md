# Critical Suite Failure Manifest

Last refreshed: 2026-06-23 @ `5e831e7` (misc cluster closed)

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

## Post-repair targeted cluster status (@ `5e831e7`)

| Cluster | Files run | Tests | Pass | Fail | Status |
|---------|----------:|------:|-----:|-----:|--------|
| Queue (`proof:queue`) | 8 | 71 | 71 | 0 | **GREEN** @ `77441a0` |
| Template | 9 | 170 | 170 | 0 | **GREEN** @ `77441a0` |
| TextGrid provider | 9 | 54 | 54 | 0 | **GREEN** @ `77441a0` |
| Classification | 5 | 98 | 98 | 0 | **GREEN** @ `ed2ce51` |
| Discord | 10 | 302 | 302 | 0 | **GREEN** @ `ca697ef` |
| Feed-candidates | 1 | 91 | 91 | 0 | **GREEN** @ `b58f287` |
| Risk-010 | 1 | 7 | 7 | 0 | **GREEN** @ `c1180ad` |
| Misc route/service batch | 23 | 358 | 358 | 0 | **GREEN** @ `5e831e7` |

### Misc cluster refresh (@ `5e831e7`)

| Metric | Pre-fix (`8754e60` partial) | Post-fix (`5e831e7`) |
|--------|----------------------------:|---------------------:|
| Files | 23 | 23 |
| Tests | 358 | 358 |
| Pass | 312 | 358 |
| Fail | 46 | 0 |

Source logs: `/tmp/misc-cluster-current.log` (46 fail), `/tmp/misc-cluster-verify.log` (0 fail)

**Resolved since stale 53-fail estimate (7 tests):** risk-010 gate overlap (3), partial inbox chain fixes, inbound second-pass supabase mock success path, feed-candidates already green before final misc pass.

### Misc cluster files (23)

`dashboard-ops-service`, `deal-intelligence-dossier`, `default-acquisition-engine`, `email-layer-brevo-discord`, `feed-candidates`, `feed-master-owners-route`, `inbound-autopilot-verification`, `inbound-failure-idempotency`, `inbound-offer-routing-integration`, `inbound-stage-lifecycle`, `inbox-bucket-counting`, `inbox-compact-row-regression`, `inbox-live-v2-service`, `message-events-noise-prevention`, `posthog-analytics`, `property-context-source`, `property-hydration-feeder`, `replay-handlers`, `risk-003-feeder-lock`, `risk-010-auto-reply-dedup`, `seller-auto-reply-plan`, `universal-deal-dossier-service`, `wfv2-runtime-proof`

### Misc subcluster closure (@ `5e831e7`)

| Subcluster | Result | Primary repair class |
|------------|--------|----------------------|
| A. Inbox / dossier | 100% PASS | Production regression + stale mock chains |
| B. Inbound lifecycle / idempotency | 100% PASS | Environment isolation + canonical label drift |
| C. Workflow / acquisition runtime | 100% PASS | Stale harness + runtime gate stubs |
| D. Locking / concurrency | 100% PASS | Stale lock mock timing |
| E. Email / Brevo isolation | 100% PASS | Production dep injection + queue stubs |

### Misc combined gate (@ `5e831e7`)

Normal order, concurrency=1, and default concurrency — all **358/358 PASS**.

## Fix classification (misc closure `8754e60` → `5e831e7`)

### Production regressions fixed

| Module | Fix |
|--------|-----|
| `live-inbox-service.js` | Thread listing order + waiting bucket contracts |
| `run-supabase-outbound-feeder.js` | Cooperative lock + `feeder_already_running` |
| `v3DecisionPipeline.js` / acquisition gates | Runtime gates, `seller_asking_price` routing |
| `process-email-queue.js` | `get_system_flag_override` dep injection |
| `handle-textgrid-inbound.js` / `sms-engine.js` | Message event error handling |

### Stale harness / fixture fixes

- Chainable supabase helper (`.then`, `.lt`, `.in`, `.range`, `.maybeSingle`)
- Dossier/inbox stub alignment (table names, JSON envelopes)
- Inbound webhook deps injection
- Canonical replay labels (`wrong_person`, `seller_asking_price`, `tenant_or_occupancy`, `stop_or_opt_out`)
- Property hydration reason `insufficient_identifiers`
- Risk-003 lock mock timing

### Environment / order isolation

- `critical-test-environment.mjs` network guard
- Injected supabase/system flags on inbound tests

### Tests removed or replaced

None — all 358 misc tests retained with same or stronger invariants.

## Commits (misc closure)

| SHA | Message |
|-----|---------|
| `dc2c0cf` | fix(inbox): live thread listing + waiting bucket contracts |
| `da3ecc8` | fix(feeder): cooperative lock + feeder_already_running |
| `7a09a9b` | fix(acquisition): runtime gates, seller_asking_price, message_event errors |
| `579b044` | fix(email): get_system_flag_override dep injection |
| `5b52ded` | test(helpers): chainable supabase inbox/inbound helpers |
| `f77952f` | test(inbox): dossier/inbox stub alignment |
| `8c1e5fc` | test(inbound): webhook deps + canonical replay labels |
| `5e831e7` | test(acquisition-email): runtime gate + email queue stubs |

## Remaining gates

- [ ] Repaired-cluster combined gate (Queue + Template + TextGrid + Classification + Discord + Feed-candidates + Risk-010 + Misc)
- [ ] Full 185-file critical suite
- [ ] API lint/build + Dashboard typecheck/build + runtime doctor

## Commands

```bash
cd apps/api && NODE_ENV=test PODIO_CLIENT_ID=test PODIO_CLIENT_SECRET=test \
  PODIO_USERNAME=test PODIO_PASSWORD=test INTERNAL_API_SECRET=test \
  BUYER_WEBHOOK_SECRET=test OPS_DASHBOARD_SECRET=test APP_BASE_URL=http://localhost:3000 \
  node --import ./tests/register-aliases.mjs --test tests/critical/<file>.test.mjs
```