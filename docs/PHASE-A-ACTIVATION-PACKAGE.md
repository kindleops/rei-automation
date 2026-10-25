# Phase A activation package: autonomous internal work (v2, 2026-10-25)

Status: **PREPARED, NOT APPROVED, NOTHING APPLIED.** Every production step needs its own owner approval and runs in the order given.

Kept OFF:

- T2, T3, T4;
- seller messaging, campaigns, offers and financial execution;
- `mission.research` (paid model calls);
- Workforce × Agntei in production;
- any metered model account.

Production facts below come from read-only SELECTs and the repository history on 2026-10-25 (§5).

## 0. Summary

| Stage | Sterling may | Spend | Runtime | API deploy | Certified (isolated) |
|---|---|---|---|---|---|
| **A0** internal tasks | `create_operator_task` (org-level internal grant + market grant), `get_operator_task`, `update_operator_task` (own tasks only) | $0 | not needed | **not needed**: the gateway runs inside the local Action MCP | **G1 PASS** (production-shaped chain), **G2 23/23** (real Sterling) |
| **A1** research | `request_property_valuation` ($0 `property.research`, `web:false`, market-scoped) | $0 | **needed**: Package A's owner activation, after the stop decision (§4) | already deployed (Package A, `6ff4a24a`) | G2 A07 (job completed); the production runtime is NOT certified |
| A1+ paid research | `create_research_job` (`mission.research`) | model calls | needed | needs a provider | enqueue + envelope + spend cap certified; **execution not**. Needs a budget approval. |
| A2 Workforce × Agntei | the 15/15 path | $0 | needed | yes (gateway + Workforce code) | 15/15 (runs 10, 11) |

## 1. A0: the minimum production change set

### 1.1 Chain (G1, `phase_a0_gateway_from_production_state`: PASS)

The test applied the chain onto a database shaped like production:

- S3 + research_ro + intel_runtime with the Fix A state;
- **`lc_mcp_reader` already applied**;
- the live public tables (fixtures).

Then, in this order and each preceded by its own pretest:

| # | File | Why A0 needs it | Touches a live table? | In production code today |
|---|---|---|---|---|
| 0 | `PROPOSED_20261016200000_automation_holds_registry.sql` | #26 precondition (`automation_hold_for`, `public.automation_holds`) | **yes**: BEFORE triggers on `send_queue` (queue_status), `seller_offers`, `closing_cases`, `acquisition_opportunities`. No-ops while no hold exists; protective by design | **no** (see §5.1) |
| 2 | `PROPOSED_20261013120000_agent_capabilities.sql` | #26 precondition (`agent.approval_request`, `capability_approval_insert`) | no | Package A (byte-identical) |
| 3 | `PROPOSED_20261013160000_conversation_ai_shadow.sql` | #26 precondition (`conversation_ai_reply_policy`) | no (two new tables, service-role only, no triggers) | Package A (byte-identical) |
| 4 | `PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql` | #7's pretest requires it | no | Package A (byte-identical) |
| 7 | `PROPOSED_20261014120000_persistent_missions.sql` | #15's pretest requires it | no | Package A (byte-identical) |
| 15 | `PROPOSED_20261016140000_operations_action_center.sql` | #26 precondition (`agent.ops_work_item`, `ops_pipeline_facts`) | no | Package A (byte-identical) |
| 24 | `PROPOSED_20261017122000_conversation_turn_operator_items.sql` | #26 precondition (`ops_scope_of_kind`) | no | not in Package A |
| 25 | `PROPOSED_20261019120000_payload_clean_opaque_ids.sql` | chain order; prevents random-UUID refusals in agent payloads | no | Package A (byte-identical) |
| 26 | `PROPOSED_20261019160000_action_gateway.sql` (**amended**, §1.2) | the gateway | no new live-table trigger | **no** |

Proven by G1, on two full cycles:

- **Ordering:** every link's pretest passed immediately before it.
- **Idempotence:** apply → rollback → re-apply → identical fingerprint.
- **Fix A state untouched:** `rc_8_5_21_fix_a_state_verify`.
- **The live Reader's self-check is still clean after #26:** `phase_a0_reader_selfcheck_verify`.
- **Structural posttests pass:** holds, capabilities, shadow, opaque ids, gateway role shape / privileges / tenant isolation / self-check.
- **The rollbacks restore the exact pre-chain fingerprint.**

