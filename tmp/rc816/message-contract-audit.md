# LeadCommand 8.5.16: outbound message contract audit

Read-only code audit of `apps/api/src` at the rc-8.5.16 base (6ecbae6b plus the R3 work), plus read-only production catalog diagnostics on 2026-10-15. Paths are relative to `apps/api/src`. The last section records what 8.5.16 changes.

## 1. Queue writers (every producer of `send_queue` rows)

| Writer | template_id / selected_template_id | template_source | metadata.source | Body |
|---|---|---|---|---|
| `app/api/dev/send-test/route.js` | none | default `catalog` | `dev_send_test` | free text (dev) |
| `app/api/internal/proof/s1s2-attended/route.js` | from the proof runner | n/a | n/a | proof |
| `lib/domain/acquisition/delivery-retry-engine.js` | new template, both | `template.source` | `default_acquisition_delivery_retry` | sms_templates |
| `lib/domain/acquisition/inbound-dispatcher.js` | template, both | `template.source` | `default_acquisition_inbound_dispatcher` | sms_templates |
| `lib/domain/acquisition/no-reply-followup-scheduler.js` | both | `template.source` | `default_acquisition_engine` | sms_templates |
| `lib/domain/buyers/materialize-buyer-outreach.js` | **not passed** | `catalog` | none (`send_kind` buyer) | caller body |
| `lib/domain/campaigns/enqueue-campaign-target-one.js` | both + metadata | `catalog` | `enqueue_campaign_target_one` | sms_templates + persona |
| `lib/domain/closings/advance-closing-workflow.js` | none (deferred resolution) | n/a | none | rendered at send |
| `lib/domain/inbound/unknown-inbound-router.js` | none | `catalog` | `textgrid_inbound_unknown_router` | free text |
| `lib/domain/inbox/send-now-service.js` | caller (manual: null) | caller | `manual_inbox` / `map_command` / `inbox` | operator text or picked template |
| `lib/domain/outbound/run-supabase-outbound-feeder.js` | spreads `rendered.queue_payload` | n/a | n/a | appears unused |
| `lib/domain/queue/build-send-queue-item.js` | `selected_template_id` | Podio / catalog | `build_send_queue_item` | template |
| `lib/domain/queue/canonical-queue-writer.js` | **metadata.template_id only** | n/a | `canonical_queue_writer` | caller body |
| `lib/domain/seller-flow/apply-inbound-automation-decision.js` | both | `sms_templates` | `auto_reply` | sms_templates |
| `lib/domain/seller-flow/execute-referral-automation.js` | both | not set | `referral_automation` | sms_templates |
| `lib/domain/workflow-v2/queue-adapter.js` | input | n/a | `workflow_v2` | caller body |
| `lib/sms/queue_message.js` | `resolution.template_id` | `resolution.source` or `catalog` | `queue_message` | rendered |
| `lib/domain/campaigns/campaign-automation-service.js` (**direct `.insert`**) | both + `template_key` | `sms_templates` | `campaign_launch_execution` | sms_templates, `agent_name` = persona |
| `lib/ai/conversation-ai-r3-executor.js` (8.5.16, unwired) | **none** (origin `ai_generated`) | `ai_generated` | `ai_conversation` | AI text with an immutable record |

Production (last 30 days, read-only): `send_queue.template_source` is an overloaded label: `sms_templates`, `catalog`, `manual_composer`, `fus2_bulk_conversation_restart`, and so on. Before 8.5.16 there was no origin column.

## 2. Insert path (`lib/supabase/sms-engine.js`)

- `insertSupabaseSendQueueRow`: sanitize, normalize, `attachOutboundProvenance`, internal-canary stamp, inbox send-now validation, then `buildSendQueueInsertPayload`.
  - Columns are whitelisted (`SEND_QUEUE_INSERT_COLUMNS`); unknown keys go to `metadata.unknown_payload_fields`.
  - Defaults: `template_source='catalog'`, `type='outbound'`, `selected_template_id ||= template_id`, `template_key ||= template_id`.
- `outbound-provenance.js` stamps `outbound_provenance_v1` (source surface from aliases; `template_id`; `automation_origin`).
- The campaign launch bulk insert bypasses this helper entirely.

## 3. Dispatch guards (`lib/domain/queue/process-send-queue.js`, in order)

1. in-session evaluation
2. acquisition runtime
3. row id
4. no_send / not sendable
5. claim
6. debug key
7. **AI row gate** (8.5.16)
8. contact window (hold / defer; in-session bypass for reply-shaped rows only)
9. destination
10. **sender selection**
11. deferred-message resolution
12. **template-asset reselection** (can swap body and template; 8.5.16 exempts verified AI rows)
13. seller-name guard
14. hard idempotency (row SID → never resent; same body / number within 24h)
15. blank greeting
16. asset guard
17. superseded auto-reply (any row with an inbound id; covers AI rows)
18. governance read
19. SMS health guard (keys on template_id)
20. dispatch authorization
21. compliance:
    - canonical contactability
    - send-time contact guard (STOP, suppression, wrong number, not-owner)
    - **template authority**
