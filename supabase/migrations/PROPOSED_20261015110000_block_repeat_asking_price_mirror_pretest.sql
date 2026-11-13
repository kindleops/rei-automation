-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261015110000_block_repeat_asking_price_mirror.sql.
-- DISPOSABLE DATABASE ONLY (owner testing boundary 2026-10-15: never run migration /
-- rollback / pretest SQL against production). The runner restores the live send_queue
-- baseline (scripts/db/fixtures/send_queue_live_baseline.sql) and runs this before and after
-- the mirror is applied: the function body and the trigger definition must equal the live
-- definitions recorded below (md5 read 2026-10-14, BEGIN READ ONLY catalog query).
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id block_repeat_asking_price_mirror
-- No transaction control, no includes.
-- Expected last notice: "pretest(block_repeat_asking_price_mirror): ALL OK".
do $$
declare
  v_md5 text;
  v_trg text;
begin
  select md5(prosrc) into v_md5 from pg_proc where oid = to_regproc('public.block_repeat_asking_price');
  if v_md5 is null then raise exception 'pretest: public.block_repeat_asking_price() is absent — the mirror would CREATE it (owner decision)'; end if;
  if v_md5 <> '06b3a9f70fd9d823e15bcdd81816659e' then raise exception 'pretest: live function body differs from the repo mirror (md5 %)', v_md5; end if;
  select pg_get_triggerdef(t.oid) into v_trg from pg_trigger t where t.tgrelid = 'public.send_queue'::regclass and t.tgname = 'trg_block_repeat_asking_price' and not t.tgisinternal;
  if v_trg is null then raise exception 'pretest: trigger trg_block_repeat_asking_price absent'; end if;
  if v_trg <> 'CREATE TRIGGER trg_block_repeat_asking_price BEFORE INSERT OR UPDATE OF queue_status, use_case_template, scheduled_for_utc ON public.send_queue FOR EACH ROW EXECUTE FUNCTION block_repeat_asking_price()' then
    raise exception 'pretest: live trigger definition differs: %', v_trg;
  end if;
  raise notice 'pretest(block_repeat_asking_price_mirror): ALL OK';
end
$$;
