# SMS Automation Readiness Audit

Date: 2026-06-01

Verdict: `NOT_READY` until controlled system-control flags are intentionally opened and the new proof scripts pass in the target environment.

## Critical Paths

| Component | Path | Wired | Gates / Controls | Current Safety |
|---|---|---:|---|---|
| Queue runner route | `apps/api/src/app/api/internal/queue/run/route.js` | Yes | `queue_runner_enabled`, `outbound_sms_enabled`, `auto_reply_live_enabled`, `queue_processor_mode`, emergency stop | Uses `runSendQueue` and runtime brakes. |
| Queue processor | `apps/api/src/lib/domain/queue/run-send-queue.js` | Yes | Runtime brakes, queue/system flags | Reconciles stale lifecycle before processing rows. |
| Send path | `apps/api/src/lib/domain/queue/process-send-queue.js` | Yes | Runtime brakes, contact window, manual-send checks | Now blocks bad sender numbers, toxic templates, and first-touch regional fallback before TextGrid. |
| Retry route | `apps/api/src/app/api/internal/queue/retry/route.js` | Yes | Cron/engine auth and `retry_enabled` | Now supports dry-run and canonical terminal/transient classification. |
| Retry engine | `apps/api/src/lib/domain/queue/retry-send-queue.js` | Yes | `retry_enabled` through route/runner | 21610, blacklist, opt-out, wrong number, invalid/deactivated, and carrier permanent failures are never retried. |
| Reconcile route | `apps/api/src/app/api/internal/queue/reconcile/route.js` | Yes | `reconcile_enabled` and route auth | Reconciles queue lifecycle and delivery truth. |
| Canonical delivery helper | `apps/api/src/lib/domain/delivery/canonical-delivery-state.js` | Yes | Pure helper | Centralizes delivered/failed/pending, retryable, terminal, suppression-required decisions. |
| SMS health guard | `apps/api/src/lib/domain/delivery/sms-health-guard.js` | Yes | Env/system-control blocklists | Emergency-blocks `+14704920588`, `+14693131600`, templates `208481`, `204257`, `204529`, `204561`, `204705`, `204721`, `207681`. |
| Feeder route | `apps/api/src/app/api/internal/outbound/feed-master-owners/route.js` | Yes | `feeder_enabled`, `outbound_sms_enabled`, campaign/queue creation brakes | Uses sender routing; Supabase feeder now passes health guard before queue insert. |
| Supabase feeder | `apps/api/src/lib/domain/outbound/supabase-candidate-feeder.js` | Yes | `campaign_mode`, `queue_auto_enqueue_enabled`, emergency stop, caps/filters | First-touch/local routing blocks non-exact sender fallback. |
| Autopilot runner | `apps/api/src/app/api/internal/autopilot/run/route.js` | Present | Route/system controls | Needs controlled-mode proof before opening. |
| Inbound webhook | `apps/api/src/app/api/webhooks/textgrid/inbound/route.js` | Yes | Webhook route into handler | Calls handler with idempotency and classification path. |
| Inbound handler | `apps/api/src/lib/flows/handle-textgrid-inbound.js` | Yes | `auto_reply_enabled`, `followup_enabled`, auto-reply mode, emergency stop | Timezone/contact-window overrides now derive safely without undefined variables. |
| Auto-reply decision | `apps/api/src/lib/domain/seller-flow/apply-inbound-automation-decision.js` | Yes | auto-reply mode and queue creation brakes | Live queue insert now accepts safe timezone/contact-window overrides. |
| Auto-reply plan | `apps/api/src/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js` | Yes | Safety policy and template lookup | Suppresses opt-out/wrong/legal paths. |
| Seller stage queueing | `apps/api/src/lib/domain/seller-flow/maybe-queue-seller-stage-reply.js` | Yes | Caller controls queue/preview | Handles contact windows internally; proof uses dry-run capture. |
| Inbound follow-up scheduler | `apps/api/src/lib/domain/seller-flow/seller-followup-scheduler.js` | Yes | `followup_enabled` in inbound handler | Handles inbound-driven nurture follow-ups, not unanswered outbound follow-ups. |
| TextGrid delivery webhook | `apps/api/src/app/api/webhooks/textgrid/delivery/route.js` | Yes | Webhook route into handler/sync | Provider failed/undelivered is reconciled against queue/message events. |
| Delivery flow | `apps/api/src/lib/flows/handle-textgrid-delivery.js` | Yes | Webhook payload normalization | Updates queue and event status; maps provider failures. |
| Delivery sync | `apps/api/src/lib/supabase/sms-engine.js` | Yes | Supabase storage | Maintains canonical lifecycle and failed/delivered truth. |

## Fixes Applied

- Added `resolveCanonicalDeliveryState` to make retry decisions deterministic.
- Added `evaluateSmsHealthGuard` with default emergency sender/template blocklists.
- Wired health guard into `process-send-queue.js` before `sendTextgridSMS`.
- Wired health guard into `supabase-candidate-feeder.js` before queue row creation.
- Hardened `retry-send-queue.js` to skip terminal/permanent failures and only retry transient classes.
- Added retry dry-run support in `queue/retry/route.js`.
- Added safe inbound autopilot timezone/contact-window derivation and passed it into live auto-reply queue insertion.
- Tightened TextGrid sender selection for first-touch/local-routing exact-market requirements.

## Unsafe / Blocking For Full Automation

- Current production controls in the provided runtime state are still locked down: `auto_queue_enabled=false`, `queue_auto_enqueue_enabled=false`, `queue_auto_send_enabled=false`, `queue_processor_mode=off`, `campaign_mode=paused`, `retry_enabled=false`.
- Retry should remain disabled until live proof confirms non-retryable failures are terminal and suppressed in production data.
- Sender/template blocklists are emergency defaults; they should be moved into managed system-control values once stable.
- No complete unanswered-text scheduler exists yet. See `apps/api/docs/unanswered-text-followup-plan.md`.
- `podio_sync_enabled=false` in the provided state, so Podio backfill/sync assumptions must be checked before scale.
- Existing caps and Houston/TX filters indicate a constrained test window, not scale readiness.

## Proof Scripts

- `scripts/proof/sms-automation-readiness-audit.mjs`
- `scripts/proof/sms-retry-safety-proof.mjs`
- `scripts/proof/sms-autopilot-dry-run-proof.mjs`
- `scripts/proof/sms-health-guard-proof.mjs`
- `scripts/ops/enable-controlled-sms-autopilot.mjs`

## Readiness Levels

- `NOT_READY`: any critical code blocker exists, proof scripts fail, system_control is unavailable, or controlled flags remain paused/off.
- `READY_FOR_CONTROLLED_AUTOPILOT`: critical proofs pass and low-volume controlled flags are enabled with retry disabled and local routing required.
- `READY_FOR_SCALE`: not asserted by this audit. Scale requires a separate delivery-health window, sender/template rotation review, cap review, and retry re-enable proof.
