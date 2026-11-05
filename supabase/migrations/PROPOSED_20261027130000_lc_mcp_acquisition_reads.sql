-- =============================================================================
-- LeadCommand MCP 1.3 — Operation Hidden Gold read coverage: five per-thread acquisition reads
-- (read-only definer projections for lc_mcp_reader)
-- STATUS: PROPOSED. NOT APPLIED. Owner approval required; applied on its own, AFTER
--   PROPOSED_20261019150000_lc_mcp_reader.sql (the lc_mcp_reader role and its self-check must exist).
--   Independent of the 1.1 / 1.2 optional links (conversation intel, corpus census): whichever of them is
--   applied is judged by the self-check below; one that is not applied is not required.
-- Test (disposable PostgreSQL ONLY, never production):
--   node scripts/db/run-migration-test.mjs --pg-bin <pg bin dir> --id lc_mcp_acquisition_reads
-- Rollback: PROPOSED_20261027130000_lc_mcp_acquisition_reads_rollback.sql (drops exactly what this creates)
-- =============================================================================
--
-- WHY. The acquisition workforce reads one seller thread at a time: what follow-ups are planned for it,
-- what LeadCommand actually sent / queued / failed for it (and what the Action Gateway did with a handed-off
-- intent), which offers and pipeline records it carries, whether it may be contacted at all, and which operator
-- tasks are open. Every one of these lives in a table the role holds NO privilege on (followup_intents,
-- send_queue, seller_offers, automation_events / _suppressions, the holds registry, schema agent, schema
-- action_gateway). This adds five READ projections. The role still sees only what these functions return.
--
-- WHAT IT CREATES (each STABLE, SECURITY DEFINER, plpgsql, search_path = pg_catalog, fully qualified, STATIC
-- SQL only — no dynamic SQL (the reader self-check refuses a reachable function whose body runs dynamic SQL:
-- dynamic_sql_function), no network — bounded inputs refused with 22023; EXECUTE revoked from PUBLIC / anon /
-- authenticated / service_role and granted to lc_mcp_reader only). A source the database does not have
-- (to_regclass / to_regprocedure checked at call time, each optional branch a separate statement that is only
-- planned when its source exists) is skipped and reported under `sources` as false — never a failure:
--
--   lc_mcp_thread_followups(uuid)
--     ONE inbox thread's rows of public.followup_intents, newest first, ≤ 50: id, kind, intent, use case, state,
--     due / next attempt, reason CODE (digit runs withheld), writer, attempts, whether a send_queue row was
--     materialized, template source, outcome, next action, timestamps; counts by state.
--     NEVER: thread_key / intent_key / send_queue_key (phone-bearing), row_spec, lease fields, provider ids.
--   lc_mcp_thread_execution_log(uuid, integer)
--     the thread's public.send_queue rows (id, queue key and failed reason with digit runs withheld, status,
--     scheduled / sent / delivered, use-case template, agent name, message origin / type, template source, touch,
--     guard / safety states, timestamps) newest first, ≤ 100 — joined, when action_gateway.seller_action_receipts
--     exists, with the receipt (state, code, action) of the gateway intent whose queue_row_id is the row — plus the
--     thread's public.automation_events (type, status, source, error code, timestamps; NO payload) if that table
--     exists. NEVER: message_body / message_text / rendered_message, to / from phone numbers, provider payloads.
--   lc_mcp_thread_offers(uuid)
--     public.seller_offers for the thread (offer id with digit runs withheld, opportunity id, version, direction,
--     type, purchase price, authorized ceiling, recommended offer, valuation mid, strategy, status, closing /
--     EMD terms, timestamps) newest first ≤ 50, and the thread's public.acquisition_opportunities rows (id, stage,
--     status, automation state, priority, temperature, approval state, next action / blocker with digit runs
--     withheld, latest intent, prices, market, timestamps) ≤ 10. NEVER: thread keys, dedupe keys, metadata.
--   lc_mcp_thread_contact_eligibility(uuid)
--     the thread's own flags (is_suppressed, contactability_status, opt_out, wrong_number, status, disposition,
--     automation_state), whether an ACTIVE public.sms_suppression_list row exists for its number (count, type,
--     reason capped, created_at — never the number), active public.automation_suppressions rows if that table
--     exists, active holds through public.automation_hold_for (type, reason CATEGORY, blocked capabilities,
--     set_at — never ids / keys / reason text), the contact_property_resolution role for the thread's property
--     if that table exists, the phone rows' states, and `eligible_for_outreach` with its blocking reasons.
--     THE RULE (stated again in the function comment): eligible_for_outreach = the thread has a key AND
--     is_suppressed / opt_out / wrong_number are all not true AND contactability_status is not in the blocked set
--     (opted_out, do_not_text, do_not_contact, dnc, wrong_number, blocked, suppressed, not_contactable,
--     unreachable) AND no active sms_suppression_list row AND no active automation_suppressions row AND no active
--     hold blocks 'ai_action'. It is a READ of the inputs the send-time guard uses, computed at read time; the
--     send path keeps its own guard — this never authorizes a send.
--   lc_mcp_operator_tasks(integer)
--     open / acknowledged agent.ops_work_item rows (id, org, scope, kind, severity, title with digit runs
--     withheld, subject type / id, state, escalated, priority, due, seen counts, timestamps) newest first ≤ 100,
--     with counts by state and severity. NEVER the detail payload.
--
-- WHAT MAKES THE APPLY ABORT (atomically): lc_mcp_reader missing; any self-check finding for the role with the
-- function list extended by the five (plus every optional 1.1 / 1.2 function that IS applied) — the same rules as
-- the 1.0 apply: no write, CREATE, login, membership, egress, dynamic SQL, exposed read outside the inventory,
-- unexpected definer, volatile allowlisted RPC.

