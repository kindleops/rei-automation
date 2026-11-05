-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261016120000_conversation_reply_turns.sql.
-- Drops exactly what the migration created, BY EXACT NAME (turn rows are discarded;
-- inbound_reply reservations a turn wrote into public.idempotency_ledger stay — they are ordinary
-- reservation rows the template engine / R3 executor read, and expire by retention).
--
-- It NEVER touches the unrelated LEGACY public.conversation_turns (phase-3, 10 columns, read by
-- conversationMemoryService.js): no statement here names it except the read-only catalog guards.
-- Guards: (1) public.conversation_reply_turns, when present, must carry the turn-engine shape
-- (turn_id / thread_key / turn_seq / version / claim_token / inbound_ids) or the rollback refuses;
-- (2) the legacy table's column set is recorded before the drops (a session setting) and
-- must be identical after them; (3) no CASCADE anywhere: a dependent object outside this
-- migration makes the drop fail instead of being dropped with it.
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261016120000_conversation_reply_turns_rollback.sql
-- DISPOSABLE DATABASE for testing (node scripts/db/run-migration-test.mjs --id conversation_reply_turns).
set local lock_timeout = '5s';

do $$
declare
  n integer;
begin
  if to_regclass('public.conversation_reply_turns') is not null then
    select count(*) into n from information_schema.columns
     where table_schema = 'public' and table_name = 'conversation_reply_turns'
       and column_name in ('turn_id', 'thread_key', 'turn_seq', 'version', 'claim_token', 'inbound_ids');
    if n <> 6 then
      raise exception 'rollback(conversation_reply_turns): public.conversation_reply_turns is not the turn-engine table (% of 6 marker columns) — refusing', n;
    end if;
  end if;
  perform set_config('lc.legacy_conversation_turns_shape',
    (select coalesce(string_agg(format('%s %s %s', column_name, data_type, is_nullable), ',' order by column_name collate "C"), '<absent>')
       from information_schema.columns where table_schema = 'public' and table_name = 'conversation_turns'),
    false);
end
$$;

drop function if exists agent.runtime_enqueue_event_at(text, text, jsonb, integer, timestamptz) restrict;
drop function if exists public.conversation_reply_turn_due(integer, integer) restrict;
drop function if exists public.conversation_reply_turn_reopen(uuid, text, timestamptz, jsonb) restrict;
drop function if exists public.conversation_reply_turn_cancel(text, text) restrict;
drop function if exists public.conversation_reply_turn_finalize(uuid, uuid, integer, text, jsonb, boolean, text) restrict;
drop function if exists public.conversation_reply_turn_claim(uuid, integer, text, integer) restrict;
drop function if exists public.conversation_reply_turn_open(text, text, timestamptz, timestamptz, jsonb, text, text) restrict;
drop table if exists public.conversation_reply_turns restrict;

do $$
declare
  before_shape text := current_setting('lc.legacy_conversation_turns_shape', true);
  after_shape text;
begin
  select coalesce(string_agg(format('%s %s %s', column_name, data_type, is_nullable), ',' order by column_name collate "C"), '<absent>') into after_shape
    from information_schema.columns where table_schema = 'public' and table_name = 'conversation_turns';
  if before_shape is null or after_shape is distinct from before_shape then
    raise exception 'rollback(conversation_reply_turns): the legacy public.conversation_turns changed (% -> %) — aborting', before_shape, after_shape;
  end if;
end
$$;
