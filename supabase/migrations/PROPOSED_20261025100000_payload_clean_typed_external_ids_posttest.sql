-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261025100000_payload_clean_typed_external_ids.sql. Changes NOTHING.
\set ON_ERROR_STOP on

do $$
begin
  assert obj_description('agent.payload_string_violation(text,text,integer)'::regprocedure, 'pg_proc') = 'payload_clean_typed_external_ids@1', 'the live body';
  -- typed ids in the generator shape: clean
  assert agent.payload_is_clean(jsonb_build_object('external_agent_id', 'agent_c382059173644fa1')), 'sample agent id';
  assert agent.payload_is_clean(jsonb_build_object('external_agent_id', 'agent_1234567890124abc')), 'a 12-digit run in the generator shape';
  assert agent.payload_is_clean(jsonb_build_object('external_install_id', 'agntei_inst_12345678901234567890123456789012')), 'an all-digit install id';
  assert agent.payload_is_clean(jsonb_build_object('args', jsonb_build_object('external_agent_id', 'agent_c382059173644fa1'))), 'nested under its typed key';
  -- everything else unchanged
  assert not agent.payload_is_clean(jsonb_build_object('note', 'agent_c382059173644fa1')), 'free-form key';
  assert not agent.payload_is_clean(jsonb_build_object('external_agent_id', '+16125550147')), 'E.164 under the typed key';
  assert not agent.payload_is_clean(jsonb_build_object('external_agent_id', '612-555-0147')), 'NANP under the typed key';
  assert not agent.payload_is_clean(jsonb_build_object('external_agent_id', 'agent_6125550147')), 'short shape';
  assert not agent.payload_is_clean(jsonb_build_object('external_agent_id', 'agent_72a1760136105eb4')), 'version nibble not 4';
  assert not agent.payload_is_clean(jsonb_build_object('external_agent_id', 'agent_c382059173644fa1 612-555-0147')), 'trailing phone';
  assert not agent.payload_is_clean(jsonb_build_object('external_agent_id', 'rosa@example.com')), 'email';
  assert not agent.payload_is_clean(jsonb_build_object('external_install_id', 'agntei_inst_6125550147')), 'short install id';
  assert not agent.payload_is_clean(jsonb_build_object('external_agent_id_note', 'agent_c382059173644fa1')), 'a key that only starts like the typed key';
  assert not agent.payload_is_clean('{"x":"612-555-0147"}'), 'a phone';
  assert agent.payload_is_clean(jsonb_build_object('key', 'conv.84512937-4021-4abc-8123-456789012345')), '#25 kept';
  raise notice 'posttest(payload_clean_typed_external_ids): OK';
end $$;
