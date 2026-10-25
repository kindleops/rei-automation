# Phase A activation package: autonomous internal research and task execution

Status: **PREPARED, NOT APPROVED, NOTHING APPLIED.** Every step below needs its own owner approval and runs in the order given.

Out of scope and kept disabled: seller messaging (T3), campaigns, offers and financial execution (T4), every T2 operational write, `mission.research` (paid model spend) and Workforce × Agntei in production.

Every fact about production below was read with read-only SELECTs on 2026-10-25.

## 0. The recommendation: the smallest safe Phase A

| Stage | What Sterling may do | Server-side spend | Needs the R2 runtime? | Needs an API deploy? |
|---|---|---|---|---|
| **A0, internal tasks** | `create_operator_task`, `update_operator_task` (agent-scope Action Center items: note / priority / due / resolve) | $0 | no (synchronous definer writes) | **no.** The gateway runs inside the local Action MCP process. |
| **A1, property research** | `request_property_valuation`: a `property.research` job, `web:false`, $0, in Minneapolis, MN and Indianapolis, IN | $0 | **yes.** The emergency stop must be resolved (§3). | verify (§2.4) |
| A2 (later) | the Workforce × Agntei path certified in isolation (`docs/CERT-STERLING-AGNTEI.md`) | $0 | yes | yes |

**Why A2 is not Phase A:**

- `workforce_agntei` requires gateway link #27 (T2), and #27 requires `public.followup_intents` and the follow-up lifecycle (#22). #22 adds `send_queue` ⇄ intent synchronization triggers on the LIVE sending path.
- Blockers B1 (≈3% of Agntei agents cannot link) and B2 (the acquisition charter) are open.

**What Sterling could do with A0 + A1 in production:**

- read live data through the Reader MCP (already live, read-only);
- create and resolve its own internal Action Center tasks;
- request $0 property research in its two markets.

Each action is attributable, capped, revocable and stoppable. None can message a seller, change a stage, touch a campaign or spend money.

## 1. Gates before ANY production step (isolated; authorized development work)

| Gate | What | Status |
|---|---|---|
| G1 | A migration-test entry that applies EXACTLY the §2.2 subset, in order, onto the production-state baseline (`rc_8_5_21_release_chain_from_production_state` setup), then posttests, rollback to the exact fingerprint, re-apply. No such entry exists today; the chain entries apply all of #0–#28. | **to do** |
| G2 | Sterling certification in the A0/A1 shape: the same driver, with the bare T1 tools instead of Workforce (create → update/resolve a task; request a valuation → job completes), plus negatives. Today these tools are certified only by the PG suites (tools-pg 9/9, standing-grants 10/10). | **to do** |
| G3 | The PostgREST layer (B3). The production data path is PostgREST + the `lc_action_gateway` JWT. Certify it either on Linux CI (pinned v16.4) or with the checksum-verified macOS binary after an explicit owner opt-in. | **owner decision** |
| G4 | `mint-gateway-token.mjs` gains `--secret-stdin` like the Reader's minter, so the legacy JWT secret never touches a file | small dev change |

## 2. Production changes (A0), in order, each separately approved

### 2.1 Facts (read-only, 2026-10-25)

