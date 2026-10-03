-- SENDER ROUTING 2.0 — RETIRE +13057604780 (Miami, local-only). DRY-RUN-ONLY BY DEFAULT.
-- Owner-run. NOT executed by this build. NEVER a hard delete.
--
-- Evidence (2026-10-02): absent from the TextGrid inventory (API GET and the owner's
-- console paste, 17 numbers each); local row status 'paused', health 'unverified',
-- zero inbound, zero outbound, zero send_queue rows; provisioned 2026-09-10 by a
-- live test ("replacement for +17866052999"); its sibling +13058975670 IS on the provider.
--
-- Retired = status stays 'paused' (the CHECK allows only active|paused),
-- health_state 'disabled', metadata.lifecycle_state 'retired'. Both routers refuse it.
-- Usage: psql "$DB" -v actor="'owner@…'" -f retire-miami-3057604780.sql   (+ -v commit=owner_approved)

\set ON_ERROR_STOP on
\if :{?actor}
\else
  \echo 'set -v actor=...'
  \quit
\endif
\if :{?commit}
\else
  \set commit 'dry_run'
\endif

begin;
update public.textgrid_numbers
   set health_state = 'disabled', health_reason = 'retired_absent_from_provider', health_source = 'operator', health_changed_at = now(),
       metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('lifecycle_state', 'retired', 'retired_at', now(), 'retired_by', :actor,
                                                                          'retired_reason', 'absent_from_provider_inventory_2026-10-02')
 where phone_number = '+13057604780' and status = 'paused'
   and coalesce(metadata->>'lifecycle_state', '') <> 'retired';
set local sender_routing.actor = :actor;
do $$ begin
  if to_regclass('public.sender_pool_numbers') is not null then
    update public.sender_pool_numbers set status = 'inactive' where textgrid_number_id = (select id from public.textgrid_numbers where phone_number = '+13057604780');
    insert into public.sender_routing_audit (event_type, actor, reason, subject)
    values ('retirement', current_setting('sender_routing.actor', true), 'absent_from_provider_inventory_2026-10-02', '{"phone":"+13057604780"}'::jsonb);
  end if;
end $$;
select phone_number, status, health_state, metadata->>'lifecycle_state' as lifecycle from public.textgrid_numbers where phone_number = '+13057604780';
select :'commit' = 'owner_approved' as do_commit \gset
\if :do_commit
commit;
\else
\echo 'DRY RUN: rolled back. Pass -v commit=owner_approved to keep it.'
rollback;
\endif
