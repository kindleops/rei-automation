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
| update_lead_disposition | leads.update_disposition | T2 | stub | WRAP `patchUniversalLeadState` |
| update_lead_stage | leads.update_stage | T2 | stub | REUSE `pipeline.propose_stage_change` |
| create_deal_action | deals.create_action | T2 | stub | MISSING |
| request_thread_hold_release | holds.request_release | T2 | stub | an operator item / approval only |
| schedule_followup | followups.schedule | T2 | stub | WRAP `planFollowUpIntent` |
| cancel_followup | followups.cancel | T2 | stub | WRAP `closeFollowUpIntentsForThread` |
| record_seller_counteroffer | offers.record_counter | T2 | stub | WRAP the negotiation ledger `seller_counter` |
| pause_campaign | campaigns.pause | T2 | stub | WRAP `applyCampaignLifecycleAction('pause')` |
| queue_authorized_reply | conversation.queue_reply | T3 | stub | MISSING: through R3 only |
| request_campaign_resume | campaigns.request_resume | T3 | stub | WRAP: approval capability |
| adjust_campaign_plan | campaigns.adjust_plan | T3 | stub | MISSING |
| prepare_acquisition_offer | offers.prepare | T4 | stub | REUSE `preparePosition` (composer view) |
| submit_offer_for_approval | offers.submit_for_approval | T4 | stub | WRAP: envelope approval |
| execute_authorized_offer | offers.execute_authorized | T4 | stub | MISSING |

Never exposed (asserted by the catalog): contracts, closings, acceptance, withdrawals of communicated offers, legal actions, hold release, unsuppression, `system_control` writes.

What each tier may do:

| Tier | Meaning | Standing grant alone? | Additionally needs |
|---|---|---|---|
| T1 | Autonomous internal: research, tasks, drafts, findings, reports | **yes**, within scope / caps / envelope | — |
| T2 | Policy-authorized reversible operational mutation | **only** actions in `action_gateway.standing_t2_actions()` (today: `set_thread_hold`) | others: a per-use human approval |
| T3 | Seller-facing | **never** (DB CHECK + trigger: `TIER_REQUIRES_APPROVAL`) | the path's production activation (e.g. `ai_conversation_send_enabled` + the send policy) AND every dispatch guard AND a per-use approval |
| T4 | Financial | **never** | prepare freely. Communication only inside an operator-authorized envelope for that exact property and thread (`envelope_ref`, not accepted in phase 1: `ENVELOPE_AUTHORIZATION_NOT_IMPLEMENTED`); else an approval request |

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
- **`apps/api/tests/critical/action-gateway-{tools,adversarial,crash,standing-grants}-pg.test.mjs`** (30 tests, `AGENT_PG_TEST_DB_URL` = a loopback scratch server):
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