The behavioural posttests of #4, #7, #15 and #24 claim runtime jobs, which the engaged emergency stop refuses. That refusal is correct behaviour, so they run in `rc_8_5_21_release_chain` instead (PASS).

The seller-messaging question:

- **#3** only creates two inert, service-role-only tables.
- **#0** adds protective triggers on the send path. They are unavoidable while #26's preconditions require the hold registry, and A0 cannot create a hold (T2 is off).

Removing them would require a "lean #26" without the reply-policy and hold dependencies. I do not recommend changing a certified migration for that.

### 1.2 Changes made to PROPOSED files in this phase (all tested)

| Change | Why | Proof |
|---|---|---|
| **#26 rollback keeps the shared egress functions when `lc_mcp_reader` exists** | The old rollback DROPPED `lc_egress_platform_allowlists()` / `lc_reachable_egress_indirect()`, which the live Reader's self-check needs. A gateway rollback in production would have stopped the Reader within 10 minutes (fail-closed). | G1 rollback fingerprint; full chains PASS |
| **#26 `update_operator_task`: own tasks only, never a human-taken task** (domain writer + policy) | Any agent could update any agent-scope task, including one an operator had acknowledged | `action-gateway-tools-pg` G2 tests (incl. a lying JS store: the DB writer refuses); G2 N01/N02 |
| **#26 `get_operator_task`** (read; own tasks; the update grant covers it) | An agent had no way to inspect the task it created | G2 test + G2 A05 |
| **New link `PROPOSED_20261025100000_payload_clean_typed_external_ids`** (B1; after #25; not needed by A0) | 3.70 % of Agntei agent ids were read as phones; that agent could never link | migration cycle PASS; 10,000-id regression; identity e2e |
| `mint-gateway-token.mjs --secret-stdin` (G4) | The root JWT secret never touches a file, argv or logs | subprocess pipe test; used by G2 |
| Workforce staffing: external employees get only externally-executable capabilities (B2 safeguard) | Closes the silent empty triage | `workforce-staffing-external-b2` |

### 1.3 Credentials (owner, on the Mac, outside every repository; 0600; never in chat)

- **Pepper:** `head -c 32 /dev/urandom | base64 > ~/.leadcommand/action-pepper` (0600).
- **Gateway JWT:** `pbpaste | node scripts/mint-gateway-token.mjs --secret-stdin --org 00000000-0000-4000-8000-00000000a001 --out ~/.leadcommand/lc_action_gateway.jwt --days 14`, then `pbcopy < /dev/null`.
- **Sterling:** `node --import ./src/loader/register.mjs scripts/mint-agent-credential.mjs --pepper-file ~/.leadcommand/action-pepper --agent-id agt_sterling --out ~/.leadcommand/agt_sterling.credential`. It prints the digest only.

### 1.4 Principal + standing grants (exactly what G2 certified, with production values)

The sponsor is the one production operator, `<owner uuid>`. Markets use production's labels: properties carry `Minneapolis, MN` / `Indianapolis, IN`. Re-check the `inbox_thread_state.market` labels read-only before applying the market grant.

```sql
insert into action_gateway.agent_principals (agent_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, read_scopes, created_by)
values ('agt_sterling', '00000000-0000-4000-8000-00000000a001', 'Sterling', '<owner uuid>', '<DIGEST>', now() + interval '14 days', 1, '{}', '<owner uuid>');
-- A0
insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, max_failures_per_hour, max_cap_hits_per_hour, granted_by, expires_at) values
 ('…a001', 'agt_sterling', 'tasks.create_operator_task', 1, '{"resource_types":["system"]}', '{}', 6, 30, 0, 3, 3, '<owner uuid>', now() + interval '14 days'),                                   -- org-level INTERNAL tasks (no subject)
 ('…a001', 'agt_sterling', 'tasks.create_operator_task', 1, '{"markets":["Minneapolis, MN","Indianapolis, IN"],"resource_types":["thread","opportunity"]}', '{}', 6, 30, 0, 3, 3, '<owner uuid>', now() + interval '14 days'),
 ('…a001', 'agt_sterling', 'tasks.update_operator_task', 1, '{"resource_types":["work_item"]}', '{}', 12, 60, 0, 3, 3, '<owner uuid>', now() + interval '14 days');                                       -- + get_operator_task; own tasks only
-- A1 (after §4): $0 read-only property research
--  ('…a001', 'agt_sterling', 'valuation.request', 1, '{"markets":["Minneapolis, MN","Indianapolis, IN"],"resource_types":["property"]}', '{}', 4, 20, 0, 3, 3, '<owner uuid>', now() + interval '14 days')
-- NOT granted: research.create_job (paid), every T2/T3/T4 capability.
```

**Cost limits:**

- Every grant has spend $0/day; the DB refuses any use with spend > 0.
- Sterling's own model runs use the operator's Claude subscription (no API key).
- **Anomaly limits:** ≥3 failures or ≥3 cap hits per hour auto-suspend a grant; only the owner reinstates it.

### 1.5 Switches, host, acceptance

1. **Switches:** `system_control`: `action_gateway_tiers = 'T1'`, then `action_gateway_enabled = 'true'`. Nothing else changes.
2. **Host:** the Action MCP on the Mac. Loopback 127.0.0.1:8766, `SUPABASE_URL = https://lcppdrmrdfblstpcbgpf.supabase.co`, Workforce OFF. The boot must report `credential_self_check ok` as `lc_action_gateway`. The Reader on 8765 is untouched.
3. **Agntei:** connection "LeadCommand Actions: Sterling", access Sterling + its project only, policies `allow` for `create_operator_task`, `get_operator_task`, `update_operator_task` only.
4. **Production acceptance (supervised, once):** Sterling creates → reads → updates → resolves one internal task. Then verify read-only:
   - the intent / authorization (grant) / outcome / audit rows and the `ops_work_item` row;
   - Agntei's call log;
   - 0 writes to `send_queue`, `seller_offers` or holds.

## 2. Production gates still open before A0

| Gate | Status |
|---|---|
| **PostgREST layer** (B3) | The production data path is PostgREST + the gateway JWT. **Not run on this Mac:** the macOS binary is unsigned and PostgREST publishes no build attestations. CI now runs it: the official Linux asset pinned by its GitHub-published sha256 `b47ecc82…`, plus PGDG PostgreSQL 17, on an ephemeral runner (`agent-s3-persistence.yml`). **That CI run has not happened: it needs a push / PR, which was not authorized.** |
| pg_net posture | Same pinned exception as the Reader, whose self-check is `ok` in production today. Re-verify read-only before #26 (`docs/SUPABASE-PG-NET-POSTURE.md` §9). |
| #0 history | See §5.1: not applied. An owner decision: apply it as part of A0 (it is a #26 precondition) knowing its send-path triggers. |
| Stamp collision | `20261020120000` is used by BOTH Package A's `research_event_budget_ceilings` and this branch's `inbox_bucket_views_declined_unverified`. Supabase keys history on the version: renumber one before either is applied. Not part of A0. |

## 3. Rollback (A0), fastest first

| Scope | Action |
|---|---|
| everything | `delete from public.system_control where key = 'action_gateway_enabled'` (certified: N10 / N09) |
| one capability | `action_gateway_killed_capabilities` |
| Sterling | revoke its grants / principal `suspended` (certified: N09 revocation) |
| the database path | `revoke lc_action_gateway from authenticator;` |
| the host | stop the Action MCP; remove the Agntei connection |
| schema | the rollbacks in reverse (#26 → #25 → #24 → #15 → #7 → #4 → #3 → #2 → #0), each with its rollback posttest; proven to restore the exact pre-chain fingerprint in G1. #26's rollback refuses while an intent is pending or an agent-scope task exists (resolve them first); with the Reader present it keeps the shared egress functions. |

## 4. A1: the research runtime (separate approvals, after A0)

- **Code:** production's deployed **Package A** (`4362dcfa` + `6ff4a24a`, `release/cloudflare-production`) is the research runtime backport.
  - It includes `property.research`, `research-runtime-wiring.js` (`PROPERTY_RESEARCH_ENABLED`), the tick route and the Worker cron `AGENT_RUNTIME_TICK` (`CRON_AGENT_RUNTIME_ENABLED`, `*/1`).
  - It ships owner scripts: `preflight`, `verify`, `monitor`, `activate`, `enable-schedules`, `disarm`, `enqueue-property`.
  - Its migrations are byte-identical to chain links #2, #3, #4, #6, #7, #15, #25 (verified today), plus two Package-A-only links.
  - **A0's runtime-side links are therefore the same files Package A's step 2 would apply.** Apply them once.
- **The emergency stop** (do NOT clear without the owner's decision): it is engaged on purpose (§5.2). Package A's stated release path is `activate.sql` (step 4):
  - "clear the agent emergency stop, enable the R2 runtime and arm ONLY the Package A kinds";
  - preconditions: Package A's migrations applied (step 2), the Fix A state, no pending runtime job.
- **Then:** the `valuation.request` grant (§1.4), and `PROPERTY_RESEARCH_ENABLED` + `CRON_AGENT_RUNTIME_ENABLED` on the Worker.
- **Paid research (`mission.research`):** it needs a model provider and an approved budget. The gateway side (envelope → human approval, daily spend cap) is certified.

## 5. G3: production facts and discrepancies (read-only)

### 5.1 The automation-holds registry (#0): documented, never applied

- **Production:** no `automation_holds`, `automation_hold_events` or `automation_hold_for`.
- **The claim:**
  - "Already applied via hotfix" originates in `85d68d58` (2026-10-17), with no production read cited.
  - The cited branch `hotfix/automation-holds` (commit `4c519ab6`) **does not exist** on the remote or in any clone.
  - The registry exists only as a forward-port (`ad886570`, `e24eab46`) on `release/lc-mcp-reader-1`.
- **Contrary evidence in the repo itself:** chain doc lines 87 and 113–114; the file header "PROPOSED (NOT APPLIED)"; `automation-hold-gate.js:5` ("production … has NEITHER the registry NOR the port").
- **The Hartford / Maxwell hold SQL** was never committed. Package A uses static code exclusions instead (`research-exclusions.js`).

### 5.2 The 2026-10-14 incident and Fix A

- **What happened:** a chain pretest `\ir`-included a rollback ending in `commit;`. The inner COMMIT committed the outer transaction, and **`intel_runtime` (#1) became applied in production** (`8247f761`; `scripts/db/lint-migration-fixtures.mjs:4-7`). The stop stamp is 21:25:22Z; the related commit `cab55727` ("…capabilities pretest runs in prod") is at 21:31Z.
- **Response:** the owner boundary "test SQL never runs against production", the disposable-DB runner, the fixture linter, the production-target scan and the CI gates.
- **Fix A** (2026-10-16 23:33Z, owner-authorized): the repo records only the resulting state (`fix_a_runtime_state.sql`): runtime applied and empty, disabled, `kind_limits {}`, **stop still engaged** (reason `pretest`). Which objects Fix A cleaned is not recorded. The execution record `tmp/incident-20261014/FIX-A-EXECUTION-RECORD.md` was **never committed anywhere** and is not on this Mac.
- **Why the stop remains:** every verify asserts it persists. The only stated release path is Package A's `activate.sql` (step 4), which has not been run (Package A's step 2 migrations are absent in production).

### 5.3 Present vs documented

- **Applied (evidence):** S3, research_ro, intel_runtime (#1, via the incident), `lc_mcp_reader` (live).
- **Documented as applied but absent:** #0.
- **Absent and correctly documented as PROPOSED:** #2, #3, #4, #7, #15, #24, #25, #26 and everything after.

### 5.4 Deployed code

- **Production runs `6ff4a24a`** (Package A, 2026-10-21) on `release/cloudflare-production`.
- **It contains:** the tick route, research wiring and Worker cron.
- **It does NOT contain:** the Action Gateway, Workforce, or the hold registry code.
- **Divergence:** `release/lc-mcp-reader-1` diverged from it: 245 ahead, 2 behind (the 2 Package A commits).
- **A0 needs no deploy** (local Action MCP). A2 does, after merging the 2 Package A commits.

## 6. Approvals required (each separate; none requested for T2+, messaging, campaigns or financial)

1. Push the cert branch / open a PR so CI runs the new suites and the PostgREST-layer tests (G3/B3).
2. Decide #0: apply it as an A0 prerequisite (with its send-path triggers), or fund a lean #26.
3. Re-run the pg_net posture check read-only.
4. **Apply the A0 chain, one approval each, pretest first:** #0, #2, #3, #4, #7, #15, #24, #25, #26 (amended).
5. Mint the pepper, the 14-day gateway JWT (stdin) and Sterling's credential.
6. Register `agt_sterling` + the three A0 grants (§1.4).
7. `action_gateway_tiers = 'T1'`, then `action_gateway_enabled = 'true'`.
8. Start the Action MCP (8766) and add the Agntei connection.
9. **Later, A1:**
   - supply or decide on the Fix A record;
   - Package A step 4 (`activate.sql`, `property.research` only);
   - the Worker flags;
   - the `valuation.request` grant.
10. **Housekeeping:** renumber the `20261020120000` collision before either file is applied.
