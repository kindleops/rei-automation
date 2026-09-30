# LeadCommand automation inventory — Workflow Studio 3.0 (Phase 1 audit)

Audited 2026-09-30 against the code on `feat/mobile-product-v1` and the production database
(`lcppdrmrdfblstpcbgpf`, read-only SQL). Every volume below is a production count unless marked otherwise.

**Principle:** Workflow Studio observes the automation that already runs; it does not own or re-implement it.
A **system workflow** is drawn from its runtime's own ledger as a read-only topology. A **studio workflow** is
authored, versioned and published on the `wf_*` orchestrator. Whatever is not driven in production is listed
under *Not running* and is never shown as live.

Observatory code: `apps/api/src/lib/domain/workflow-studio/observatory/` (registry, topologies, adapters,
projection, analytics). Read APIs: `/api/cockpit/workflow-studio/observatory/*`.

## Production schedule (the only scheduler)

`infra/cloudflare/worker/index.ts` → `PRODUCTION_CRON_JOBS`. Jobs in one tick are fanned out **concurrently**.

| Lane | Job id | Route | Per-job flag |
|---|---|---|---|
| `*/5` | seller_state_reconciliation | `/api/internal/seller-flow/reconcile-state` | CRON_SELLER_STATE_RECONCILE_ENABLED |
| `*/5` | delivery_reconciliation | `/api/internal/webhooks/recover-delivery` | CRON_DELIVERY_RECONCILE_ENABLED |
| `*/5` | workflow_runtime_tick | `/api/internal/workflows/runtime-tick` | CRON_WORKFLOW_RUNTIME_ENABLED |
| `*/5` | queue_reconcile | `/api/internal/queue/reconcile` | CRON_QUEUE_RECONCILE_ENABLED |
| `*/5` | campaign_activate_due | `/api/internal/campaigns/activate-due` | CRON_CAMPAIGN_ACTIVATE_DUE_ENABLED |
| `*/5` | campaign_feed | `/api/internal/campaigns/feed` | CRON_CAMPAIGN_FEED_ENABLED |
| `*/5` | closing_automation | `/api/internal/closings/automation` | CRON_CLOSING_AUTOMATION_ENABLED |
| `*/5` | workflow_orchestrator | `/api/internal/workflow-studio/orchestrator/tick` | CRON_WORKFLOW_ORCHESTRATOR_ENABLED |
| `* * * * *` | queue_run | `/api/internal/queue/run` (the only SMS sender) | CRON_QUEUE_RUN_ENABLED |
| `* * * * *` | email_dispatch | `/api/internal/email/dispatch` | CRON_EMAIL_DISPATCH_ENABLED |

Deliberately absent (can cause seller-visible sends): queue/retry, queue/force-due, campaigns/recover-stale-expired,
autopilot/run, outbound/feed-master-owners, seller-flow/flush-inbound-bursts, seller-flow/recover-inbound,
webhooks/recover-inbound, offers/recalculate.

Heartbeats observed 2026-09-30 ~11:40Z (`system_control`): `queue_processor_heartbeat_at`, `queue_reconcile_heartbeat_at`,
`campaign_feeder_heartbeat_at`, `closing_automation_heartbeat_at`, `email_dispatch_heartbeat_at`,
`seller_state_reconcile_heartbeat_at`, `workflow_orchestrator_heartbeat_at`, `webhook_delivery_recovery_last_at` — all current.
Stale since 2026-09-17 (Vercel crons removed): `recovery_worker_heartbeat_at`, `follow_up_scheduler_heartbeat_at`,
`webhook_inbound_recovery_last_at`. Campaign **activation** and the V2 runtime tick write **no** heartbeat.

---

## LIVE SYSTEM WORKFLOWS

### 1. Seller Conversation · Inbound — `seller_inbound` (SELLER · owner: Inbox)

