-- PRETEST for PROPOSED_20261030120000_lc_mcp_full_history.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production. Read-only; ends in ROLLBACK.
-- Asserts the prerequisites the apply relies on:
--   * lc_mcp_reader exists, and the two 1.1 functions exist with their 1.1 signatures
--     (PROPOSED_20261026120000_lc_mcp_conversation_intel.sql is applied);
--   * they still carry the 1.1 bounds (1..365 for the worklist, 1..1095 for the conversation): nothing redefined them.
begin;
do $$
declare problems text[] := '{}';
begin
  if not exists (select 1 from pg_roles where rolname = 'lc_mcp_reader') then problems := problems || 'lc_mcp_reader missing'::text; end if;
  if to_regprocedure('public.lc_mcp_conversation_worklist(text,integer,text,timestamptz,uuid,integer)') is null then problems := problems || 'lc_mcp_conversation_worklist (1.1) missing'::text;
  elsif position('window must be 1..365 days' in (select prosrc from pg_proc where oid = 'public.lc_mcp_conversation_worklist(text,integer,text,timestamptz,uuid,integer)'::regprocedure)) = 0 then
    problems := problems || 'lc_mcp_conversation_worklist is not the 1.1 definition'::text;
  end if;
  if to_regprocedure('public.lc_mcp_lead_conversation(text,uuid,integer,timestamptz,text,integer)') is null then problems := problems || 'lc_mcp_lead_conversation (1.1) missing'::text;
  elsif position('window must be 1..1095 days' in (select prosrc from pg_proc where oid = 'public.lc_mcp_lead_conversation(text,uuid,integer,timestamptz,text,integer)'::regprocedure)) = 0 then
    problems := problems || 'lc_mcp_lead_conversation is not the 1.1 definition'::text;
  end if;
  if cardinality(problems) > 0 then raise exception 'PRETEST FAILED: %', array_to_string(problems, '; '); end if;
  raise notice 'PRETEST OK: the 1.1 conversation reads are present with their bounds';
end $$;
rollback;
