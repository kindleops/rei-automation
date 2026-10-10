-- PROPOSED — NOT APPLIED. OWNER GO REQUIRED (10-08 outbound policy).
--
-- Re-arm the no-response follow-ups that never fired (owner P0 2026-10-10).
-- Root cause: delivery-triggered-followup.js read the outbound use case from
-- message_events.metadata, which the send path never writes, and the
-- S2/offer no-response leg was gated on a system_control key that does not
-- exist (followup_no_response_mode) — so ZERO stage follow-ups were written.
--
-- Scope: threads whose LATEST outbound in the last 14 days is our S2 interest
-- question, our S3 asking-price question, or an offer; delivered; >= 24h old;
-- the seller had replied before it (a live conversation) and has not replied
-- since; no pending follow-up. One FU1 per thread (step 0). The chain continues
-- on its own after delivery once followup_no_response_mode = 'live'.
--
-- Respects: sms_suppression_list (active), automation_suppressions
-- (precautionary holds), inbox_thread_state.is_suppressed, contactability
-- blocks, disqualifying last intents (opt-out, wrong number/person, legal,
-- not-interested → those own a 30-day nurture), an explicit stop-contact request
-- in the seller's last message, terminal lifecycle stages, unknown language
-- (only English / Spanish — never English by default). ARCHIVE IS NOT A FILTER
-- (visibility only). Offers are re-armed with the NO-NUMBER copy only (never
-- re-quotes a number from SQL).
--
-- 10-08 policy: rows are written queue_status = 'held' (never 'scheduled'), so
-- NOTHING can send from step 2. Step 4 (separate owner GO) releases them in a
-- stagger — no overdue burst — and the queue processor still applies every
-- brake: 8am–9pm recipient-local window, suppression / four-truth final
-- dispatch gate, sender continuity (anchor sender kept), caps, template
-- authority (only approved sms_templates rows render; S3 / offer copy is
-- PROPOSED-inactive, so those rows park as paused_deferred_unresolved until the
-- owner approves the wording).
--
-- Run each step separately. Steps 1 and 3 are read-only.
--
-- DRY RUN 2026-10-10 (prod, read-only): s2_interest 27 · s3_asking_price 4 ·
-- offer 0 → 31 rows; 19 skipped for unknown language (12 S2, 6 S3, 1 offer);
-- 0 archived. (Broader "silent > 24h, no follow-up" count before the stricter
-- exclusions: S2 39 · S3 8 · S4 3 · offer 1.)

