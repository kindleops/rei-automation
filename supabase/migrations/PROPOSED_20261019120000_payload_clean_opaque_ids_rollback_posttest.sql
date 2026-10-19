-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261019120000_payload_clean_opaque_ids_rollback.sql. Read-only.
\set ON_ERROR_STOP on

do $$
begin
  if obj_description('agent.payload_string_violation(text,text,integer)'::regprocedure, 'pg_proc') is not null then
    raise exception 'rollback posttest(payload_clean_opaque_ids): marker comment not removed';
  end if;
  if position('s_ids' in pg_get_functiondef('agent.payload_string_violation(text,text,integer)'::regprocedure)) > 0 then
    raise exception 'rollback posttest(payload_clean_opaque_ids): the S3 body is not restored';
  end if;
  if agent.payload_is_clean(jsonb_build_object('key', 'conv.84512937-4021-4abc-8123-456789012345')) then
    raise exception 'rollback posttest(payload_clean_opaque_ids): the S3 behaviour is not restored';
  end if;
  raise notice 'rollback posttest(payload_clean_opaque_ids): all assertions OK';
end $$;
