-- IC8 campaign controller v0 -- historical replay extract (READ-ONLY).
--
-- Run through the Supabase MCP execute_sql (SELECT only; statement_timeout set
-- below). Returns ONE row: `units` (index -> unit key) and `body`, a compact
-- ';'-separated list of "u,d,lag,sent,spam,dlv,fail,rt,oo,wn,eng,qual,host"
-- tuples plus md5(body) so the saved copy can be verified byte-for-byte.
--
--   u    unit index into `units`: c:<campaign_id> (the 6 real campaigns,
--        proactive queue_key prefixes only) or l:<property market> (legacy
--        master-owner feeder, queue_key prefix feed:, campaign_id null)
--   d    send OPS-DAY as days since 2026-04-20. An ops-day starts 10:00 UTC
--        (05:00 CDT / 03:00 PDT), so no US 08:00-21:00 local window is split.
--   lag  ops-days from the send day to the day the outcome was FIRST
--        observable (event time). The replay may use a cell only when
--        d + lag < decision day: this is what makes it point-in-time.
--   sent / spam (lag 0)       send_queue sent rows / outbound failure_bucket='Spam'
--   dlv  delivered_at day;  fail  first outbound failure event (else send day)
--   rt oo wn eng qual host    DISTINCT reply threads, first reply of each class.
--        Attribution = Analytics Lab rule: inbound (message_events.created_at,
--        the only true receive time) -> latest sent row on the normalised
--        E.164 thread at or before it, within 30 days.
--        oo   = is_opt_out OR opt_out_keyword OR detected_intent in OPTOUT_INTENTS
--               (analytics/lab/fact-classifiers.js -> metrics/war-room-service.js:29)
--        wn   = WRONG_NUM_INTENTS (war-room-service.js:30, not exported)
--        eng  = POSITIVE_INTENTS (war-room-service.js:25)
--        qual = audit 1.2 strict-qualified (engaged - ownership_confirmed + latent/callback/contract/condition)
--        host = hostile_or_legal
-- Exclusions: config/internal-phones.js INTERNAL_TEST_PHONE_SET, source
-- internal_canary, metadata.internal_canary. detected_intent is the CURRENT
-- classifier reading (later repairs included) -- an operational signal, not a label.
set statement_timeout = '25s';
with canary(p) as (values ('+16127433952'),('+16124515970'),('+16128072000'),('+13059807795'),('+13055376631')),
camp(id) as (values ('320c798a-84c9-45b8-a7c9-d166ddd7bd46'::uuid),('b821cb13-deeb-4ab4-9505-01dbcdaa136d'::uuid),
  ('dbcfe227-4423-4b74-bb28-2af02c45dde7'::uuid),('df0671fa-4bdf-41a8-bba0-bdd39b2f9bb9'::uuid),
  ('7f2ba659-16ad-463b-851d-3381c81e2e38'::uuid),('c963defc-5672-4419-b494-807d453f8d18'::uuid)),
sq as (
  select s.id, s.campaign_id, coalesce(p.market, nullif(trim(s.market),''), '<unresolved>') mkt,
    split_part(coalesce(s.queue_key,''), ':', 1) pfx,
    case when coalesce(s.thread_key, s.to_phone_number) ~ '^\+1\d{10}$' then coalesce(s.thread_key, s.to_phone_number)
         when coalesce(s.thread_key, s.to_phone_number) ~ '^1\d{10}$'  then '+'||coalesce(s.thread_key, s.to_phone_number)
         when coalesce(s.thread_key, s.to_phone_number) ~ '^\d{10}$'   then '+1'||coalesce(s.thread_key, s.to_phone_number)
         else coalesce(s.thread_key, s.to_phone_number) end k,
    coalesce(s.sent_at, s.created_at) t, s.delivered_at,
    (s.queue_status in ('failed','failed_transport','undelivered')) is_failed
  from send_queue s left join properties p on p.property_id::text = s.property_id
  where (s.sent_at is not null or s.queue_status in ('sent','delivered'))
    and coalesce(s.to_phone_number,'') not in (select p from canary)
    and coalesce(s.thread_key,'') not in (select p from canary)
    and coalesce(s.source,'') <> 'internal_canary'
    and coalesce(s.metadata->>'internal_canary','false') <> 'true'),
