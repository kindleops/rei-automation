-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261025100000_payload_clean_typed_external_ids_rollback.sql.
\set ON_ERROR_STOP on

do $$
begin
  assert obj_description('agent.payload_string_violation(text,text,integer)'::regprocedure, 'pg_proc') = 'payload_clean_opaque_ids@1', 'the #25 body is back';
  assert not agent.payload_is_clean(jsonb_build_object('external_agent_id', 'agent_c382059173644fa1')), 'the #25 behaviour is back';
  assert agent.payload_is_clean(jsonb_build_object('key', 'conv.84512937-4021-4abc-8123-456789012345')), '#25 kept';
  raise notice 'rollback_posttest(payload_clean_typed_external_ids): OK';
end $$;
