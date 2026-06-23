# Critical Suite Failure Manifest

Last refreshed: 2026-06-23 @ `1d534f4` (final closure gates)

## Session SHAs

| | SHA |
|--|-----|
| Required ancestor | `8754e60` |
| Session start | `8754e60` |
| **Final HEAD** | **`1d534f4`** |

## Baseline (pre-repair full suite @ `77441a0` ancestor)

| Metric | Value |
|--------|-------|
| Files | 183 |
| Tests | 2420 |
| Pass | 2048 |
| Fail | 372 |
| Skipped | 0 |
| Unique failing files | 57 |

Source log: `/tmp/canonical-full-critical.log`

## Refreshed misc failure count (@ `1d534f4`)

Stale pre-fix estimate was **53 fail / 358 tests** (log predated partial fixes). Current HEAD refresh:

| Metric | Value |
|--------|------:|
| Files | 23 |
| Tests | 358 |
| Pass | 358 |
| Fail | 0 |

Source log: `/tmp/misc-cluster-refresh-1d534f4.log`

**Resolved since stale 53-fail estimate:** risk-010 gate overlap (3), inbox chain fixes, inbound supabase mock paths, queue/send-now harness rewrites (13 files), `canSend` + hard-compliance ordering (`1d534f4`).

### Misc cluster files (23)

`dashboard-ops-service`, `deal-intelligence-dossier`, `default-acquisition-engine`, `email-layer-brevo-discord`, `feed-candidates`, `feed-master-owners-route`, `inbound-autopilot-verification`, `inbound-failure-idempotency`, `inbound-offer-routing-integration`, `inbound-stage-lifecycle`, `inbox-bucket-counting`, `inbox-compact-row-regression`, `inbox-live-v2-service`, `message-events-noise-prevention`, `posthog-analytics`, `property-context-source`, `property-hydration-feeder`, `replay-handlers`, `risk-003-feeder-lock`, `risk-010-auto-reply-dedup`, `seller-auto-reply-plan`, `universal-deal-dossier-service`, `wfv2-runtime-proof`

### Misc subcluster closure (@ `1d534f4`)

| Subcluster | Result | Primary repair class |
|------------|--------|----------------------|
| A. Inbox / dossier | 100% PASS | Production regression + stale mock chains |
| B. Inbound lifecycle / idempotency | 100% PASS | Environment isolation + canonical label drift |
| C. Workflow / acquisition runtime | 100% PASS | Stale harness + runtime gate stubs |
| D. Locking / concurrency | 100% PASS | Stale lock mock timing |
| E. Email / Brevo isolation | 100% PASS | Production dep injection + queue stubs |

### Misc combined gate (@ `1d534f4`)

| Variant | Tests | Pass | Fail | Log |
|---------|------:|-----:|-----:|-----|
| Normal order, default concurrency | 358 | 358 | 0 | `/tmp/misc-cluster-refresh-1d534f4.log` |
| Concurrency=1, wfv2 last | 335 | 335 | 0 | `/tmp/misc-cluster-c1-retry-1d534f4.log` |
| Concurrency=1, wfv2 first (order-independence proof) | 358 | 358 | 0 | `/tmp/misc-cluster-c1-reorder-1d534f4.log` |

> **Order note:** With `--test-concurrency=1`, placing `wfv2-runtime-proof.test.mjs` as the final file after `seller-auto-reply-plan` causes the node test runner to exit before executing wfv2's 23 proofs (0 fail, but 23 tests not scheduled). Full 185-file suite avoids this because additional files follow wfv2 alphabetically. Reordering wfv2 earlier in the misc batch restores 358/358 under c1.

## Post-repair targeted cluster status (@ `1d534f4`)

| Cluster | Files | Tests | Pass | Fail | Status |
|---------|------:|------:|-----:|-----:|--------|
| Queue | 9+ | 74+ | ✓ | 0 | **GREEN** |
| Template | 9 | 170 | 170 | 0 | **GREEN** |
| TextGrid provider | 9 | 54 | 54 | 0 | **GREEN** |
| Classification | 5 | 98 | 98 | 0 | **GREEN** |
| Discord | 10 | 302 | 302 | 0 | **GREEN** |
| Feed-candidates | 1 | 91 | 91 | 0 | **GREEN** |
| Risk-010 | 1 | 7 | 7 | 0 | **GREEN** |
| Misc route/service | 23 | 358 | 358 | 0 | **GREEN** |

## Repaired-cluster combined gate (@ `1d534f4`)

| Metric | Value |
|--------|------:|
| Files | 63 |
| Tests | 1161 |
| Pass | 1161 |
| Fail | 0 |

Log: `/tmp/repaired-cluster-gate-1d534f4.log`

## Full critical suite (@ `1d534f4`)