| | |
|---|---|
| Runtime | seller-flow orchestrator — `lib/domain/seller-flow/process-seller-inbound-message.js` (`processSellerInboundMessage`, line 646) |
| Trigger | every inbound seller message: TextGrid inbound webhook (deduped by `inbound_processing_ledger`, 135 rows/30d) and Email Command inbound (`handleSellerEmail`) — event-driven |
| Subject | conversation thread (`thread_key`), property, participant |
| Ledger | `seller_automation_executions` (run: `id`, `workflow_id`=`seller-inbound-v1`, `status`, `thread_id`, `property_id`, `source_message_id`, `started_at`, `completed_at`) + `seller_automation_execution_steps` (step: `id`, `action_key`, `execution_status`, `block_reason`, `queue_id`, `selected_template`, `output_summary`, `created_at`) |
| Volume | 212 runs / 30d (62 / 7d); 3,604 blocked + 122 succeeded + 2 failed since 2026-08-03 |
| Versioning | `workflow_id` = `seller-inbound-v1` (single version observed) |
| Heartbeat | none — event-driven; `auto_reply_mode` (= `live_limited`) and `followup_automation_mode` (= `full_live`) are its policies |

**How the ledger is written.** `recordSellerInboundExecutionTimeline`
(`lib/domain/seller-automation/seller-automation-execution-service.js:519-740`) writes the steps **after** the
orchestration, in a fixed order, with synthetic `duration_ms` (≥1 ms). Step order therefore equals recorder order,
and **per-step latency is not measured** by this runtime (the observatory says so; it measures reply → delivery from
`send_queue` instead).

**Real order (steps and conditions):**
`inbound_message_received` → `property_resolved`? → `participant_resolved`? → `phone_thread_resolved` →
`message_classified` → `facts_extracted` → `ownership_confirmed|ownership_inferred|ownership_denied`? →
`seller_interest_detected`? → `asking_price_extracted`? → `property_condition_extracted`? →
`decision_intelligence_evaluated` → (`automatic_reply_selected` → `template_rendered`)? →
`contactability_checked` (succeeded, or **blocked** with the decision's block reason) → `automation_blocked`? →
(`duplicate_send_check` → `message_queued` [+ `message_sent`, a legacy label])? — only when a real queue row exists →
`message_failed`? → `follow_up_scheduled`? → `stage_advanced`? → `operational_status_changed` → `temperature_changed` →
`disposition_changed`? → `contactability_changed`? → `needs_review_created`? → phases → `notification_emitted`.

**Semantics pinned by the audit**
- `contactability_checked = blocked` means the decision carried a **block reason** (30d: `execution_gated` 88,
  `unclear_low_confidence` 38, `auto_reply_mode_disabled` 30, `opt_out` 18, `wrong_number` 9, `recent_outbound` 8,
  `automation_review_required` 4, `property_relationship_review_required` 4, `missing_context` 2,
  `hostile_or_legal_intent` 2). Nothing is sent automatically — but the reply may still be drafted as a queue row in the
  canonical **review hold** (`paused_operator_review`, `lib/domain/queue/queue-authority.js:51`) for a person to release.
- `message_sent` is the recorder's label, never send truth. **The queue row owns the send result** (delivered /
  failed_transport / blocked_by_health_guard / cancelled / review hold).
- "Needs you" = a review item whose conversation is still open in `v_inbox_thread_state_buckets`
  (`in_needs_review` or `in_new_replies`).
- Structured AI output lives on the inbound `message_events.metadata` (`detected_intent`, `classification_confidence`,
  `payload.metadata.emotion`, `language`, `automation_decision.{next_action, reply_mode}`) — shown as fields, never prose.
- Side effects: `send_queue` rows (canonical queue writer), `inbox_thread_state` via `patchUniversalLeadState`
  (`universal_lead_state_events`, source `seller_inbound_orchestrator`), `notification_events` (`inbox_*`),
  `automation_events` (source `seller_inbound_orchestrator`: HUMAN_REVIEW_REQUESTED 61, AUTOMATION_NEEDS_REVIEW 36,
  AUTOMATION_BLOCKED 33, SUPPRESSION_APPLIED 24, SELLER_NOT_INTERESTED 19, OWNER_CONFIRMED 15, …), shadow
  `seller_automation_decisions` (134/30d, acquisition-brain shadow, `execution_result.queued=false` on every row).
