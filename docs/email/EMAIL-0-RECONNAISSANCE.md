# EMAIL-0 — Reconnaissance & Architecture

Status: complete
Date: 2026-09-08
Scope: what exists today for email, what exists for SMS that email must reuse, and the
implementation sequence that follows from both.

Every claim below was verified against the repository at `claude/email-infrastructure-recon-nk15mh`
and against the live Supabase project `lcppdrmrdfblstpcbgpf` (`real-estate-automation`). Where the
code and the database disagree, that disagreement is recorded as a defect, not smoothed over.

---

## 1. What currently exists for email

### 1.1 Three overlapping code layers, two of them pointed at tables that do not exist

| Layer | Files | Tables it targets | Exists in production? |
|---|---|---|---|
| Queue layer | `apps/api/src/lib/email/{queue-email,process-email-queue,brevo-client,email-suppression,render-email-template}.js` | `email_send_queue`, `email_templates`, `email_identities`, `email_suppression`, `contact_outreach_state` | **No** — only `email_templates` and `contact_outreach_state` exist |
| Service layer | `apps/api/src/lib/domain/email/{email-service,brevo-provider}.js` | `email_messages`, `email_events`, `email_drafts`, `email_senders`, `email_suppression`, `v_email_records` | **Partly** — only `email_events` and `email_senders` exist |
| SMTP transport | `apps/api/src/lib/providers/email.js` (646 lines, hand-rolled SMTP over `node:tls`) | n/a | Unused by any seller path |

Both email layers were written against `apps/api/supabase/migrations/20260421_create_email_layer.sql`
and `20260531222758_brevo_email_backend_foundation.sql`. **Neither migration has ever been applied.**
`supabase_migrations.schema_migrations` contains no corresponding version.

Concrete consequences, each independently fatal to a live send:

* `queueEmail()` inserts into `email_send_queue` — table does not exist.
* `processEmailQueue()` selects from `email_send_queue` — table does not exist.
* `sendManualEmail()` / `getEmailThreads()` / `getEmailThread()` read and write `email_messages` — table does not exist.
* `getEmailRecords()` selects from `v_email_records` — view does not exist. The Email Command Center's entire records grid depends on it.
* `checkEmailSuppression()` and `suppressEmail()` read/write `email_suppression` — table does not exist. **There is no email suppression list in production at all.**
* `saveEmailDraft()` writes `email_drafts` — table does not exist.

### 1.2 Column drift against the tables that *do* exist

Even where the table exists, the code names columns the table does not have:

* `renderEmailTemplate()` reads `template.html_body` / `template.text_body`. Production `email_templates` stores the body in **`template_body`** and has no `html_body`. Every render would produce an empty body and return `rendered_template_invalid`.
* `resolveSenderIdentity()` queries `email_senders.sender_email`. Production `email_senders` uses **`from_email`**. Every sender lookup returns null and falls through to env vars.
* `hasRecentSmsOutreach()` filters `contact_outreach_state` on `master_owner_id`, `property_id`, `last_outreach_at`. Production uses **`podio_master_owner_id`**, **`podio_property_id`**, and has no `last_outreach_at` (it has `last_sms_at` / `last_email_at` / `last_outbound_at`). The query errors, the helper swallows the error and returns `false` — **so the cross-channel duplicate-contact guard silently always passes.**
* `recordEmailOutreach()` upserts the same non-existent columns with `onConflict: "master_owner_id,property_id,channel"` — no such constraint exists.

### 1.3 The production email schema nobody is using

The database already carries a coherent, well-shaped email substrate that no application code
reads or writes:

| Table | Rows | Notes |
|---|---:|---|
| `emails` | **165,655** | Seller email addresses with `email_score_final`, `email_rank`, `email_eligible`, `is_best_email_for_owner`, `master_owner_id`, `primary_prospect_id`, `primary_market`, `timezone`, `sending_priority_tier`, language linkage. This is a real, valuable asset. |
| `email_queue` | 0 | `queue_key` (unique), `queue_status`, `scheduled_for`, `send_priority`, `is_locked`/`locked_at`/`lock_token`, `retry_count`/`max_retries`/`next_retry_at`, `to_email`, `from_email`, `subject`, `email_body`, `template_id`, `provider_message_id`, `master_owner_id`/`prospect_id`/`property_id`/`market_id`. **Structurally a mirror of `send_queue`.** |
| `email_events` | 0 | `event_key` (unique), `provider_message_id`, `direction`, `event_type`, `to_email`/`from_email`, `subject`, `email_body`, `queue_id`, plus `sent_at`/`delivered_at`/`failed_at`/`opened_at`/`clicked_at`/`open_count`/`click_count`/`tracking_pixel_id`. Serves as both message log and event log — the email analogue of `message_events`. |
| `email_senders` | 0 | `sender_key` (unique), `from_email` (unique), `reply_to_email`, `provider`, `provider_api_key_name`, `domain`, `warmup_status`, `sender_status`, `daily_limit`, `messages_sent_today`, `market`, `agent_persona`, `language`, `is_default`. Sender-pool / warm-up infrastructure already modelled. |
| `email_templates` | 0 | `template_id`, `use_case`, `stage_code`, `stage_label`, `language`, `agent_persona`, `property_type_scope`, `deal_strategy`, `is_first_touch`, `is_follow_up`, `subject`, `template_body`, `variables`. Mirrors the SMS template catalog dimension-for-dimension. |

**Zero emails have ever been sent.** `email_queue`, `email_events`, `email_senders` and
`email_templates` are all empty. `system_control.email_enabled = 'false'`.

### 1.4 Transport and webhook

* `lib/email/brevo-client.js` — Brevo `POST /v3/smtp/email`, per-brand API key resolution
  (`BREVO_PROMINENT_API_KEY` / `BREVO_REIVESTI_API_KEY`), sanitized error classification with a
  `retryable` boolean. Solid, and the only real provider code.
* `lib/domain/email/brevo-provider.js` — a second, parallel Brevo client used by `email-service.js`.
* `POST /api/webhooks/brevo/events` — accepts events, normalizes them, upserts `email_events` on
  `event_key`, updates `email_messages` (non-existent), upserts `email_suppression` (non-existent).
  Signature verification is **optional**: if `BREVO_WEBHOOK_SECRET` is unset the route returns
  `{ ok: true, configured: false }` and accepts anything. Brevo does not HMAC-sign by default, so in
  practice this is an unauthenticated write endpoint.
* **There is no inbound email path at all.** No inbound route, no MIME parsing, no threading,
  no attachment handling, no reply ingestion.

### 1.5 Routes

`/api/cockpit/email/{overview,records,threads,threads/[id],templates,drafts,manual-send,brevo-health}`
and `/api/internal/email/{queue/run,send-test,preview,cockpit}` all exist and are wired to the two
service layers above — which is why they currently return empty or error payloads.

---

## 2. What exists for SMS that should be reused

This is the important half of the recon. The SMS stack is mature and its abstractions are
transport-shaped, not SMS-shaped, in almost every place that matters.

### 2.1 The §11 canonical communication seam — reuse wholesale

`apps/api/src/lib/domain/communications/`

* **`logical-communication-key.js`** — the canonical identity of a communication *action*. A domain
  action that must happen exactly once, keyed on durable pre-send anchors (`decision_id`,
  `campaign_target_id + touch_number`, `follow_up_id`, `offer_id + offer_version`,
  `message_event_id`, `operator_action_id`, …). Explicitly forbids body, template, timestamp,
  queue key or sender from contributing to identity. Refuses rather than inventing an identity.
* **`communication-transition-authority.js`** — a three-axis durable model:
  `state` × `delivery_possibility` (`definitely_not_sent` / `may_have_been_sent` /
  `provider_accepted`) × `retry_authority` (`retry_allowed` / `retry_after` / `retry_denied` /
  `operator_hold` / `terminal`). Deliberately not a `retryable` boolean.
* **`transport-outcome-mapping.js`** — maps a provider classification onto those three axes.
  Vocabulary is provider-neutral (`provider_ambiguous_transport`, `provider_auth_failed`,
  `invalid_to_number`, `recipient_opted_out`, `content_filter_blocked`, …).
* **`canonical-communication-dispatch.js`** — the one place a seller-visible message may reach a
  provider. Enforces: identity → transport authority → runtime authority → content guard →
  atomic attempt allocation → **provider-request-start marker committed before the network call** →
  classify → persist evidence → advance state → projections last.