| Metric | Value |
|--------|------:|
| Files | 185 |
| Tests | 2530 |
| Pass | 2530 |
| Fail | 0 |
| Skipped | 0 |

Log: `/tmp/canonical-full-critical-final3.log`

> Suite grew from documented 183/2420 baseline due to added proofs and harness expansions during repair (not regressions).

## Fix classification (`8754e60` → `1d534f4`)

### Production regressions fixed

| Module | Fix |
|--------|-----|
| `live-inbox-service.js` | Thread listing order + waiting bucket contracts |
| `run-supabase-outbound-feeder.js` | Cooperative lock + `feeder_already_running` |
| `v3DecisionPipeline.js` / acquisition gates | Runtime gates, `seller_asking_price` routing |
| `process-email-queue.js` | `get_system_flag_override` dep injection |
| `handle-textgrid-inbound.js` / `sms-engine.js` | Message event error handling + canonical queue fields |
| `send-now-service.js` / `send-now-request.js` | Restored `canSend` gate; hard compliance before `canSend` (`1d534f4`) |
| `seller-message-event.js` | `outbound_send` → `"Seller Outbound SMS"` category |
| `load-template.js` | Explicit `use_case` wins over `variant_group` |
| `queue-reconcile-runner.js` | Honor injected `deps.getSystemFlag` |
| `run-send-queue.js` | Preclaim diagnostics in return envelope |
| `force-send/route.js`, `send-test/route.js` | Exported dev handler entrypoints |

### Stale harness / fixture fixes

- Chainable supabase helper (`.then`, `.lt`, `.in`, `.range`, `.maybeSingle`)
- Dossier/inbox stub alignment (table names, JSON envelopes)
- Inbound webhook deps injection + canonical replay labels
- Queue-run-finalization/lock/revision-limit rewrites for Supabase preclaim contract
- `supabase-sms-runtime`, `supabase-queue`, `queue-reconcile` mock alignment
- `big-pickle` env isolation (`OPENCODE_ZEN_API_KEY`)
- `first-touch-template-selection` `skip_render_validation`
- `seller-flow-auto-queue` timestamp expectation update

### Environment / order isolation

- `critical-test-environment.mjs` network guard
- Injected supabase/system flags on inbound tests
- Misc c1 gate: wfv2 file-order scheduling quirk documented (not an assertion weakening)

### Tests removed or replaced

| Change | Replacement coverage |
|--------|---------------------|
| `queue-run-finalization` rewrite | Same preclaim/finalize invariants via Supabase contract |
| `queue-run-lock` / `queue-run-revision-limit` rewrite | Runtime-brake + revision-limit invariants preserved |

## Commits (closure session)

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
| `66e5b69` | test(critical): close misc cluster gates and refresh queue harness stubs |
| `4629a11` | docs(critical): record repaired-cluster and full-suite gate results |
| `0a8dfbb` | fix(queue-inbox): restore canSend gate and canonical queue row fields |
| `8af285f` | test(critical): close canonical misc route and service failures |
| `1d534f4` | fix(inbox): run hard compliance before canSend gate in send-now |

## Build gates (@ `1d534f4`)

| Gate | Result |
|------|--------|
| API lint | PASS |
| API build | PASS |
| Dashboard typecheck | PASS |
| Dashboard build | PASS |
| Runtime doctor | FAIL (dev servers not running — expected without `npm run dev`) |
| Worktree | CLEAN @ `1d534f4` |

## Claim-only classification

**EXTERNALLY BLOCKED — APPROVED INTERNAL FIXTURE REQUIRED**

No remaining code defect blocks claim-only execution. Broad live sending remains prohibited (campaign paused; no approved schedulable internal fixture).

## Explicit status

**READY TO MERGE EXCEPT FOR EXTERNAL CLAIM-ONLY INPUT**

Code suite: 185 files, 2530/2530 PASS. Do not merge to main. Do not deploy. Do not send SMS.

## Commands

```bash
# Misc cluster (23 files)
cd apps/api && NODE_ENV=test PODIO_CLIENT_ID=test PODIO_CLIENT_SECRET=test \
  PODIO_USERNAME=test PODIO_PASSWORD=test INTERNAL_API_SECRET=test \
  BUYER_WEBHOOK_SECRET=test OPS_DASHBOARD_SECRET=test APP_BASE_URL=http://localhost:3000 \
  CRITICAL_TEST_NETWORK_GUARD=1 node --import ./tests/register-aliases.mjs --test \
  $(cat /tmp/misc-cluster-files.txt)

# Repaired cluster (63 files)
cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test \
  $(cat /tmp/repaired-cluster-files.txt)

# Full suite
cd apps/api && npm run test:critical 2>&1 | tee /tmp/canonical-full-critical.log
```