22. canonical dispatch seam (identity, runtime authority, em-dash content check)
23. provider duplicate
24. TextGrid blank-greeting check

Guards keyed on template_id: 12, 16, 18, 19, 21 (template authority).

## 4. Template authority and pre-claim

- **Template authority** (`templates/template-authority.js`): manual operator copy is allowed; a missing, registry or code id is refused (`template_not_in_supabase`, held for a human). Otherwise the id is looked up in sms_templates. Body binding is enforced only for free-text producers. `is_active` is not checked (pre-existing).
- **Pre-claim** (`sms-engine.js` `preclaimInvalidQueueRowReason`): checks id, body and phones, then `paused_review`, then canonical thread key. Manual and unknown-auto-reply rows are exempt. Otherwise it requires `missing_selected_template_id`, then `missing_candidate_snapshot`, then `missing_seller_first_name`.

## 5. Sender routing

- `selectAvailableTextgridNumber` uses the send class (`delivery/send-class.js`), which keys on source / type / message_type / queue_key prefix. Then Routing 2.0, revalidation, sticky thread selection and the blocklist.
- No routing code keys on template_id; the SMS health guard does.

## 6. message_events

- The live writer is `buildSuccessMessageEvent`, upserted on `outbound_<queue_key>`.
- It copies the `template_id` column, `sms_agent_id`, `metadata.source`, stage and language. It does not copy `use_case_template`, `selected_template_id` or `template_source`.
- Delivery callbacks go through `syncDeliveryEvent`, matched by provider SID.

## 7. Provider adapters and retries

- TextGrid receives `{body, from, to}` only, through the canonical dispatch seam.
- Retries:
  - requeue only on a retryable classification and `retry_count + 1 < max_retries`;
  - content-filter template rotation only for rows with an originating template id;
  - a row SID never resends.
- AI rows: `max_retries = 0` and no template id, so neither retry nor rotation applies.

## 8. KPI joins on template_id

- **SQL (live):** `v_template_performance`, `v_template_sender_performance` (`send_queue.template_id = sms_templates.template_id`), `message_attribution_events_v` (no `manual_inbox` fallback in the live definition), `template_performance_kpis_v`, `performance_message_events_v`.
- **JS:** `metrics/war-room-service.js`, `templates/template-intelligence-*.js`, `analytics/lab/*`, `intelligence/features/v1-features.js`, `cockpit/ops/metrics`.
- AI rows carry no template id, so they never inflate template statistics. 8.5.16 gives them their own war-room bucket (`origin:ai_generated`).

## 9. Personas (flagged for the owner, not decided)

- `outbound/outbound-persona.js` resolves a persona in this order: thread (names already shown) → campaign → owner → stable distribution (Helen Crawford, Michael Hargrove, …). A conflict is held.
- Templates sign with `{{agent_name}}` ("this is {{agent_name}}"); some seeded templates carry `agent_persona='Alex'`.
- **Conflict for the owner:**
  - Directive: AI must never claim to be a specific human unless an established persona is the thread convention. Established threads DO sign with a human first name today.
  - Playbook v1 default (`PERSONA_POLICY_DEFAULT.allow_established_persona = false`): AI never uses a name. A name is accepted only when the owner enables persona use AND the name equals the thread's established persona.
  - The R1 shadow prompt (`conversation-ai/prompts.js`) still tells the model to use "the agent name we signed with". The validator overrides it.
  - Owner decision needed: may AI replies continue an established persona?

## 10. What 8.5.16 changes

- **Origin column:** `send_queue.message_origin` (PROPOSED). It is written only by the AI path; NULL means the legacy derivation (operator_manual for manual composer, template otherwise).
- **AI message records:**
  - `public.ai_generated_messages` (immutable; no template id; provenance, sealed identities, authorization, body hash; linked by `queue_key`).
  - `public.ai_generated_message_events` (append-only lifecycle).
  - DB guard trigger: ai_generated rows need their record and no template id; any `ai-msg:` id is refused.
- **Code-side origin handling:** template authority, pre-claim, the runner name guard, asset reselection, the AI row gate (record, policy, latest-inbound staleness), provenance, message_events metadata and the war-room bucket now treat `ai_generated` as a first-class origin.
- **Byte-identity:** every other producer's insert payload, success-event metadata, provenance, template-authority verdict and pre-claim verdict is identical to production. `tests/fixtures/origin-byte-identity.golden.json` was generated from 6ecbae6b.