-- ═══ STEP 1 — DRY RUN (read-only): eligible count by stage ═══════════════════
-- \set ON_ERROR_STOP on
-- set statement_timeout = '15s';
with last_out as (
  select distinct on (me.thread_key)
         me.thread_key, me.id as anchor_event_id, me.queue_id, coalesce(me.sent_at, me.event_timestamp) as sent_at,
         me.delivery_status, me.message_body as body,
         sq.type as sq_type, lower(coalesce(sq.use_case_template, '')) as uc, coalesce(nullif(sq.language,''), sq.metadata->>'language', sq.metadata->'automation_provenance'->>'language', me.language) as anchor_language,
         sq.seller_first_name, sq.property_address, sq.property_id, sq.master_owner_id, sq.timezone, sq.market,
         sq.agent_name, sq.from_phone_number, sq.textgrid_number_id
    from public.message_events me
    left join public.send_queue sq on sq.id = me.queue_id
   where me.direction = 'outbound' and me.thread_key ~ '^\+1\d{10}$'
     and me.created_at > now() - interval '14 days'
   order by me.thread_key, coalesce(me.sent_at, me.event_timestamp) desc
), classified as (
  select lo.*,
    case
      when lo.sq_type = 'followup' then null
      when lo.uc in ('initial_offer','conditional_offer','counter_offer','final_offer','offer_reveal_cash','as_is_comp_anchor','price_anchor_above_max','comp_anchor')
        or (lo.body ~ '\$\s?\d' and lo.body ~* '(offer|i can do|i could do|we can do|we could do|cash|move forward at|pay you|oferta)') then 'offer'
      when lo.uc in ('seller_asking_price','asking_price_follow_up')
        or (lo.body like '%?%' and lo.body !~ '\$\s?\d|\d{1,3}(,\d{3})+'
            and lo.body ~* '(asking price|price in mind|number in mind|what price|precio)') then 's3_asking_price'
      when lo.uc in ('consider_selling','consider_selling_follow_up')
        or (lo.body like '%?%' and lo.body !~ '\$\s?\d|\d{1,3}(,\d{3})+'
            and lo.body ~* '(open to|consider|entertain|interested in).{0,40}(proposal|offer|sell)') then 's2_interest'
      else null
    end as kind
  from last_out lo
), facts as (
  select c.*,
    its.is_suppressed, its.is_archived, lower(coalesce(its.contactability_status, '')) as contact,
    lower(coalesce(its.last_intent, '')) as last_intent, lower(coalesce(its.lifecycle_stage, '')) as lifecycle_stage,
    (select i.message_body from public.message_events i
      where i.thread_key = c.thread_key and i.direction = 'inbound' and i.event_timestamp < c.sent_at
      order by i.event_timestamp desc limit 1) as last_seller_text,
    exists (select 1 from public.message_events i where i.thread_key = c.thread_key and i.direction = 'inbound' and i.event_timestamp >= c.sent_at) as replied_after,
    exists (select 1 from public.send_queue p where p.thread_key = c.thread_key and p.type = 'followup'
             and p.queue_status in ('scheduled','queued','held','processing','paused_operator_review','paused_deferred_unresolved')) as pending_fu,
    exists (select 1 from public.sms_suppression_list s where coalesce(s.is_active, true) and (s.phone_e164 = c.thread_key or s.phone_number = c.thread_key)) as on_supp_list,
    exists (select 1 from public.automation_suppressions a where a.phone_e164 = c.thread_key and a.status = 'active' and (a.expires_at is null or a.expires_at > now())) as precautionary_hold
  from classified c
  left join public.inbox_thread_state its on its.thread_key = c.thread_key
  where c.kind is not null
), eligible as (
  select f.*,
    case when f.kind = 'offer' then 'offer_no_response_no_number'
         when f.kind = 's3_asking_price' then 's3_no_response_fu1'
         else 's2_no_response_fu1' end as use_case,
    coalesce(nullif(f.anchor_language, ''), case when f.last_seller_text ~* '\m(si|sí|gracias|propiedad|casa|vender|precio|cuánto|cuanto)\M' then 'Spanish' end) as language
  from facts f
  where f.delivery_status in ('delivered','delivery_confirmed','confirmed')
    and f.sent_at < now() - interval '24 hours'
    and f.last_seller_text is not null                                  -- seller replied before the anchor
    and not f.replied_after
    and not f.pending_fu
    and not f.on_supp_list and not f.precautionary_hold and not coalesce(f.is_suppressed, false)
    and f.contact not in ('opted_out','dnc','do_not_text','invalid_number','provider_blacklisted','wrong_number','suppressed')
    and f.last_intent not in ('opt_out','wrong_number','wrong_person','hostile_or_legal','timing_complaint','not_interested','need_time',
                              'listed_or_unavailable','property_specific_non_owner','former_owner_respondent','non_owner_referral')
    and f.last_seller_text !~* '(do\s*n.?t|dont|stop|quit)\s+(call|text|contact|messag|bother|reach)|leave me alone|remove (me|my number)|take me off|no (me )?(llame|escriba|moleste|contacte)|deje de (llamar|escribir)'
    and f.lifecycle_stage not in ('closed','dead','closed_lost')
)
select kind as stage,
       count(*) filter (where language in ('English','Spanish')) as rearm_rows,
       count(*) filter (where language is null or language not in ('English','Spanish')) as skipped_unknown_language,
       count(*) filter (where is_archived and language in ('English','Spanish')) as of_which_archived
  from eligible group by 1 order by 1;

