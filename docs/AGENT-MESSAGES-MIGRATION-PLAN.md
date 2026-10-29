# Agent texts — production migration plan (DRAFT for owner review)

Status: **draft**. Nothing in this plan has been applied anywhere but disposable PostgreSQL 17 databases. Every step
that touches production is an owner decision; this document only proposes the order and the checks.

**Architecture (owner correction, 2026-10-29).** "Agntei owns the intelligence and conversation. LeadCommand owns
messaging infrastructure and compliance enforcement. The carrier delivers the SMS." Agntei's AI employees (Sterling,
head of acquisitions; Nova, representative) compose **every** SMS on their own model sessions. LeadCommand never writes
a word for them. It validates the agent's exact text deterministically, enforces every compliance gate, records the
text word for word, and transports it. The earlier design, in which LeadCommand wrote the agent's message from a brief
(`queue_agent_message` → `composeAgentOutbound`) or wrote the certified reply (`queue_authorized_reply`), is
**retired for agents**: both answer `AGENT_COMPOSES_TEXT`.

Scope: everything committed on `feat/hidden-gold-operations` after `31eb0be7` (link #31). That is two database links
and the application code that uses them:

| # | File (apply) | Rollback | Runner id |
|---|---|---|---|
| A | `supabase/migrations/PROPOSED_20261029090000_ai_generated_outbound.sql` | `PROPOSED_20261029090000_ai_generated_outbound_rollback.sql` | `ai_generated_outbound` |
| B | `supabase/migrations/PROPOSED_20261029100000_action_gateway_agent_message.sql` (link #32) | `PROPOSED_20261029100000_action_gateway_agent_message_rollback.sql` | `action_gateway_agent_message` |

Each has a `_pretest.sql`, `_posttest.sql` and `_rollback_posttest.sql` beside it. All of them are read-only or end in
`ROLLBACK`. Both links pass the migration runner on disposable PG 17 (pretest → apply → posttest → rollback → rollback
posttest → fingerprint equals pre-apply → re-apply → posttest).

**A** adds `record_kind` (`reply` default | `agent_outbound` | `agent_text`) and two author columns to
`public.ai_generated_messages`:
- `reply` records keep every original invariant;
- an `agent_outbound` record (the retired brief-based message) answers no inbound and is bound to one intent;
- an `agent_text` record is the agent's **exact** text: `queue_key = 'agent_text:<intent>'`, `decision_outcome =
  'AGENT_COMPOSED_TEXT'`, one of eight purpose categories, `inbound_message_id` = the inbound it answers (or null), and
  its author: `author_employee` plus `author_attribution` {employee, model, provider, route, session_id, turn_id},
  stored verbatim and never interpreted. The column's existing UNIQUE index keeps **one answer per inbound** across
  every kind.

**B** (link #32) adds:
- the `queue_agent_text` T3 action (capability `conversation.queue_agent_text`, standing-grant eligible exactly like
  the certified reply: `standing_seller_facing` + `standing_basis`);
- `action_gateway.agent_text_submissions`: the agent's exact text and attribution, stored once (content-addressed by
  their sha256, append-only). The intent carries only the two hashes, never the words;
- its own switch `ai_agent_text_enabled` (born OFF: `AGENT_TEXT_KILL_SWITCH_OFF`) and an optional policy
  `ai_agent_text_policy` (caps, quiet hours, languages, links). It does **not** read the reply engine's
  `ai_conversation_send_enabled` / categories: those certify LeadCommand's writer, which writes nothing here.
  `ai_conversation_send_policy.scope` restricts agent texts only **when it lists something**;
- lead ownership (`assign_lead`, `release_lead`, `transfer_lead`, `get_lead_assignment`): exactly one holder per lead;
  a supervisor (Sterling) moves a lead with `transfer_lead`;
- the agents' event feed (`action_gateway.lead_events`, read through `events_since`): `inbound_message`, `opt_out`,
  `lead_state_changed`, `lead_transferred`, `delivery_changed` (incl. the carrier's `delivered` / `undelivered`);
- the lead pool read (`agent_lead_pool`) and the send-controls read (`send_controls`, now with `agent_text_enabled` and
  `agent_text_refusal`);
- day-cap reservations (`agent_text_lead_day`, `agent_text_initiated_day`, `agent_text_global_day`, plus the shared
  `inbound_reply` reservation for an answer);
- `lc_agent_lead_holder`: LeadCommand's own conversation engine **stands down** on a lead an agent holds;
- the retirement of `queue_agent_message` and `queue_authorized_reply` at the handoff (`AGENT_COMPOSES_TEXT`).

It also makes the R2 runtime emergency stop refuse every seller-facing request at request time.

Not part of this change, but relevant: `PROPOSED_20261027130000_lc_mcp_acquisition_reads.sql` (reader 1.3, separately
approved, runner id `lc_mcp_acquisition_reads`). It provides `leadcommand_get_thread_contact_eligibility`. Apply it only
if that reader tool is wanted in production. It does not depend on A or B.

## 1. Prerequisites (verify on production before anything else)

**A requires** `PROPOSED_20261015130000_message_origin_ai_generated_messages.sql` (the AI-message ledger).

**B requires**, in this order, each already applied:
- **#26** `PROPOSED_20261019160000_action_gateway.sql`, with its own chain: runtime, capabilities, missions, holds registry, S3 payload guard, durability ledger.
- **#27** `PROPOSED_20261020100000_action_gateway_t2.sql`, the extension registry.
- **#28** `PROPOSED_20261020110000_action_gateway_t34.sql`, with negotiation authority and send authorization (a priced agent text consumes one use of a live send authorization).
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
       to_regprocedure('public.negotiation_send_authorization_consume(uuid,text,numeric)') is not null as link_28_send_authority,
       to_regclass('action_gateway.lead_annotations') is not null                                 as link_29,
       to_regprocedure('action_gateway.standing_reply_refusal(uuid,uuid)') is not null            as link_31,
       (select pg_get_constraintdef(oid) ~ 'conversation.queue_reply' from pg_constraint
         where conrelid = 'action_gateway.capability_grants'::regclass
           and conname = 'capability_grants_standing_seller_facing_chk')                          as link_31_check,
       coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false)        as gateway_self_check,
       to_regclass('public.campaign_targets') is not null and to_regclass('public.message_events') is not null
         and to_regclass('public.idempotency_ledger') is not null                                 as relations;
```

If any value is `false`, stop. The missing link is applied first, through its own approval and its own plan.

## 2. Application code (inert without the links)

The code can deploy before or after A and B. Without them, every new path does nothing:
- **Gateway tools.** `sms_send_agent_text` fails closed: its definer reads do not exist. The retired composer tools
  answer `AGENT_COMPOSES_TEXT` from the gateway itself, link or no link.
- **Action MCP boot.** The new RPC names are an allowlist, not a boot requirement.
- **Feed writers.** The inbound webhook, the lead-state registry and the delivery webhook append through
  `lead-events.js`. Those calls never throw or block; without B they return `not_appended`.
- **Stand-down.** `lc_agent_lead_holder` does not exist without B: nobody holds a lead, and LeadCommand's engine runs as
  before.
- **Queue runner.** The agent-text row gate applies only to rows stamped `metadata.agent_text_intent_id`, and only B can
  create those. The transport's greeting rule is lifted only for such a row whose body the gate verified against its
  ledger record.
- **Receipt sweep.** The runtime-tick maintenance task `action_gateway_receipt_sweep` exists only with
  `LC_ACTION_GATEWAY_EXECUTION=1` (born OFF, like the executor).

Recommended order: rehearse on the clone (§3), deploy the code, apply A, apply B, verify (§4).

## 3. Clone rehearsal (a disposable clone, never production)

1. **Clone.** Restore a recent production backup into a disposable project or database: schema plus data, so the pretests see real relations. Use no production credentials in any app pointed at it.
2. **Prerequisites.** Run the §1 query on the clone. Every value must be `true`.
3. **Runner on the clone.** `node scripts/db/run-migration-test.mjs --admin-url <clone admin url> --id ai_generated_outbound` and then `--id action_gateway_agent_message`.
   On the clone the setup is the clone itself, so run the files by hand if the runner's fixture setup does not fit: the steps below.
4. **Manual sequence**, each file inside its own transaction (the link files already are):
   - `…090000_ai_generated_outbound_pretest.sql`, then the apply, then the posttest. Verify with **V-A**.
   - `…100000_action_gateway_agent_message_pretest.sql`, then the apply, then the posttest. Verify with **V-B** and **V-OFF**.
5. **Rollback rehearsal.** Take a schema fingerprint before step 4 (`pg_dump -s` of `action_gateway`, `agent` and `public`, sorted). Then run B's rollback and its rollback posttest, A's rollback and its rollback posttest, and diff the fingerprint; it must be identical. Then re-apply A and B.
6. **Read-only exercise on the clone**, with switches OFF, as `lc_action_gateway` through the Action MCP pointed at the clone:
   - `leadcommand_send_controls` shows `agent_text_enabled:false` and `agent_text_refusal:'AGENT_TEXT_KILL_SWITCH_OFF'`;
   - `leadcommand_agent_lead_pool {market}` on a real market returns rows with no phones or names, and `agent_texts_available:false`;
   - `sms_send_agent_text` returns `AGENT_TEXT_KILL_SWITCH_OFF`; `sms_send_agent_message` returns `AGENT_COMPOSES_TEXT`.
7. **Feed volume estimate.** About one `lead_events` row per inbound, plus one per lead-state change or transfer, plus about three per agent text (enqueued, sent, the carrier's verdict).

**V-A** (after A):
```sql
select (select count(*) from pg_attribute where attrelid = 'public.ai_generated_messages'::regclass and attname in ('record_kind', 'author_employee', 'author_attribution') and not attisdropped) = 3 as has_columns,
       (select count(*) from public.ai_generated_messages where record_kind <> 'reply') = 0                                                       as no_agent_records_yet,
       (select count(*) from public.ai_generated_messages where record_kind = 'reply' and inbound_message_id is null) = 0                       as replies_bound;
```

**V-B** (after B):
```sql
select coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false)                                    as self_check,
       (select count(*) from action_gateway.extensions where link = 'PROPOSED_20261029100000_action_gateway_agent_message') = 17 as registry_rows,
       action_gateway.t34_handoff_kind('queue_agent_text') = 'action_gateway.execute'                                          as handoff_kind,
       action_gateway.t34_capability_refusal('queue_agent_message') = 'AGENT_COMPOSES_TEXT'
         and action_gateway.t34_capability_refusal('queue_authorized_reply') = 'AGENT_COMPOSES_TEXT'                          as composers_retired,
       has_function_privilege('lc_action_gateway', 'public.action_gateway_agent_text_submit(text,jsonb)', 'EXECUTE')         as gateway_writer,
       not has_function_privilege('lc_action_gateway', 'public.lc_agent_text_load(uuid)', 'EXECUTE')                         as no_worker_fn_for_gateway,
       not has_function_privilege('anon', 'public.action_gateway_agent_lead_pool(text,integer,text)', 'EXECUTE')              as no_anon,
       (select count(*) from action_gateway.lead_events) = 0                                                                     as feed_empty;
```

**V-OFF** (born OFF; run after B and again before every activation step):
```sql
select action_gateway.agent_text_refusal()                                                                      as refusal,     -- 'AGENT_TEXT_KILL_SWITCH_OFF'
       (select value from public.system_control where key = 'ai_agent_text_enabled')                            as at_switch,   -- null (absent) = OFF
       (select count(*) from action_gateway.capability_grants where revoked_at is null
          and capability in ('conversation.queue_agent_text', 'leads.assign_lead', 'leads.release_lead', 'leads.transfer_lead', 'leads.read_pool',
                             'leads.read_assignment', 'events.read', 'controls.read'))                          as new_grants, -- 0
       (select count(*) from action_gateway.capability_grants where standing_seller_facing and revoked_at is null
          and capability = 'conversation.queue_agent_text')                                                     as standing_at; -- 0
```

## 4. Production apply (owner)

1. **Freeze.** Run §1. Choose a quiet window. No queue or worker change is needed: A and B are DDL plus registry rows, each in one transaction, about 250 ms on PG 17.
2. **Apply A.** Pretest, apply, posttest. Verify V-A.
3. **Apply B.** Pretest, apply, posttest. Verify V-B and V-OFF.
4. **Deploy the code** if it was not deployed first. Confirm `leadcommand_send_controls` answers through the Action MCP.
5. **Watch for 24 h with everything OFF:**
   - `lead_events` grows with `inbound_message`, `lead_state_changed` and `opt_out`, and holds no `delivery_changed` rows;
   - `action_gateway.self_check` stays ok;
   - no `ops_work_item` rows with `action = 'queue_agent_text'`.

## 5. What each switch and grant is born as

| Control | Born as | Owner of the change |
|---|---|---|
| `system_control.ai_agent_text_enabled` | absent = **OFF** (`AGENT_TEXT_KILL_SWITCH_OFF`) | owner |
| `system_control.ai_agent_text_policy` | absent = the defaults: `max_per_day_global` 200, `max_per_lead_per_day` 6 (all texts), `max_initiated_per_lead_per_day` 1, `followup_min_quiet_hours` 24, `reengage_min_quiet_hours` 72, `allow_links` false, `languages` ["en"]; malformed = every cap 0 | owner |
| `system_control.ai_conversation_send_policy.scope` | when it lists thread keys / markets / campaigns, agent texts are confined to them; empty = no restriction | owner |
| `system_control.ai_conversation_send_enabled` | **not read** by agent texts; it gates LeadCommand's own reply engine only | owner |
| `system_control.ai_conversation_company_identity` | absent = the agent may name no company; `human_review` and `persona_descriptor` are never claimed unless configured | owner |
| `action_gateway_enabled` / `action_gateway_tiers` | unchanged; T3 must be listed for any send | owner |
| Grants for the new capabilities | **none exist** | owner mints them |
| `capability_grants.standing_seller_facing` for `conversation.queue_agent_text` | none; the CHECK confines the flag to the three pairs and requires a `standing_basis` | owner only |
| `leads.transfer_lead` | none; grant it to the supervising agent only | owner |
| `action_gateway.lead_events` feed | **written from the first deploy after B**. No switch: ids and codes only, append-only. Retention is not implemented (see §8) | — |

## 6. Owner-only activation, in order

Before each step: V-OFF (where still applicable) and `leadcommand_send_controls`. Each step is reversible by the
brakes in §7.

1. **Reads only.** Grant per agent: `events.read`, `leads.read_pool`, `leads.read_assignment`, `controls.read` (T1). No seller contact is possible.
2. **Lead ownership.** Grant `leads.assign_lead` and `leads.release_lead` (T2, standing, reversible) to the senders, and `leads.transfer_lead` to the supervisor. These are internal only.
3. **Company identity.** Configure `ai_conversation_company_identity` (name; `human_review` only if a person really reads the messages; a `persona_descriptor` only if approved).
4. **Agent-text policy and switch.** Optionally set `ai_agent_text_policy` (start small: e.g. `max_per_day_global` 20); then set `ai_agent_text_enabled = 'true'`; confirm `send_controls.agent_text_refusal` is null.
5. **Per-use authority.** Grant `conversation.queue_agent_text` (T3) to the supervised agents. Every text then waits for a human approval in the existing decide path.
6. **Standing authority (optional, later).** Only after a supervised period, mint ONE standing grant per agent with `standing_seller_facing = true` and a `standing_basis` that names the evidence.
7. **Widen.** Grow `max_per_day_global` in steps, watching receipts, `ops_work_item` and the `CONTENT_REJECTED` reason mix.

## 7. Rollback triggers and brakes

Brakes, fastest first. None of them needs a migration.
- **R2 runtime emergency stop** (`agent.runtime_emergency_stop`, a named operator): every seller-facing request is refused `EMERGENCY_STOP_ACTIVE`; workers halt; queued agent texts are cancelled at dispatch.
- **Queue emergency stop** (`queue_emergency_stop_at`): the same at request time and at dispatch.
- **`ai_agent_text_enabled = 'false'`**: new requests are refused, and queued agent texts are cancelled at dispatch.
- **Revoke the grants**: the worker re-checks authority at execution (`NO_PER_USE_AUTHORITY`).
- **Release / transfer the lead**: a queued text of an agent that no longer holds the lead is cancelled at dispatch.

Triggers. Brake immediately and investigate:
- a sent agent text whose body differs from its `agent_text` record (the row gate cancels it; a send would be a defect);
- a text sent to a stopped, suppressed, wrong-number or non-owner lead;
- an initiated text sent outside 08:00–21:00 recipient-local;
- more than one answer to an inbound, or any duplicate;
- any amount sent without a consumed negotiation send authorization, any visit / call promise, any human claim;
- LeadCommand's own AI replying on an agent-held lead;
- `self_check` not ok, or a sustained spike of `outcome_unknown` receipts.

Rollback (only after the brakes, and only if the link itself is at fault):
- **B's rollback refuses while** a live standing grant exists, any agent-message / agent-text / lead intent is pending, or **any agent-message or agent-text receipt exists** (evidence: export and deliberately delete first). It **drops** `lead_events`, `lead_assignments` and `agent_text_submissions` with their rows; export them first if they are wanted.
- **A's rollback refuses while** any `agent_outbound` or `agent_text` record exists (append-only evidence).
- Order: B's rollback and its rollback posttest; then A's rollback and its rollback posttest. Both restore earlier bodies and CHECKs exactly (fingerprint-proven on disposable PG).

## 8. What stays off or is not done

- **Off at apply:** agent texts (switch absent), standing seller-facing authority for agent texts, every new grant.
- **Never automatic:**
  - an amount in a text without a live negotiation send authorization of that lead for exactly that amount (`MONEY_NOT_AUTHORIZED`);
  - an initiated text outside the window (refused with `next_permitted_at`, never scheduled);
  - a first touch to a contacted number; a second answer to one inbound.
- **Retired for agents (kept for the record):** `queue_agent_message` (brief → `composeAgentOutbound`) and `queue_authorized_reply`: `AGENT_COMPOSES_TEXT` at the gateway and at the handoff; their worker executors refuse too.
- **Not implemented:**
  - retention for `action_gateway.lead_events` and `agent_text_submissions`; a decision is needed before scale;
  - LeadCommand's deterministic template auto-reply on an inbound is **not** stood down on an agent-held lead (only the AI engine is); an owner decision is needed if the agent should be the only voice there too;
  - a runner entry for #31.
- **Separate decision:** reader 1.3 (`lc_mcp_acquisition_reads`) for `leadcommand_get_thread_contact_eligibility`.
