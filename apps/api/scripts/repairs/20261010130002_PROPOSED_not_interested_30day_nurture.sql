-- PROPOSED — NOT APPLIED. OWNER GO REQUIRED (10-08 outbound policy).
--
-- Every NOT-INTERESTED seller on the 30-day drip (owner, 2026-10-10;
-- "A not interested is a 30 day follow up"). Scope: the open pipeline deals the
-- owner approved archiving (classifier /tmp/rc847v/pipe_v2.sql, same classes,
-- rewritten as read-only CTEs). Archive is visibility only — it never stops
-- the drip, so this is independent of the archive action.
--
-- Rules: suppression wins; wrong number / opt-out / STOP / stop-contact
-- requests / non-owner / sold never get dripped; only threads whose seller said
-- not_interested and that have NO pending follow-up get a row. Rows are
-- queue_status = 'held' (nothing sends); scheduled_for = not-interested reply
-- + 30 days (or now when that is past). Dispatch resolves the approved
-- nurture copy (consider_selling_follow_up / not_ready rows), render context
-- and the 8am–9pm recipient-local window at send time.
--
-- DRY RUN 2026-10-10 (prod, read-only), class 4 "negative" = 162:
--   WILL GET 30-day nurture                          47
--   already has nurture (future follow-up)           68
--   excluded: wrong number / non-owner               26
--   excluded: opt-out / STOP / stop-contact request  21
-- class 3 "noise" = 39: 15 suppressed · 4 wrong number / non-owner · 6 already
--   have a follow-up · 14 silence-cadence candidates (only 4 have a recent S2
--   question → covered by 20261010130000 if they pass its gates; 10 are S1 /
--   check-in / stale / failed → not eligible).
-- class 5 "no reply" = 19: S1 cold — no automated S1 cadence (campaign-owned).

