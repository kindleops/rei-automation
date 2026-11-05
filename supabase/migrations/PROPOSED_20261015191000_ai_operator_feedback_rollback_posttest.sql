-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261015191000_ai_operator_feedback_rollback.sql.
-- DISPOSABLE DATABASE ONLY. Read-only.
\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public.ai_operator_feedback') is not null or to_regclass('public.ai_eval_sets') is not null
     or to_regprocedure('public.ai_feedback_immutable_guard()') is not null then
    raise exception 'rollback posttest(ai_operator_feedback): an object survived the rollback';
  end if;
  raise notice 'rollback posttest(ai_operator_feedback): clean';
end
$$;