set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'lc_mcp_reader') then
    raise exception 'lc_mcp_acquisition_reads: role lc_mcp_reader does not exist — apply PROPOSED_20261019150000_lc_mcp_reader.sql first';
  end if;
  if pg_catalog.to_regprocedure('public.lc_mcp_reader_self_check(text[],text[],name)') is null then
    raise exception 'lc_mcp_acquisition_reads: public.lc_mcp_reader_self_check missing — apply PROPOSED_20261019150000_lc_mcp_reader.sql first';
  end if;
end
$$;

-- ------------------------------------------------------------ 1. the thread's follow-up intents ----
create or replace function public.lc_mcp_thread_followups(p_thread_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  t record;
  has_fi boolean := pg_catalog.to_regclass('public.followup_intents') is not null;
  rows_out jsonb := '[]'::jsonb;
  n integer := 0;
  total integer := 0;
  counts jsonb := '{}'::jsonb;
begin
  if p_thread_id is null then raise exception using errcode = '22023', message = 'lc_mcp_thread_followups: thread id required'; end if;
  select s.id, s.thread_key, s.property_id into t from public.inbox_thread_state s where s.id = p_thread_id;
  if not found then return jsonb_build_object('thread_found', false); end if;
  if has_fi and t.thread_key is not null then
    -- the projection reads the row as jsonb: a column this database lacks is simply null
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', x.j->>'id', 'kind', x.j->>'kind', 'intent', x.j->>'intent', 'use_case', x.j->>'use_case', 'state', x.j->>'state',
        'due_at', x.j->>'due_at', 'next_attempt_at', x.j->>'next_attempt_at',
        'reason_code', left(regexp_replace(x.j->>'reason', '[0-9]{7,}', '[digits withheld]', 'g'), 120),
        'writer', x.j->>'writer', 'attempts', (x.j->>'attempts')::int, 'max_attempts', (x.j->>'max_attempts')::int,
        'materialize_seq', (x.j->>'materialize_seq')::int, 'materialized', (x.j->>'send_queue_id') is not null,
        'template_source', x.j->>'template_source', 'outcome', x.j->>'outcome', 'next_action', left(regexp_replace(x.j->>'next_action', '[0-9]{7,}', '[digits withheld]', 'g'), 120),
        'property_id', x.j->>'property_id', 'this_property', t.property_id is not null and (x.j->>'property_id') = t.property_id,
        'created_at', x.j->>'created_at', 'updated_at', x.j->>'updated_at', 'closed_at', x.j->>'closed_at')
        order by x.created_at desc, x.id desc), '[]'::jsonb), count(*)
      into rows_out, n
      from (select f.id, f.created_at, to_jsonb(f) as j from public.followup_intents f
             where f.thread_key = t.thread_key order by f.created_at desc, f.id desc limit 50) x;
    select coalesce(jsonb_object_agg(c.state, c.n), '{}'::jsonb), coalesce(sum(c.n), 0)::int into counts, total
      from (select f.state, count(*)::int as n from public.followup_intents f where f.thread_key = t.thread_key group by f.state) c;
  end if;
  return jsonb_build_object(
    'thread_found', true, 'thread_id', t.id, 'property_id', t.property_id,
    'rows', rows_out, 'returned', n, 'limit', 50, 'total', total, 'has_more', total > n,
    'counts_by_state', counts,
    'sources', jsonb_build_object('followup_intents', has_fi),
    'as_of', pg_catalog.now());
