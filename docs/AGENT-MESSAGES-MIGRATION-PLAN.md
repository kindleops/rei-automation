# Agent-initiated messages — production migration plan (DRAFT for owner review)

Status: **draft**. Nothing in this plan has been applied anywhere but disposable PostgreSQL 17 databases. Every step
that touches production is an owner decision; this document only proposes the order and the checks.

Scope: everything committed on `feat/hidden-gold-operations` after `31eb0be7` (link #31). That is two database links
and the application code that uses them:

| # | File (apply) | Rollback | Runner id |
|---|---|---|---|
| A | `supabase/migrations/PROPOSED_20261029090000_ai_generated_outbound.sql` | `PROPOSED_20261029090000_ai_generated_outbound_rollback.sql` | `ai_generated_outbound` |
| B | `supabase/migrations/PROPOSED_20261029100000_action_gateway_agent_message.sql` (link #32) | `PROPOSED_20261029100000_action_gateway_agent_message_rollback.sql` | `action_gateway_agent_message` |

Each has a `_pretest.sql`, `_posttest.sql` and `_rollback_posttest.sql` beside it. All three are read-only or end in
`ROLLBACK`.

**A** adds `record_kind` (`reply` default | `agent_outbound`) to `public.ai_generated_messages`. Reply records keep
every original invariant. An `agent_outbound` record answers no inbound and is bound to one Action Gateway intent.

**B** (link #32) adds:
- the `queue_agent_message` T3 action;
- lead ownership (`assign_lead`, `release_lead`, `get_lead_assignment`);
- the agents' event feed (`action_gateway.lead_events`, read through `events_since`);
- the lead pool read (`agent_lead_pool`);
- the send-controls read (`send_controls`);
- the fallback-template read;
- day-cap reservations;
- the agent-message switch and policy (born OFF);
- the standing-grant extension of #31;
- feed writes from the receipt writer.

It also makes the R2 runtime emergency stop refuse the certified reply and the authorized offer at request time.

Not part of this change, but relevant: `PROPOSED_20261027130000_lc_mcp_acquisition_reads.sql` (reader 1.3, separately
approved, runner id `lc_mcp_acquisition_reads`). It provides `leadcommand_get_thread_contact_eligibility`. Apply it only
if that reader tool is wanted in production. It does not depend on A or B.

## 1. Prerequisites (verify on production before anything else)

**A requires** `PROPOSED_20261015130000_message_origin_ai_generated_messages.sql` (the AI-message ledger).

**B requires**, in this order, each already applied:
- **#26** `PROPOSED_20261019160000_action_gateway.sql`, with its own chain: runtime, capabilities, missions, holds registry, S3 payload guard, durability ledger.
- **#27** `PROPOSED_20261020100000_action_gateway_t2.sql`, the extension registry.
- **#28** `PROPOSED_20261020110000_action_gateway_t34.sql`, with negotiation authority and send authorization.
- **#29** `PROPOSED_20261027120000_action_gateway_ohg.sql`. #31 requires it; B does not reference it.
- **#31** `PROPOSED_20261028100000_action_gateway_standing_reply.sql`.
- **A.**

> Gap to close before the rehearsal: #31 has **no runner entry and no pre/posttest files** (only apply + rollback).
> It is covered by `apps/api/tests/critical/action-gateway-standing-reply-pg.test.mjs` on disposable PG only.
> B's pretest checks #31 indirectly (its standing CHECK must be #31's).

Verification query (read-only; every value must be `true`):

```sql
select to_regclass('public.ai_generated_messages') is not null                                   as ledger,
       to_regprocedure('action_gateway.dw_begin(uuid,uuid,text[])') is not null                  as link_26,
       to_regclass('action_gateway.extensions') is not null                                       as link_27,
       to_regclass('action_gateway.seller_action_receipts') is not null                           as link_28,
       to_regclass('action_gateway.lead_annotations') is not null                                 as link_29,
       to_regprocedure('action_gateway.standing_reply_refusal(uuid,uuid)') is not null            as link_31,
       (select pg_get_constraintdef(oid) ~ 'conversation.queue_reply' from pg_constraint
         where conrelid = 'action_gateway.capability_grants'::regclass
           and conname = 'capability_grants_standing_seller_facing_chk')                          as link_31_check,
       coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false)        as gateway_self_check,
       to_regclass('public.campaign_targets') is not null and to_regclass('public.sms_templates') is not null
         and to_regclass('public.ownership_template_rotation_control') is not null
         and to_regclass('public.idempotency_ledger') is not null                                 as relations;
```

If any value is `false`, stop. The missing link is applied first, through its own approval and its own plan.

## 2. Application code (inert without the links)

The code can deploy before or after A and B. Without them, every new path does nothing:
- **Gateway tools.** The new tools fail closed: their definer reads do not exist, so the agent gets `capability_unavailable` or a read error.
- **Action MCP boot.** The new RPC names are an allowlist, not a boot requirement.
- **Feed writers.** The inbound webhook and the lead-state registry call `lc_lead_event_append` through `lead-events.js#appendLeadEvent`. That function never throws or blocks; without B it returns `not_appended`.
- **R2 at request time.** The reply and offer check uses `action_gateway_send_controls`. When that function is missing, #28's contract is unchanged.
- **Queue runner.** The agent-message row gate applies only to rows stamped `metadata.agent_message_intent_id`, and only B can create those. The AI row gate verifies outbound records only for `agent_outbound` records, and only A can store those.
- **Send policy.** `first_touch` / `reengage` / `followup` are AI send categories only when listed explicitly. The default set is unchanged.

Recommended order: rehearse on the clone (§3), deploy the code, apply A, apply B, verify (§4). Code first means each
link starts its life with the code that reads it.

## 3. Clone rehearsal (a disposable clone, never production)

1. **Clone.** Restore a recent production backup into a disposable project or database: schema plus data, so the pretests see real relations. Use no production credentials in any app pointed at it.
2. **Prerequisites.** Run the §1 query on the clone. Every value must be `true`.
3. **Runner on the clone.** `node scripts/db/run-migration-test.mjs --admin-url <clone admin url> --id ai_generated_outbound` and then `--id action_gateway_agent_message`.
   - That is pretest → apply → posttest → rollback → rollback posttest → fingerprint equals pre-apply → re-apply → posttest.
   - Both have passed on disposable PG 17 (latest: `7ea4b458`).
   - On the clone the setup is the clone itself, so run the files by hand if the runner's fixture setup does not fit: the steps below.
4. **Manual sequence**, each file inside its own transaction (the link files already are):
   - `…090000_ai_generated_outbound_pretest.sql`, then the apply, then the posttest. Verify with **V-A**.
   - `…100000_action_gateway_agent_message_pretest.sql`, then the apply, then the posttest. Verify with **V-B** and **V-OFF**.
5. **Rollback rehearsal.** Take a schema fingerprint before step 4: `pg_dump -s` of `action_gateway`, `agent` and `public`, sorted. Then:
   - run B's rollback and its rollback posttest;
   - run A's rollback and its rollback posttest;
   - diff the fingerprint; it must be identical.

   Then re-apply A and B.
6. **Read-only exercise on the clone**, with switches OFF, as `lc_action_gateway` through the Action MCP pointed at the clone:
   - `leadcommand_send_controls` shows `agent_message_enabled:false` and `agent_message_refusal:'AGENT_MESSAGE_KILL_SWITCH_OFF'` (or the AI gate's code);
   - `leadcommand_agent_lead_pool {market}` on a real market returns rows with no phones or names, and `agent_messages_available:false`;
   - `sms_send_agent_message` returns `capability_unavailable`.
7. **Feed volume estimate.** With the code deployed against the clone, replay a day of inbound messages if a harness exists. Otherwise estimate the number of `lead_events` rows per day: about one per inbound, plus one per lead-state change, plus about two per agent message.

**V-A** (after A):
```sql
select (select count(*) from pg_attribute where attrelid = 'public.ai_generated_messages'::regclass and attname = 'record_kind' and not attisdropped) = 1 as has_kind,
       (select count(*) from public.ai_generated_messages where record_kind <> 'reply') = 0                                                       as no_outbound_yet,
       (select count(*) from public.ai_generated_messages where record_kind = 'reply' and inbound_message_id is null) = 0                       as replies_bound;
```

**V-B** (after B):
```sql
select coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false)                                    as self_check,
       (select count(*) from action_gateway.extensions where link = 'PROPOSED_20261029100000_action_gateway_agent_message') = 12 as registry_rows,
       action_gateway.t34_handoff_kind('queue_agent_message') = 'action_gateway.execute'                                       as handoff_kind,
       has_function_privilege('lc_action_gateway', 'public.action_gateway_send_controls()', 'EXECUTE')                        as gateway_reads,
       not has_function_privilege('lc_action_gateway', 'public.lc_agent_message_reserve(uuid)', 'EXECUTE')                    as no_worker_fn_for_gateway,
       not has_function_privilege('anon', 'public.action_gateway_agent_lead_pool(text,integer,text)', 'EXECUTE')              as no_anon,
       (select count(*) from action_gateway.lead_events) = 0                                                                     as feed_empty;
```

**V-OFF** (born OFF; run after B and again before every activation step):
```sql
select action_gateway.agent_message_refusal()                                                                   as refusal,     -- must be non-null
       (select value from public.system_control where key = 'ai_agent_message_enabled')                         as am_switch,   -- null (absent) = OFF
       (select value from public.system_control where key = 'ai_agent_message_policy')                          as am_policy,   -- null = disabled
       (select count(*) from action_gateway.capability_grants where revoked_at is null
          and capability in ('conversation.queue_agent_message', 'leads.assign_lead', 'leads.release_lead', 'leads.read_pool',
                             'leads.read_assignment', 'events.read', 'controls.read', 'conversation.read_message_templates')) as new_grants, -- 0
       (select count(*) from action_gateway.capability_grants where standing_seller_facing and revoked_at is null
          and capability = 'conversation.queue_agent_message')                                                  as standing_am; -- 0
```

## 4. Production apply (owner)

1. **Freeze.** Run V-OFF's prerequisites (§1). Choose a quiet window. No queue or worker change is needed: A and B are DDL plus registry rows, each in one transaction, about 150 ms on PG 17.
2. **Apply A.** Pretest, apply, posttest. Verify V-A.
3. **Apply B.** Pretest, apply, posttest. Verify V-B and V-OFF.
4. **Deploy the code** if it was not deployed first. Confirm `leadcommand_send_controls` answers through the Action MCP.
5. **Watch for 24 h with everything OFF:**
   - `lead_events` grows with `inbound_message`, `lead_state_changed` and `opt_out`, and holds no `delivery_changed` rows;
   - `action_gateway.self_check` stays ok;
   - no `ops_work_item` rows with `action = 'queue_agent_message'`.

## 5. What each switch and grant is born as

| Control | Born as | Owner of the change |
|---|---|---|
| `system_control.ai_agent_message_enabled` | absent = **OFF** | owner |
| `system_control.ai_agent_message_policy` | absent = **disabled**; defaults when enabled: `max_per_day_global` 200, `max_per_lead_per_day` 1, `reengage_min_quiet_hours` 72, no fallback templates | owner |
| `system_control.ai_conversation_send_enabled` / `_policy` | **unchanged** by A and B. They must stay OFF until the AI-reply blind evaluation; outbound categories are opt-in only | owner |
| `action_gateway_enabled` / `action_gateway_tiers` | unchanged; T3 must be listed for any send | owner |
| Grants for the new capabilities | **none exist** | owner mints them |
| `capability_grants.standing_seller_facing` for `conversation.queue_agent_message` | none; the CHECK confines it to the two pairs and requires a `standing_basis` | owner only |
| `capability_grants.agent_message_lead_day_cap` | null (policy default); CHECK allows 1–3, only on the agent-message capability | owner |
| `action_gateway.lead_events` feed | **written from the first deploy after B**. It has no switch: ids and codes only, append-only. Retention is not implemented (see §8) | — |

## 6. Owner-only activation, in order

Before each step: V-OFF (where still applicable) and `leadcommand_send_controls`. Each step is reversible by the
brakes in §7.

1. **Reads only.** Grant per agent: `events.read`, `leads.read_pool`, `leads.read_assignment`, `controls.read`, `conversation.read_message_templates` (T1). No seller contact is possible.
2. **Lead ownership.** Grant `leads.assign_lead` and `leads.release_lead` (T2, standing, reversible). These are internal only.
3. **Blind evaluation of the outbound writer.** `composeAgentOutbound` should face the same blind evaluation that gated AI replies, using real quiet threads and campaign targets with drafts never sent. Record the basis.
4. **The AI send gate** (if not already on for replies, it must pass its own evaluation first):
   - set `ai_conversation_send_enabled = 'true'`;
   - give `ai_conversation_send_policy` the chosen outbound purposes in `categories` (`first_touch` / `reengage` / `followup`; listing the reply categories too);
   - give it a supervised `scope.thread_keys` list. The dispatch gate honours `thread_keys` only.
5. **Agent-message policy:**
   - set `ai_agent_message_policy` to `{"enabled": true, "max_per_day_global": <start small, e.g. 20>, "max_per_lead_per_day": 1, "reengage_min_quiet_hours": 72, "fallback_templates": {…governed ids…}}`;
   - then set `ai_agent_message_enabled = 'true'`;
   - confirm `send_controls.agent_message_refusal` is null.
6. **Per-use authority.** Grant `conversation.queue_agent_message` (T3) to the supervised agents. Every message then waits for a human approval in the existing decide path.
7. **Standing authority (optional, later).** Only after a supervised period, mint ONE standing grant per agent with `standing_seller_facing = true`, a `standing_basis` that names the evaluation, and optionally `agent_message_lead_day_cap`.
8. **Widen.** Grow `thread_keys` and `max_per_day_global` in steps, watching receipts, `ops_work_item` and the validator refusal mix.

## 7. Rollback triggers and brakes

Brakes, fastest first. None of them needs a migration.
- **R2 runtime emergency stop** (`agent.runtime_emergency_stop`, a named operator):
  - every seller-facing request is refused `EMERGENCY_STOP_ACTIVE`;
  - workers halt;
  - queued agent messages are cancelled at dispatch.
- **Queue emergency stop** (`queue_emergency_stop_at`): the same at request time and at dispatch.
- **`ai_agent_message_enabled = 'false'`** or the policy disabled: new requests are refused, and queued agent messages are cancelled at dispatch. Replies are untouched.
- **Revoke the grants**: the worker re-checks authority at execution (`NO_PER_USE_AUTHORITY`).

Triggers. Brake immediately and investigate:
- a sent agent message whose body differs from its `agent_outbound` record;
- a message sent to a stopped, suppressed or wrong-number lead;
- a message sent outside 08:00–21:00 recipient-local;
- more than one send per lead per day, or any duplicate;
- any amount, offer, visit or human claim in a sent message;
- `self_check` not ok;
- `lead_events` refusing appends at a meaningful rate (the webhook keeps working, but the feed is incomplete);
- a sustained spike of `outcome_unknown` receipts.

Rollback (only after the brakes, and only if the link itself is at fault):
- **B's rollback refuses while** a live standing grant exists, any agent-message intent is pending, or **any agent-message receipt exists**. Receipts are the evidence of what agents asked for, so once any agent message has been requested, B can only be rolled back after exporting and deliberately deleting that evidence. The brakes above are the intended off-switch.
- B's rollback **drops** `action_gateway.lead_events` and `lead_assignments` with their rows. Export them first if they are wanted.
- **A's rollback refuses while** any `agent_outbound` record exists. Records are append-only evidence.
- Order: B's rollback, then its rollback posttest; A's rollback, then its rollback posttest. Both restore earlier bodies and CHECKs exactly (fingerprint-proven on disposable PG).

## 8. What stays off or is not done

- **Off at apply.**
  - Agent messages: switch and policy absent.
  - Standing seller-facing authority for agent messages: none.
  - Outbound AI send categories: not listed.
  - No grants for any new capability.
- **Never automatic:**
  - an offer, price or negotiation in an agent message (refused by the writer and the validator);
  - a send outside the window (refused with `next_permitted_at`, never scheduled);
  - a first touch to a contacted number.
- **Not implemented:**
  - retention for `action_gateway.lead_events`; a decision is needed before scale;
  - market or campaign scope in the dispatch-time AI gate (it honours `thread_keys` only);
  - a runner entry for #31.
- **Separate decision:** reader 1.3 (`lc_mcp_acquisition_reads`) for `leadcommand_get_thread_contact_eligibility`.