- Subworkflows: **Offer negotiation** (S3–S6) and **Opt-out & DNC** (below). Handoff: queue_reply → **Queue Dispatch**.
- Waits / retries: follow-up scheduling (cancelled on any reply); no retries inside the run.
- Tests: `seller-inbound-orchestration.test.mjs`, `workflow-observatory.test.mjs`, `workflow-observatory-registry.test.mjs`.

### 2. Outbound Dispatch · Queue Runner — `queue_dispatch` (DELIVERY · owner: Queue)

| | |
|---|---|
| Runtime | `lib/domain/queue/process-send-queue.js` — `processSendQueue` → `processSendQueueItem` (2743) → `processSupabaseQueueItem` (1434) |
| Trigger | Cloudflare `* * * * *` (`queue_run`, no body — caps come from `system_control`) |
| Subject / run id | one `send_queue` row (`id`) |
| Order | operator brakes (`evaluateCanonicalSendAuthority`: execution mode, processor mode, emergency stop) → campaign authority (paused → deferred, 423) → atomic claim (`queue_claim_audit`, 41k claims/7d over 731 rows — due rows are re-claimed every minute) → contact window (defer) → sender selection (`blocked_sender_ineligible`) → deferred body (`paused_deferred_unresolved`) → template↔asset reselection → seller-name guard (`paused_name_missing`) → hard idempotency lock (`duplicate_blocked`) → blank-greeting / asset guards (`blocked`) → stale auto-reply guard (`cancelled`) → SMS health guard (`blocked_by_health_guard`) → compliance (`evaluateAndBlockSendAtCompliance` → `evaluateCanonicalContactability` → suppression; re-checked before every dispatch) → §11 canonical dispatch (`dispatchSellerQueueRow`) → `finalizeSendQueueSuccess` (`sent`, send-success seam lead-state writes) → delivery result later (callback / reconciler: `delivered` or `failed_transport`/`delivery_failed`) |
| Ledger | `send_queue` (status + timestamps), §11 `seller_logical_communications` (837/30d) + `seller_communication_attempts` (836/30d: 826 provider_accepted, 8 recipient_opted_out, 1 ambiguous, 1 operator_hold), `queue_claim_audit`; `seller_provider_callback_events` = **0 rows** (callbacks are not landing; delivery arrives via reconciliation) |
| Volume | 948 rows / 7d; 30d statuses include delivered, failed_transport, blocked_by_health_guard, cancelled, queued, sent, failed, paused_* |
| Retries | none in production (`attempt_number` is 1 on every attempt ever recorded) |
| Heartbeat | `queue_processor_heartbeat_at` (current) |
| Tests | `queue-*`, `campaign-pause-blocks-dispatch.test.mjs`, `cloudflare-cron-scope.test.mjs`, observatory registry test (status → gate mapping) |

The runner keeps no per-guard ledger, so a run's path is read from the row's own terminal status: every gate before
the deciding gate is shown as passed, nothing after it is drawn, and an unclaimed row waits at "due".

### 3. Delivery Reconciliation — `delivery_reconcile` (DELIVERY · owner: Queue)

`webhooks/recover-delivery` (`include_polling_fallback: false`) ∥ `queue/reconcile` on `*/5`. Writes only
delivered/terminal states (disjoint from claimable statuses). **No per-run ledger** — only
`webhook_delivery_recovery_last_{at,groups,webhooks,execution_id}` and `queue_reconcile_heartbeat_at`. Shown live with a
heartbeat; node volumes are declared *not observable*.

### 4. Campaign Execution · Activation & Feeding — `campaign_execution` (CAMPAIGN · owner: Campaign Command)

