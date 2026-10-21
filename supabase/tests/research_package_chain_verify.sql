-- lc-fixture: verify
-- PROPOSED ONLY — READ-ONLY verification of the Package A research chain (hotfix/research-runtime):
-- every object it ships exists exactly once, the event enqueue reads the ceiling, and NOTHING outside the
-- package exists (no reply-turn / follow-up / conversation-AI / negotiation / ZIP / holds objects, no
-- trigger on public.send_queue, no public object at all). Runs after apply AND after the re-apply.
-- Every row must say ok = true. Selects only. DISPOSABLE DATABASE ONLY.
select 'capabilities: agent.approval_request + agent.capability_audit' as check, (to_regclass('agent.approval_request') is not null and to_regclass('agent.capability_audit') is not null) as ok, null::text as detail
union all select 'kind limits: event_budget_cap_usd accepted', agent.runtime_kind_limits_valid('{"property.research":{"enabled":false,"max_concurrency":1,"armed_by":"00000000-0000-4000-8000-000000000001","event_budget_cap_usd":0.30}}'::jsonb), null
union all select 'missions: max_concurrency 3 accepted', agent.runtime_kind_limits_valid('{"recovery.sweep":{"enabled":false,"max_concurrency":3}}'::jsonb), null
union all select 'missions: indexes', (to_regclass('agent.research_job_requested_recent_idx') is not null and to_regclass('agent.finding_type_key_job_idx') is not null), null
union all select 'operations: action state + work items + 4 read functions', (to_regclass('agent.conversation_action_state') is not null and to_regclass('agent.ops_work_item') is not null
        and to_regprocedure('agent.ops_conversation_facts(timestamptz,uuid,integer)') is not null and to_regprocedure('agent.ops_pipeline_facts(uuid,integer)') is not null
        and to_regprocedure('agent.ops_supervisor_snapshot(timestamptz)') is not null and to_regprocedure('agent.ops_brief_facts(timestamptz,timestamptz)') is not null), null
union all select 'ceilings: column + function, default {}', (select event_budget_ceilings = '{}'::jsonb from agent.runtime_limits where id = 1) and to_regprocedure('agent.runtime_event_budget_ceiling(text)') is not null, null
union all select 'ceilings: one runtime_enqueue_event overload reading the ceiling', (select count(*) = 1 from pg_proc where pronamespace = 'agent'::regnamespace and proname = 'runtime_enqueue_event')
        and position('runtime_event_budget_ceiling(p_kind)' in pg_get_functiondef('agent.runtime_enqueue_event(text,text,jsonb,integer)'::regprocedure)) > 0, null
union all select 'not in package: runtime_enqueue_event_at', to_regprocedure('agent.runtime_enqueue_event_at(text,text,jsonb,integer,timestamptz)') is null, null
union all select 'not in package: agent.ops_research_valuation_snapshot', to_regprocedure('agent.ops_research_valuation_snapshot(timestamptz)') is null, null
union all select 'not in package: no public object created by the chain (reply turns, follow-up intents, holds, conversation AI, negotiation, ZIP)',
        (select count(*) = 0 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
          and c.relname ~ '^(conversation_reply_turns|followup_intents|automation_holds|conversation_ai_|negotiation_|zip_|acquisition_outcomes|ai_operator_feedback)'), null
union all select 'not in package: no trigger on public.send_queue', (select count(*) = 0 from pg_trigger t where t.tgrelid = to_regclass('public.send_queue') and not t.tgisinternal), null
union all select 'agent functions write no public table (no INSERT/UPDATE/DELETE on public.* in any agent.* body)',
        (select count(*) = 0 from pg_proc p where p.pronamespace = 'agent'::regnamespace
          and pg_get_functiondef(p.oid) ~* '(insert\s+into|update|delete\s+from)\s+public\.'), null
union all select 'runtime switches untouched by the chain: one runtime_limits row', (select count(*) = 1 from agent.runtime_limits), null;
