-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261016155000_campaign_graph_prior_reply_not_owner.sql:
-- runs AFTER the runner applied the migration; every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id campaign_graph_prior_reply_not_owner
-- Expected last notice: "posttest(campaign_graph_prior_reply_not_owner): apply assertions OK".
\set ON_ERROR_STOP on
begin;
do $$
declare f text; r record; v text;
begin
  -- every queue_eligible / queue_block_reason writer reads the ONE helper
  foreach f in array array['refresh_campaign_target_graph_seller_batch','refresh_campaign_target_graph_fallback_batch',
                           'refresh_campaign_target_graph_stage_batch','refresh_campaign_target_graph_sender_coverage',
                           'campaign_target_graph_enrich_rows'] loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = f and pg_get_functiondef(p.oid) like '%campaign_target_graph_reply_block%') then
      raise exception 'assert: public.% must read campaign_target_graph_reply_block', f;
    end if;
  end loop;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'campaign_target_graph_reply_block' and (p.prosecdef or p.proconfig is not null or p.provolatile <> 's')) then
    raise exception 'assert: the helper is STABLE, SECURITY INVOKER and has no SET clause (inlinable)';
  end if;
  if has_function_privilege('anon', 'public.campaign_target_graph_reply_block(text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.campaign_target_graph_reply_block(text,text)', 'execute') then
    raise exception 'assert: anon / authenticated may not execute the helper';
  end if;
  if to_regclass('public.contact_property_resolution_phone_idx') is null then
    raise exception 'assert: phone index present';
  end if;

  -- fixture store rows (synthetic; no real phones)
  insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role, rejected_at, rejection_reason, suppression_scope) values
    ('P-DENIED', '+15550000001', 'not_owner',       now() - interval '90 days', 'not_owner',        'contact_property_pair'),
    ('P-SOLD',   '+15550000002', 'former_owner',    now() - interval '90 days', 'former_owner',     'contact_property_pair'),
    ('P-REF',    '+15550000003', 'referral_source', now() - interval '90 days', 'referral',         'contact_property_pair'),
    ('P-ANY',    '+15550000004', 'suppressed',      now() - interval '90 days', 'opt_out',          'channel_compliance'),
    ('P-OWNER',  '+15550000005', 'confirmed_owner', null,                       null,               'contact_property_pair'),
    ('P-UNREJ',  '+15550000006', 'not_owner',       null,                       null,               'contact_property_pair'),
    ('P-DECL',   '+15550000007', 'ownership_declined_unverified', null,         null,               'contact_property_pair');

  -- helper verdicts: pair scope, both phone formats, phone-wide opt-out, no false positives
  if public.campaign_target_graph_reply_block('P-DENIED', '+15550000001') is distinct from 'prior_reply_not_owner' then raise exception 'assert: E.164 pair denial'; end if;
  if public.campaign_target_graph_reply_block('P-DENIED', '5550000001') is distinct from 'prior_reply_not_owner' then raise exception 'assert: 10-digit graph phone matches'; end if;
  if public.campaign_target_graph_reply_block('P-OTHER', '5550000001') is not null then raise exception 'assert: a denial is PROPERTY-scoped — other property stays eligible'; end if;
  if public.campaign_target_graph_reply_block('P-DENIED', '5550000009') is not null then raise exception 'assert: another contact on the denied property stays eligible'; end if;
  if public.campaign_target_graph_reply_block('P-SOLD', '5550000002') is distinct from 'prior_reply_not_owner' then raise exception 'assert: former owner'; end if;
  if public.campaign_target_graph_reply_block('P-REF', '5550000003') is distinct from 'prior_reply_not_owner' then raise exception 'assert: referral source'; end if;
  if public.campaign_target_graph_reply_block('P-ELSEWHERE', '5550000004') is distinct from 'suppressed' then raise exception 'assert: channel-compliance opt-out is contact-wide'; end if;
  if public.campaign_target_graph_reply_block('P-OWNER', '5550000005') is not null then raise exception 'assert: a confirmed owner is not blocked'; end if;
  if public.campaign_target_graph_reply_block('P-UNREJ', '5550000006') is not null then raise exception 'assert: a not_owner role without rejected_at is not a recorded denial'; end if;
  if public.campaign_target_graph_reply_block('P-DENIED', null) is not null then raise exception 'assert: null phone'; end if;
  -- owner 2026-10-17: a polite decline (ownership UNVERIFIED) blocks THIS property for this phone, never others
  if public.campaign_target_graph_reply_block('P-DECL', '5550000007') is distinct from 'ownership_declined_unverified' then raise exception 'assert: declined-unverified hold blocks its property'; end if;
  if public.campaign_target_graph_reply_block('P-OTHER', '5550000007') is not null then raise exception 'assert: the declined hold is property-scoped'; end if;
  if public.campaign_target_graph_reply_block('P-DECL', '5550000009') is not null then raise exception 'assert: another contact on the declined property stays eligible'; end if;

  -- the post-commit recompute (sender coverage) honours the store: the verdict survives a refresh
  insert into public.campaign_target_graph (graph_id, property_id, canonical_e164, market, state, sms_eligible) values
    ('g-denied', 'P-DENIED', '5550000001', 'M', 'TX', true),
    ('g-other-prop', 'P-OTHER', '5550000001', 'M', 'TX', true),
    ('g-other-contact', 'P-DENIED', '5550000009', 'M', 'TX', true),
    ('g-optout', 'P-ELSEWHERE', '5550000004', 'M', 'TX', true),
    ('g-owner', 'P-OWNER', '5550000005', 'M', 'TX', true);
  perform * from public.refresh_campaign_target_graph_sender_coverage('posttest');
  for r in select graph_id, queue_eligible, queue_block_reason from public.campaign_target_graph order by graph_id loop
    v := case r.graph_id when 'g-denied' then 'prior_reply_not_owner' when 'g-optout' then 'suppressed' else null end;
    if r.queue_block_reason is distinct from v then raise exception 'assert: % block reason % (want %)', r.graph_id, r.queue_block_reason, v; end if;
    if r.queue_eligible is distinct from (v is null) then raise exception 'assert: % queue_eligible %', r.graph_id, r.queue_eligible; end if;
  end loop;

  -- precedence: an earlier operator-locked reason still wins (wrong_number before the reply block)
  update public.campaign_target_graph set wrong_number = true where graph_id = 'g-denied';
  perform * from public.refresh_campaign_target_graph_sender_coverage('posttest');
  if (select queue_block_reason from public.campaign_target_graph where graph_id = 'g-denied') <> 'wrong_number' then
    raise exception 'assert: wrong_number keeps precedence over prior_reply_not_owner';
  end if;
  raise notice 'posttest(campaign_graph_prior_reply_not_owner): apply assertions OK';
end $$;
rollback;