* **`seller-communication-store.js`** — the only reader/writer of the §11 tables, over the
  `seller_logical_communication_get_or_create` and `seller_communication_attempt_allocate` RPCs.
* **`dispatch-seller-queue-row.js`** — bridge from the queue runner into the seam. Wired live at
  `domain/queue/process-send-queue.js:2003`.

Database side, all present in production: `seller_logical_communications` (38 columns),
`seller_communication_attempts` (25 columns, immutability trigger), both RPCs.

> The module header in `canonical-communication-dispatch.js` still says *"DORMANT UNTIL MIGRATION.
> The §11 tables do not exist in production yet."* That comment is stale — the tables, the RPCs and
> the live wiring all exist. It should be corrected so the next reader does not conclude the seam is
> optional.

### 2.2 Runtime authority and guardrails — reuse wholesale

* `domain/queue/canonical-send-authority.js` — composes `evaluateQueueSendRuntimeBrakes`
  (emergency stop + `queue_processor_mode`) and `evaluateUnrestrictedDispatchGate`
  (`queue_execution_mode`). **Fails closed**: absent or unreadable control values deny.
* `domain/queue/operator-brake-authority.js`, `queue-control-safety.js`,
  `queue-execution-mode.js`, `queue-global-execution-lock.js`, `queue-canary-authorization.js`,
  `contact-window-deferral.js`, `block-send-at-compliance.js`, `queue-daily/market/per-number caps`.
* `lib/system-control.js` — cached `system_control` flags. `email_enabled` already exists as a key.

### 2.3 Cross-channel contact governance — already exists, already email-aware

`contact_outreach_state` (8,708 rows) is the canonical per-(owner, property) contact governor and it
is **already modelled cross-channel**:

```
to_phone_number, to_email
last_sms_at, last_email_at, last_outbound_at, last_inbound_at
next_allowed_sms_at, next_allowed_email_at, next_allowed_any_contact_at
is_paused, dnc, pause_reason, suppression_until, suppression_reason
current_campaign_key, current_touch_number, current_stage, touch_count, channel
```

This is the duplicate-contact-protection primitive. It does not need to be invented; it needs to be
*used* by the email path (see §1.2 — the current usage is broken).

### 2.4 Seller intelligence — reuse, do not duplicate

`domain/seller-flow/` (≈75 modules) and `domain/classification/` are the acquisition brain:
inbound burst coordination, classification, `extract-seller-facts`, `monetary-understanding`,
`negotiation-state` / `negotiation-policy` / `negotiation-strategy-router`, staged engines
(`stage2-offer-interest` → `stage6-seller-contract`), `seller-offer-authority` (authority bands),
`autonomous-seller-reply`, `execute-autonomous-reply`, `seller-followup-scheduler`,
`record-seller-automation-decision`, `autonomy-invariants`.

**These are written against message *text*, not against SMS transport.** They take a message body,
a thread, and seller state, and return a decision. That is exactly the seam email needs.

### 2.5 Inbox / threading

`domain/inbox/` — `resolve-canonical-inbound-thread.js`, `canonical-inbox-row-contract.js`,
`live-inbox-service.js` (3,886 lines), `thread-context-service.js`, `participant-intelligence.js`.
The canonical thread is keyed on `thread_key` and is **phone-shaped**: `canonical_e164`,
`seller_phone`, `display_phone`, `best_phone`. `message_events` likewise has `to_phone_number` /
`from_phone_number` and no email columns.

### 2.6 AI infrastructure

`lib/ai/ai-router.js` selects a provider from configured keys but **currently always returns
`deterministicAiRoute()` with `fallback_used: true`** — no LLM adapter is actually invoked. The
"AI" in the seller flow today is the deterministic classification + stage-engine + natural-response
stack, which is auditable by construction. `ai_decisions` and `seller_automation_decisions` tables
exist and are the decision ledger.

---

## 3. The canonical communication architecture