| | |
|---|---|
| Runtime | `lib/domain/campaigns/campaign-activation-orchestrator.js` (activate-due) ∥ `run-campaign-outbound-feeder.js` (feed) → `campaign-automation-service.js` (`createCampaignQueuePlan`) |
| Trigger | Cloudflare `*/5`, both jobs concurrent, no body |
| Activation | due `scheduled` campaigns (≤ 20) → missed if > 2 h stale (`metadata.schedule_missed_*`, never fired late, stays `scheduled`) → launch readiness (blocking codes; nothing persisted; retried each tick) → hydrate first chunk → `scheduled → activating → active` (`campaign_transition_status`) → `campaign_events campaign.activated` (**no run_id; writes no campaign_runs row** — verified 2026-09-30) |
| Feeder | `queue_auto_enqueue_enabled` gate → feedable campaigns → spam recycle (1 retry, different template) → `resolveFeedLimit` (buffer 150, chunk 100, daily/total caps) → queue plan (eligibility, routing, window) → completion (`active → completed`) or stalled |
| Ledger / run id | `campaign_runs` (`launch_queue_plan`, 4,783/30d, 587/7d; `queue_rows_created`, `blocked_counts`, `metadata.caps`) + `campaign_events` (`campaign.launch_scheduled` 587/7d, `campaign.activated` …) + `campaigns.metadata.feeder_last` (overwritten each tick) |
| Heartbeat | `campaign_feeder_heartbeat_at` + `campaign_feeder_last_*` (feeder only) |
| Tests | `campaign-full-cohort-execution`, `campaign-send-pipeline`, `campaign-queue-plan-hydration`, `campaign-pause-blocks-dispatch`, `campaign-resume-*`, `cloudflare-cron-scope` |

### 5. Closing Execution · Title & Buyer Coordination — `closing_execution` (CLOSING · owner: Closing Desk)

`lib/domain/closings/closing-automation.js` (`runClosingAutomation`/`planClosingAutomation`) on `*/5`; kill switch
`closing_automation_enabled` (= true). One run = one closing case. Title open → ack (24 h × 3) → commitment (can start
without ack) → clear to close (close −72 h) → settlement (close −36 h, every 12 h); closing confirmation per confirmed
date (independent of clear to close); buyer EMD ∥ buyer agreement; escalation once per category
(`automation_escalated`, `closing_party_unreachable`); pause withdraws pending requests; **only an operator
finalizes** (`finalize_closing_case`). Ledgers: `closing_cases.automation_state.escalations`, `closing_email_requests`,
`closing_activity_events`, `closing_milestones`. Heartbeat current; **production has zero live closings** (one voided
case) — shown live with "no live closings".

### 6. Email Dispatch · Revalidate & Send — `email_dispatch` (EMAIL · owner: Email Command)

`lib/domain/email/email-dispatch.js` every minute: bridge closing requests → reap stuck (> 15 min, never re-sent) → send
gate (`system_control.email_enabled` ∧ env `EMAIL_SEND_ENABLED`) → claim once → revalidate (defer / fail / supersede /
cancel / escalate / send) → Brevo → retry 5 min × 2ⁿ (max 3) → delivered via webhook. Ledger `email_queue` +
append-only `email_events`. Heartbeat current, `email_enabled=false`: **status OFF — zero email rows ever**.

### 7. Lead-State Reconciliation — `lead_state_reconcile` (SYSTEM · owner: Inbox)

`seller-flow/reconcile-state` on `*/5`, one-entry sweep allowlist, send-incapable. Restores a missing `next_action`
from the canonical opportunity, or writes `human_review` when there is no canonical evidence. Ledger
`universal_lead_state_events` (source_view `seller_execution_gap_recovery`: 430 `human_review`, 4 `send_message_now`,
1 `schedule_follow_up` in 30d) + `automation_events RECOVERY_NEXT_ACTION_RESTORED`. Heartbeat
`seller_state_reconcile_heartbeat_at`, switch `seller_state_reconcile_enabled`.

### 8. Operator Notifications — `operator_notifications` (COMMUNICATION)

`lib/domain/notifications/notification-emitter.js` (`emitNotificationFromBusinessEvent`) → `notification_events`
(246/30d; deduplication_key upsert, grouping). Event-driven from seller flow (`inbox_*`), campaigns
(`campaign_*`), closing, the orchestrator (`inbox_needs_call` ×2).

### 9. Canonical Event Bridge — `event_bridge` (SYSTEM)

