\pset pager off
select r.rolcanlogin = false and r.rolbypassrls = false                                                                                                  as reader_role_safe,
       has_function_privilege('lc_mcp_reader', 'public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)', 'EXECUTE') as worklist,
       has_function_privilege('lc_mcp_reader', 'public.lc_mcp_lead_conversation(text,uuid,integer,timestamp with time zone,text,integer)', 'EXECUTE')    as conversation,
       has_function_privilege('lc_mcp_reader', 'public.lc_mcp_corpus_census(text)', 'EXECUTE')                                                          as census,
       has_function_privilege('lc_mcp_reader', 'public.lc_mcp_thread_contact_eligibility(uuid)', 'EXECUTE')                                             as acquisition_reads,
       not has_function_privilege('anon', 'public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)', 'EXECUTE')     as no_anon,
       pg_get_functiondef('public.lc_mcp_conversation_worklist(text,integer,text,timestamp with time zone,uuid,integer)'::regprocedure) ~ '36500'        as full_history
from pg_roles r where r.rolname = 'lc_mcp_reader';
begin;
set local role lc_mcp_reader;
select (w ->> 'total')::int as all_history_total, jsonb_array_length(w -> 'rows') as page_rows
  from public.lc_mcp_conversation_worklist('recent_inbound', 0, null, null, null, 25) w;
rollback;
