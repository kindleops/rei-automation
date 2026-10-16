-- lc-fixture: setup
-- DISPOSABLE DATABASE ONLY. Model of the LEGACY production table public.conversation_turns
-- (apps/api/supabase/migrations/20260510000000_phase3_nexus_architecture.sql; 10 columns, 104 rows
-- written 2026-05-12; read by apps/api/src/lib/automation/conversationMemoryService.js; listed in
-- 20261003130000_operator_lockdown.sql). It is NOT the rc-8.5.20 turn engine table
-- (public.conversation_reply_turns). It exists here only so the conversation_reply_turns tests
-- and the rc_8_5_20_release_chain prove the migration, its rollback and the re-apply never touch
-- it: same 10 columns, same indexes / RLS / policies, three rows. No FK (conversation_threads is
-- not part of these tests).
-- Applied by scripts/db/run-migration-test.mjs (and the PG tests) as setup; never against Supabase.
create extension if not exists pgcrypto;

create table if not exists public.conversation_turns (
  id               uuid primary key default gen_random_uuid(),
  thread_id        uuid not null,
  direction        varchar(20) not null,
  channel          varchar(50) not null,
  content          text,
  intent_detected  varchar(100),
  confidence_score double precision,
  handled_by       varchar(50) not null default 'ai',
  created_at       timestamptz default now(),
  metadata         jsonb default '{}'::jsonb
);
create index if not exists idx_conv_turns_thread_id on public.conversation_turns (thread_id);
create index if not exists idx_conv_turns_created_at on public.conversation_turns (created_at);
alter table public.conversation_turns enable row level security;
drop policy if exists "Allow service role full access on turns" on public.conversation_turns;
create policy "Allow service role full access on turns" on public.conversation_turns for all using (true);
drop policy if exists "Allow authenticated read on turns" on public.conversation_turns;
create policy "Allow authenticated read on turns" on public.conversation_turns for select to authenticated using (true);

insert into public.conversation_turns (id, thread_id, direction, channel, content, handled_by, created_at)
values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000f1', 'inbound', 'sms', 'legacy row 1', 'ai', '2026-05-12T10:00:00Z'),
       ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000f1', 'outbound', 'sms', 'legacy row 2', 'ai', '2026-05-12T10:01:00Z'),
       ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-0000000000f2', 'system', 'sms', 'legacy row 3', 'system', '2026-05-12T10:02:00Z')
on conflict (id) do nothing;