```
domain action (decision / campaign touch / follow-up / offer / operator send)
        │  logical-communication-key.js        identity, or a refusal
        ▼
seller_logical_communications                  one row per action that must happen once
        │  canAllocateAttempt()                transport authority
        │  evaluateCanonicalSendAuthority()    runtime authority (brakes, compliance)
        │  assertNoEmDash() / content guards
        ▼
seller_communication_attempts                  numbered attempt; provider_request_started_at
        │                                      COMMITTED BEFORE the network call
        ▼
provider (TextGrid)                            the only network primitive
        │  classifyTextGridProviderError()
        │  mapTransportOutcome()               → state × delivery_possibility × retry_authority
        ▼
evaluateLogicalTransition() → applyLogicalTransition()
        │
        ▼
projections (send_queue row, message_events)   LAST, and never authority
```

Reconciliation of provider callbacks runs through a parallel, equally strict path:
`seller_provider_callback_events` → `reconcile-provider-callback.js` → `provider-outcome-lattice.js`
(monotonic) → `callback-trust-policy.js` → the same transition authority.

**The seam is channel-agnostic in its logic and SMS-bound in exactly three places:**

1. `seller_logical_communications` has `to_phone_number` and no `channel` / `to_email` column.
2. `buildLogicalCommunicationKey()` does not include a channel component — so an SMS campaign touch
   and an email campaign touch on the same `campaign_target_id + touch_number` would collide onto
   **one** logical communication, and the second channel would be refused as a duplicate attempt.
3. `sendProvider` is bound to TextGrid, and `classifyTextGridProviderError` is the only classifier.

Those three are the whole of the email integration problem at the transport layer.

---

## 4. Frontend email surfaces that are fake or placeholder

`apps/dashboard/src/views/email-command/` — `EmailCommandCenter.tsx` (1,139 lines),
`emailAdapter.ts` (346), `email.types.ts` (223), `email.css` (1,304). Registered as a real route
(`/email-command`) and as the `email` tab inside `modules/inbox/InboxPage.tsx`.

The UI is real and reasonably built. What is fake:

| Surface | Status |
|---|---|
| Overview KPI tiles | Wired to `/api/cockpit/email/overview`, which reads the non-existent `v_email_records`. Falls back to `MOCK_OVERVIEW` — **all zeros presented as real data**. |
| Brevo health panel | Falls back to `MOCK_HEALTH` (`connected: false`, zeroed rates) rather than surfacing "unknown". |
| Records grid | `/api/cockpit/email/records` → `v_email_records` (missing) → always empty. Meanwhile 165,655 real rows sit in `emails`. |
| Threads / thread detail | Reads `email_messages` (missing) → always empty. `property_context`, `prospect_context`, `ai_summary`, `sms_thread_id` are hardcoded `null` in `getEmailThread()`. |
| `getEmailCampaigns()` | `return []` — pure stub. |
| `getSuppressionList()` | Derived client-side by filtering records; `can_remove: false` always. No suppression table behind it. |
| `previewEmailTemplate()` | Client-side `replaceAll` of `{{var}}` — does not use the server renderer, so preview and send can diverge. |
| Composer send | Posts to `/api/cockpit/email/manual-send`, which inserts into `email_messages` (missing) and would fail before reaching Brevo. |
| Delivery / bounce / open state | Modelled in `email.types.ts` but never populated. |

There is no SMS/email unified timeline anywhere. `PipelineLeadCommandSheet.tsx` +
`use-lead-thread-messages.ts` is the closest existing "Lead Command" surface and is SMS-only.

---

## 5. Relevant Supabase objects

**Present and load-bearing**
`seller_logical_communications`, `seller_communication_attempts`,
`seller_logical_communication_get_or_create()`, `seller_communication_attempt_allocate()`,
`enforce_seller_communication_attempt_immutability()`, `seller_provider_callback_events`,
`seller_automation_decisions`, `seller_automation_executions`, `seller_offers`,
`seller_operator_actions`, `seller_state_snapshots`, `seller_inbound_bursts`,
`send_queue`, `message_events`, `contact_outreach_state`, `conversation_threads`,
`conversation_turns`, `conversation_memory`, `campaigns`, `campaign_targets`,
`campaign_touch_plan` (has a `channel` column), `follow_up_queue`, `system_control`,
`automation_suppressions`, `sms_suppression_list`, `canonical_inbox_threads`.

