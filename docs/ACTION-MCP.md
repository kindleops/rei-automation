# LeadCommand Action MCP + Action Gateway (phase 1)

> "AGNTEI THINKS, COORDINATES AND ACTS. LEADCOMMAND ENFORCES AUTHORITY AND EXECUTES." (owner directive, 2026-10-19)

Status: **PROPOSED. Nothing is deployed, applied or activated.** Everything is born OFF.

The read-only MCP (`mcp/leadcommand-mcp`, 13 tools, role `lc_mcp_reader`) is unchanged. The Action MCP is a separate server with a separate credential.

Related documents:

- the audit of the existing action paths: [`docs/ACTION-MCP-AUDIT.md`](ACTION-MCP-AUDIT.md);
- the migration chain: [`docs/rc-8.5.21-migration-chain.md`](rc-8.5.21-migration-chain.md), link #26.

## 1. Architecture

```
Agntei agent ──(MCP: loopback Streamable HTTP or stdio, Bearer lcag_… per agent)──▶ mcp/leadcommand-action-mcp
   │                                                                                   protocol layer only
   ▼                                                                                   (no other code path)
apps/api/src/lib/domain/action-gateway  ── THE ONE EXECUTION SERVICE ──────────────────────────────────────────
   auth → tenant → stop / tier / capability kills → standing grant → schema → resource → intent → policy
   → authorization → lease → domain service → outcome → recovery → audit
   │ every DB call: PostgREST RPC AS lc_action_gateway (JWT role + lc_org tenant claim) through a guarded fetch
   ▼
PostgreSQL: schema action_gateway (intents, authorizations, outcomes, audit, principals, standing grants)
            + the EXISTING domain objects: automation_holds, agent.ops_work_item, agent.runtime_enqueue,
              agent.approval_request (human decide path), agent.ops_pipeline_facts, the conversation read surface
```

### 1.1 Per call: the gateway pipeline

The pipeline lives in `apps/api/src/lib/domain/action-gateway/gateway.js`.

1. **Agent identity.** The presented credential becomes `HMAC-SHA256(pepper, token)`. The definer function `public.action_gateway_principal(digest)` resolves it to a principal.
   - The gateway role cannot read or enumerate the registry.
   - The principal must be active, its credential unexpired, its org the served org, and its human sponsor still an org member.
   - Nothing in a tool argument selects an identity.
2. **Kill switches.** `system_control` keys, absent = OFF:
   - `action_gateway_enabled` = `'true'`: the global emergency stop;
   - `action_gateway_tiers`, e.g. `T1,T2`;
   - `action_gateway_killed_capabilities`.
3. **Implemented?** A stub answers `not_implemented / capability_not_implemented`.
4. **Grant.** A standing grant must exist for the capability, at least at the action's tier and within the principal's tier ceiling. It must be in its validity window and not suspended. Its scope must cover the resource.
5. **Arguments.** Forged-context keys (agent, org, tier, approval, grant, role, scope, …) and escalation keys (sql, statement, route, search_path, …) are refused at any depth. The closed, bounded schema is validated.
6. **Rate.** Per agent and per action, in process. The grant's caps are enforced in the database.
7. **Resource.** The authoritative LeadCommand row is resolved in the tenant: an `inbox_thread_state.id`, a property, an opportunity or an agent work item. Its market is part of the scope facts.
8. **Intent.** `action_intents` gets one row per `(org, sha256(agent, action, resource, client_request_id))`.
   - A replay returns the recorded outcome.
   - The same key with other parameters is a `conflict`.
9. **Policy.** The action's policy calls the EXISTING guards: the hold authority, STOP / suppression / opt-out, budgets. It answers `allow | deny | approval`.
   - `deny` records a refused outcome.
   - `approval` files ONE `agent.approval_request` bound to the intent (§5).
   - Outside the grant's argument envelope, or T3/T4, or an irreversible T2, `allow` becomes `approval`.
10. **Authorization.** `action_authorizations` gets an immutable row.
    - Standing-grant admission runs first, under a row lock on the grant. It records a cap hit and auto-suspends at the threshold.
    - A definer trigger re-verifies, before the row exists: the presented digest equals the intent agent's; the principal; the sponsor; every grant bound; the kills; and the human approval record when one is required.
11. **Execution.** A lease is taken on the intent. At most one executing intent per resource is allowed, so concurrent agents on one lead serialize. Then the domain service runs:
    - **database domain writes:** `action_gateway_dw_*` SECURITY DEFINER functions. They re-check the lease, authorization, kills and grant (revocation or suspension mid-run refuses). They read their parameters from the authorized intent, never from the caller. The write and its outcome commit in ONE transaction: exactly once;
    - **read-only JS services:** the draft service and the reconciler. The outcome is recorded on completion. The database withholds the result if the stop or a revocation landed meanwhile.