-- ═══ STEP 1 — DRY RUN (read-only) ═══════════════════════════════════════════
with opp as (
  select o.id, o.primary_thread_key tk, o.opportunity_status st, o.acquisition_stage stage
    from acquisition_opportunities o join inbox_thread_state t on t.thread_key=o.primary_thread_key
   where o.opportunity_status in ('active','nurture','waiting','paused') and coalesce(t.is_archived,false)=false
), ev as (
  select opp.id,
    count(m.*) filter (where m.direction='inbound') n_in,
    bool_or(m.direction='inbound' and (
       m.detected_intent in ('seller_interested','asks_offer','offer_request','price_anchor','asking_price','asking_price_provided','counter_offer','potential_interest','condition_disclosed','open_to_offer','needs_time','maybe','callback_requested','ready_to_proceed','price_or_counter','seller_chasing','proposal_request','interested','considering')
       or m.message_body ~* '(\$\s?\d|\d{2,3}\s?k\b|\d{3},\d{3}|\bmillion\b|\bsell\b|\bselling\b|\boffer\b|\bprice\b|how much|make me|interested|\bmaybe\b|depends|\bcash\b|\bvender\b|\bvendo\b|precio|oferta|call me|give me a call|what.?s your|max you|\bsure\b|consider|tal vez|cu[aá]nto|mill[oó]n|propuesta|proposal|open to|let.?s talk|\bdepende)'
    )) motivated,
    bool_or(m.direction='inbound' and m.detected_intent in ('not_interested','wrong_number','opt_out','hostile_or_troll','not_owner','non_owner_referral','sold')) negative,
    bool_or(m.direction='inbound' and m.detected_intent in ('wrong_number','not_owner','non_owner_referral','property_specific_non_owner','former_owner_respondent','wrong_person')) neg_wrong,
    bool_or(m.direction='inbound' and (m.detected_intent='opt_out' or m.message_body ~* '^\s*(stop|unsubscribe|stopall|cancel|end|quit)\s*$' or m.message_body ~* '(do\s*n.?t|dont|stop|quit)\s+(call|text|contact|messag|bother|reach)|leave me alone|remove (me|my number)|take me off|no (me )?(llame|escriba|moleste|contacte)')) neg_optout,
    bool_or(m.direction='inbound' and m.detected_intent='sold') neg_sold,
    bool_or(m.direction='inbound' and m.detected_intent='hostile_or_troll') neg_hostile,
    bool_or(m.direction='inbound' and m.detected_intent='not_interested') neg_not_interested,
    max(m.event_timestamp) filter (where m.direction='inbound' and m.detected_intent='not_interested') last_ni_at
  from opp left join message_events m on m.thread_key=opp.tk group by opp.id
), own as (
  select opp.id,
   bool_or(m.direction='inbound' and m.detected_intent='ownership_confirmed') owner_yes,
   bool_or(m.direction='inbound' and m.message_body ~* '(listed|realtor|\bsold\b|don.?t own|never owned|not for sale|no est[aá] en venta|isn.?t for sell|not selling|\bstop\b|molestar|fuck|\bgfy\b|lmtfa|border hopper|i said no)') noise
  from opp join message_events m on m.thread_key=opp.tk group by opp.id
), cls as (
  select opp.*, ev.n_in, ev.motivated, ev.negative, ev.neg_wrong, ev.neg_optout, ev.neg_sold, ev.neg_hostile, ev.neg_not_interested, ev.last_ni_at, own.owner_yes, own.noise,
    case when ev.motivated then '1 KEEP motivated/price'
         when own.owner_yes and not coalesce(own.noise,false) and not ev.negative then '2 KEEP owner confirmed'
         when ev.n_in=0 then '5 REMOVE no reply'
         when ev.negative then '4 REMOVE negative'
         else '3 REMOVE noise' end cls
  from opp join ev using (id) left join own using (id)
), st as (
  select c.*,
    its.is_suppressed, lower(coalesce(its.contactability_status,'')) contact, lower(coalesce(its.last_intent,'')) last_intent,
    exists (select 1 from sms_suppression_list s where coalesce(s.is_active,true) and (s.phone_e164=c.tk or s.phone_number=c.tk)) on_supp,
    exists (select 1 from automation_suppressions a where a.phone_e164=c.tk and a.status='active' and (a.expires_at is null or a.expires_at>now())) precaution,
    exists (select 1 from send_queue q where q.thread_key=c.tk and q.type='followup' and q.queue_status in ('scheduled','queued','held','processing') and coalesce(q.scheduled_for_utc,q.scheduled_for) > now()) has_future_fu,
    exists (select 1 from send_queue q where q.thread_key=c.tk and q.type='followup' and q.queue_status in ('scheduled','queued','held','paused_operator_review','paused_deferred_unresolved')) has_pending_fu
  from cls c left join inbox_thread_state its on its.thread_key=c.tk
), verdict as (
  select st.*,
    (on_supp or precaution or coalesce(is_suppressed,false) or contact in ('opted_out','dnc','do_not_text','invalid_number','provider_blacklisted','wrong_number','suppressed')) suppressed_any,
    case
      when cls in ('1 KEEP motivated/price','2 KEEP owner confirmed') then 'n/a (kept deal)'
      when neg_optout then 'excluded: opt-out / STOP / stop-contact request'
      when neg_wrong then 'excluded: wrong number / non-owner'
      when on_supp or precaution or coalesce(is_suppressed,false) or contact in ('opted_out','dnc','do_not_text','invalid_number','provider_blacklisted','wrong_number','suppressed') then 'excluded: suppressed (suppression wins)'
      when neg_sold then 'excluded: sold / former owner'
      when cls='4 REMOVE negative' and neg_not_interested and has_future_fu then 'already has nurture (future follow-up)'
      when cls='4 REMOVE negative' and neg_not_interested and has_pending_fu then 'already has follow-up (pending, not future-dated)'
      when cls='4 REMOVE negative' and neg_not_interested then 'WILL GET 30-day nurture'
      when cls='4 REMOVE negative' and neg_hostile then 'excluded: hostile / troll only (owner rule: quiet archive, no reply)'
      when cls='4 REMOVE negative' then 'excluded: other negative'
      when has_future_fu or has_pending_fu then 'already has follow-up'
      when cls='5 REMOVE no reply' then 'silence cadence: S1 cold — no automated S1 cadence (campaign-owned)'
      else 'silence cadence: see no-response re-arm (eligible only if last outbound is S2/S3/offer <= 14d)'
    end verdict
  from st
)
select cls, verdict, count(*) from verdict group by 1,2 order by 1,2;

