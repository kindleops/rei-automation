-- lc-fixture: verify
-- PROPOSED ONLY — READ-ONLY verification of the rc-8.5.21 release chain (8.5.15 … 8.5.21 + the P0 holds
-- registry) on the final state. Every row must say ok = true. Selects only.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15).
-- ONE final definition: agent.runtime_enqueue_event_at is created by 8.5.20-a
-- (PROPOSED_20261016120000_conversation_reply_turns) and re-created by 8.5.21-b
-- (PROPOSED_20261016160000_runtime_event_budget_ceilings); 8.5.21-a only CALLS it (follow-up
-- schedules). The surviving body must be 8.5.21-b's (clamp = the per-kind ceiling function).
with f as (
  select p.proname, pg_get_functiondef(p.oid) as def, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p where p.pronamespace = 'agent'::regnamespace and p.proname in ('runtime_enqueue_event', 'runtime_enqueue_event_at')
)
select 'agent.runtime_enqueue_event_at: exactly ONE overload' as check, (select count(*) = 1 from f where proname = 'runtime_enqueue_event_at') as ok, (select string_agg(args, ' / ') from f where proname = 'runtime_enqueue_event_at') as detail
union all select 'agent.runtime_enqueue_event: exactly ONE overload', (select count(*) = 1 from f where proname = 'runtime_enqueue_event'), (select string_agg(args, ' / ') from f where proname = 'runtime_enqueue_event')
union all select 'runtime_enqueue_event_at final body = 8.5.21-b (per-kind ceiling, no literal 0.05 clamp)', (select position('runtime_event_budget_ceiling(p_kind)' in def) > 0 and position('0.05)' in def) = 0 from f where proname = 'runtime_enqueue_event_at'), null
union all select 'runtime_enqueue_event final body = 8.5.21-b (per-kind ceiling, no literal 0.05 clamp)', (select position('runtime_event_budget_ceiling(p_kind)' in def) > 0 and position('0.05)' in def) = 0 from f where proname = 'runtime_enqueue_event'), null
union all select 'runtime_enqueue_event_at keeps the 8.5.20-a not-before contract (p_not_before)', (select position('p_not_before' in def) > 0 from f where proname = 'runtime_enqueue_event_at'), null
union all select 'event budget ceilings born empty ({})', (select event_budget_ceilings = '{}'::jsonb from agent.runtime_limits where id = 1), null
union all select 'P0 holds registry present first-class: 9 enabled hold triggers', (select count(*) = 9 from pg_trigger where not tgisinternal and tgenabled = 'O' and tgname in ('aa_automation_hold_seller_offers', 'aa_automation_hold_closing_cases', 'aa_automation_hold_opportunities', 'aa_automation_hold_send_queue', 'aa_automation_holds_append_only', 'aa_automation_holds_no_truncate', 'zz_automation_holds_audit', 'aa_automation_hold_events_append_only', 'aa_automation_hold_events_no_truncate')), null
union all select 'P0 holds registry born empty', (select count(*) = 0 from public.automation_holds), null
union all select 'the hold send_queue guard fires before every other send_queue BEFORE trigger', (select min(tgname) = 'aa_automation_hold_send_queue' from pg_trigger where not tgisinternal and tgrelid = 'public.send_queue'::regclass), (select string_agg(tgname, ',' order by tgname) from pg_trigger where not tgisinternal and tgrelid = 'public.send_queue'::regclass)
union all select 'runtime schedules: nothing enabled by the chain', (select count(*) = 0 from agent.runtime_schedule where enabled), (select string_agg(name, ',') from agent.runtime_schedule where enabled)
union all select 'runtime: kill switch off (runtime_enabled = false)', (select runtime_enabled = false from agent.runtime_limits where id = 1), null
-- the LEGACY public.conversation_turns (10 columns, rows written 2026-05-12; scripts/db/fixtures/legacy_conversation_turns_baseline.sql
-- models it with 3 rows) is untouched by the whole chain: same column set, same rows, same content
union all select 'legacy public.conversation_turns: column set unchanged (10 columns, in order)', (select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'conversation_turns') = 'id:uuid,thread_id:uuid,direction:character varying,channel:character varying,content:text,intent_detected:character varying,confidence_score:double precision,handled_by:character varying,created_at:timestamp with time zone,metadata:jsonb', (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'conversation_turns')
union all select 'legacy public.conversation_turns: row count unchanged (3 fixture rows)', (select count(*) = 3 from public.conversation_turns), (select count(*)::text from public.conversation_turns)
union all select 'legacy public.conversation_turns: row content unchanged', (select string_agg(id::text || '|' || thread_id::text || '|' || direction || '|' || channel || '|' || coalesce(content, '') || '|' || handled_by || '|' || created_at::text, ';' order by id) from public.conversation_turns) = (select string_agg(x, ';' order by x) from (values ('00000000-0000-4000-8000-0000000000a1|00000000-0000-4000-8000-0000000000f1|inbound|sms|legacy row 1|ai|' || '2026-05-12T10:00:00Z'::timestamptz::text), ('00000000-0000-4000-8000-0000000000a2|00000000-0000-4000-8000-0000000000f1|outbound|sms|legacy row 2|ai|' || '2026-05-12T10:01:00Z'::timestamptz::text), ('00000000-0000-4000-8000-0000000000a3|00000000-0000-4000-8000-0000000000f2|system|sms|legacy row 3|system|' || '2026-05-12T10:02:00Z'::timestamptz::text)) v(x)), null
union all select 'legacy public.conversation_turns: RLS + both policies intact', (select relrowsecurity from pg_class where oid = 'public.conversation_turns'::regclass) and (select count(*) = 2 from pg_policies where schemaname = 'public' and tablename = 'conversation_turns'), null;