end
$fn$;
comment on function public.lc_mcp_thread_followups(uuid) is 'LeadCommand MCP 1.3: one inbox thread''s follow-up intents (kind, state, due, reason code, attempts, materialized, outcome, timestamps; counts by state), newest first, ≤ 50. Never thread keys, intent keys, row specs, leases or provider ids. Read-only. Executable by lc_mcp_reader only.';

-- ------------------------------------------------------------ 2. the thread's execution log ----
create or replace function public.lc_mcp_thread_execution_log(p_thread_id uuid, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  lim integer := coalesce(p_limit, 50);
  t record;
  has_sq boolean := pg_catalog.to_regclass('public.send_queue') is not null;
  has_rc boolean := pg_catalog.to_regclass('action_gateway.seller_action_receipts') is not null;
  has_ae boolean := pg_catalog.to_regclass('public.automation_events') is not null;
  q jsonb := '[]'::jsonb; qn integer := 0;
  rc jsonb := '{}'::jsonb;
  ev jsonb := '[]'::jsonb; en integer := 0;
begin
  if p_thread_id is null then raise exception using errcode = '22023', message = 'lc_mcp_thread_execution_log: thread id required'; end if;
  if lim < 1 or lim > 100 then raise exception using errcode = '22023', message = 'lc_mcp_thread_execution_log: limit must be 1..100'; end if;
  select s.id, s.thread_key, s.property_id into t from public.inbox_thread_state s where s.id = p_thread_id;
  if not found then return jsonb_build_object('thread_found', false); end if;

  -- the send queue rows of the thread: states, timing, template / agent / origin — never the body or a number
  if has_sq and t.thread_key is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', x.id,
        'queue_key', left(regexp_replace(x.j->>'queue_key', '[0-9]{7,}', '[digits withheld]', 'g'), 120),
        'queue_status', x.j->>'queue_status', 'scheduled_for', x.j->>'scheduled_for', 'sent_at', x.j->>'sent_at', 'delivered_at', x.j->>'delivered_at',
        'failed_reason', left(regexp_replace(x.j->>'failed_reason', '[0-9]{7,}', '[digits withheld]', 'g'), 200),
        'use_case_template', x.j->>'use_case_template', 'agent_name', x.j->>'agent_name', 'message_origin', x.j->>'message_origin',
        'message_type', x.j->>'message_type', 'template_source', x.j->>'template_source', 'touch_number', (x.j->>'touch_number')::int,
        'retry_count', (x.j->>'retry_count')::int, 'safety_status', x.j->>'safety_status', 'guard_status', x.j->>'guard_status',
        'paused_reason', left(regexp_replace(x.j->>'paused_reason', '[0-9]{7,}', '[digits withheld]', 'g'), 120),
        'property_id', x.j->>'property_id', 'created_at', x.j->>'created_at', 'updated_at', x.j->>'updated_at', 'receipt', null)
        order by x.created_at desc nulls last, x.id desc), '[]'::jsonb), count(*)
      into q, qn
      from (select q0.id::text as id, q0.created_at, to_jsonb(q0) as j from public.send_queue q0
             where q0.thread_key = t.thread_key order by q0.created_at desc nulls last, q0.id::text desc limit lim) x;
  end if;

  -- what the Action Gateway did with a handed-off intent whose queue row this is (link #28, optional)
  if has_rc and qn > 0 then
    select coalesce(jsonb_object_agg(r.queue_row_id, jsonb_build_object('state', r.state, 'code', r.code, 'action', r.action, 'updated_at', r.updated_at)), '{}'::jsonb)
      into rc
      from (select distinct on (r0.queue_row_id) r0.queue_row_id, r0.state, r0.code, r0.action, r0.updated_at
              from action_gateway.seller_action_receipts r0
             where r0.queue_row_id in (select e->>'id' from jsonb_array_elements(q) e)
             order by r0.queue_row_id, r0.updated_at desc) r;
    select coalesce(jsonb_agg((e.v || jsonb_build_object('receipt', rc->(e.v->>'id'))) order by e.o), '[]'::jsonb) into q
      from jsonb_array_elements(q) with ordinality e(v, o);
  end if;

  -- the automation engine's events for the thread (type / status / source / error code — never the payload)
  if has_ae and t.thread_key is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', x.id, 'event_type', x.j->>'event_type', 'status', x.j->>'status', 'source', x.j->>'source', 'error_code', x.j->>'error_code',
        'property_id', x.j->>'property_id', 'run_started_at', x.j->>'run_started_at', 'run_completed_at', x.j->>'run_completed_at',
        'created_at', x.j->>'created_at', 'updated_at', x.j->>'updated_at')
        order by x.created_at desc nulls last, x.id desc), '[]'::jsonb), count(*)
      into ev, en
      from (select a.id::text as id, a.created_at, to_jsonb(a) as j from public.automation_events a
             where a.conversation_thread_id = t.thread_key or a.conversation_thread_id = t.id::text
             order by a.created_at desc nulls last, a.id::text desc limit lim) x;
  end if;

  return jsonb_build_object(
    'thread_found', true, 'thread_id', t.id, 'property_id', t.property_id, 'limit', lim,
    'queue_rows', q, 'queue_returned', qn,
    'events', ev, 'events_returned', en,
    'sources', jsonb_build_object('send_queue', has_sq, 'seller_action_receipts', has_rc, 'automation_events', has_ae),
    'as_of', pg_catalog.now());