-- ═══ STEP 2 — WRITE (owner GO): HELD nurture rows; ROLLBACK by default ══════
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
with opp as (
  select o.id, o.primary_thread_key tk, o.opportunity_status st, o.acquisition_stage stage
    from acquisition_opportunities o join inbox_thread_state t on t.thread_key=o.primary_thread_key
   where o.opportunity_status in ('active','nurture','waiting','paused') and coalesce(t.is_archived,false)=false
), ev as (
  select opp.id,
    count(m.*) filter (where m.direction='inbound') n_in,
    bool_or(m.direction='inbound' and (
       m.detected_intent in ('seller_interested','asks_offer','offer_request','price_anchor','asking_price','asking_price_provided','counter_offer','potential_interest','condition_disclosed','open_to_offer','needs_time','maybe','callback_requested','ready_to_proceed','price_or_counter','seller_chasing','proposal_request','interested','considering')
       or m.message_body ~* '(\$\s?\d|\d{2,3}\s?k\b|\d{3},\d{3}|\bmillion\b|\bsell\b|\bselling\b|\boffer\b|\bprice\b|how much|make me|interested|\bmaybe\b|depends|\bcash\b|\bvender\b|\bvendo\b|precio|oferta|call me|give me a call|what.?s your|max you|\bsure\b|consider|tal vez|cu[aá]nto|mill[oó]n|propuesta|proposal|open to|let.?s talk|\bdepende)'
    )) motivated,
    bool_or(m.direction='inbound' and m.detected_intent in ('not_interested','wrong_number','opt_out','hostile_or_troll','not_owner','non_owner_referral','sold')) negative,
    bool_or(m.direction='inbound' and m.detected_intent in ('wrong_number','not_owner','non_owner_referral','property_specific_non_owner','former_owner_respondent','wrong_person')) neg_wrong,
    bool_or(m.direction='inbound' and (m.detected_intent='opt_out' or m.message_body ~* '^\s*(stop|unsubscribe|stopall|cancel|end|quit)\s*$' or m.message_body ~* '(do\s*n.?t|dont|stop|quit)\s+(call|text|contact|messag|bother|reach)|leave me alone|remove (me|my number)|take me off|no (me )?(llame|escriba|moleste|contacte)')) neg_optout,
    bool_or(m.direction='inbound' and m.detected_intent='sold') neg_sold,
    bool_or(m.direction='inbound' and m.detected_intent='hostile_or_troll') neg_hostile,
    bool_or(m.direction='inbound' and m.detected_intent='not_interested') neg_not_interested,
    max(m.event_timestamp) filter (where m.direction='inbound' and m.detected_intent='not_interested') last_ni_at
  from opp left join message_events m on m.thread_key=opp.tk group by opp.id
), own as (
  select opp.id,
   bool_or(m.direction='inbound' and m.detected_intent='ownership_confirmed') owner_yes,
   bool_or(m.direction='inbound' and m.message_body ~* '(listed|realtor|\bsold\b|don.?t own|never owned|not for sale|no est[aá] en venta|isn.?t for sell|not selling|\bstop\b|molestar|fuck|\bgfy\b|lmtfa|border hopper|i said no)') noise
  from opp join message_events m on m.thread_key=opp.tk group by opp.id
), cls as (
  select opp.*, ev.n_in, ev.motivated, ev.negative, ev.neg_wrong, ev.neg_optout, ev.neg_sold, ev.neg_hostile, ev.neg_not_interested, ev.last_ni_at, own.owner_yes, own.noise,
    case when ev.motivated then '1 KEEP motivated/price'
         when own.owner_yes and not coalesce(own.noise,false) and not ev.negative then '2 KEEP owner confirmed'
         when ev.n_in=0 then '5 REMOVE no reply'
         when ev.negative then '4 REMOVE negative'
         else '3 REMOVE noise' end cls
  from opp join ev using (id) left join own using (id)
), st as (
  select c.*,
    its.is_suppressed, lower(coalesce(its.contactability_status,'')) contact, lower(coalesce(its.last_intent,'')) last_intent,
    exists (select 1 from sms_suppression_list s where coalesce(s.is_active,true) and (s.phone_e164=c.tk or s.phone_number=c.tk)) on_supp,
    exists (select 1 from automation_suppressions a where a.phone_e164=c.tk and a.status='active' and (a.expires_at is null or a.expires_at>now())) precaution,
    exists (select 1 from send_queue q where q.thread_key=c.tk and q.type='followup' and q.queue_status in ('scheduled','queued','held','processing') and coalesce(q.scheduled_for_utc,q.scheduled_for) > now()) has_future_fu,
    exists (select 1 from send_queue q where q.thread_key=c.tk and q.type='followup' and q.queue_status in ('scheduled','queued','held','paused_operator_review','paused_deferred_unresolved')) has_pending_fu
  from cls c left join inbox_thread_state its on its.thread_key=c.tk
), verdict as (
  select st.*,
    (on_supp or precaution or coalesce(is_suppressed,false) or contact in ('opted_out','dnc','do_not_text','invalid_number','provider_blacklisted','wrong_number','suppressed')) suppressed_any,
    case
      when cls in ('1 KEEP motivated/price','2 KEEP owner confirmed') then 'n/a (kept deal)'
      when neg_optout then 'excluded: opt-out / STOP / stop-contact request'
      when neg_wrong then 'excluded: wrong number / non-owner'
      when on_supp or precaution or coalesce(is_suppressed,false) or contact in ('opted_out','dnc','do_not_text','invalid_number','provider_blacklisted','wrong_number','suppressed') then 'excluded: suppressed (suppression wins)'
      when neg_sold then 'excluded: sold / former owner'
      when cls='4 REMOVE negative' and neg_not_interested and has_future_fu then 'already has nurture (future follow-up)'
      when cls='4 REMOVE negative' and neg_not_interested and has_pending_fu then 'already has follow-up (pending, not future-dated)'
      when cls='4 REMOVE negative' and neg_not_interested then 'WILL GET 30-day nurture'
      when cls='4 REMOVE negative' and neg_hostile then 'excluded: hostile / troll only (owner rule: quiet archive, no reply)'
      when cls='4 REMOVE negative' then 'excluded: other negative'
      when has_future_fu or has_pending_fu then 'already has follow-up'
      when cls='5 REMOVE no reply' then 'silence cadence: S1 cold — no automated S1 cadence (campaign-owned)'
      else 'silence cadence: see no-response re-arm (eligible only if last outbound is S2/S3/offer <= 14d)'
    end verdict
  from st
),
src as (
  select v.*, its.master_owner_id as its_owner, its.property_id as its_property,
         'seller_followup:' || v.tk || ':not_interested:cycle:rearm_20261010' as dedupe_key
    from verdict v left join inbox_thread_state its on its.thread_key = v.tk
   where v.verdict = 'WILL GET 30-day nurture' and v.tk ~ '^\+1\d{10}$'
)
insert into public.send_queue (
  queue_key, queue_id, dedupe_key, thread_key, to_phone_number, queue_status, type, message_type, message_body,
  use_case_template, scheduled_for, scheduled_for_utc, scheduled_for_local, master_owner_id, property_id, metadata
)
select 'followup:' || encode(extensions.digest(s.dedupe_key, 'sha1'), 'hex'),
       'followup:' || encode(extensions.digest(s.dedupe_key, 'sha1'), 'hex'),
       s.dedupe_key, s.tk, s.tk, 'held', 'followup', 'followup', '',
       'nurture_not_interested',
       greatest(coalesce(s.last_ni_at, now()) + interval '30 days', now()),
       greatest(coalesce(s.last_ni_at, now()) + interval '30 days', now()),
       greatest(coalesce(s.last_ni_at, now()) + interval '30 days', now()),
       s.its_owner, s.its_property,
       jsonb_build_object(
         'deferred_message_resolution', true,
         'source', 'nurture_rearm_20261010',
         'intent', 'not_interested',
         'followup_reason', 'nurture_followup:not_interested',
         'days_until_followup', 30,
         'opportunity_id', s.id,
         'not_interested_at', s.last_ni_at,
         'rearm', jsonb_build_object('batch', 'rearm_not_interested_nurture_20261010', 'held_pending_owner_release', true)
       )
  from src s
 where not exists (select 1 from public.send_queue q where q.dedupe_key = s.dedupe_key)
   and not exists (select 1 from public.send_queue q where q.thread_key = s.tk and q.type = 'followup'
                    and q.queue_status in ('scheduled','queued','held','processing','paused_operator_review','paused_deferred_unresolved'));