u as (
  select sq.*, ((t - interval '10 hours') at time zone 'UTC')::date d,
    case when pfx in ('campaign','campaign_target_one','campaign-recovery') and campaign_id in (select id from camp) then 'c:'||campaign_id::text
         when pfx = 'feed' and campaign_id is null then 'l:'||mkt end unit
  from sq),
uu as (select * from u where unit is not null),
spam as (select distinct queue_id from message_events where direction='outbound' and failure_bucket='Spam'),
fev as (select queue_id, min(coalesce(failed_at, created_at)) ft from message_events
  where direction='outbound' and (failed_at is not null or failure_bucket is not null or coalesce(is_final_failure,false)) group by 1),
ev as (
  select unit, d, 0 lag, 'sent' c from uu
  union all select unit, d, 0, 'spam' from uu join spam on spam.queue_id = uu.id
  union all select unit, d, greatest(0, ((delivered_at - interval '10 hours') at time zone 'UTC')::date - d), 'dlv' from uu where delivered_at is not null
  union all select unit, d, greatest(0, coalesce(((f.ft - interval '10 hours') at time zone 'UTC')::date - d, 0)), 'fail'
    from uu left join fev f on f.queue_id = uu.id where uu.is_failed),
inb as (
  select me.id, me.created_at, me.detected_intent it,
    (coalesce(me.is_opt_out,false) or nullif(trim(coalesce(me.opt_out_keyword,'')),'') is not null
      or me.detected_intent in ('opt_out','stop','unsubscribe','remove')) oo,
    case when me.thread_key ~ '^\+1\d{10}$' then me.thread_key when me.thread_key ~ '^1\d{10}$' then '+'||me.thread_key
         when me.thread_key ~ '^\d{10}$' then '+1'||me.thread_key else me.thread_key end k
  from message_events me
  where me.direction='inbound' and me.thread_key is not null
    and me.thread_key not in (select p from canary) and coalesce(me.from_phone_number,'') not in (select p from canary)
    and coalesce(me.metadata->>'internal_canary','false') <> 'true'),
attr as (
  select distinct on (i.id) i.id, i.k, i.created_at, i.it, i.oo, s.unit, s.d
  from inb i join u s on s.k = i.k and s.t <= i.created_at and i.created_at - s.t <= interval '30 days'
  order by i.id, s.t desc),
cls as (
  select a.unit, a.d, a.k, x.c, ((a.created_at - interval '10 hours') at time zone 'UTC')::date rd
  from attr a cross join lateral (values
    ('rt', true), ('oo', a.oo),
    ('wn', a.it in ('wrong_number','wrong_person','not_owner','wrong_contact')),
    ('eng', a.it in ('seller_interested','asking_price_provided','asks_offer','ownership_confirmed','price_anchor','price_interest')),
    ('qual', a.it in ('seller_interested','asking_price_provided','asks_offer','price_anchor','price_interest','latent_interest','callback_requested','contract_requested','condition_disclosed')),
    ('host', a.it = 'hostile_or_legal')) x(c, hit)
  where x.hit and a.unit is not null),
firsts as (select unit, d, min(rd) - d lag, c from cls group by unit, d, k, c),
allev as (select unit, d, lag, c from ev union all select unit, d, lag, c from firsts),
units as (select unit, (row_number() over (order by unit)) - 1 ui from (select distinct unit from allev) z),
cells as (
  select n.ui, (a.d - date '2026-04-20') dd, a.lag,
    count(*) filter (where c='sent') sent, count(*) filter (where c='spam') spam,
    count(*) filter (where c='dlv') dlv, count(*) filter (where c='fail') fail,
    count(*) filter (where c='rt') rt, count(*) filter (where c='oo') oo, count(*) filter (where c='wn') wn,
    count(*) filter (where c='eng') eng, count(*) filter (where c='qual') qual, count(*) filter (where c='host') host
  from allev a join units n using (unit) group by 1,2,3),
body as (select string_agg(concat_ws(',', ui, dd, lag, sent, spam, dlv, fail, rt, oo, wn, eng, qual, host), ';' order by ui, dd, lag) b from cells)
select (select string_agg(unit, '|' order by ui) from units) units, b body, md5(b) body_md5,
  (select sum(sent) from cells) total_sent, (select count(*) from cells) n_cells
from body;