`workflows/runtime-tick` (`canonical-event-bridge.js`) on `*/5`: `automation_events` → `workflow_events` (251/30d,
dedupe_key unique, overlapping window). Consumers: the Studio orchestrator (durable cursor). The Workflow V2 matcher
selects nothing (no real definition is `active`). No heartbeat key.

### 10. Opt-out & DNC — `dnc_opt_out` (subworkflow of seller inbound)

Seller opt-out → block reason `opt_out` → `sms_suppression_list` (13/30d) + `SUPPRESSION_APPLIED` +
`contactability_changed` + `inbox_opt_out_received` notification; the queue runner's compliance gate re-checks
suppression before every dispatch. Production proof: run `b4568a74` → suppression row present.

### 11. Offer Negotiation · S3–S6 — `offer_negotiation` (subworkflow of seller inbound)

Seller negotiation engine, evidenced by `automation_events` source `seller_negotiation_engine` (30d: offer_queued 33,
review_required 27, underwriting_recalculated 12, underwriting_completed 10, strategy_selected 10, asking_price_captured 8,
comp_anchor_selected 6, …). One run = one burst of engine events for one conversation (≤ 3 min apart).

### 12. Acquisition Decision · Comps & Valuation — `decision_engine` (ACQUISITION, on demand)

`ensurePropertyAcquisitionDecision` (`lib/acquisition/decisionAuthority.js`); immutable `acquisition_score_snapshots`
(34/30d; engine 2.0.0; tiers CREATIVE_TERMS 22, AUTO_HARD_OFFER 8, AUTO_RANGE_OFFER 3, NURTURE 1). Invoked by the seller
flow / negotiation / Deal Intelligence. No schedule.

### 13. Buyer Matching — `buyer_matching` (BUYER, on demand)

Buyer Match workspace; `buyer_match_runs` (31 total, last 2026-09-18). Idle (no run in 7 days).

## STUDIO WORKFLOWS (wf_* orchestrator)

`seller_review_escalation` — **armed**, v1 (`wf_workflows`, `wf_versions`), 2 runs, both `completed/escalated`
(runs `397d93a5`, `3f2f2c59`). Path proof: `grace:waiting → still_open:resolved→Open → escalate:succeeded` matches the
observed `trigger → grace → still_open → escalate → escalated`. Orchestrator heartbeat current; cursor advances;
last summary: 0 events started since arming (no new `human_review_requested` after 18:15:56Z on 09-29).

## NOT RUNNING (built, never shown as live)

| Key | Why |
|---|---|
| `delivery_retry` | queue/retry not scheduled; `retry_enabled=false`; zero attempts beyond #1 ever; `workflow-v2/delivery-recovery.js` undriven |
| `inbound_burst_flush` | flush-inbound-bursts / recover-inbound deliberately unscheduled; heartbeats stopped 2026-09-17 |
| `follow_up_scheduler_legacy` | `follow_up_scheduler_heartbeat_at` stopped 2026-09-17 |
| `autopilot` | autopilot/run excluded from the production schedule |
| Workflow V2 templates (14 `system_*` published, 2 drafts) | published, never subscribed — no production event matches; `test_wf1/test_wf2` are test fixtures (hidden) |

## Findings worth the owner's attention

1. **Seller ledger drift (7 days):** 2 runs end without `notification_emitted`; 1 run goes classify → render with no
   decision; 1 goes facts → reply with no decision (the drift monitor lists them).
2. **Provider callbacks are not landing** (`seller_provider_callback_events` = 0); delivery truth arrives only through
   the */5 reconciler.
3. **Review holds that never resolved:** 6 `auto_reply` + 17 `inbox_bulk_follow_up` rows sit in
   `paused_operator_review` since 2026-09-11/12.
4. Campaign activation writes no heartbeat and no run row; a readiness-blocked activation leaves no trace until it is
   marked missed.
5. The queue runner re-claims every due-but-deferred row each minute (41k claim audits / 731 rows / 7 days).
6. The legacy observatory labelled campaigns "paused" from `campaign_mode`, which neither campaign job reads.
