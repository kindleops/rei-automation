# Deterministic Automation Engine Audit

## Existing Files And Functions To Reuse

- `apps/api/src/lib/flows/handle-textgrid-inbound.js`
  - TextGrid inbound normalization, classification, inbox state patching, brain/master-owner updates, negative-reply queue cancellation, guarded auto-reply planning, Discord notifications.
- `apps/api/src/lib/flows/handle-textgrid-delivery.js`
  - TextGrid delivery normalization, message-event/queue correlation, queue delivery updates, phone compliance updates, failure classification.
- `apps/api/src/lib/domain/queue/process-send-queue.js`
  - Send queue runtime brakes, health guard, TextGrid send execution, success/failure finalization.
- `apps/api/src/lib/domain/queue/build-send-queue-item.js`
  - Queue item construction, template reference resolution, message safety normalization.
- `apps/api/src/lib/domain/queue/cancel-pending-queue-items.js`
  - Existing Podio pending queue cancellation for negative replies.
- `apps/api/src/lib/domain/seller-flow/seller-followup-scheduler.js`
  - Deterministic follow-up planning and idempotent scheduled follow-up insertion.
- `apps/api/src/lib/domain/seller-flow/apply-inbound-automation-decision.js`
  - Existing suppression/write helpers for inbound seller-flow decisions.
- `apps/api/src/lib/domain/master-owners/run-master-owner-outbound-feeder.js`
  - Master-owner outbound feeder.
- `apps/api/src/lib/domain/outbound/supabase-candidate-feeder.js`
  - Supabase candidate loading, sender/routing data, template source logic.
- `apps/api/src/lib/domain/delivery/sms-health-guard.js`
  - Sender/template health guard decisions before live sends.
- `apps/api/src/lib/domain/messaging/textgrid-failure-normalization.js`
  - Provider failure normalization.
- `apps/api/src/lib/domain/messaging/textgrid-sender-health.js`
  - Sender health classification.
- `apps/api/src/lib/domain/ops/proactive-notifications.js`
  - Existing ops notification patterns and `ops_notifications` reuse.
- `apps/api/src/app/api/cockpit/inbox/thread-state/route.js`
  - Existing cockpit status/stage/temperature mutation surface.
- `apps/api/src/app/api/cockpit/threads/[thread_key]/route.js`
  - Existing universal deal-thread mutation surface.
- `apps/dashboard/src/modules/inbox/InboxPage.tsx`
  - Dashboard workflow surface only; no automation ownership should move here.

## Existing Tables To Reuse

- `message_events`
- `send_queue`
- `inbox_thread_state`
- `deal_thread_state`
- `deal_thread_state_events`
- `phones`
- `sms_suppression_list`
- `contact_outreach_state`
- `ops_notifications`
- `sms_templates`
- `textgrid_numbers`
- `campaigns`, `campaign_targets`, `campaign_runs`, `campaign_events`
- `sms_campaigns`, `sms_campaign_targets`
- `campaign_target_graph`
- `deal_context_index`
- `system_control`

## Current State Patch Targets

Automation does not create new canonical state tables in this slice.

- Inbox/Pipeline/List/Queue-visible thread patches currently write to `inbox_thread_state` through `patch_thread_state`, `update_thread_status`, `update_stage`, and `update_temperature`.
- Deal-thread cockpit mutations still write to `deal_thread_state` and `deal_thread_state_events`; those routes only emit automation events after the primary mutation succeeds.
- Queue cancellation writes to existing `send_queue` rows and only targets active queue statuses.
- Message delivery/inbound provider state remains in `message_events` and the existing TextGrid/queue flows; automation receives emitted events after those primary writes.
- Suppression writes to the automation ledger `automation_suppressions` and mirrors to `sms_suppression_list` or `phones` when those existing tables/columns are available.

If a target table or column is missing or pending migration, the action records a skipped audit reason instead of inventing a fallback table.

## Idempotency Strategy

- Event idempotency uses `automation_events.dedupe_key`, derived from explicit emitter keys first, then provider message IDs, queue IDs, thread context, message body, and status.
- Action idempotency uses `automation_actions.dedupe_key` from event dedupe/id, rule key, action type, and stable JSON-hashed params.
- Suppression idempotency uses `automation_suppressions.dedupe_key` from normalized phone plus suppression type, so repeated STOP/wrong-number events update one active suppression row.
- Notification idempotency uses `ops_notifications.notification_key` from rule key, event dedupe/id, and notification type.
- Follow-up planning remains dry-run by default and records one action per deduped delivered/no-reply event. Live queue writes require `AUTOMATION_LIVE_SENDS_ENABLED=true`, `WORKFLOW_LIVE_SENDS_ENABLED=true`, `allow_send_queue_writes`, and action/rule `live_enabled=true`.

## Missing Tables

Before this pass, there was no central deterministic automation ledger. Added:

- `automation_events`
- `automation_rules`
- `automation_actions`
- `automation_runs`
- `automation_suppressions`
- `automation_audit_log`

## Missing Service Modules

Before this pass, automation logic existed in separate webhook, queue, seller-flow, and dashboard paths. Added:

- `apps/api/src/lib/domain/automation/automation-engine.js`
- `apps/api/src/lib/domain/automation/automation-events.js`
- `apps/api/src/lib/domain/automation/automation-rules.js`
- `apps/api/src/lib/domain/automation/automation-actions.js`
- `apps/api/src/lib/domain/automation/automation-audit.js`
- Rule modules under `apps/api/src/lib/domain/automation/rules/`

## Suggested Integration Points

- Emit `inbound_message_received` from TextGrid inbound after existing classification/state updates complete.
- Emit `outbound_message_delivered` and `outbound_message_failed` from TextGrid delivery after normalized delivery correlation completes.
- Emit `queue_item_sent` and `queue_item_failed` from the queue processor after terminal send outcomes.
- Emit `status_changed`, `stage_changed`, and `temperature_changed` from cockpit thread-state mutation endpoints.
- Ingest `template_performance_changed`, `sender_health_changed`, `market_health_changed`, and `deal_intelligence_changed` through `/api/internal/automation/ingest-event` until their refresh workers are identified.

## What Not To Touch Yet

- No React component should own automation logic.
- Do not add AI features to this engine.
- Do not send live outbound messages from automation rules.
- Keep `AUTOMATION_LIVE_SENDS_ENABLED` and `WORKFLOW_LIVE_SENDS_ENABLED` false until Workflow Studio has an explicit send-safety review.
- Do not fully pause sender numbers from sender-health rules without an explicit runtime flag.
- Do not delete or mutate templates destructively; mark recommendations only.
- Do not replace existing TextGrid, queue, feeder, seller-flow, or dashboard state services.