select queue_status, count(*), min(scheduled_for), max(scheduled_for) from public.send_queue
 where metadata->'rearm'->>'batch' = 'rearm_not_interested_nurture_20261010' group by 1;   -- expect 47 held
rollback;  -- COMMIT only after the owner checks the count

-- ═══ STEP 3 — RELEASE (separate owner GO) ════════════════════════════════════
-- Future-dated rows release as-is; anything already due is staggered 2 minutes
-- apart (no overdue burst):
--   with r as (
--     select id, scheduled_for, row_number() over (order by scheduled_for, id) n from public.send_queue
--      where metadata->'rearm'->>'batch' = 'rearm_not_interested_nurture_20261010' and queue_status = 'held'
--   )
--   update public.send_queue q
--      set queue_status = 'scheduled',
--          scheduled_for = greatest(r.scheduled_for, now() + r.n * interval '2 minutes'),
--          scheduled_for_utc = greatest(r.scheduled_for, now() + r.n * interval '2 minutes'),
--          metadata = q.metadata || jsonb_build_object('rearm_released_at', now())
--     from r where q.id = r.id;
-- ROLLBACK before release:
--   update public.send_queue set queue_status = 'cancelled', metadata = metadata || '{"rearm_rolled_back": true}'::jsonb
--    where metadata->'rearm'->>'batch' = 'rearm_not_interested_nurture_20261010' and queue_status = 'held';
