-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261019120000_payload_clean_opaque_ids.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY: never run against production.
-- No transaction control, no includes: read-only prerequisite checks.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id payload_clean_opaque_ids
-- Expected last notice: "pretest(payload_clean_opaque_ids): prerequisites OK".
\set ON_ERROR_STOP on

do $$
begin
  if to_regprocedure('agent.payload_string_violation(text,text,integer)') is null or to_regprocedure('agent.payload_is_clean(jsonb)') is null then
    raise exception 'pretest(payload_clean_opaque_ids): agent_s3_persistence is not applied';
  end if;
  if obj_description('agent.payload_string_violation(text,text,integer)'::regprocedure, 'pg_proc') is not distinct from 'payload_clean_opaque_ids@1' then
    raise exception 'pretest(payload_clean_opaque_ids): already applied';
  end if;
  -- the defect is present: the S3 body refuses this UUID token under a neutral key
  if agent.payload_is_clean(jsonb_build_object('key', 'conv.84512937-4021-4abc-8123-456789012345')) then
    raise exception 'pretest(payload_clean_opaque_ids): the live body is not the S3 body';
  end if;
  raise notice 'pretest(payload_clean_opaque_ids): prerequisites OK';
end $$;
