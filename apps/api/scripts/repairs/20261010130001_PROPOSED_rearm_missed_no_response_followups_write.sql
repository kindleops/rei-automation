-- PROPOSED — NOT APPLIED. STEP 2 of 20261010130000_PROPOSED_rearm_missed_no_response_followups.sql
-- Writes HELD rows only (nothing sends). Owner GO required. Ends in ROLLBACK by default: change to COMMIT after checking the count equals the STEP 1 dry run.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
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
),
src as (
  select e.*, 'seller_followup:' || e.thread_key || ':stage_no_reply:' || e.kind || ':' || e.anchor_event_id || ':0' as dedupe_key
    from eligible e where e.language in ('English','Spanish')
)
insert into public.send_queue (
  queue_key, queue_id, dedupe_key, thread_key, to_phone_number, from_phone_number, textgrid_number_id,
  queue_status, type, message_type, message_body, use_case_template,
  scheduled_for, scheduled_for_utc, scheduled_for_local,
  master_owner_id, property_id, agent_name, seller_first_name, property_address, timezone, market, language, metadata
)
select 'followup:' || encode(extensions.digest(s.dedupe_key, 'sha1'), 'hex'),
       'followup:' || encode(extensions.digest(s.dedupe_key, 'sha1'), 'hex'),
       s.dedupe_key, s.thread_key, s.thread_key, s.from_phone_number, s.textgrid_number_id,
       'held', 'followup', 'followup', '', s.use_case,
       s.sent_at + interval '24 hours', s.sent_at + interval '24 hours', s.sent_at + interval '24 hours',
       s.master_owner_id, s.property_id, s.agent_name, s.seller_first_name, s.property_address, s.timezone, s.market, s.language,
       jsonb_build_object(
         'deferred_message_resolution', true,
         'source', 'no_response_followup',
         'intent', 'stage_no_reply',
         'followup_reason', 'stage_no_reply_followup:' || s.kind,
         'stage', s.kind,
         'stage_no_reply_hours', 24,
         'followup_anchor_at', s.sent_at,
         'followup_use_case', s.use_case,
         'followup_dedupe_scope', s.kind || ':' || s.anchor_event_id || ':0',
         'skip_email_lane', true,
         'language', s.language,
         'thread_key', s.thread_key,
         'outbound_message_event_id', s.anchor_event_id,
         'rearm', jsonb_build_object('batch', 'rearm_missed_followups_20261010', 'held_pending_owner_release', true),
         'no_response_followup', jsonb_build_object(
            'version', 'no_response_followup_v1_2026_10_06', 'kind', s.kind, 'step', 0, 'step_label', 'fu1',
            'chain_root_id', s.anchor_event_id, 'anchor_message_event_id', s.anchor_event_id,
            'anchor_at', s.sent_at, 'anchor_queue_row_id', s.queue_id, 'language', s.language,
            'offer', case when s.kind = 'offer' then jsonb_build_object('mode', 'no_number', 'reason', 'rearm_sql_never_quotes') end)
       )
  from src s
 where not exists (select 1 from public.send_queue q where q.dedupe_key = s.dedupe_key);
;
select metadata->>'stage' as stage, language, count(*) from public.send_queue where metadata->'rearm'->>'batch' = 'rearm_missed_followups_20261010' group by 1, 2 order by 1, 2;
rollback;  -- COMMIT only after the owner checks the counts