**Present but unused by code**
`emails` (165,655), `email_queue`, `email_events`, `email_senders`, `email_templates`.

**Referenced by code but absent from the database**
`email_send_queue`, `email_messages`, `email_drafts`, `email_suppression`, `email_identities`,
`v_email_records`.

**Repo migrations never applied**
`20260421_create_email_layer.sql`, `20260531222758_brevo_email_backend_foundation.sql`.

**Current runtime posture** (`system_control`)
`email_enabled=false`, `outbound_sms_enabled=true`, `queue_processor_mode=off`,
`queue_execution_mode=scoped_canary_only`, `queue_emergency_stop_at` set, `campaign_mode=paused`,
`auto_reply_enabled=true` / `auto_reply_mode=live_limited` with a phone allowlist.

---

## 6. Recommendation: extend vs replace

### Extend
* The §11 canonical seam — make it channel-aware rather than building a second dispatcher.
* `contact_outreach_state` — it is already the cross-channel governor.
* `canonical-send-authority` and the whole brake/kill-switch stack — unchanged, channel-agnostic.
* `transport-outcome-mapping` + `communication-transition-authority` — the failure vocabulary is
  provider-neutral; Brevo needs a classifier that speaks it, not a new outcome model.
* `domain/seller-flow/*` and `domain/classification/*` — feed them email bodies.
* Production `email_queue` / `email_events` / `email_senders` / `email_templates` — real schema,
  right shape, empty. Add lineage columns; do not create a parallel set.
* `views/email-command/*` — keep the visual language; replace the data plumbing beneath it.

### Replace / retire
* `lib/email/queue-email.js` + `process-email-queue.js` — retarget onto `email_queue` and the
  canonical seam. Their present form cannot execute.
* `lib/domain/email/email-service.js` — split: keep the read/projection helpers, move sending onto
  the canonical dispatch. It currently owns identity, sending, suppression and webhook handling in
  one 1,079-line module.
* Two parallel Brevo clients (`lib/email/brevo-client.js`, `lib/domain/email/brevo-provider.js`) →
  one transport adapter behind the provider interface.
* `lib/providers/email.js` (hand-rolled SMTP) — retire once nothing depends on it.
* The two unapplied migrations — supersede rather than apply; applying them would create
  `email_send_queue` alongside `email_queue` and `email_messages` alongside `email_events`.

### Do not build
A second inbox, a second thread model, a second suppression concept, a second retry policy, a second
kill switch, or a generic SaaS email UI.

---

## 7. Recommended provider abstraction

```
domain/email/transport/
  email-transport-contract.js     the interface + the shape every adapter must return
  brevo-email-transport.js        Brevo REST adapter (send)
  brevo-error-classifier.js       HTTP/network failure → the EXISTING failure_class vocabulary
  brevo-event-normalizer.js       Brevo webhook payload → canonical provider event
  brevo-inbound-normalizer.js     Brevo inbound parse → canonical inbound message
```

Rules:
* One method: `send({ to, from, reply_to, subject, html, text, headers, attachments, tags })`
  → `{ ok, provider_message_id }` or a classified throw.
* The adapter never decides retry policy. It returns a `failure_class` from the vocabulary
  `transport-outcome-mapping.js` already understands; the transition authority decides the rest.
* Provider-specific vocabulary (`hard_bounce`, `soft_bounce`, `blocked`, `spam`, `unsubscribed`,
  `deferred`) is translated at the boundary and never leaks inward.
* API keys resolve server-side per brand, as `brevo-client.js` already does. Never client-exposed.
* Adding a second ESP means one new file in this folder and nothing else.

---

## 8. Architectural risks found

1. **Channel collision, in two places (highest severity).** Without a channel component,
   `campaign_target_id + touch_number` identifies one action across both channels. Turning email on
   would make an email touch look like a duplicate of the SMS touch and be refused — or, worse,
   adopt the SMS attempt's provider evidence. The same blindness exists a second time in the three
   partial unique indexes on `seller_logical_communications`
   (`uq_..._decision_action`, `uq_..._campaign_touch`, `uq_..._offer_action`), so fixing only the
   key moves the collision from the hash to the index rather than removing it. Both are closed in
   EMAIL-1.
