# Action MCP audit: the existing action paths behind the requested tools

Owner directive, 2026-10-19: "AGNTEI THINKS, COORDINATES AND ACTS. LEADCOMMAND ENFORCES AUTHORITY AND EXECUTES."

This is Step 1 of the Action MCP / Action Gateway build (branch `feat/action-mcp`, base `353e9170` = rc-8.5.21 plus the read-only MCP). It inventories every EXISTING action path the requested tools map to, with `file:line` and the authority checks each path performs today. For each tool it gives a verdict:

- **REUSE**: call an existing service as is.
- **WRAP**: call an existing service behind a gateway policy that adds missing guards.
- **MISSING**: no service exists; the doc says what would have to be built.

The build in this branch follows these verdicts. It adds no second system for anything that already exists.

Paths are relative to `apps/api/src/lib/` unless they start with `supabase/`, `apps/`, `mcp/`, `scripts/` or `docs/`. `[mig]` means `supabase/migrations/`.

The audit was read-only. No production system was touched and no `.env*` file was read.

## 0. Findings to read first

1. **A capability plane already exists** (`agent/capabilities/`): one `invoke()` enforcement path (`registry.js:135`), approvals (`approvals.js:55,102`), prohibited-tool rules (`agent/tools/prohibited.js`). The gateway does not replace it. The two planes have different principals:
   - The capability plane serves a **human operator session**. It requires a verified named operator (`registry.js:155`) and is gated by `AGENT_ENABLED` + `AGENT_CAPABILITIES_ENABLED` (`registry.js:38`). Writes also need `AGENT_CAPABILITIES_WRITES_ENABLED` and `AGENT_READ_ONLY` lifted (frozen ON in production builds, `registry.js:52`).
   - The Action Gateway serves an **agent principal** (an Agntei agent with its own credential and an accountable human sponsor).
   - They share: the approval ledger and its human decide path (§2), the domain services, the hold authority, the prohibited-module rules (the gateway catalog is checked with `classifyProhibited` at load), and the canonical hashing / PII helpers.
2. **Approvals are approve-and-execute only.** `approvals.decide` claims `pending → executing`, then runs `executeApproved` immediately (`approvals.js:146-162`). There is no "approve now, consume later" record.
   - The gateway therefore registers one capability, `agent_actions.authorize_action`, whose `executeApproved` only records the grant.
   - The gateway consumes that record **once**: `action_authorizations.approval_id` is unique and a trigger re-verifies the binding.
   - Wiring that capability into the production plane registry is a dependency (§9, D1).
3. **Envelope and send-authorization approvals cannot be decided today.** They live in their own sealed registries (`domain/negotiation/envelope-approval.js:141-145`, `send-authorization.js:232-235`). The only decide route uses the main plane registry (`agent/actions/routes.js:104-110`), where `decide()` finds no spec and refuses (`approvals.js:125-128`). T4 cannot be built on them until this is fixed (D6).
4. **No agent-initiated seller send path exists, by design.**
   - The R3 executor is the only module that may insert AI text into `send_queue` (`ai/conversation-ai-r3-executor.js:149`). A static test pins its single importer (`apps/api/tests/critical/conversation-ai-no-send-and-runtime.test.mjs:197-198`).
   - `queue/canonical-queue-writer.js` is marked dead (`apps/api/tests/critical/seller-send-source-inventory.test.mjs:184`).
   - `queue_authorized_reply` (T3) is therefore MISSING and stays a stub.
