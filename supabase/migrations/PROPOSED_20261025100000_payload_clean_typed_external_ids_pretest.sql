-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261025100000_payload_clean_typed_external_ids.sql. Changes NOTHING; read-only prerequisite checks.
\set ON_ERROR_STOP on

do $$
begin
  if to_regprocedure('agent.payload_is_clean(jsonb)') is null then raise exception 'pretest(payload_clean_typed_external_ids): agent_s3_persistence is not applied'; end if;
  if obj_description('agent.payload_string_violation(text,text,integer)'::regprocedure, 'pg_proc') is distinct from 'payload_clean_opaque_ids@1' then
    raise exception 'pretest(payload_clean_typed_external_ids): #25 (payload_clean_opaque_ids@1) must be the live body';
  end if;
  if agent.payload_is_clean(jsonb_build_object('external_agent_id', 'agent_c382059173644fa1')) then
    raise exception 'pretest(payload_clean_typed_external_ids): the defect is not present (unexpected body)';
  end if;
  raise notice 'pretest(payload_clean_typed_external_ids): prerequisites OK';
end $$;