end
$fn$;
comment on function public.lc_mcp_thread_execution_log(uuid, integer) is 'LeadCommand MCP 1.3: one inbox thread''s send_queue rows (status, timing, template, agent, origin; queue key / failed reason with digit runs withheld) with the Action Gateway receipt of a handed-off intent when action_gateway.seller_action_receipts exists, plus its automation_events (no payload) when that table exists; newest first, ≤ 100. Never a message body or a phone number. Read-only. Executable by lc_mcp_reader only.';

-- ------------------------------------------------------------ 3. the thread's offers and pipeline records ----
create or replace function public.lc_mcp_thread_offers(p_thread_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  t record;
  has_so boolean := pg_catalog.to_regclass('public.seller_offers') is not null;
  has_ao boolean := pg_catalog.to_regclass('public.acquisition_opportunities') is not null;
  offers jsonb := '[]'::jsonb; on_ integer := 0; o_total integer := 0;
  opps jsonb := '[]'::jsonb; pn integer := 0;
begin
  if p_thread_id is null then raise exception using errcode = '22023', message = 'lc_mcp_thread_offers: thread id required'; end if;
  select s.id, s.thread_key, s.property_id into t from public.inbox_thread_state s where s.id = p_thread_id;
  if not found then return jsonb_build_object('thread_found', false); end if;

  if has_so and t.thread_key is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
        'offer_id', left(regexp_replace(x.j->>'offer_id', '[0-9]{7,}', '[digits withheld]', 'g'), 80),
        'opportunity_id', x.j->>'opportunity_id', 'property_id', x.j->>'property_id', 'offer_version', (x.j->>'offer_version')::int,
        'direction', x.j->>'direction', 'offer_type', x.j->>'offer_type',
        'purchase_price', (x.j->>'purchase_price')::numeric, 'authorized_ceiling', (x.j->>'authorized_ceiling')::numeric,
        'recommended_offer', (x.j->>'recommended_offer')::numeric, 'valuation_mid', (x.j->>'valuation_mid')::numeric, 'strategy', x.j->>'strategy',
        'status', x.j->>'status', 'closing_date', x.j->>'closing_date', 'closing_term', x.j->>'closing_term', 'emd_amount', (x.j->>'emd_amount')::numeric, 'emd_term', x.j->>'emd_term',
        'policy_version', x.j->>'policy_version', 'send_bound', (x.j->>'send_queue_row_id') is not null,
        'created_at', x.j->>'created_at', 'sent_at', x.j->>'sent_at', 'superseded_at', x.j->>'superseded_at',
        'accepted_at', x.j->>'accepted_at', 'accepted_price', (x.j->>'accepted_price')::numeric)
        order by x.created_at desc nulls last, x.id desc), '[]'::jsonb), count(*)
      into offers, on_
      from (select o.id, o.created_at, to_jsonb(o) as j from public.seller_offers o
             where o.thread_key = t.thread_key order by o.created_at desc nulls last, o.id desc limit 50) x;
    select count(*) into o_total from (select 1 from public.seller_offers o where o.thread_key = t.thread_key limit 1000) z;
  end if;

  if has_ao and t.thread_key is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', x.j->>'id', 'primary_property_id', x.j->>'primary_property_id',
        'acquisition_stage', x.j->>'acquisition_stage', 'opportunity_status', x.j->>'opportunity_status', 'automation_state', x.j->>'automation_state',
        'priority', x.j->>'priority', 'temperature', x.j->>'temperature', 'approval_state', x.j->>'approval_state',
        'next_action', left(regexp_replace(x.j->>'next_action', '[0-9]{7,}', '[digits withheld]', 'g'), 160), 'next_action_due', x.j->>'next_action_due',
        'blocker', left(regexp_replace(x.j->>'blocker', '[0-9]{7,}', '[digits withheld]', 'g'), 160), 'latest_intent', x.j->>'latest_intent',
        'estimated_value', (x.j->>'estimated_value')::numeric, 'arv', (x.j->>'arv')::numeric, 'asking_price', (x.j->>'asking_price')::numeric, 'current_offer', (x.j->>'current_offer')::numeric,
        'active_offer_id', left(regexp_replace(x.j->>'active_offer_id', '[0-9]{7,}', '[digits withheld]', 'g'), 80),
        'accepted_offer_id', left(regexp_replace(x.j->>'accepted_offer_id', '[0-9]{7,}', '[digits withheld]', 'g'), 80),
        'market', x.j->>'market', 'stage_entered_at', x.j->>'stage_entered_at', 'last_activity_at', x.j->>'last_activity_at', 'last_contact_at', x.j->>'last_contact_at',
        'created_at', x.j->>'created_at', 'updated_at', x.j->>'updated_at')
        order by x.ordered_at desc nulls last, x.id desc), '[]'::jsonb), count(*)
      into opps, pn
      from (select o.id, coalesce((to_jsonb(o)->>'updated_at')::timestamptz, (to_jsonb(o)->>'created_at')::timestamptz) as ordered_at, to_jsonb(o) as j
              from public.acquisition_opportunities o where o.primary_thread_key = t.thread_key
             order by 2 desc nulls last, 1 desc limit 10) x;
  end if;

  return jsonb_build_object(
    'thread_found', true, 'thread_id', t.id, 'property_id', t.property_id,
    'offers', offers, 'offers_returned', on_, 'offers_total', o_total, 'offers_limit', 50,
    'opportunities', opps, 'opportunities_returned', pn, 'opportunities_limit', 10,
    'sources', jsonb_build_object('seller_offers', has_so, 'acquisition_opportunities', has_ao),
    'as_of', pg_catalog.now());