12. **Recovery.**
    - An expired lease is re-claimed and re-executed. This is safe because the writes are atomic and keyed by the intent.
    - An intent recorded `report_unknown`, or one out of attempts, becomes a visible `outcome_unknown`. It is never silently retried.
    - The server runs the sweeper every 30 s.
13. **Audit.** `action_audit_events` is append-only. It records every refusal, including unauthenticated ones, and every step. The host audit file holds the same events, redacted.

### 1.2 Data path and credentials

**Role `lc_action_gateway`** (link #26):

- NOLOGIN NOINHERIT. No SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS. A member of no role. Granted to `authenticator`.
- It can:
  - EXECUTE the SECURITY INVOKER entry points `public.action_gateway_*`;
  - INSERT bookkeeping rows, and UPDATE only the intent lifecycle columns;
  - EXECUTE an allowlisted set of definer functions: principal lookup, reply-policy read, three domain writes, grant admission / failure / execution check, `agent.capability_approval_insert` (the wrapper only files approvals for its own open intents), `agent.ops_pipeline_facts`;
  - SELECT the read inventory: 14 public relations, plus a key-allowlisted `system_control` (RLS).
- It cannot:
  - write any public / agent table;
  - read principals or grants;
  - release a hold;
  - write `system_control`;
  - reach any egress function.
- `action_gateway.self_check()` proves all of this at apply time and at every server boot.

**Tenant.** The PostgREST JWT carries `lc_org`. Every RLS policy and entry point reads it; without it nothing is visible.

**Server credentials.** All are 0600 files outside the repo, never env values:

- the gateway JWT;
- the public API key;
- the credential pepper;
- (stdio only) one agent credential.

The loader fences the service-role client, direct Postgres and dotenv. Ambient writable credentials refuse the boot.

**HTTP.**

- Loopback only, with Host / Origin checks.
- The bearer is the agent credential, verified with the gateway at session open; every call is authenticated again.
- A session is bound to the credential that opened it.
- Bodies and sessions are bounded, and authentication failures are throttled.

## 2. Tool inventory and the capability × tier matrix

| Tool | Capability | Tier | Phase 1 | Wraps (audit verdict) |
|---|---|---|---|---|
| create_research_job | research.create_job | T1 | **built** | `agent.runtime_enqueue('mission.research')`. Spend ≤ the grant envelope (default $0.50) else approval; the daily spend cap |
| request_property_valuation | valuation.request | T1 | **built** | `agent.runtime_enqueue('property.research', web:false, $0)`. Hold `valuation.refresh` |
| create_operator_task | tasks.create_operator_task | T1 | **built** | `agent.ops_work_item` scope `agent` (the Action Center). Humans decide |
| update_operator_task | tasks.update_operator_task | T1 | **built** | agent tasks only: note / priority / due / resolve |
| draft_seller_reply | conversation.draft_reply | T1 | **built** | `draftReplyForInbound` → `decideAndCompose` (shadow). Hold + STOP / suppression before and after; never queued |
| run_authorized_reconciliation | ops.reconciliation_report | T1 | **built** (kind `pipeline`) | `ops_pipeline_facts` + `reconcileOpportunity`, report only |
| read_conversation_context (read) | conversation.read_context + scope `conversation_context.read` | T1 | **built** | `loadCanonicalInputs` projection: masked bodies, facts, persona, permission, property evidence; no phones |
| set_thread_hold | holds.set_thread_hold | T2 (reversible) | **built** | `public.automation_holds`, SET only; release is human |
| update_lead_disposition | leads.update_disposition | T2 (request only) | **built** (§8) | WRAP `patchUniversalLeadState` via a human-decided request |
| update_lead_stage | leads.update_stage | T2 (request only) | **built** (§8) | REUSE `pipeline.propose_stage_change` |
| create_deal_action | deals.create_action | T2 (reversible) | **built** (§8) | REUSE `agent.ops_work_item` (opportunity subject) |
| request_thread_hold_release | holds.request_release | T2 (request only) | **built** (§8) | a human-decided release request; agents never release |
| schedule_followup | followups.schedule | T2 (reversible) | **built** (§8) | WRAP the lifecycle writer `followup_intent_plan` |
| cancel_followup | followups.cancel | T2 (reversible) | **built** (§8) | WRAP the lifecycle cancel path |
| record_seller_counteroffer | offers.record_counter | T2 (irreversible: per-use approval) | **built** (#28, §9) | `recordSellerCounter` + ledger `seller_counter` via the executor; the acceptance guard reports, never accepts |
| pause_campaign | campaigns.pause | T2 (reversible) | **built** (§8) | WRAP `campaign_transition_status(…, 'paused')` |
| queue_authorized_reply | conversation.queue_reply | T3 | **built** (#28, §9) | handoff → `createCanonicalTurnDecider` → the R3 dispatcher → canonical queue writer → runner |
| request_campaign_resume | campaigns.request_resume | T2 (request only) | **built** (§8) | a human-decided resume (`applyCampaignLifecycleAction('resume')`) |
| adjust_campaign_plan | campaigns.adjust_plan | T2 (request only) | **built** (§8) | a human-decided bounded `updateCampaign` |
| prepare_acquisition_offer | offers.prepare | T4 (scoped read) | **built** (#28, §9) | `assessOpportunityEconomics` + `planOffer` + `laneValuation` (cross-check) + `preparePosition` → composer view |
| submit_offer_for_approval | offers.submit_for_approval | T4 | **built** (#28, §9) | the approval ledger → on the human decision `negotiation_envelopes` |
| execute_authorized_offer | offers.execute_authorized | T4 (envelope ref) | **built** (#28, §9) | envelope + send authorization (D6) + durable budget (R5) → composer → `persistActiveOffer` (R4) → ledger → canonical queue writer |

Never exposed (asserted by the catalog): contracts, closings, acceptance, withdrawals of communicated offers, legal actions, hold release, unsuppression, `system_control` writes.

What each tier may do:

| Tier | Meaning | Standing grant alone? | Additionally needs |
|---|---|---|---|
| T1 | Autonomous internal: research, tasks, drafts, findings, reports | **yes**, within scope / caps / envelope | — |
| T2 | Policy-authorized reversible operational mutation | **only** actions in `action_gateway.standing_t2_actions()` (today: `set_thread_hold`) | others: a per-use human approval |
| T3 | Seller-facing | **never** (DB CHECK + trigger: `TIER_REQUIRES_APPROVAL`) | the path's production activation (e.g. `ai_conversation_send_enabled` + the send policy) AND every dispatch guard AND a per-use approval |
| T4 | Financial | **never** | prepare freely. Communication only inside an operator-authorized envelope for that exact property and thread (`envelope_ref` `send_authorization:<uuid>`, accepted for `execute_authorized_offer` only from link #28, verified by the authorization guard); else an approval request |

## 3. Standing grants (owner addition, 2026-10-19)

The owner's words: "reusable, bounded agent authority so approved internal operations can run autonomously without repetitive human approval."

A row of `action_gateway.capability_grants` is an owner-approved grant per agent × capability × scope:

| Bound | Column | Enforced |
|---|---|---|
| Resource scope (org; markets; campaigns; resource types) | `org_id`, `scope` `{markets, campaign_ids, resource_types}` | JS (clear refusal) and DB (`grant_scope_refusal` over the authoritative market of the thread / property / opportunity) |
| Use caps | `max_uses_per_hour`, `max_uses_per_day` | DB, under a row lock on the grant: concurrent uses cannot race past a cap |
| Spend cap | `max_spend_usd_per_day` (each use's `spend_usd` = the intent's `budget_usd`) | DB |
| Allowed-argument envelope | `envelope` `{max: {param: n}, allow: {param: [v]}}` over the stored params | outside the envelope: a per-use approval (JS); the DB refuses it without one |
| Validity window | `valid_from`, `expires_at` (≤ 366 days) | DB |
| Revocation | `revoked_at / revoked_by` (final). A new version = a new row with `grant_version` and `supersedes_grant_id` | DB, also mid-run: the domain write / completion refuses |
| Use record | `action_authorizations.grant_id` + `spend_usd`; `grant_events` (cap hits, failures, suspensions) | append-only |
| Anomaly auto-suspension | `max_cap_hits_per_hour`, `max_failures_per_hour` → `suspended_at`, `suspended_reason` `ANOMALY_CAP_HITS` / `ANOMALY_ERROR_RATE` | DB; only an owner reinstates |

Only org owners write grants and principals (SQL editor / service_role). The gateway role cannot.

## 4. Schema (link #26)

`supabase/migrations/PROPOSED_20261019160000_action_gateway.sql` (+ `_pretest`, `_posttest`, `_rollback`, `_rollback_posttest`). Schema `action_gateway`:

- **`agent_principals`**
  - Columns: `agent_id`, `org_id`, `display_name`, `sponsor_user_id` (a named operator), `credential_digest` (unique HMAC), `credential_rotated_at` / `credential_expires_at` (≤ 90 days), `tier_ceiling`, `read_scopes`, `status` (active / suspended / revoked: final), `created_by` (owner).
  - Rules: guard trigger; owner-written.
- **`capability_grants`**: the standing grants (§3). Rules: guard trigger (revoke / suspend only; versions supersede).
- **`action_intents`**
  - Columns: idempotency key unique per org, params (payload-clean) + hash, state, recovery mode, attempts, lease, approval link.
  - Rules:
    - partial unique index: one executing intent per resource;
    - trigger: born `received`, immutable request, legal transitions (mirrored in `constants.js`, pinned by a test), `authorized` ⇒ a verified authorization, terminal ⇒ its outcome.
- **`action_authorizations`**
  - Columns: grant, tier, policy id + version, sponsor, approval (unique: single use) + `approved_by`, `spend_usd`, `envelope_ref`.
  - Rules: immutable; the definer verification trigger (§1.1 step 10).
- **`action_outcomes`**: one per intent; immutable; ids / codes / hashes only.
- **`action_audit_events`**: append-only.
- **`grant_events`**: append-only.

RLS is enabled and FORCED on every gateway table:

- `lc_action_gateway`: its tenant (`lc_org`) only;
- operators (`authenticated`): read via `agent.can_read_org`;
- `agent_api`: reads intents, for the approval cards;
- `service_role`: administers principals and grants.

`agent.ops_work_item`: the scope / kind CHECKs gain `agent` / `agent_task`.

## 5. Approvals

An agent can never claim approval:

- an `approval_id` argument is refused as forged context;
- the authorization trigger accepts an approval only when every condition below holds:

1. it is an `agent.approval_request` of capability `agent_actions.authorize_action` v1;
2. it is in state `executed`, decision `approve`, decided by an org member;
3. it is bound to THIS intent, its `params_hash`, its agent and its action;
4. its `grant_expires_at` has not passed;
5. it has not been used before.

The human decides through the EXISTING operator path: `POST /api/cockpit/agent/actions/approvals/:id/decide`, with a verified named operator and a payload hash echo. The capability's `executeApproved` executes nothing; it re-verifies the intent and records the grant. The gateway consumes it on the agent's retry with the same `client_request_id`.

## 6. Tests (disposable PostgreSQL 17 only)

- **`node scripts/db/run-migration-test.mjs --pg-bin <pg17 bin> --id action_gateway`**
  - Steps: apply → posttest → rollback, restoring the exact fingerprint → re-apply.
  - The posttest proves: role shape; raw writes refused; tenant isolation; forged digests; a hold blocking a queued row; the emergency stop; approval binding / replay / expiry; resource exclusivity; the self-check.
  - Also the last link of both `rc_8_5_21_release_chain*` entries (4/4 PASS).
- **`apps/api/tests/critical/action-gateway-{tools,adversarial,crash,standing-grants}-pg.test.mjs`** (31 tests, `AGENT_PG_TEST_DB_URL` = a loopback scratch server; green 5× in one run under default file concurrency, and alone; bootstrap serialized by a cluster-wide advisory lock because roles are cluster-global):
  - every T1 tool end to end;
  - unauthorized capability; tier ceiling; cross-tenant; forged identity;
  - approval replay / denial / expiry / lapsed grant;
  - duplicates, incl. 8 concurrent; concurrent agents on one lead;
  - the emergency stop, incl. mid-flight;
  - raw SQL / escalation through arguments and the role;
  - `set_thread_hold` blocking a queued send in the REAL dispatcher (zero simulated provider calls);
  - STOP arriving during the draft (discarded + recorded);
  - REAL SIGKILL recovery: before the domain write, and inside the in-flight write;
  - outcome_unknown;
  - a regression: an approval for a resource whose UUID contains a phone-shaped digit run (UUIDs in CHECKed payloads always sit under id-named keys);
  - the context read checked with a phone-precise NANP / E.164 detector plus a negative control that the seeded real number is caught;
  - standing grants: exhaustion, spend cap, expiry, not-yet-valid, revocation mid-run (domain write + read-only service), out-of-scope resource, argument outside the envelope, concurrent cap races, anomaly suspension (cap hits, error rate), versioning, T3 / T4 / irreversible T2 never by grant alone, default OFF.
- **`apps/api/tests/critical/action-gateway-unit.test.mjs`**: catalog invariants; scope / envelope mirrors; approval judging; text cleaning; credentials; and a STATIC proof that the gateway module has no import path to the send stack.
- **`mcp/leadcommand-action-mcp` `npm test`** (19 tests):
  - protocol (discovery, call mapping, the connection-bound credential, masks, secret guard);
  - config and credential refusals; guarded fetch; HTTP (Host / Origin / auth / throttle / session binding); inventory pinned to the migration; owner scripts;
  - end to end on PG: boot self-check, two agents, the hold, stubs, the stop, an audit with no credential or phone, and a boot refusal for a wrong DB role.
- **Network is trapped in every PG test**: any `fetch` or TextGrid credential read fails the test. The provider is simulated.

## 7. Deployment and rollback plan

Nothing below is authorized yet. **Each step needs its own owner approval.**

1. **Code deploy (no behaviour change).**
   - Merge `feat/action-mcp`.
   - The API gains the domain module, but no route and no runtime handler calls it.
   - The Action MCP is a separate local process that nobody starts.
2. **Dependencies first.** See the audit, §13:
   - D1: register `agentActionApprovalCapability` and the intent reader in the capability plane, so approvals can be decided;
   - D3: hold fact on the injected client;
   - D4: operator-owned keys.
3. **Resolve pg_net** (the same prerequisite as #25). Link #26's self-check refuses while PUBLIC can reach schema `net`.
4. **Apply link #26 in production.**
   - Precondition: #0, #1, #2, #3, #7, #15 and #24 are applied, and RLS is on `system_control`.
   - Run its pretest read-only first, then: `psql --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261019160000_action_gateway.sql`.
   - The apply ends with the self-check.
5. **Mint credentials** (owner, outside the repo):
   - the pepper file (≥ 32 random bytes, 0600);
   - `npm run mint:gateway-token -- --secret-file … --org <org> --out …` (role `lc_action_gateway` + `lc_org`, ≤ 90 days);
   - per agent: `npm run mint:agent-credential -- --pepper-file … --agent-id agt_… --out …`. It prints only the digest and the registration SQL.
6. **Register principals and standing grants** (owner SQL). Start with T1 only, narrow scopes, low caps, a short validity window, `max_spend_usd_per_day` 0 unless research spend is intended.
7. **Activate** (owner, `system_control`):
   - `action_gateway_tiers = 'T1'`, then `action_gateway_enabled = 'true'`;
   - drafts additionally need `LEADCOMMAND_ACTION_MCP_DRAFT_SHADOW_ENABLED=true` on the server and the reply policy's shadow gate open.
   - T2 (`set_thread_hold`) is a separate approval: add `T2` to the tiers.
8. **Start the server.**
   - Command: `LEADCOMMAND_ACTION_MCP_TRANSPORT=streamable-http … npm start`, on the operator host, loopback only.
   - The boot self-check must report `ok` as `lc_action_gateway`.

**Kill switches** (any one stops every action, immediately):

- delete `system_control.action_gateway_enabled`: the global emergency stop; it also refuses intents already authorized, at execution;
- remove a tier from `action_gateway_tiers`;
- add a capability to `action_gateway_killed_capabilities`;
- revoke one grant, or set a principal `suspended` / `revoked`;
- `revoke lc_action_gateway from authenticator;` cuts the database path.

**Rollback** (`PROPOSED_20261019160000_action_gateway_rollback.sql`, its own approval):

- It refuses while any intent is pending or any agent-scope operator task exists.
- It drops exactly what the apply created and restores the `ops_work_item` CHECKs.
- Holds the gateway set REMAIN: releasing them is an operator decision in the hold registry.

### Exact production approvals needed

1. Merge + deploy the branch (code only; inert).
2. The D1 / D3 / D4 changes in their owners' areas.
3. pg_net remediation (shared with #25).
4. Apply link #26 (and, separately, its rollback if ever needed).
5. Mint the gateway token and the pepper; mint and register each agent principal.
6. Each standing grant: capability, scope, caps, spend, envelope, validity.
7. Turn on `action_gateway_enabled` with `action_gateway_tiers = 'T1'`.
8. Draft shadow on the server (and the reply policy's shadow gate).
9. `T2` for `set_thread_hold`.
10. Any T3 / T4 tool: a separate build phase. For each one: its own production activation of the path (e.g. `ai_conversation_send_enabled` + the send policy, envelope decidability D6), plus per-use approval / envelope wiring.

## 8. Tier-2 tools (link #27, PROPOSED, born OFF)

Branch `feat/action-mcp-t2`. Code: `apps/api/src/lib/domain/action-gateway/actions/t2/` (one module per tool). Migration: `supabase/migrations/PROPOSED_20261020100000_action_gateway_t2.sql` (+ pretest / posttest / rollback / rollback_posttest), optional link #27 after #26 in both chains.

### 8.1 Two kinds of T2 action

- **Reversible** (a standing grant authorizes them alone): `pause_campaign`, `cancel_followup`, `schedule_followup`, `create_deal_action` (and #26's `set_thread_hold`). Each runs through a lease-bound SECURITY DEFINER writer that reads its parameters from the authorized intent and wraps the EXISTING domain writer.
- **Request only**: `update_lead_stage`, `update_lead_disposition`, `request_thread_hold_release`, `request_campaign_resume`, `adjust_campaign_plan`. Their own effect is ONE pending `agent.approval_request` of a fixed capability. A named operator decides it through the existing decide path, and that capability's `executeApproved` runs the existing service **as the operator**. The gateway never executes the change. The irreversible step therefore always has its per-use human approval; filing the request is what the standing grant covers.

The gateway mirrors this: `spec.reversible` / `spec.request_only`; the database mirrors it in `action_gateway.standing_t2_actions()` (now `set_thread_hold` ∪ the registry rows with their basis). An unregistered T2 action still needs a per-use approval (`T2_ACTION_NOT_REVERSIBLE`).

### 8.2 Tools → services

| Tool | Writer / human capability | Existing service | Guards (gateway policy; DB writer re-checks in bold) |
|---|---|---|---|
| update_lead_stage | `pipeline.propose_stage_change` (existing, reused) | `transitionOpportunityStage` | S1–S5 only; **contract / closing stages refused** (S10 = `finalize_closing_case`, human); hold on advance; `validateStageTransition` + `evaluateStageAdvance` dry run with the agent source (Offer needs a recorded offer event); never revive; source = `action_gateway:<agent>` |
| update_lead_disposition | `inbox.prepare_disposition_change` | `patchUniversalLeadState` (dry run, then write) | agent allowlist (never suppression / contactability / wrong number / wrong person); **allowlist**; hold (`ai_action`); STOP / suppression; "No thanks" to the ownership question ⇒ `declined_unverified`, never `not_interested`; bare "No" ⇒ property denial, not a disposition; denied pair; re-checked at approval |
| create_deal_action | `action_gateway_dw_deal_action` | `agent.ops_work_item` (scope agent, subject opportunity) | opportunity open; never revive |
| request_thread_hold_release | `holds.prepare_release_approval` | `holds/automation-hold-release#releaseAutomationHoldByOperator` (new: the registry's audited UPDATE, released_by = the operator) | hold active and on the thread; **permanent exclusions (Maxwell) and the Hartford hold refused** (gateway, DB writer, release writer) |
| schedule_followup | `action_gateway_dw_followup_schedule` | `followup_intent_plan` | **hold at plan (R7)**; STOP / suppression / send-time guard; `propertyContactBlock` (no selling nurture after an ownership answer, property denial); contact-window category = `scheduled_followup`; not-interested nurture ≥ 21 days; **suppressed thread**. Planned under `followup_execution_mode` OFF; only the lifecycle's own switch materializes |
| cancel_followup | `action_gateway_dw_followup_cancel` | `followup_intent_close_for_thread` (or the same statements by id) | reason required; allowed under a hold / STOP |
| pause_campaign | `action_gateway_dw_campaign_pause` | `campaign_transition_status(…, 'paused')` | pausable state (JS `isTransitionAllowed`, **SQL edge set**) |
| request_campaign_resume | `campaigns.prepare_resume_approval` | `applyCampaignLifecycleAction('resume')` (readiness re-checked) | **campaign paused** |
| adjust_campaign_plan | `campaigns.prepare_plan_adjustment_approval` | `updateCampaign` (bounded patch) | caps, interval, window only (closed schema); **window 08:00–21:00, bounds**; re-checked at approval |

### 8.3 The composable extension registry

Phase 1 hard-codes three reviewed lists in function bodies. Link #27 adds `action_gateway.extensions (kind, name, link, basis)` (create-if-not-exists) and replaces `self_check`, `standing_t2_actions` and `action_gateway_complete` ONCE with bodies that union the registry (`action_gateway.extension_names(kind)`, definer, STABLE). Kinds: `definer_function`, `entry_point`, `standing_t2_action`, `domain_write_action`.

**Rule for any later link (e.g. the T3 / T4 link):** insert your own rows (your `link` value) instead of editing those three bodies; if your link is applied before #27, create the same table and the byte-identical bodies (copy them from #27). A link's rollback deletes only its rows; whoever leaves the registry empty restores #26's bodies and drops it.

### 8.4 Dependencies closed here

- **D1**: `agentActionApprovalCapability` and the four T2 request capabilities are in `FIRST_CAPABILITIES`; `getCapabilityPlane` adds `services.actionGateway` (`withActionGatewayServices`, agent_api pool). Gateway-filed capabilities are never model-facing tools (`capabilityToolDefs` filters them) and their `prepare` refuses.
- **R1**: `PATCH /api/cockpit/pipeline/opportunities/[id]/stage` refuses a body carrying `source`, `actor`, `offer_event`, `valuation_mid`, `mao`; source = `pipeline`, actor = the ops-dashboard identity (`lib/domain/opportunity/stage-route-input.js`). `pipeline.propose_stage_change` passes `action_gateway:<agent>` only when the approved change carries it (payload-hashed), else `agent_approval`; neither is a manual or closing source.
- **R7**: holds are checked at plan for gateway follow-ups.

### 8.5 Tests

- `action-gateway-t2-tools-pg` (6): per tool, happy path + every refusal above + the human decision through the production registry (stage transition / campaign lifecycle and editor are spies wrapping a minimal real write; the hold release, the approval ledger, the follow-up lifecycle and the campaign writer are real).
- `action-gateway-t2-matrix-pg` (4): all nine tools × unauthorized capability, other-tenant agent, forged `source` / `agent_id` / `actor` / `approval_id`, replay (exactly one effect); concurrent agents on one lead; a crash after the claim, before / inside the write, recovered exactly once; D1 envelope approval consumed once, never replayable, denial refuses.
- `action-gateway-t2-unit` (8): catalog / standing mirror pinned to the migration, D1 registry, snapshot ≡ `normalizeOpportunityRow`, R1 route + capability source, never-revive, bounds, ownership rules.
- `node scripts/db/run-migration-test.mjs --id action_gateway_t2` and both `rc_8_5_21_release_chain*` entries (link #27 last).

### 8.6 Activation (each step its own owner approval)

Apply #27 after #26 (pretest read-only first). Then per agent: standing grants for the T2 capabilities, and `T2` in `action_gateway_tiers`. Follow-ups additionally follow `followup_execution_mode`; request actions need a named operator to decide in the approvals UI.

## 9. Tier-3 / Tier-4 tools (link #28, PROPOSED, born OFF)

Branch `feat/action-mcp-t34` (merged with `feat/action-mcp-t2` at `6e67643d`). Code: `apps/api/src/lib/domain/action-gateway/actions/t34/` (one module per family; registered by one line in `catalog.js` / `actions.js`). LeadCommand's executing half: `apps/api/src/lib/ai/action-gateway-execution.js` and `apps/api/src/lib/domain/negotiation/negotiation-send.js`. Migration: `supabase/migrations/PROPOSED_20261020110000_action_gateway_t34.sql` (+ pretest / posttest / rollback / rollback_posttest), optional link #28 after #27 in both chains; standalone entry `action_gateway_t34`.

### 9.1 The shape: the gateway authorizes, LeadCommand executes

- The gateway role still writes NO business table. A seller-facing / financial / offer-history action's domain write is a **handoff** (`action_gateway_dw_handoff`): in ONE transaction with the intent's outcome it re-checks the production activation, the hold registry and the destination's suppression, consumes the durable send budget (offers, R5), enqueues ONE runtime job of the one executor kind **`action_gateway.execute`** (accountable to the agent's human sponsor; the same kind and pattern as T2's executor — the worker dispatches by the intent's action, `ACTION_EXECUTORS`), and writes a receipt (`action_gateway.seller_action_receipts`).
- The worker (`LC_ACTION_GATEWAY_EXECUTION=1` + the runtime gate + the kind armed by an operator) runs the canonical service with the backend client and records the receipt (`public.lc_seller_action_receipt_record`). A hold, a failure, a refusal after the request or an unknown outcome raises ONE agent-scope operator work item. `input {sweep:'receipts'}` follows enqueued rows to their dispatch outcome (an ambiguous provider accept ⇒ `outcome_unknown` + a critical item, never a resend).

### 9.2 Tools → services → tests

| Tool | Authority | Canonical path (worker) | PG proofs |
|---|---|---|---|
| queue_authorized_reply (T3) | available ONLY with `ai_conversation_send_enabled` + an enabled `ai_conversation_send_policy` and no queue emergency stop (else `capability_unavailable`, before grants); thread in the policy scope; a per-use human approval | `createCanonicalTurnDecider` (decideAndCompose) → the one R3 dispatcher (the intent's `inbound_reply` reservation is the "turn" R3 verifies, so a crashed attempt resumes) → `insertSupabaseSendQueueRow` → the runner | `action-gateway-t34-reply-pg` (9): OFF ⇒ unavailable; happy path → exactly one simulated send; STOP before / during preparation; operator hold before dispatch (policy + registry trigger); unhealthy sender ⇒ hold, never a number change; ambiguous accept ⇒ no resend + critical item; two agents, one inbound ⇒ one reply; REAL SIGKILL between the R3 record and the queue insert ⇒ one row; forged approval / SQL / phone arguments |
| prepare_acquisition_offer (T4, read) | grant + tier ceiling 4 (no intent, audited) | `assessOpportunityEconomics` + `planOffer` (MAO = ceiling, opening strictly below) + `laneValuation` when lane inputs are supplied + `preparePosition` → `composerView`; uneconomic ⇒ never HOT; `plan_hash` | `action-gateway-t34-offers-pg` |
| submit_offer_for_approval (T4) | always a per-use human approval (`agent_actions.authorize_action`) bound to (property, thread, max, opening, terms, expiry days, `plan_hash`); max ≤ engine MAO; opening < both | `action_gateway_dw_offer_envelope`: the envelope for EXACTLY that scope, next version, approval_id = the gateway approval, granted_by = the deciding operator, validity from the grant | `action-gateway-t34-offers-pg` |
| execute_authorized_offer (T4) | `negotiation_send_enabled` (else `capability_unavailable`); a live envelope AND its DISTINCT live send authorization (operator-proposed, decided through the D6 path) for EXACTLY this thread + property; amount = the engine's move ≤ send ceiling ≤ envelope max ≤ MAO; envelope ref `send_authorization:<uuid>` verified by the authorization guard (scope, liveness, both approval records, budget); the budget consumed atomically (R5) | `sendAuthorizedOffer`: `composeNegotiationReply` (approved template, seller-facing guard, the reserved use) → `persistActiveOffer` (R4) → `recordNegotiationEvent` → `insertSupabaseSendQueueRow` (`negotiation_offer:<intent>`, persona + sender of the thread, `max_retries` 1) → `bindOfferToQueueRow`; resumable | `action-gateway-t34-offers-pg` (11): prepare; happy path → one offer under the ceiling, one ledger event, one simulated send; OFF ⇒ unavailable; no send authorization / above the envelope / not the engine's move / EXPIRED / another thread + property / forged refs; the database guard with the JS bypassed; two agents racing (max_sends 1) ⇒ one; REAL SIGKILL after the offer + ledger ⇒ one row; STOP after authorization ⇒ nothing persisted; R4; R5 (8 concurrent consumes); the counter |
| record_seller_counteroffer (T2, irreversible) | a per-use human approval; the price must be a dollar amount the bound inbound states | `recordAgentCounter`: `recordSellerCounter` (a new seller-counter version, history kept) + the ledger; `evaluateAcceptanceRules` reported (`acceptance: human_review_only`); never accepts | `action-gateway-t34-offers-pg` |

Never exposed (catalog `NEVER_EXPOSED`): contracts, acceptance, withdrawals of communicated offers, legal actions.

### 9.3 R4, R5, D6

- **R4** (Hartford's $315K above the $126.1K ceiling): `persistActiveOffer` refuses an outbound offer with no independent ceiling (`offer_ceiling_missing`) or above the LOWEST of the frozen `authorized_ceiling`, the envelope max and the MAO (`offer_above_authorized_ceiling`) unless a complete HUMAN override `{operator_id, reason ≥ 12, approval_ref}` is supplied (recorded on the row as `metadata.ceiling_override`, logged). The effective ceiling is frozen on the row. Link #28's trigger `seller_offers_ceiling_guard` re-checks the same rule in the database (incl. the live envelope max of the scope); a seller counter is never capped.
- **R5**: `public.negotiation_send_authorization_uses` + `public.negotiation_send_authorization_consume` (row lock, re-check, count, insert; idempotent per use key). The composer reads the durable count (a caller-supplied `sends_used` is ignored) and fails closed without it.
- **D6**: `agent/capabilities/decision-registry.js` — the decide path resolves the model-facing specs ∪ the decide-only specs (envelope grant, send authorization, gateway intent). They never enter the model tool list; a decision by an agent / service identity is refused (`HUMAN_DECISION_REQUIRED`). Proven through `handleApprovalDecide` (`action-gateway-t34-unit`).

### 9.4 Schema (link #28) and composition with #27

Adds rows to #27's `action_gateway.extensions` (definer functions, the envelope entry point, the four domain-write actions; never a standing T2 action) and never re-edits `self_check` / `standing_t2_actions` / `action_gateway_complete`. It replaces ONE #26 body, `action_gateway.authorization_guard` (the envelope-ref branch; #27 does not touch it); the rollback restores #26's body verbatim and deletes only its own registry rows. It also adds a key-allowlist policy for `negotiation_send_enabled` on `system_control`. The rollback refuses while a T3 / T4 intent is pending, a receipt is open or a durable send-budget use exists.

### 9.5 Activation (each step its own owner approval)

Apply #28 after #27. Then: `T3` / `T4` in `action_gateway_tiers`; per-agent grants (`conversation.queue_reply` T3, `offers.*` T4, `offers.record_counter` T2; tier ceiling); for replies the production AI send capability itself (`ai_conversation_send_enabled` + the policy); for offers `negotiation_send_enabled` + `NEGOTIATION_COMPOSER_ENABLED=1` in the worker; `LC_ACTION_GATEWAY_EXECUTION=1` and arming `action_gateway.execute` in `agent.runtime_limits.kind_limits`; operators deciding approvals / proposing send authorizations.