2. **Silent cross-channel guard failure.** `hasRecentSmsOutreach()` queries columns that do not
   exist, catches the error, and returns `false`. The one existing duplicate-contact protection
   fails *open*.
3. **Schema drift with no CI gate.** Two migrations sit in the repo unapplied; the email code has
   been drifting against imagined tables for months. Nothing catches it.
4. **Unauthenticated webhook when the secret is unset.** `verifyWebhookSecret` returns `ok: true`
   when `BREVO_WEBHOOK_SECRET` is absent.
5. **No email suppression list exists.** Opt-outs, hard bounces and complaints have nowhere to land.
   This is a legal exposure the moment sending is enabled.
6. **UI presents zeros as facts.** `MOCK_OVERVIEW` / `MOCK_HEALTH` make a broken backend look like a
   healthy, empty one. An operator cannot distinguish "no emails sent" from "the query failed".
7. **Threading model is phone-shaped.** `message_events` and `canonical_inbox_threads` cannot
   currently represent an email message, so a unified timeline needs a deliberate widening rather
   than a join.
8. **Stale "DORMANT" comment** on the canonical dispatcher invites someone to route around the seam.
9. **Two Brevo clients** with different error shapes — divergent retry behaviour by construction.
10. **165,655 email addresses with no eligibility policy.** `emails.email_eligible` exists but no
    code consumes it, and there is no verification/role-account/disposable policy.

---

## 9. Phased plan

| Phase | Deliverable |
|---|---|
| **EMAIL-0** | This document. Schema truth, drift inventory, architecture decision. |
| **EMAIL-1** | **Canonical email domain.** Channel-aware logical key; `channel`/`to_email` on `seller_logical_communications`; email address normalization; email eligibility policy; provider transport contract + Brevo adapter + Brevo error classifier speaking the existing failure vocabulary; migration retargeting `email_queue` with canonical lineage; retire the phantom-table code paths. |
| **EMAIL-2** | **Brevo transport.** Outbound send through `canonical-communication-dispatch`; provider events with verified, idempotent webhooks; suppression on bounce/complaint/unsubscribe; `email_events` as the durable projection. |
| **EMAIL-3** | **Inbound replies.** Inbound route, MIME/threading normalization, canonical conversation resolution across channels, attachments. |
| **EMAIL-4** | **Seller intelligence on email.** Route inbound email bodies through the existing classification / fact-extraction / stage engines. No new brain. |
| **EMAIL-5** | **Automated response.** Reply engine on email, human locks, escalation, authority bands — reusing `autonomous-seller-reply` and `seller-offer-authority`. |
| **EMAIL-6** | **Negotiation.** Cross-channel negotiation state; an offer stated on one channel binds the other. |
| **EMAIL-7** | **Orchestration.** Channel preference, sequence cancellation across channels, cross-channel cooldowns via `contact_outreach_state`. |
| **EMAIL-8** | **Lead Command UX.** Unified SMS + email timeline, composer, scheduled sends, AI actions, decision explainability — inside the existing Reivesti visual language. |
| **EMAIL-9** | **Analytics & hardening.** Deliverability telemetry, conversion by sequence / market / source, observability, stress tests. |

## 10. Starting phase

**EMAIL-1 — Canonical Email Domain.** It is the only phase that unblocks every other one, it is
fully implementable and testable without any external credential, and it removes the two defects
(channel collision, fail-open duplicate guard) that would otherwise cause a duplicate or
contradictory seller contact the first time email is enabled.

## 11. External dependencies required from Ryan

None are required for EMAIL-1. The following are required before EMAIL-2 can send to a real seller:

* `BREVO_PROMINENT_API_KEY` and/or `BREVO_REIVESTI_API_KEY` (server-side only).
* `BREVO_WEBHOOK_SECRET`, plus the Brevo webhook configured to send it.
* Verified sending domain(s) with SPF, DKIM and DMARC published, and the `email_senders` rows to
  match (`from_email`, `reply_to_email`, `domain`, `daily_limit`).
* A reply-to mailbox and Brevo Inbound Parse configured to a webhook URL (EMAIL-3).
* An unsubscribe/preference destination for the required footer link.
* Confirmation of the intended per-domain daily send caps and warm-up schedule.