- **Present:**
  - S3 persistence and R2 runtime (#1) objects;
  - `agent.runtime_kind_limits_valid`;
  - RLS on `system_control`;
  - `inbox_thread_state.market` / `manual_override`;
  - `campaign_transition_status`;
  - `is_ops_operator()`;
  - the role `lc_mcp_reader` (self-check ok).
- **Missing:**
  - `agent.approval_request` + `capability_approval_insert` (#2);
  - `public.conversation_ai_reply_policy` (#3);
  - `agent.ops_work_item` + `ops_pipeline_facts` (#15);
  - `ops_scope_of_kind` (#24);
  - `public.automation_holds` + `automation_hold_for` + `automation_hold_events` (#0).
- **Absent:** schema `action_gateway`, role `lc_action_gateway`, any `action_gateway_*` switch.
- **#0 discrepancy.** The chain doc says #0 was "ALREADY APPLIED VIA HOTFIX", but production has no `automation_holds`. The owner must confirm whether the hotfix was ever applied (or was rolled back) before #0 is applied. Its precondition refuses an existing registry, so a double apply is impossible.

### 2.2 Migrations: run each file's read-only `_pretest.sql` first, then `psql --single-transaction -v ON_ERROR_STOP=1 -f …`

1. `PROPOSED_20261016200000_automation_holds_registry.sql` (#0).
   - Note: the registry's trigger runs on `send_queue` claims. With zero hold rows it is a no-op, but it executes on the live sending path. G1 must measure that.
2. `PROPOSED_20261013120000_agent_capabilities.sql` (#2).
3. `PROPOSED_20261013160000_conversation_ai_shadow.sql` (#3): shadow tables only. `conversation_ai_reply_policy` stays service-role only.
4. `PROPOSED_20261014120000_persistent_missions.sql` (#7). The chain doc lists it as a #26 prerequisite; G1 confirms whether it is actually needed. Its schedules seed stays unapplied.
5. `PROPOSED_20261016140000_operations_action_center.sql` (#15), without its schedules seed (`…140100_operations_schedules.sql`).
6. `PROPOSED_20261017122000_conversation_turn_operator_items.sql` (#24).
7. **Verify the pg_net posture** (`docs/SUPABASE-PG-NET-POSTURE.md` §9). Strong signal: the Reader's self-check with the same pinned exception is `ok` in production today.
8. `PROPOSED_20261019160000_action_gateway.sql` (#26). Its pretest first. The apply ends with `action_gateway.self_check()`.

Before each apply, re-read `list_migrations` and confirm the stamp is not already recorded (chain doc rule).

### 2.3 Credentials (owner, on the Mac, outside every repository; 0600; never pasted into chat)

- **Pepper:** `~/.leadcommand/action-pepper`, 32 random bytes.
- **Gateway JWT:**
  - Command: `mint-gateway-token … --org 00000000-0000-4000-8000-00000000a001 --days 14`. Use the G4 stdin pipe, the same clipboard pattern as the Reader token.
  - Claims: role `lc_action_gateway` + `lc_org`.
- **Sterling's credential:** `mint-agent-credential --pepper-file ~/.leadcommand/action-pepper --agent-id agt_sterling --out ~/.leadcommand/agt_sterling.credential`. It prints the digest only.
- **Public key:** reuse `~/.leadcommand/anon.key`.

### 2.4 Principal + standing grants (owner SQL; replace `<DIGEST>`; the sponsor is the one operator in production)

```sql
insert into action_gateway.agent_principals (agent_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, read_scopes, created_by)
values ('agt_sterling', '00000000-0000-4000-8000-00000000a001', 'Sterling', '<owner uuid>', '<DIGEST>', now() + interval '14 days', 1, '{}', '<owner uuid>');

-- A0: internal tasks ($0). Empty scope: a task may have no subject, and a markets scope would refuse subject-less (system) tasks.
insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, max_failures_per_hour, max_cap_hits_per_hour, granted_by, expires_at) values
 ('00000000-0000-4000-8000-00000000a001', 'agt_sterling', 'tasks.create_operator_task', 1, '{}', '{}', 6, 30, 0, 3, 3, '<owner uuid>', now() + interval '14 days'),
 ('00000000-0000-4000-8000-00000000a001', 'agt_sterling', 'tasks.update_operator_task', 1, '{}', '{}', 12, 60, 0, 3, 3, '<owner uuid>', now() + interval '14 days');

-- A1 only, after §3: $0 read-only property research, two markets.
-- insert into action_gateway.capability_grants (…) values
--  ('00000000-0000-4000-8000-00000000a001', 'agt_sterling', 'valuation.request', 1, '{"markets": ["Minneapolis, MN", "Indianapolis, IN"], "resource_types": ["property"]}', '{}', 4, 20, 0, 3, 3, '<owner uuid>', now() + interval '14 days');
```

**Cost limits:**

- Every grant has `max_spend_usd_per_day = 0`. The DB refuses any use with spend > 0.
- Sterling's own model runs use the operator's Claude subscription quota. There is no API key and no metered spend.
- `create_research_job` / `mission.research` (paid model calls) is NOT granted.
- **Anomaly limits:** ≥3 failures or ≥3 cap hits in an hour auto-suspend the grant; only the owner reinstates it.

### 2.5 Switches (owner, `system_control`; last, and in this order)

```sql
insert into public.system_control (key, value) values ('action_gateway_tiers', 'T1') on conflict (key) do update set value = excluded.value;
insert into public.system_control (key, value) values ('action_gateway_enabled', 'true') on conflict (key) do update set value = excluded.value;
```

Nothing else changes. In particular, `ai_conversation_send_enabled`, `negotiation_send_enabled`, the queue / campaign / follow-up switches and `agent.runtime_limits` stay as they are.

### 2.6 Hosts (the Mac)

- **The Action MCP:**
  - `LEADCOMMAND_ACTION_MCP_TRANSPORT=streamable-http`, bind 127.0.0.1, port 8766;
  - `SUPABASE_URL=https://lcppdrmrdfblstpcbgpf.supabase.co`;
  - the 0600 files, Workforce OFF.
  - The boot must log `credential_self_check ok` as `lc_action_gateway` plus the live exposure probe. The Reader on 8765 is untouched.
- **Agntei:** a connection "LeadCommand Actions: Sterling" → `http://127.0.0.1:8766/mcp`, Token = Sterling's credential.
  - Access: agent Sterling + the acquisitions project only.
  - Policy `allow` only for `create_operator_task` and `update_operator_task`. Everything else in that server keeps Agntei's default (asks).
- **Laptop dependence:** both run on the Mac. While it sleeps nothing runs; nothing is lost; it resumes on wake.

### 2.7 Acceptance in production (read-only checks + one supervised task)

1. Sterling creates ONE task ("Phase A acceptance") and resolves it.
2. Verify the intent / authorization (grant) / outcome / audit rows and the `agent.ops_work_item` row (scope agent).
3. Verify Agntei's call log for that task.
4. Verify: 0 `send_queue`, offer, stage or hold writes by `agent:%`.

## 3. A1: the runtime emergency stop (investigation; nothing to change until it is understood)

**Facts:**

- `agent.runtime_limits`: `runtime_enabled = false`, `emergency_stop = true` since 2026-10-14 21:25:22Z by the owner account, reason `"pretest"`, `kind_limits = {}`, last updated 2026-10-16 23:33Z by `incident-20261014-fixA-revised`.
- Zero jobs, schedules or heartbeats.
- The repo's production-state fixture (`scripts/db/fixtures/fix_a_runtime_state.sql`) records this as the DELIBERATE state after **Fix A** (incident 2026-10-14, executed 2026-10-16 23:33Z, owner-authorized). The execution record is `tmp/incident-20261014/FIX-A-EXECUTION-RECORD.md`. It is **not in the repository and not on this Mac**.

**Required before A1:**

1. The owner supplies that record: what failed on 10-14, what Fix A changed, and the stated condition for releasing the stop.
2. Confirm the deployed API (`6ff4a24a`, 2026-10-21) wires the `property.research` handler. It must run with `web:false`, no model, and a research source. Confirm too that the Worker cron (`CRON_AGENT_RUNTIME_ENABLED` → `POST /api/internal/agent/runtime/tick`) is deployed and off.
3. Then, as the owner (clearing is a `service_role` act by design):
   - set `runtime_enabled = true`, `emergency_stop = false`;
   - set `kind_limits = {"property.research": {"enabled": true, "max_concurrency": 1, "armed_by": "<owner uuid>"}}`;
   - set `max_concurrency_global = 1`, `tick_max_jobs = 1`;
   - enable the cron.

   Nothing else is armed.
4. Re-stop at once with `select agent.runtime_emergency_stop('<owner uuid>', 'reason')`. Any named operator may do that.

**Code note:** the release branch has diverged from the deployed commit (245 ahead, 2 behind). A0 needs no API deploy. Any later deploy must first take in the 2 production-only commits.

## 4. Kill switches and rollback (fastest first)

| Scope | Action | Effect |
|---|---|---|
| everything, instantly | `delete from public.system_control where key = 'action_gateway_enabled'` | every gateway action refused (`ACTION_GATEWAY_STOPPED`; new writes certified live in N09; already-authorized intents refused at execution are proven by the PG suite, not this run) |
| one capability | `action_gateway_killed_capabilities` = 'tasks.create_operator_task' | that capability refused |
| Sterling | `update action_gateway.capability_grants set revoked_at = now(), revoked_by = '<owner>' where agent_id = 'agt_sterling'`; or principal `status = 'suspended'` | refused (certified N03) |
| the database path | `revoke lc_action_gateway from authenticator;` | the Action MCP cannot reach the database |
| the host | stop the Action MCP; remove the Agntei connection (deletes the keychain token) | nothing listening |
| research (A1) | `select agent.runtime_emergency_stop('<owner>', '…')` | nothing claimed (certified N10) |
| schema | `…_action_gateway_rollback.sql`, then #24, #15, #7, #3, #2, #0 rollbacks in reverse, each with its rollback posttest | #26's rollback REFUSES while an intent is pending or an agent-scope task exists: resolve those first. Holds are never released by a rollback. |

## 5. Approvals required (each separate)

1. G1–G4 (isolated, development): authorize building G1 and G2, decide G3, approve G4.
2. Confirm the #0 hotfix history.
3. Apply #0, #2, #3, (#7), #15, #24: one approval each, after their pretests.
4. The pg_net posture verification, then apply #26.
5. Mint the pepper, the 14-day gateway JWT and Sterling's 14-day credential.
6. Register `agt_sterling` and the two A0 grants exactly as in §2.4.
7. `action_gateway_tiers = 'T1'`, then `action_gateway_enabled = 'true'`.
8. Start the Action MCP on 8766 and add the Agntei connection (Sterling + project).
9. **A1 (separately, later):**
   - supply the Fix A record;
   - confirm the handler and cron;
   - clear the runtime stop with only `property.research` armed;
   - add the `valuation.request` grant.

Not requested, and staying OFF: T2 / T3 / T4 tiers, `ai_conversation_send_enabled`, `negotiation_send_enabled`, campaign / queue / follow-up switches, `mission.research`, Workforce × Agntei in production, any metered model account.