end
$fn$;
comment on function public.lc_mcp_thread_offers(uuid) is 'LeadCommand MCP 1.3: one inbox thread''s seller offers (version, direction, type, price, ceiling, status, terms, timestamps; ≤ 50) and its acquisition opportunities (stage, status, priority, next action, prices; ≤ 10), newest first. Never thread keys, dedupe keys or metadata; digit runs in free text withheld. Read-only. Executable by lc_mcp_reader only.';

-- ------------------------------------------------------------ 4. the thread's contact eligibility inputs ----
create or replace function public.lc_mcp_thread_contact_eligibility(p_thread_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  t record;
  k text;
  cs text;
  has_as boolean := pg_catalog.to_regclass('public.automation_suppressions') is not null;
  has_cpr boolean := pg_catalog.to_regclass('public.contact_property_resolution') is not null;
  has_holds boolean := pg_catalog.to_regprocedure('public.automation_hold_for(text,uuid,text,uuid,text,text)') is not null;
  sup jsonb := '[]'::jsonb; sup_active integer := 0;
  asup jsonb := null; asup_active integer := 0;
  hl jsonb := null; hn integer := 0; hold_blocks_ai boolean := false;
  cpr jsonb := null;
  ph jsonb := '[]'::jsonb;
  blocked text[] := '{}';
begin
  if p_thread_id is null then raise exception using errcode = '22023', message = 'lc_mcp_thread_contact_eligibility: thread id required'; end if;
  select s.id, s.thread_key, s.property_id, s.master_owner_id, to_jsonb(s) as j into t from public.inbox_thread_state s where s.id = p_thread_id;
  if not found then return jsonb_build_object('thread_found', false); end if;
  k := t.thread_key;
  cs := lower(t.j->>'contactability_status');

  -- the suppression list: active rows for the thread's number (the number itself never leaves)
  select count(*) filter (where coalesce(x.is_active, false)),
         coalesce(jsonb_agg(jsonb_build_object(
             'type', x.suppression_type,
             'reason', left(regexp_replace(to_jsonb(x)->>'suppression_reason', '[0-9]{7,}', '[digits withheld]', 'g'), 80),
             'sender_scoped', (to_jsonb(x)->>'sender_phone_e164') is not null,
             'created_at', to_jsonb(x)->>'created_at')
           order by to_jsonb(x)->>'created_at' desc nulls last) filter (where coalesce(x.is_active, false)), '[]'::jsonb)
    into sup_active, sup
    from (select x0.* from public.sms_suppression_list x0
           where k is not null and (x0.phone_e164 = k or (to_jsonb(x0)->>'phone_number') = k) limit 20) x;

  -- the automation engine's own suppressions (optional table)
  if has_as and k is not null then
    select count(*), coalesce(jsonb_agg(jsonb_build_object(
        'type', a.j->>'suppression_type', 'rule_key', a.j->>'rule_key', 'event_type', a.j->>'event_type', 'action_type', a.j->>'action_type',
        'reason', left(regexp_replace(a.j->>'suppression_reason', '[0-9]{7,}', '[digits withheld]', 'g'), 80),
        'suppressed_at', a.j->>'suppressed_at', 'expires_at', a.j->>'expires_at', 'created_at', a.j->>'created_at')
        order by a.created_at desc nulls last), '[]'::jsonb)
      into asup_active, asup
      from (select a0.created_at, to_jsonb(a0) as j from public.automation_suppressions a0
             where (a0.phone_e164 = k or a0.conversation_thread_id = k)
               and coalesce(a0.status, 'active') = 'active'
               and (a0.expires_at is null or a0.expires_at > pg_catalog.now())
             order by a0.created_at desc nulls last limit 10) a;
  end if;

  -- THE hold authority (public.automation_hold_for) over the thread's keys: category, never the reason text
  if has_holds then
    select count(*),
           coalesce(jsonb_agg(jsonb_build_object(
               'hold_type', h.hold_type,
               'reason_category', case when h.hold_type = 'permanent_exclusion' then 'permanent_exclusion'
                                       when h.reason = 'ownership_denial_property_unresolved' or h.hold_key like 'ownership_unresolved:%' then 'ownership_attribution_unresolved'
                                       else 'operator_hold' end,
               'matched_on', case when (k is not null and h.thread_key = k) or h.inbox_thread_id = t.id then 'thread'
                                  when t.property_id is not null and h.property_id = t.property_id then 'property'
                                  when t.master_owner_id is not null and h.master_owner_id = t.master_owner_id then 'owner'
                                  else 'other' end,
               'blocked_capabilities', to_jsonb(h.blocked_capabilities),
               'blocks_ai_action', 'ai_action' = any (h.blocked_capabilities),
               'set_at', h.set_at)
             order by h.set_at, h.id), '[]'::jsonb),
           coalesce(bool_or('ai_action' = any (h.blocked_capabilities)), false)
      into hn, hl, hold_blocks_ai
      from public.automation_hold_for(k, t.id, t.property_id, null::uuid, t.master_owner_id, null::text) h;
  end if;

  -- the contact <-> property resolution of this number for the thread's property (optional table)
  if has_cpr and k is not null and t.property_id is not null then
    select jsonb_build_object('role', r.contact_property_role, 'rejected', r.rejected_at is not null,
                              'suppression_scope', to_jsonb(r)->>'suppression_scope', 'updated_at', to_jsonb(r)->>'updated_at')
      into cpr
      from public.contact_property_resolution r where r.property_id = t.property_id and r.contact_phone_e164 = k limit 1;
  end if;

  -- the phone rows' states
  select coalesce(jsonb_agg(jsonb_build_object(
      'phone_type', to_jsonb(p)->>'phone_type', 'contact_status', to_jsonb(p)->>'phone_contact_status',
      'activity_status', to_jsonb(p)->>'activity_status', 'wrong_number_at', to_jsonb(p)->>'wrong_number_at')), '[]'::jsonb)
    into ph from (select p0.* from public.phones p0 where k is not null and p0.canonical_e164 = k limit 3) p;

  -- THE RULE: eligible_for_outreach = a thread key exists AND not is_suppressed AND not opt_out AND not wrong_number
  -- AND contactability_status not in the blocked set AND no active suppression-list row AND no active automation
  -- suppression AND no active hold blocking 'ai_action'. Every failing input is named in blocking_reasons.
  if k is null then blocked := blocked || 'no_thread_key'::text; end if;
  if coalesce((t.j->>'is_suppressed')::boolean, false) then blocked := blocked || 'thread_suppressed'::text; end if;
  if coalesce((t.j->>'opt_out')::boolean, false) then blocked := blocked || 'thread_opt_out'::text; end if;
  if coalesce((t.j->>'wrong_number')::boolean, false) then blocked := blocked || 'thread_wrong_number'::text; end if;
  if cs in ('opted_out', 'do_not_text', 'do_not_contact', 'dnc', 'wrong_number', 'blocked', 'suppressed', 'not_contactable', 'unreachable') then
    blocked := blocked || ('contactability_' || cs);
  end if;
  if sup_active > 0 then blocked := blocked || 'suppression_list_active'::text; end if;
  if asup_active > 0 then blocked := blocked || 'automation_suppression_active'::text; end if;
  if hold_blocks_ai then blocked := blocked || 'hold_blocks_ai_action'::text; end if;

  return jsonb_build_object(
    'thread_found', true, 'thread_id', t.id, 'property_id', t.property_id,
    'thread_flags', jsonb_build_object('is_suppressed', t.j->'is_suppressed', 'contactability_status', t.j->>'contactability_status',
                                       'opt_out', t.j->'opt_out', 'wrong_number', t.j->'wrong_number', 'status', t.j->>'status',
                                       'disposition', t.j->>'disposition', 'automation_state', t.j->>'automation_state',
                                       'paused', (t.j->>'status') = 'paused_review', 'has_thread_key', k is not null),
    'suppression_list', jsonb_build_object('active', sup_active, 'rows', sup),
    'automation_suppressions', case when has_as then jsonb_build_object('active', asup_active, 'rows', coalesce(asup, '[]'::jsonb)) else null end,
    'holds', case when has_holds then jsonb_build_object('active', hn, 'blocks_ai_action', hold_blocks_ai, 'rows', coalesce(hl, '[]'::jsonb)) else null end,
    'contact_property', cpr,
    'phone_rows', ph,
    'eligible_for_outreach', cardinality(blocked) = 0,
    'blocking_reasons', to_jsonb(blocked),
    'rule', 'eligible = thread key present and not is_suppressed/opt_out/wrong_number and contactability_status not in (opted_out, do_not_text, do_not_contact, dnc, wrong_number, blocked, suppressed, not_contactable, unreachable) and no active sms_suppression_list row and no active automation_suppressions row and no active hold blocking ai_action; a read of the guard''s inputs, never a send authorization',
    'sources', jsonb_build_object('sms_suppression_list', true, 'automation_suppressions', has_as, 'automation_hold_for', has_holds, 'contact_property_resolution', has_cpr, 'phones', true),
    'as_of', pg_catalog.now());
end
$fn$;
comment on function public.lc_mcp_thread_contact_eligibility(uuid) is 'LeadCommand MCP 1.3: one inbox thread''s contact eligibility INPUTS (thread flags, active suppression-list rows, active automation suppressions, active holds by category, contact-property role, phone states) and eligible_for_outreach = thread key present AND not is_suppressed / opt_out / wrong_number AND contactability_status not in (opted_out, do_not_text, do_not_contact, dnc, wrong_number, blocked, suppressed, not_contactable, unreachable) AND no active sms_suppression_list row AND no active automation_suppressions row AND no active hold blocking ai_action. Never a phone number, thread key, hold id / key or reason text. Read-only; never a send authorization. Executable by lc_mcp_reader only.';

-- ------------------------------------------------------------ 5. open operator tasks ----
create or replace function public.lc_mcp_operator_tasks(p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  lim integer := coalesce(p_limit, 50);
  has_wi boolean := pg_catalog.to_regclass('agent.ops_work_item') is not null;
  rows_out jsonb := '[]'::jsonb;
  n integer := 0;
  counts jsonb := null;
begin
  if lim < 1 or lim > 100 then raise exception using errcode = '22023', message = 'lc_mcp_operator_tasks: limit must be 1..100'; end if;
  if has_wi then
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', x.j->>'work_item_id', 'org_id', x.j->>'org_id', 'scope', x.j->>'scope', 'kind', x.j->>'kind', 'severity', x.j->>'severity',
        'title', left(regexp_replace(x.j->>'title', '[0-9]{7,}', '[digits withheld]', 'g'), 200),
        'subject_type', x.j->>'subject_type',
        -- a subject id is a uuid (returned as is) or an opaque key (digit runs withheld)
        'subject_id', case when (x.j->>'subject_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then x.j->>'subject_id'
                           else left(regexp_replace(x.j->>'subject_id', '[0-9]{7,}', '[digits withheld]', 'g'), 80) end,
        'state', x.j->>'state', 'escalated', (x.j->>'escalated')::boolean, 'priority', (x.j->>'priority')::int, 'due_at', x.j->>'due_at',
        'first_seen_at', x.j->>'first_seen_at', 'last_seen_at', x.j->>'last_seen_at', 'seen_count', (x.j->>'seen_count')::int,
        'acknowledged_at', x.j->>'acknowledged_at', 'source_job_id', x.j->>'source_job_id',
        'created_at', x.j->>'created_at', 'updated_at', x.j->>'updated_at')
        order by x.created_at desc, x.id desc), '[]'::jsonb), count(*)
      into rows_out, n
      from (select w.work_item_id as id, w.created_at, to_jsonb(w) as j from agent.ops_work_item w
             where w.state in ('open', 'acknowledged') order by w.created_at desc, w.work_item_id desc limit lim) x;
    select jsonb_build_object(
        'open', count(*) filter (where w.state = 'open'), 'acknowledged', count(*) filter (where w.state = 'acknowledged'),
        'critical', count(*) filter (where w.severity = 'critical'), 'warning', count(*) filter (where w.severity = 'warning'), 'info', count(*) filter (where w.severity = 'info'),
        'escalated', count(*) filter (where coalesce(w.escalated, false)), 'total', count(*))
      into counts from agent.ops_work_item w where w.state in ('open', 'acknowledged');
  end if;
  return jsonb_build_object(
    'rows', rows_out, 'returned', n, 'limit', lim, 'has_more', coalesce((counts->>'total')::int, 0) > n,
    'counts', counts,
    'sources', jsonb_build_object('ops_work_item', has_wi),
    'as_of', pg_catalog.now());