-- ═══ STEP 2 — WRITE (owner GO): stage FU1 rows as HELD ═══════════════════════
-- Re-run the CTEs above as the source (copy them in place of "eligible"), then:
--
-- begin;
-- set local lock_timeout = '5s';
-- set local statement_timeout = '30s';
-- with <the CTEs above>,
-- src as (
--   select e.*, 'seller_followup:' || e.thread_key || ':stage_no_reply:' || e.kind || ':' || e.anchor_event_id || ':0' as dedupe_key
--     from eligible e where e.language in ('English','Spanish')
-- )
-- insert into public.send_queue (
--   queue_key, queue_id, dedupe_key, thread_key, to_phone_number, from_phone_number, textgrid_number_id,
--   queue_status, type, message_type, message_body, use_case_template,
--   scheduled_for, scheduled_for_utc, scheduled_for_local,
--   master_owner_id, property_id, agent_name, seller_first_name, property_address, timezone, market, language, metadata
-- )
-- select 'followup:' || encode(extensions.digest(s.dedupe_key, 'sha1'), 'hex'),
--        'followup:' || encode(extensions.digest(s.dedupe_key, 'sha1'), 'hex'),
--        s.dedupe_key, s.thread_key, s.thread_key, s.from_phone_number, s.textgrid_number_id,
--        'held', 'followup', 'followup', '', s.use_case,
--        s.sent_at + interval '24 hours', s.sent_at + interval '24 hours', s.sent_at + interval '24 hours',
--        s.master_owner_id, s.property_id, s.agent_name, s.seller_first_name, s.property_address, s.timezone, s.market, s.language,
--        jsonb_build_object(
--          'deferred_message_resolution', true,
--          'source', 'no_response_followup',
--          'intent', 'stage_no_reply',
--          'followup_reason', 'stage_no_reply_followup:' || s.kind,
--          'stage', s.kind,
--          'stage_no_reply_hours', 24,
--          'followup_anchor_at', s.sent_at,
--          'followup_use_case', s.use_case,
--          'followup_dedupe_scope', s.kind || ':' || s.anchor_event_id || ':0',
--          'skip_email_lane', true,
--          'language', s.language,
--          'thread_key', s.thread_key,
--          'outbound_message_event_id', s.anchor_event_id,
--          'rearm', jsonb_build_object('batch', 'rearm_missed_followups_20261010', 'held_pending_owner_release', true),
--          'no_response_followup', jsonb_build_object(
--             'version', 'no_response_followup_v1_2026_10_06', 'kind', s.kind, 'step', 0, 'step_label', 'fu1',
--             'chain_root_id', s.anchor_event_id, 'anchor_message_event_id', s.anchor_event_id,
--             'anchor_at', s.sent_at, 'anchor_queue_row_id', s.queue_id, 'language', s.language,
--             'offer', case when s.kind = 'offer' then jsonb_build_object('mode', 'no_number', 'reason', 'rearm_sql_never_quotes') end)
--        )
--   from src s
--  where not exists (select 1 from public.send_queue q where q.dedupe_key = s.dedupe_key);
-- -- expect exactly the STEP 1 rearm_rows total; otherwise ROLLBACK
-- select metadata->>'stage' as stage, count(*) from public.send_queue
--  where metadata->'rearm'->>'batch' = 'rearm_missed_followups_20261010' group by 1;
-- commit;   -- or rollback;

-- ═══ STEP 3 — POSTCHECK (read-only) ══════════════════════════════════════════
-- select metadata->>'stage' stage, queue_status, language, count(*)
--   from public.send_queue where metadata->'rearm'->>'batch' = 'rearm_missed_followups_20261010'
--  group by 1, 2, 3 order by 1, 2, 3;

-- ═══ STEP 4 — RELEASE (separate owner GO; after the S3/offer copy decision) ══
-- Gate for the chain to continue (FU2 / nurture) after each delivery:
--   insert into public.system_control (key, value, updated_at) values ('followup_no_response_mode', 'live', now())
--   on conflict (key) do update set value = excluded.value, updated_at = now();
-- Staggered release — 2 minutes apart, never an overdue burst; the processor
-- still holds anything outside 8am–9pm recipient-local:
--   with r as (
--     select id, row_number() over (order by created_at, id) as n from public.send_queue
--      where metadata->'rearm'->>'batch' = 'rearm_missed_followups_20261010' and queue_status = 'held'
--   )
--   update public.send_queue q
--      set queue_status = 'scheduled',
--          scheduled_for = now() + (r.n * interval '2 minutes'),
--          scheduled_for_utc = now() + (r.n * interval '2 minutes'),
--          metadata = q.metadata || jsonb_build_object('rearm_released_at', now())
--     from r where q.id = r.id;
-- ROLLBACK (any time before release):
--   update public.send_queue set queue_status = 'cancelled', metadata = metadata || '{"rearm_rolled_back": true}'::jsonb
--    where metadata->'rearm'->>'batch' = 'rearm_missed_followups_20261010' and queue_status = 'held';
