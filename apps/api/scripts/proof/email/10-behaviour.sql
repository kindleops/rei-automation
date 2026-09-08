\set ON_ERROR_STOP off
\echo '--- 1. channel has NO default ---'
select coalesce(column_default,'(none)') as channel_default, is_nullable
  from information_schema.columns
 where table_name='seller_logical_communications' and column_name='channel';

\echo '--- 2. an SMS touch and an EMAIL touch on the same anchors coexist ---'
select (public.seller_logical_communication_get_or_create(
  'lck_v2:campaign_touch:'||repeat('a',64), 'lck_v2', 'campaign_touch',
  jsonb_build_object('channel','sms','to_phone_number','+13125550100',
                     'campaign_target_id','11111111-1111-4111-8111-111111111111','touch_number','3')
))->>'ok' as sms_ok;
select (public.seller_logical_communication_get_or_create(
  'lck_v2:campaign_touch:'||repeat('b',64), 'lck_v2', 'campaign_touch',
  jsonb_build_object('channel','email','to_email','seller@example.com',
                     'campaign_target_id','11111111-1111-4111-8111-111111111111','touch_number','3')
))->>'ok' as email_ok;
select channel, to_phone_number, to_email from public.seller_logical_communications order by channel;

\echo '--- 3. a caller with NO channel is REFUSED, not defaulted to sms ---'
select public.seller_logical_communication_get_or_create(
  'lck_v2:campaign_touch:'||repeat('c',64), 'lck_v2', 'campaign_touch',
  jsonb_build_object('campaign_target_id','11111111-1111-4111-8111-111111111111','touch_number','9')
);

\echo '--- 4. the SAME key replayed is REUSED, not duplicated ---'
select (public.seller_logical_communication_get_or_create(
  'lck_v2:campaign_touch:'||repeat('a',64), 'lck_v2', 'campaign_touch',
  jsonb_build_object('channel','sms','to_phone_number','+13125550100',
                     'campaign_target_id','11111111-1111-4111-8111-111111111111','touch_number','3')
))->>'reused' as reused;

\echo '--- 5. the SAME key with a DIFFERENT channel is an identity CONFLICT ---'
select public.seller_logical_communication_get_or_create(
  'lck_v2:campaign_touch:'||repeat('a',64), 'lck_v2', 'campaign_touch',
  jsonb_build_object('channel','email','to_email','x@y.com',
                     'campaign_target_id','11111111-1111-4111-8111-111111111111','touch_number','3')
) -> 'conflicting_fields' as conflicting_fields;

\echo '--- 6. a row cannot carry BOTH recipient kinds ---'
insert into public.seller_logical_communications
  (logical_key, logical_key_version, communication_type, channel, to_phone_number, to_email, campaign_target_id, touch_number)
values ('lck_v2:campaign_touch:'||repeat('d',64),'lck_v2','campaign_touch','email','+13125550100','x@y.com',
        '11111111-1111-4111-8111-111111111111', 5);

\echo '--- 7. an unknown channel is refused ---'
insert into public.seller_logical_communications
  (logical_key, logical_key_version, communication_type, channel, campaign_target_id, touch_number)
values ('lck_v2:campaign_touch:'||repeat('e',64),'lck_v2','campaign_touch','carrier_pigeon',
        '11111111-1111-4111-8111-111111111111', 6);

\echo '--- 8. suppression: only a soft bounce may expire ---'
insert into public.email_suppression (email_address, reason, expires_at)
values ('a@b.com','unsubscribed', now() + interval '1 day');

\echo '--- 9. suppression is unique per address ---'
insert into public.email_suppression (email_address, reason) values ('dup@b.com','hard_bounce');
insert into public.email_suppression (email_address, reason) values ('dup@b.com','complaint');

\echo '--- 10. email_queue dedupe uniqueness applies to LIVE rows only ---'
insert into public.email_queue (queue_key, queue_status, to_email, subject, email_body, dedupe_key)
values ('q1','queued','a@b.com','s','b','dk-1');
insert into public.email_queue (queue_key, queue_status, to_email, subject, email_body, dedupe_key)
values ('q2','queued','a@b.com','s','b','dk-1');
\echo '(above must fail) and a SENT row may reuse the key:'
insert into public.email_queue (queue_key, queue_status, to_email, subject, email_body, dedupe_key)
values ('q3','sent','a@b.com','s','b','dk-1');

\echo '--- 11. contact_outreach_state can now be upserted BY EMAIL ---'
insert into public.contact_outreach_state (podio_master_owner_id, to_email, channel, last_email_at, last_outbound_at)
values ('own-1','bob@example.com','email', now(), now())
on conflict (podio_master_owner_id, to_email) do update set last_email_at = excluded.last_email_at;
insert into public.contact_outreach_state (podio_master_owner_id, to_email, channel, last_email_at, last_outbound_at)
values ('own-1','bob@example.com','email', now(), now())
on conflict (podio_master_owner_id, to_email) do update set last_email_at = excluded.last_email_at;
select count(*) as rows_for_owner from public.contact_outreach_state where podio_master_owner_id='own-1';
