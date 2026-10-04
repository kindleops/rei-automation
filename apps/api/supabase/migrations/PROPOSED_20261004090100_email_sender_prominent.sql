-- PROPOSED — NOT APPLIED. Owner approval required. Contains NO secrets.
-- First email brand: Prominent Cash Offer, sending subdomain
-- mail.prominentcashoffer.com (owner decision 2026-10-04).
--
-- The Brevo API key is NOT here. provider_api_key_name names the Worker
-- secret that holds it (BREVO_PROMINENT_API_KEY, already forwarded to the API
-- container by infra/cloudflare/worker/index.ts). Brevo must show
-- mail.prominentcashoffer.com as AUTHENTICATED before this row is applied.
--
-- Replace every <<PLACEHOLDER>> before applying. Placeholders:
--   <<FROM_LOCALPART>>     mailbox on the sending subdomain, e.g. offers
--   <<SENDER_NAME>>        display name shown to recipients
--   <<POSTAL_ADDRESS>>     the business's valid physical postal address
--                          (street address, or a USPS-registered PO box /
--                          private mailbox) — printed in every seller email
--   <<INBOUND_DOMAIN>>     reply subdomain routed by Cloudflare Email Routing
--                          to the Email Worker, recommended reply.prominentcashoffer.com
--   <<TRACKING_HOST>>      host attached to lead-command-production as a
--                          Custom Domain, recommended track.prominentcashoffer.com
--
-- sender_status 'warming' is accepted by the dispatcher; daily_limit is the
-- owner's ramp number for this domain (provider reputation realities are in
-- the runbook — this is a dial, not a guarantee).

begin;

insert into public.email_senders
  (sender_key, sender_name, from_email, reply_to_email, provider, provider_api_key_name,
   domain, warmup_status, sender_status, daily_limit, is_default, is_active, metadata)
values
  ('prominent',
   '<<SENDER_NAME>>',
   '<<FROM_LOCALPART>>@mail.prominentcashoffer.com',
   null, -- replies route per-thread to reply+<token>@<<INBOUND_DOMAIN>>
   'brevo',
   'BREVO_PROMINENT_API_KEY',
   'mail.prominentcashoffer.com',
   'warming',
   'warming',
   20,     -- owner sets the day-1 ramp; raise deliberately
   true,   -- default sender while it is the only brand
   false,  -- flip to true only at the go-live step (runbook step 9)
   jsonb_build_object(
     'brand', 'Prominent Cash Offer',
     'inbound_domain', '<<INBOUND_DOMAIN>>',
     'tracking_base_url', 'https://<<TRACKING_HOST>>/api/public/email',
     'unsubscribe_base_url', 'https://<<TRACKING_HOST>>/api/public/email',
     'postal_address', '<<POSTAL_ADDRESS>>',
     'proposed', '2026-10-04'
   ))
on conflict (sender_key) do nothing;

-- Guard: refuse to leave placeholders behind.
do $$
begin
  if exists (select 1 from public.email_senders where sender_key = 'prominent'
             and (sender_name like '%<<%' or from_email like '%<<%' or metadata::text like '%<<%')) then
    raise exception 'email_senders.prominent still contains <<PLACEHOLDER>> values — fill them in first';
  end if;
end $$;

commit;

-- ROLLBACK: delete from public.email_senders where sender_key = 'prominent' and messages_sent_today = 0;
