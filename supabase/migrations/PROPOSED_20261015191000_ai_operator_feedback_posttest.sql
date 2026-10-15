-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261015191000_ai_operator_feedback.sql: append-only
-- behaviour, linkage, reviewer and masking CHECKs, eval-set immutability and access.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- No transaction control, no includes (rows stay in the disposable database).
-- Expected last notice: "posttest(ai_operator_feedback): all assertions OK".
\set ON_ERROR_STOP on

do $$
declare
  f1 uuid;
  n integer;
begin
  insert into public.ai_operator_feedback (kind, ai_message_id, thread_ref, draft_text_masked, model, cost_usd, idempotency_key)
  values ('draft_generated', 'aim-1', 'thr_abcdefghijkl', 'What would you need to get for it?', 'haiku', 0.0012, 'pt-feedback-1')
  returning feedback_id into f1;
  insert into public.ai_operator_feedback (kind, ai_message_id, operator_id, final_text_masked, note_masked, labels, idempotency_key)
  values ('draft_edited', 'aim-1', 'op-1', 'What price did you have in mind?', 'softer wording', '{"tone_match": 0}'::jsonb, 'pt-feedback-2');

  begin update public.ai_operator_feedback set note_masked = 'x' where feedback_id = f1; raise exception 'assert: feedback UPDATE must be refused'; exception when check_violation then null; end;
  begin delete from public.ai_operator_feedback where feedback_id = f1; raise exception 'assert: feedback DELETE must be refused'; exception when check_violation then null; end;
  begin truncate public.ai_operator_feedback; raise exception 'assert: feedback TRUNCATE must be refused'; exception when check_violation then null; end;
  begin
    insert into public.ai_operator_feedback (kind, idempotency_key) values ('draft_generated', 'pt-feedback-3');
    raise exception 'assert: an unlinked feedback row must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.ai_operator_feedback (kind, ai_message_id, idempotency_key) values ('draft_approved', 'aim-1', 'pt-feedback-4');
    raise exception 'assert: a review without an operator must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.ai_operator_feedback (kind, ai_message_id, operator_id, idempotency_key) values ('draft_edited', 'aim-1', 'op-1', 'pt-feedback-5');
    raise exception 'assert: an edit without the edited text must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.ai_operator_feedback (kind, decision_id, operator_id, note_masked, idempotency_key) values ('operator_note', 'dec-1', 'op-1', 'call him at 612-555-0147', 'pt-feedback-6');
    raise exception 'assert: an unmasked phone must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.ai_operator_feedback (kind, ai_message_id, idempotency_key) values ('draft_generated', 'aim-2', 'pt-feedback-1');
    raise exception 'assert: a duplicate idempotency key must be refused';
  exception when unique_violation then null; end;
  begin
    insert into public.ai_operator_feedback (kind, ai_message_id, idempotency_key) values ('auto_applied', 'aim-2', 'pt-feedback-7');
    raise exception 'assert: an unknown kind must be refused';
  exception when check_violation then null; end;
  select count(*) into n from public.ai_operator_feedback where ai_message_id = 'aim-1';
  if n <> 2 then raise exception 'assert: 2 feedback rows for aim-1 (got %)', n; end if;

  insert into public.ai_eval_sets (eval_set_id, name, version, builder_version, seed, holdout_fraction, item_count, manifest, content_hash, created_by)
  values ('evalset_seller_s3_v1', 'seller_s3', 1, 'ai-evalset.v1', 'seed-1', 0.2, 0, '{"items":[]}'::jsonb, repeat('cd', 32), 'op-1');
  begin
    insert into public.ai_eval_sets (eval_set_id, name, version, builder_version, seed, holdout_fraction, item_count, manifest, content_hash, created_by)
    values ('evalset_seller_s3_v1', 'seller_s3', 1, 'ai-evalset.v1', 'seed-2', 0.2, 0, '{"items":[]}'::jsonb, repeat('cd', 32), 'op-1');
    raise exception 'assert: a duplicate eval-set version must be refused';
  exception when unique_violation then null; end;
  begin
    insert into public.ai_eval_sets (eval_set_id, name, version, builder_version, seed, holdout_fraction, item_count, manifest, content_hash, created_by)
    values ('evalset_other_v2', 'seller_s3', 2, 'ai-evalset.v1', 'seed-2', 0.2, 0, '{"items":[]}'::jsonb, repeat('cd', 32), 'op-1');
    raise exception 'assert: an eval-set id must match name + version';
  exception when check_violation then null; end;
  begin update public.ai_eval_sets set seed = 'x' where eval_set_id = 'evalset_seller_s3_v1'; raise exception 'assert: eval-set UPDATE must be refused'; exception when check_violation then null; end;
  begin delete from public.ai_eval_sets where eval_set_id = 'evalset_seller_s3_v1'; raise exception 'assert: eval-set DELETE must be refused'; exception when check_violation then null; end;

  if exists (select 1 from pg_class where oid in ('public.ai_operator_feedback'::regclass, 'public.ai_eval_sets'::regclass) and not (relrowsecurity and relforcerowsecurity)) then
    raise exception 'assert: RLS enabled + forced';
  end if;
  if has_table_privilege('anon', 'public.ai_operator_feedback', 'select') or has_table_privilege('authenticated', 'public.ai_eval_sets', 'insert') then
    raise exception 'assert: anon / authenticated have no table privileges';
  end if;
  if has_table_privilege('service_role', 'public.ai_operator_feedback', 'update') or has_table_privilege('service_role', 'public.ai_eval_sets', 'delete') then
    raise exception 'assert: service_role is insert/select only';
  end if;
  raise notice 'posttest(ai_operator_feedback): all assertions OK';
end
$$;
