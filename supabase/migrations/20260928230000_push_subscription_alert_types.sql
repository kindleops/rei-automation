-- Per-device alert-type choices for web push (see apps/api/src/lib/domain/notifications/alert-types.js).
-- NULL / missing key = that type's default (PUSH_DEFAULTS). Additive and nullable: existing
-- subscriptions keep receiving exactly the defaults.
alter table public.push_subscriptions
  add column if not exists alert_types jsonb;

comment on column public.push_subscriptions.alert_types is
  'Operator choice per alert type for this device, e.g. {"seller_reply":true,"campaign":false}. Missing key = default.';
