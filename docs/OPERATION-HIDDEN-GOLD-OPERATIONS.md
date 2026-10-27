# Operation Hidden Gold — LeadCommand operational access for acquisitions agents

Branch `feat/hidden-gold-operations` (from `feat/lc-conversation-intelligence` @ `fde1f0b9`). Nothing here is applied to
production, deployed or activated. Every write path below is PROPOSED and born OFF; every seller-facing path keeps
LeadCommand's existing approvals and emergency stops. The companion in Agntei: `docs/AGNTEI-OPERATION-HIDDEN-GOLD.md`
(agntau, branch `agntei-living-world-1.1-e`).

## 1. What was built (and what was reused)

| Layer | What it is | Reused, never duplicated |
|---|---|---|
| Reader MCP (`mcp/leadcommand-mcp`, role `lc_mcp_reader`) | 24 read tools (19 before): per-thread **follow-ups**, **execution log** (send_queue rows with delivery states + gateway receipts + automation events), **offers / opportunities**, **contact eligibility** (suppression, holds, contact role, phone states, an `eligible_for_outreach` verdict with its rule), **operator tasks**. Link `PROPOSED_20261027130000_lc_mcp_acquisition_reads.sql`. | The reader's gateway, masking, envelope, scopes, inventory pins, fixture mode, fake PostgREST. |
| Action Gateway link #29 (`PROPOSED_20261027120000_action_gateway_ohg.sql`) | The **acquisitions family**: `set_lead_temperature`, `update_lead_status` (standing T2, reversible, through a hand-off to LeadCommand's worker which runs the canonical lead-state registry `patchUniversalLeadState`, change_source `ai`, audit rows), `record_conversation_note`, `record_seller_statement` (append-only ledger `action_gateway.lead_annotations`, a price must appear in the seller's own words, bound to the inbound message), reads `get_reply_delivery_status` (queued ≠ sent ≠ delivered) and `get_lead_annotations`. | #26 pipeline (identity → kills → grant → schema → resource → intent → policy → authorization → lease → domain write → outcome → audit), #27 registry + hold registry, #28 receipts + the ONE executor kind, the lead-state registry, the follow-up lifecycle. |
| Action MCP (`mcp/leadcommand-action-mcp`) | The **sms_* family** as protocol-layer **aliases** of the certified tools: `sms_send` / `sms_reply` → `queue_authorized_reply`; `sms_schedule` / `sms_create_followup` → `schedule_followup`; `sms_cancel_scheduled` → `cancel_followup`; `sms_get_conversation` → `read_conversation_context`; `sms_get_delivery_status` → `get_reply_delivery_status`; `flag_data_conflict` / `propose_record_correction` → `record_conversation_note`. Same schema, tier, capability and risk as their targets, `leadcommand/alias_of` in the metadata. 49 tools. | No second SMS system: nothing in this work reaches `send_queue`, the provider or the templates. The canonical AI reply path (decideAndCompose → validators → R3 → the queue writer → the queue runner) is the only sender. |
| Conversation engine | **F5** "is this a bot / a real person?" is answered by the AI itself, truthfully (an `identity_answer` flagged `automation_question`; the composer is told to disclose; the validator refuses an identity answer that does not disclose, and any denial). **F1** bare Spanish / Portuguese stop words (`Para`, `ALTO`, `Basta`, `Detente`, `Cancela`, `No más`, `Chega`) are confirmed opt-outs at every reading; soft "not now", "maybe later" and goodbyes are never opt-outs. | The canonical runtime, playbook v3, the validators, the stop readings. |
| Evaluation | `tests/critical/hidden-gold-evaluation.test.mjs`: 18 scenarios through the canonical path with a scripted model, 0 safety-critical failures, two adversarial models refused (`tests/ohg/evaluation-report.json`). | — |
| Acceptance world | `apps/api/tests/ohg/world-server.mjs`: one disposable PostgreSQL 17 database (links #26–#29, the R3 / turn world, the reader link + its reads) served to the reader (live, local PostgREST + `/rest/v1` shim), the Action MCP (real app, one bearer credential per agent principal) and LeadCommand's worker + the REAL queue runner with a SIMULATED provider; a loopback control endpoint (simulated seller reply, LeadCommand's own operator approval through the existing human decide path, state dump). | — |

## 2. Capability matrix (truthful states)

States: **production** (already working in production) · **built, not deployed** · **tested, simulated provider** · **awaiting grant / authorization** · **awaiting independent evaluation** · **ready for controlled activation** · **fully operational**.

| Capability | State | Evidence / what is missing |
|---|---|---|
| Read leads, properties, scores, campaigns, market, comps, contact status, holds, conversations, worklists, pipeline, census (reader 1.0–1.2) | **built, not deployed** (the reader link #26 is PROPOSED; production runs none of the PROPOSED links) | reader suite 166 pass; chain runner |
| Read follow-ups, execution log with delivery states, offers / opportunities, contact eligibility, operator tasks (reader, link #30) | **built, not deployed** | runner `lc_mcp_acquisition_reads` PASS; `test/acquisitions.test.mjs` |
| Full inbound / outbound SMS histories with actual text (reader `leadcommand_get_lead_conversation`; gateway `read_conversation_context`) | **built, not deployed** | masked phones / emails; message text as quoted data |
| Buyers / demand | **not available** — no buyer list or buy-box table exists in LeadCommand; `eg_buyer_index` gives ZIP buyer counts only | would need a LeadCommand data model, not a tool |
| Set temperature, operational status (standing T2 writes through the canonical registry) | **tested, simulated** (disposable PostgreSQL: gateway → hand-off → worker → registry → audit) · **awaiting grant** in production (an owner mints `acquisitions.*` standing grants; link #29 applied) | `action-gateway-ohg-pg.test.mjs`, runner `action_gateway_ohg` PASS |
| Notes, interest, objections, context, next steps, data conflicts, correction proposals, seller-stated price / timeline / condition / ownership | **tested, simulated** · **awaiting grant** | same; `lead_annotations` append-only, phone-masked |
| Stages, disposition (request-only T2: a human applies), tasks, holds, follow-ups schedule / cancel, campaign pause (link #27) | **built, not deployed** (pre-existing) | T2 suites |
| Assign a lead to an agent | **not available** — not a LeadCommand concept outside the Workforce assignment tools | — |
| Real SMS by an agent (`sms_send` = `queue_authorized_reply`, T3) | **tested, simulated provider**: Agntei approval → LeadCommand's own operator approval (existing decide path) → hand-off → canonical compose + validators → queue row → the real runner → the simulated provider; dispatch-time revalidation (window, stop, eligibility, kill switch) proven by refusals in the runs · **awaiting independent evaluation** and **separate activation** (`ai_conversation_send_enabled`, `ai_conversation_send_policy`, the R2 stop untouched) | world runs (§4); refusals `OUTSIDE_RECIPIENT_WINDOW`, `NOT_AN_UNANSWERED_SELLER_MESSAGE`, `ai_conversation_outside_contact_window` observed and honoured |
| Scheduled follow-ups (`sms_schedule`) | **built, not deployed**: the follow-up lifecycle materializes under its own switch, re-checked at due time | T2 suite |
| Two-way autonomous conversation (inbound → context → intent → original reply → certified send → pipeline update → next follow-up) | **tested, simulated** at the engine level (the evaluation harness) and at the agent level (Agntei watch → agent → gateway writes → scheduled follow-up) · **awaiting independent (blind) evaluation** with a real model before activation | this doc §4; `docs/LEADCOMMAND-CONVERSATION-INTELLIGENCE.md` F6 still open |
| Truthful AI identity answers (F5) | **built, not deployed** | `hidden-gold-conversation-rules.test.mjs` |
| Multilingual opt-out (F1) | **built, not deployed** | same; reader expectations updated |
| Emergency stop (R2 `agent.runtime_limits.emergency_stop`; `queue_emergency_stop_at`) | **production** — untouched; both stop every path here (jobs are not claimed; the row gate cancels) | — |
| Existing approved production messaging (templates, campaigns) | **production** — untouched | — |

Nothing above is "fully operational". The honest end state today: every read and write an acquisitions agent needs exists, is certified on disposable PostgreSQL, and waits for (a) the PROPOSED links to be applied in order (#26 → #27 → #28 → #29; reader #26 → 1.1 → 1.2 → #30), (b) owner-minted standing grants for `acquisitions.*` and the reader scopes, (c) the blind evaluation and the separate activation decision for AI-written sends.

## 3. Safeguards that every send keeps (nothing bypassed)

Identity (one credential per agent principal; the Action MCP binds the connection's bearer to the principal), recipient / thread verification (the intent binds the thread; the reply answers the latest unanswered inbound only), consent / eligibility (send-time guard, suppression list, holds), opt-out (stop readings at decide time, at R3, at dispatch; F1 widened), dispatch-time revalidation (the AI row gate re-reads the kill switch, the policy scope, the window, newer inbounds), sending hours and time zones (recipient-window policy: the seller's area code, the property, the conservative intersection when unknown), daily limits (25 global / 1 per seller per day in the send policy; the standing grants' caps per hour / day), dedup and idempotency (client_request_id → one intent; `idempotency_ledger` reservations; the queue's dedupe), provider delivery tracking (receipts: requested → executing → enqueued → sent / held / failed / outcome_unknown; `get_reply_delivery_status`), durable audit (intents, authorizations, outcomes, audit events, receipts, annotations, lead-state audit rows), emergency stop (R2 and the queue stop). Agntei never represents a drafted message as sent nor a queued one as delivered: the delivery read says which.

## 4. Acceptance run (disposable world + Agntei)

`apps/api/tests/ohg/world-server.mjs` + the Agntei fixture in `hiddengold` mode + the acceptance probe. Steps proven (evidence of the lawful-window run in `docs/hidden-gold/lawful-window-2026-10-27/`):

1. Sterling discovers the overlooked conversation (reader worklist, unanswered inbound, 11 days old) and reads it in full (reader conversation read; the Action MCP's context read).
2. Cites the evidence (message ids; quoted as data).
3. Records seller statements bound to the inbound message (ownership, condition; later the stated price and timeline) and a context note; sets the temperature to warm through the canonical registry (hand-off → worker → `inbox_thread_state` + audit).
4. Delegates: Equity (property record, score, an underwriting note — no number without comps), Haven (market read, buyer demand "unknown, not assumed"), Clara (transactions: nothing contractual; escalate before any price / offer / agreement).
5. Decides the follow-up: status → active communication; `sms_send` is filed for the person's approval (sensitive; never preapproved).
6. The person approves in Agntei; LeadCommand holds the T3 intent for ITS operator (existing approval path); the operator decides; Sterling retries the same request (same idempotency key); the person approves the execution; LeadCommand hands off, composes with the canonical decider + validators, queues ONE row; the REAL queue runner sends to the SIMULATED provider (no external delivery possible: any fetch or provider credential read aborts).
7. A simulated seller reply; the watch wakes Sterling; the stated price and timeline are recorded on that message; Sterling asks for a follow-up through the lifecycle — in the lawful-window run LeadCommand REFUSED it (see below) and Sterling reports the refusal, not a schedule; the status hand-off to "waiting on seller" is queued and applied by LeadCommand's worker.
8. Restart persistence: the Agntei fixture was killed and restarted on its persistent home mid-flow — the room, its messages, the pending execution, the watch and the connections' credentials were all still there; the LeadCommand side persists in PostgreSQL by construction.

Refusals observed and honoured along the way (each a safeguard working): `OUTSIDE_RECIPIENT_WINDOW` (01:35 local), `NOT_AN_UNANSWERED_SELLER_MESSAGE` (our message was the latest), `NO_AUTHORIZED_REPLY:no_reply` (a priced turn escalated to an operator by the canonical decider), `ai_conversation_outside_contact_window` at dispatch (the row gate's own window check). None of them was worked around in code; the scenario was corrected or the run moved into the lawful window.

### The lawful-window run (2026-10-27, Indianapolis defaults)

Run inside the seller's sending window (Central time), with `OHG_GEO` and `OHG_SELLER_PHONE` unset (Indianapolis, IN 46203; the seller's number +13125550161), `stopall.sh` → `FRESH=1 startall.sh` → the probe. The third run of the day is the one recorded; the first two found the defects listed below, which were fixed before it.

| Step | Result |
|---|---|
| Discovery, reading, citing | The overlooked thread (4471 Marigold Ln, 11 days unanswered) found and read in full; message ids cited; the seller's words quoted as data. |
| Pipeline writes | Ownership and condition recorded on the inbound message (`STATEMENT_RECORDED`), a context note (`ANNOTATION_RECORDED`), temperature warm (`HANDOFF_QUEUED`, applied by the worker). |
| Delegation | Equity: no number without comps; Haven: buyer demand unknown, not assumed; Clara: nothing contractual — escalate before any price or offer. |
| Preapproval of `sms_send` | Refused by Agntei for every agent (a sensitive tool always needs the person). |
| The send | The person approved in Agntei → LeadCommand held the T3 intent for its operator → the operator approved → the same request retried (same idempotency key) → approved again in Agntei → `HANDOFF_QUEUED` → one queue row composed and validated by LeadCommand → the real queue runner sent it to the SIMULATED provider: **one** provider send, `sent_at` set, `delivered_at` empty. Sterling reported "sent no · delivered no" at hand-off and never called it delivered. |
| The seller's reply | Posted by the thread watch as data, waking Sterling; asking price (185,000) and timeline recorded on that message; next-step note recorded. |
| The follow-up | **Refused** by LeadCommand: `OWNERSHIP_DECLINED_UNVERIFIED` (reason `selling_nurture_requires_selling_intent_answer`). Sterling reported the refusal and its reason; nothing scheduled, nothing worked around. |
| Restart | The Agntei fixture was killed and restarted on its home mid-flow (before the operator's decision); the room, the pending execution, the watch and the credentials came back. |
| Page errors | 0 |

Defects found by the lawful-window runs and fixed:
- **Agntei:** the fixture's scripted Sterling reported a follow-up as "scheduled" when LeadCommand had refused it. He now reports what LeadCommand did. A status hand-off is now worded as asked, not done.
- **Agntei engine:** the conversation watch took its baseline on its first *successful* poll, so a seller's reply that arrived while earlier polls failed was silently absorbed. Messages after the watch was set are now news even on the first poll (tested).
- **Acceptance world:** the seeded ownership question named a different street; it now names 4471 Marigold Ln.

Findings for the owner (not changed — certified LeadCommand code):
- **The follow-up gate is stricter than the scheduler.** It judges every follow-up kind by the selling-nurture rule. It did not count "I would let it go for 185,000 if it could close before the end of the year" as a selling answer. So a seller-requested callback after a stated price is refused.
  - In the simulated world the sent reply is not mirrored into `message_events`, so the ownership question still reads as the latest outbound. In production the outbound row exists, and the result may differ there.
  - Decide whether a seller-requested callback should pass after a stated price.
- **The gateway's refusal code is coarse.** Every ownership-related block is labelled `OWNERSHIP_DECLINED_UNVERIFIED`; the precise reason travels in `reason`. Consider distinct codes.

## 5. Activation path (owner decisions, in order)

1. Apply links #26 → #27 → #28 → #29 (Action Gateway) and reader #26 → 1.1 → 1.2 → #30 on production, each through its runner-tested apply (`scripts/db/run-migration-test.mjs --id …` on a disposable clone first). `pg_net` resolution stays a prerequisite of #26.
2. Register the Agntei agent principals (one credential each: Sterling, Equity, Haven); mint standing grants for `acquisitions.set_lead_temperature`, `acquisitions.update_lead_status`, `acquisitions.record_conversation_note`, `acquisitions.record_seller_statement`, `followups.schedule`, `followups.cancel`, `tasks.create_operator_task` with caps; grant the reader scopes. `action_gateway_tiers` to `T1,T2` first.
3. Run the Agntei connections with those credentials; preapprove the reversible writes in Agntei's policies; keep `sms_send` on approval (Agntei refuses to preapprove a sensitive tool).
4. For agent-initiated SMS: the blind evaluation with a real model (zero safety-critical failures), then the separate activation of `ai_conversation_send_enabled` + an explicit `ai_conversation_send_policy` scope, `T3` in `action_gateway_tiers`, `conversation.queue_reply` grants (T3 always needs the per-use operator approval in LeadCommand as well), a limited supervised rollout (the policy's 25 / day and 1 per seller / day caps). The R2 stop and the queue stop remain the brakes.