5. **The draft path resolves one hold fact through the process-default client** (found by this build's network trap).
   - `draftReplyForInbound` → `loadCanonicalInputs` → `dryRunEligibility` → `loadSendTimeContactFacts` consults the hold **port** without an injected checker. That resolves through `getDefaultSupabaseClient()` rather than the client the caller injected.
   - The Action MCP fences that default client to a refusal (fail closed: the eligibility reads "held", never "not held").
   - The gateway binds the port to its own `lc_action_gateway` client at the composition root (`domain/action-gateway/ports.js`, `createGatewayServices`). The underlying gap in `queue/send-time-contact-guard.js` is reported, not changed (D3).
6. **`ai_conversation_send_enabled` / `ai_conversation_send_policy` are not operator-owned keys** (`domain/queue/operator-brake-authority.js:27-37`), so a non-operator `setSystemValues` call can write them (`system-control.js:201-220`). The new gateway keys (`action_gateway_enabled`, `action_gateway_tiers`, `action_gateway_killed_capabilities`) should be added to the same list (D4).
7. **The AI reply policy table is service-role only by design.** #3 asserts it: RLS forced, no policies (`[mig] PROPOSED_20261013160000_conversation_ai_shadow_posttest.sql:61-66`). The gateway does not add a policy. It reads only the one policy row the draft gate needs, through an allowlisted STABLE definer read (`public.action_gateway_reply_policy()`). The first chain run caught the conflict.
8. **Risks found in existing paths** (not changed here):
   - **R1: stage source spoof.** `PATCH /api/cockpit/pipeline/opportunities/[id]/stage` passes the raw body to `transitionOpportunityStage`. A `source: 'closing_authority'` / `'operator'` or an `offer_event` in that body skips gates (`domain/opportunity/opportunity-service.js:635,657`; `stage-advance-guard.js:31,33,197,201`). Its only auth is the shared secret. Any gateway stage tool must set `source` and `actor` on the server.
   - **R2: the closed-won gate in `patchUniversalLeadState` never runs.** It requires `changeSource === MANUAL` inside a block that excludes it (`domain/lead-state/patch-universal-lead-state.js:547` vs `:601`).
   - **R3: `transitionOpportunityStage` has no concurrency control.** The update filters by id only (`opportunity-service.js:694-699`); duplicates are detected only at the history insert (`:702-715`).
   - **R4: `persistActiveOffer` does no authority check.** `authorized_ceiling` is lineage only (`domain/seller-flow/seller-offer-authority.js:148-151,296`); supersede + insert are two statements (`:259-317`).
   - **R5: the negotiation send budget is not durable.** `max_sends` is checked against a caller-supplied `sends_used` (`domain/negotiation/send-authorization.js:92`).
   - **R6: campaign lifecycle / edit routes run on the shared secret only.** No named user is recorded, and `ensureMutationAuth` passes when no secret is configured (`app/api/_shared.js:17-25`).
   - **R7: no hold check when a follow-up is planned** (`domain/followups/followup-lifecycle.js:268`). It is checked at materialization and at dispatch.
   - **R8: prohibited-module patterns check `wraps.module` only** (`agent/tools/prohibited.js:71`), but capability specs declare `wraps.service`. The gateway catalog sets `wraps.module`, so the net applies to it.

## 1. Agent capability registry, approvals, actions routes (8.5.15)

| Path | file:line | Authority today |
|---|---|---|
| Plane gate | `agent/capabilities/registry.js:38` `capabilityGate` | `AGENT_ENABLED` ∧ `AGENT_CAPABILITIES_ENABLED` (default off) |
| Write ceiling | `registry.js:52` `writeCeiling` | agent mode ≥ read; writes need `AGENT_CAPABILITIES_WRITES_ENABLED` ∧ not `AGENT_READ_ONLY` |
| The one enforcement path | `registry.js:135` `invoke` | 1. closed schema; 2. gate + ceiling; 3. verified named operator + `agent.operator_membership` + role (`:155-159`); 4. taint escalation: untrusted content refuses autonomous writes (`:164`); 5. rate + per-day cap from the durable audit (`:171`); 6. idempotency replay (`:181`); 7. dispatch by tier; 8. `agent.capability_audit` row for every decision |
| Approval request / decide | `agent/capabilities/approvals.js:55` `request`, `:102` `decide` | decide: verified org member echoes the payload hash; expiry; capability version; drift snapshot; single claim `pending→executing` (`:146`); execute; record (`:155-162`); replay returns the recorded result |
| Approval ledger | `[mig] PROPOSED_20261013120000_agent_capabilities.sql:42-69` | state graph + immutability + member checks by trigger (`:87-131`); writes only via `capability_approval_insert` / `_transition` (definer, agent_api / service_role) |
| Capability audit | same file `:187-217` | append-only (trigger); drives per-day caps and replay |
| Routes | `agent/actions/routes.js:1-15,45` | gate → ops-dashboard secret → Supabase JWT + allowlist → per-user rate limit → membership; decide = POST `/api/cockpit/agent/actions/approvals/:id/decide` |
| Registered capabilities | `agent/capabilities/index.js:19` `FIRST_CAPABILITIES` | campaigns.\*, inbox.\*, pipeline.\*, platform.health, missions.create |

## 2. R2 durable runtime

| Path | file:line | Authority today |
|---|---|---|
| Three default-off gates | `agent/runtime/runtime-service.js:3-8,24` | Worker cron flag; API `AGENT_RUNTIME_ENABLED` ∧ `AGENT_ENABLED`; DB `agent.runtime_limits.runtime_enabled` ∧ ¬`emergency_stop` ∧ the kind enabled (armed by a named operator) |
| Store | `agent/runtime/job-runtime.js:112` (enqueue), `:117` (claim), `:125` (reserve), `:133` (emergency stop) | every write is an `agent.runtime_*` SECURITY DEFINER function; least privilege asserted in production (`runtime-service.js:51`) |
| Enqueue | `[mig] PROPOSED_20261012140000_intel_runtime.sql:550` `runtime_enqueue_core`, `:593` `runtime_enqueue` | kind valid (not `research.*`); `requested_by` a named operator uuid; sha256 idempotency key dedupe; budget ≤ caps |
| Leases / finish / reap | same `:740` `runtime_leased`, `:803` `runtime_finish`, `:859` `runtime_reap` | token-bound; expired leases reaped with backoff; dead letter |
| Emergency stop | same `:137,151,154`; claim refuses `:697` | anyone with `runtime_emergency_stop()` may set it; only the owner path clears it |
| Spend ledger guard | same `:373` `spend_ledger_guard`, `:898-923` | switch / day / cycle / job / escalation caps; refusal ⇒ `budget_blocked` |
| Job events | same `:299` `agent.job_event` | append-only event stream |

## 3. Research missions and the valuation refresh queue

| Path | file:line | Authority today |
|---|---|---|
| `missions.create` capability | `agent/capabilities/defs/platform.js:81` (input `researchMissionInput` `:26`) | the capability plane (operator session); kinds ops.health_check / mission.research / mission.supervisor; idempotent per operator × kind × input × hour |
| Missions API | `agent/missions/missions-service.js:127-132` | create ONLY via `missions.create` |
| property.research triggers | `agent/missions/property-research-triggers.js:22,42` `enqueuePropertyResearch` | `PROPERTY_RESEARCH_ENABLED=1` + kind armed (`runtime_enqueue_event` refuses `kind_not_armed`) |
| property.research handler | `agent/missions/property-research-handler.js:1-40` | read-only internal dossier, comps, economics, MAO / opening plan as FINDINGS; optional bounded web step; never writes a score, offer or stage |
| Valuation refresh queue | `domain/valuation-refresh/valuation-queue.js:55` `classifyValuationCandidate`, `:87` `buildValuationQueue` | pure; excludes suppressed / wrong number / denied / closed |
| Valuation refresh handler | `agent/missions/valuation-refresh-handler.js:27,48,79` | `VALUATION_REFRESH_ENABLED=1`; hold consulted per property (`consultHold`); dry run by default |
| Dry-run runner | `domain/valuation-refresh/dry-run.js:30,40,108` | write mode needs `VALUATION_REFRESH_WRITE_ENABLED=1` + an owner approval ref + a write-capable client (none provided) |

## 4. Operator work items

| Path | file:line | Authority today |
|---|---|---|
| Table | `[mig] PROPOSED_20261016140000_operations_action_center.sql:82` `agent.ops_work_item` | CHECKed scope / kind / payload_is_clean; unique (org, dedupe_key) |
| Lease-bound writer | same `:166` `agent.ops_work_item_sync` | the caller must hold the live lease of a running job whose kind maps to a scope (`ops_scope_of_kind`, `:117`; #24 adds `conversation`); dedupe keys carry the scope |
| Operator decision | same `:219` `agent.ops_work_item_decide` | a named operator acknowledges / resolves / dismisses / reopens |
| Store | `agent/operations/operations-store.js:14,64-65` | reads in `BEGIN READ ONLY`; writes only via the functions above |

## 5. Automation hold authority

| Path | file:line | Authority today |
|---|---|---|
| Registry | `[mig] PROPOSED_20261016200000_automation_holds_registry.sql:66` `public.automation_holds`; `:98` one active hold per key | append-only (release = audited update); `automation_hold_events` audit trigger |
| Lookup | same `:173` `public.automation_hold_for` | STABLE invoker; any scope key match × blocked capability |
| Table guards | same `:335-346` | BEFORE triggers on seller_offers, closing_cases, acquisition_opportunities and **send_queue** (insert or `queue_status` → a sendable state, incl. `processing`) |
| Resolver | `domain/holds/automation-hold.js:95` `resolveAutomationHold`, `:357` `checkAutomationHold`, `:389` port binding | FAIL CLOSED (no client / RPC / unmapped capability ⇒ held) |
| Port | `domain/holds-port/automation-hold-port.js:28,41` | process-global checker; unregistered ⇒ held |
| Ownership-attribution hold | `domain/holds/ownership-attribution-hold.js:29` `recordOwnershipAttributionHold` | raw insert of an operator_hold per thread (`ownership_unresolved:<thread>`); idempotent per thread |
| Dispatch-time check (blocks an already-queued row) | `domain/queue/process-send-queue.js:3240` (block `:3220-3271`) | `resolveAutomationHold(OUTBOUND_SEND)` ⇒ 423 skipped, row untouched |

## 6. Disposition / stage transitions (pipeline = projection)

The real stage is a projection of offer / contract / closing events; parsed text is evidence only.

| Path | file:line | Authority today |
|---|---|---|
| `transitionOpportunityStage` (the one writer of the real stage) | `domain/opportunity/opportunity-service.js:572-738` | hold on stage advance, fail closed (`:588-606`); closed-won only via `finalizeClosing` (`:608-627`) + DB trigger; money / contract guard (`:629-666`); `validateStageTransition` (`universal-pipeline-registry.js:495-559`). See R1, R3 |
| `evaluateStageAdvance` | `opportunity/stage-advance-guard.js:183-219` | offer needs a valid offer event for non-manual sources; S6+ needs a live closing case |
| `patchUniversalLeadState` (thread copy, disposition) | `domain/lead-state/patch-universal-lead-state.js:397-994` | suppression evidence + invariants; thread copy may not lead the real stage; dryRun (`:738-748`). **No hold check.** See R2 |
| Projection clamp | `lead-state/project-acquisition-stage.js:103-135` | pure |
| `pipeline.propose_stage_change` | `agent/capabilities/defs/pipeline.js:52-95` | approval only; refuses closed; dry-run validation; drift snapshot |

## 7. Follow-up lifecycle

| Path | file:line | Authority today |
|---|---|---|
| Lifecycle tables | `[mig] PROPOSED_20261017120000_followup_intent_lifecycle.sql:78-209` | state graph, one live intent per thread × property × kind, append-only audit; writes service_role only (`:648-666`) |
| Plan | `domain/followups/followup-lifecycle.js:213` `planFollowUpIntent` → RPC `followup_intent_plan` (`[mig] …:246-300`) | writer records planned / not_executable / held; suppression + property × contact + send-time guard at plan; **no hold at plan** (R7) |
| Cancel paths | `followup-lifecycle.js:239` `closeFollowUpIntentsForThread`; `queue/cancel-supabase-pending-outbound.js:149`; `seller-flow/seller-followup-scheduler.js:620`; send_queue sync trigger (`[mig] …:474-526`) | reason required; live mode only (`followup_execution_mode = 'live'`, `:36-37`) |

## 8. AI drafting, R3, send policy, kill switch, queue writer, dispatch

| Path | file:line | Authority today |
|---|---|---|
| `decideAndCompose` | `domain/conversation-ai/runtime/canonical.js:70` | pure apart from the injected model client; `caller` allowlisted; no side effects |
| Review-draft service | `ai/conversation-ai-draft-service.js:44` `draftReplyForInbound` | shadow gate: the reply-policy row (`shadow_enabled`, kill switch released) ∧ `AI_CONVERSATION_SHADOW_ENABLED`; model only with `AI_CONVERSATION_DRAFT_MODEL_ENABLED` and a $0.02 cap; returns a phone-free projection; never queues |
| Canonical inputs | `ai/conversation-canonical-inputs.js:38` `loadCanonicalInputs` | read-only; includes the eligibility dry run (see finding 5) |
| `inbox.draft_ai_reply` capability | `agent/capabilities/defs/inbox.js:240-261` | capability plane (operator session) |
| Kill switch / send policy | `domain/conversation-ai/send-policy.js:25-26,80,86` | `ai_conversation_send_enabled` absent ⇒ OFF; policy defaults disabled; hard caps 25/day, 1/seller/day |
| R3 executor | `ai/conversation-ai-r3-executor.js:149` (steps `:176-437`) | kill switch, policy, owner-handled, fresh state, persona, scope, hold (`:257`), eligibility, validation, timing, reservations, brakes, immutable record, then `insertSupabaseSendQueueRow` |
| Insert chokepoint | `supabase/sms-engine.js:5430` `insertSupabaseSendQueueRow` | hold at enqueue, fail closed (`:5553-5584`) |
| Dispatch | `domain/queue/process-send-queue.js:3146` | canonical send authority (`:3197`); hold (`:3240`); campaign authority; AI row gate (`:1677`); compliance + send-time guard (`:2586`); canonical seam (`:2607`) |

## 9. Negotiation, seller offers, campaigns

| Path | file:line | Authority today |
|---|---|---|
| Envelope | `domain/negotiation/envelope.js:37-238`; approval `envelope-approval.js:50-138` | scope = sha256(thread\|property); max price ≤ MAO; expiry ≤ 30 days; operator-only prepare (`:85`). See finding 3 |
| Send authorization (8.5.21-b) | `negotiation/send-authorization.js:46-94,180-193` | a second, distinct approval; ceiling ≤ envelope max; TTL ≤ 7 days; terms hash. See R5 |
| `preparePosition` | `negotiation/negotiation-service.js:64-101` → `position.js:71-178` | pure; escalates on every out-of-envelope condition; amount ≤ max |
| `composeNegotiationReply` | `negotiation/negotiation-composer.js:101-156` | flag, hold, within_authority, live send authorization, one `{{offer_price}}` template, seller-facing guard; **never sends** |
| Seller offers | `seller-flow/seller-offer-authority.js:140` `persistActiveOffer`, `:374` `recordSellerCounter`, `:414` `acceptActiveOffer` | hold; CAS; replay. See R4. Acceptance is never exposed |
| Manual-offer override | `domain/inbox/manual-offer-guard.js:112-123` | free-text `approval_ref` checked only for presence: **not authority** for the gateway |
| Campaign lifecycle | `domain/campaigns/campaign-automation-service.js:9777-10105` (pause `:9967`, resume `:9994-10046`); state machine `campaign-state-machine.js:60-71,220-299` | see R6; dispatch defers paused campaigns (`queue/campaign-execution-authority.js:35-49`) |
| Execution lock | `domain/campaigns/campaign-execution-lock.js:39-60` | TTL lease on queue-plan writes only; fails open when the RPC is missing (`:54-58`) |

## 10. Reconciliation jobs

| Job | file:line | Report-only? |
|---|---|---|
| `pipeline.reconcile` | `agent/operations/operations-handlers.js:228-279`; logic `operations/pipeline-reconciler.js:59-110` | never writes a stage; `propose:false` ⇒ findings only, but still writes findings and work items |
| `followup.reconcile` | `domain/followups/followup-execution.js:153-188` | report-only unless `apply:true` ∧ live |
| Seller-state reconcile | `app/api/internal/seller-flow/reconcile-state/route.js:27-34,80` | dry run in body |
| recover-inbound / queue reconcile | `route.js:15-28`; `queue-reconcile-request.js:120` | too broad / no dry run: **never wrap** |

Nothing can enqueue `pipeline.reconcile` or `followup.reconcile` on demand today: `missions.create` kinds (`defs/platform.js:22`), the missions route (`mission-kinds.js:21`).

## 11. Verdicts: requested tools → existing services

**Status** is this branch:

- **built**: implemented end to end, with tests;
- **stub**: registered, and every call answers `capability_not_implemented`.

| Tool | Tier | Verdict | Existing service (file:line) | Guards the gateway policy calls / adds | Status |
|---|---|---|---|---|---|
| create_research_job | T1 | **REUSE** (input encoding) + **WRAP** (agent principal) | `agent.runtime_enqueue` (`[mig] intel_runtime.sql:593`) with `researchMissionInput` (`defs/platform.js:26`), kind `mission.research` | properties exist; hold per property (`property.research_enqueue`); budget ≤ the grant envelope ceiling (default $0.50) else a human approval; the runtime's own gates, spend guard and emergency stop at claim / reserve | **built** |
| request_property_valuation | T1 | **WRAP** | `agent.runtime_enqueue('property.research', {trigger:'valuation_stale_or_missing', web:false})`, the `enqueuePropertyResearch` shape (`property-research-triggers.js:42`) | property exists; hold (`valuation.refresh`); $0, no web; findings only. A per-property `valuation.refresh` dry run needs handler input support (D5) | **built** |
| create_operator_task | T1 | **WRAP** | `agent.ops_work_item` (`[mig] operations_action_center.sql:82`): the gateway writes scope `agent`, kind `agent_task`, through its own lease-bound writer (same pattern as `ops_work_item_sync`, `:166`) | subject (thread / opportunity) exists; text masked + digit-neutralized; humans decide via `ops_work_item_decide` (`:219`) | **built** |
| update_operator_task | T1 | **WRAP** | same table, agent scope only | only agent-created tasks; add note / priority / due / resolve; acknowledge and dismiss stay human | **built** |
| run_authorized_reconciliation | T1 | **REUSE** (logic) + **WRAP** (report only) | `agent.ops_pipeline_facts` + `reconcileOpportunity` (`pipeline-reconciler.js:59-110`) | report only: no finding, work item, approval or stage written. Apply mode = a separate approval-tier action (later) | **built** (pipeline kind) |
| update_lead_disposition | T2 | **WRAP** | `patchUniversalLeadState({patch:{disposition}})` (`patch-universal-lead-state.js:397`, dry run `:738`) | allowlisted disposition codes only (no suppression / contactability); never pass suppression evidence; add the hold check (the service has none) | stub |
| update_lead_stage | T2 | **REUSE** | `pipeline.propose_stage_change` → `transitionOpportunityStage` on human approval (`defs/pipeline.js:52-95`) | server-set `source` / `actor` (R1); stage stays a projection | stub |
| create_deal_action | T2 | **MISSING** | — (closest: `updateOpportunity` next_action / next_action_due, `opportunity-service.js:1035-1043`) | a narrow next-action writer with a hold check and `emitWorkflowEvents:false`; never the money fields | stub |
| set_thread_hold | T2 | **REUSE** (the registry) + **WRAP** (lease-bound SET-only writer) | `public.automation_holds` (`[mig] holds_registry.sql:66`) and its triggers | thread exists; hold key `agent_hold:<thread>` (idempotent); blocks every automated capability, never `manual_send`; release stays human | **built** |
| request_thread_hold_release | T2 | **MISSING** (by design) | — | must become an operator work item / approval; agents never release | stub |
| draft_seller_reply | T1 | **REUSE** | `draftReplyForInbound` → `decideAndCompose` (`ai/conversation-ai-draft-service.js:44`; `runtime/canonical.js:70`) | hold (`ai_reply_decision`); STOP / suppression / opt-out before AND after the draft (a STOP arriving mid-draft discards it); the draft service's shadow gate; never queued | **built** |
| schedule_followup | T2 | **WRAP** | `planFollowUpIntent` (`followup-lifecycle.js:213`) | live mode only; add a hold check at plan (R7); send-time guard; eligible intents only | stub |
| cancel_followup | T2 | **WRAP** | `closeFollowUpIntentsForThread` (`followup-lifecycle.js:239`) | reason required; cancel-one-by-id is MISSING | stub |
| queue_authorized_reply | T3 | **MISSING** | the only AI-text writer is the R3 executor (`r3-executor.js:149`, single pinned importer) | the production capability (`ai_conversation_send_enabled` + send policy) AND every R3 / dispatch guard; never bypass | stub |
| prepare_acquisition_offer | T4 | **REUSE** (read only) | `preparePosition` (`negotiation-service.js:64`), composer view only | the capability-plane naming gate refuses `offer` outside `.prepare_` approval capabilities (`contracts.js:70`); the gateway capability id is `offers.prepare` | stub |
| submit_offer_for_approval | T4 | **WRAP** (new approval capability) | modelled on `envelope-approval.js:50-138` | MAO cap; `validateEnvelope`; drift snapshot; fix decidability first (D6) | stub |
| execute_authorized_offer | T4 | **MISSING** | parts: `composeNegotiationReply`, `persistActiveOffer`, `recordNegotiationEvent` | live envelope + send authorization for the exact thread / property; durable sends-used (R5); amount ≤ ceiling before persist (R4) | stub |
| record_seller_counteroffer | T2 | **WRAP** | ledger `seller_counter` (`negotiation/ledger.js:66-67,96`) / `recordSellerCounter` (`seller-offer-authority.js:374`) | bound to an inbound message id, never a model-asserted number | stub |
| pause_campaign | T2 | **WRAP** | `applyCampaignLifecycleAction(id, {action:'pause'})` (`campaign-automation-service.js:9967`) | fixed action; a named actor recorded (R6) | stub |
| request_campaign_resume | T3 | **WRAP** (approval capability) | modelled on `campaigns.prepare_launch_approval` (`defs/campaigns.js:216-263`) | launch + resume readiness re-checked on approval | stub |
| adjust_campaign_plan | T3 | **MISSING** | `updateCampaign` (`campaign-automation-service.js:6331`) is too broad | allowlisted caps / interval / filters behind approval; a state guard | stub |
| read_conversation_context (scoped read) | T1 read | **WRAP** (projection) | `loadCanonicalInputs` + `ledgerSummary` + persona continuity + `dryRunEligibility` | its own read scope + grant; audited; bodies masked; no phone, sender number, street address or names | **built** |

**Never exposed:** contracts, closings, acceptance (`acceptActiveOffer`), withdrawals of communicated offers (no service exists), envelope revocation, legal actions, hold release, unsuppression, system_control writes. The catalog asserts none of them is registered.

## 12. No duplicate systems

What the gateway adds, and why each piece is not already somewhere:

- **Agent principal registry + standing grants.** No agent identity exists today. The capability plane's principal is a human session; missions run as their requesting operator.
- **Durable intents, immutable authorizations, outcomes, audit.**
  - The capability audit records decisions but not a lease-based execution with recovery.
  - The R2 job table is for background jobs, not synchronous agent actions with a per-resource exclusivity rule.
- **Lease-bound domain-write functions for the two writes that had no SQL writer.** Holds were raw inserts; ops work items accepted runtime leases only. Both follow the existing pattern (definer, lease-bound, parameters from the authorized record).

Everything else is reused:

- the approval ledger and its human decide path;
- the runtime enqueue, its idempotency and its spend guard;
- the hold registry and its triggers;
- the draft service and decideAndCompose;
- the pipeline reconciler;
- the prohibited-tool rules;
- canonical hashing and the PII masks;
- the read-only server's credential-file, limits, redaction and audit modules (imported, not modified).

## 13. Dependencies on code owned elsewhere (written up, not changed)

- **D1 (done on `feat/action-mcp-t2`, docs/ACTION-MCP.md §8.4):** register `agentActionApprovalCapability` (`domain/action-gateway/approvals.js`) in `agent/capabilities/index.js` `FIRST_CAPABILITIES`, and add `services.actionGateway = createIntentApprovalReader({ query })` over the agent_api pool. Without it, gateway approvals can be filed but not decided in production.
- **D2:** the Inbound Action Center UI should render `agent.ops_work_item` scope `agent` / kind `agent_task` (it reads every scope today; the label set is UI-side).
- **D3:** `queue/send-time-contact-guard.js#loadSendTimeContactFacts` should use the injected client for its hold fact when no checker is passed (finding 5).
- **D4:** add `action_gateway_enabled`, `action_gateway_tiers` and `action_gateway_killed_capabilities` (and the AI send keys, finding 6) to `OPERATOR_OWNED_SYSTEM_KEYS` (`domain/queue/operator-brake-authority.js:27-37`).
- **D5:** `valuation.refresh` handler: accept `input.property_refs` so one property can be dry-run valued on request (today it builds its own queue).
- **D6:** make envelope / send-authorization approvals decidable through the one decide route (finding 3) before any T4 tool.
- **D7:** fix R1 (server-set stage source; done on `feat/action-mcp-t2`), R4 (amount ≤ ceiling inside `persistActiveOffer`) and R5 (durable sends-used) before the corresponding T2 / T4 tools are built.