end
$fn$;
comment on function public.lc_mcp_operator_tasks(integer) is 'LeadCommand MCP 1.3: open / acknowledged operator work items (agent.ops_work_item: scope, kind, severity, title with digit runs withheld, subject, state, priority, due, seen counts, timestamps) newest first, ≤ 100, with counts by state / severity. Never the detail payload. Read-only. Executable by lc_mcp_reader only.';

-- ------------------------------------------------------------ 6. grants + verification ----
revoke all on function public.lc_mcp_thread_followups(uuid), public.lc_mcp_thread_execution_log(uuid, integer), public.lc_mcp_thread_offers(uuid),
  public.lc_mcp_thread_contact_eligibility(uuid), public.lc_mcp_operator_tasks(integer) from public, anon, authenticated, service_role;
grant execute on function public.lc_mcp_thread_followups(uuid), public.lc_mcp_thread_execution_log(uuid, integer), public.lc_mcp_thread_offers(uuid),
  public.lc_mcp_thread_contact_eligibility(uuid), public.lc_mcp_operator_tasks(integer) to lc_mcp_reader;

do $$
declare
  -- lc-inventory:relations (unchanged: the 1.0 inventory)
  rels text[] := array['acquisition_opportunities','campaign_target_graph','campaign_targets','campaigns','census_geo_metrics','eg_buyer_index','eg_property_facts','emails','inbox_thread_state','master_owners','mi_geo_period_rollup','mi_rollup_builds','mv_map_market_sales','phones','preforeclosure_status_v2','probate_status','properties','property_acquisition_scores','prospects','sms_suppression_list'];
  -- the 1.0 (required) functions + the five acquisition reads
  fns text[] := array['public.campaign_entity_contact_review_flags(text[])','public.entity_graph_property_records(text)','public.lc_mcp_action_center(uuid,text,boolean,uuid,integer)','public.lc_mcp_followup_intent_health()','public.lc_mcp_operator_role(uuid,uuid)','public.lc_mcp_operator_tasks(integer)','public.lc_mcp_ops_finding(uuid,text)','public.lc_mcp_ops_research_valuation_snapshot()','public.lc_mcp_reader_self_check(text[],text[],name)','public.lc_mcp_thread_contact_eligibility(uuid)','public.lc_mcp_thread_execution_log(uuid,integer)','public.lc_mcp_thread_followups(uuid)','public.lc_mcp_thread_hold_status(uuid)','public.lc_mcp_thread_offers(uuid)'];
  -- the OPTIONAL 1.1 / 1.2 functions: judged when applied, not required
  optional_fns text[] := array['public.lc_mcp_conversation_signals(integer,text)','public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)','public.lc_mcp_corpus_census(text)','public.lc_mcp_lead_conversation(text,uuid,integer,timestamp with time zone,text,integer)','public.lc_mcp_lead_screen(text,integer,text,text)','public.lc_mcp_pipeline_counts(text,text,text,integer)'];
  f text;
  rep jsonb;
begin
  foreach f in array optional_fns loop
    if pg_catalog.to_regprocedure(f) is not null then fns := fns || f; end if;
  end loop;
  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if not coalesce((rep->>'ok')::boolean, false) then
    raise exception 'lc_mcp_acquisition_reads: refused — the reader self-check reports %', rep->'findings';
  end if;
  raise notice 'lc_mcp_acquisition_reads: self-check ok (% relations, % functions)', jsonb_array_length(rep->'relations'), jsonb_array_length(rep->'functions');
end
$$;

notify pgrst, 'reload schema';
