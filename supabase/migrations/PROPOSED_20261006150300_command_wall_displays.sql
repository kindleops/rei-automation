-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED — NOT APPLIED. Command Wall V1 display registry (owner brief §59–§62).
--
-- Three service-role-only tables behind the narrow wall API
-- (apps/api/src/lib/domain/command-wall/wall-store.js):
--   command_wall_displays   one row per paired TV: config + credential HASH
--   command_wall_pairings   short-lived single-use pairing rendezvous
--   command_wall_audit      paired / revoked / config / connected / version events
--
-- Security model:
--   * Raw tokens and pairing codes are NEVER stored: only HMAC-SHA256 hashes
--     (COMMAND_WALL_TOKEN_PEPPER) or SHA-256 when no pepper is configured.
--   * RLS on, no policies, and anon/authenticated revoked: the browser can never
--     read these tables directly — not with the anon key, not with an operator
--     session, and certainly not with a display token (which is not a JWT).
--   * Revocation = status 'revoked' + token_hash NULL (immediate in-process;
--     ≤ 30 s across processes via the authenticator cache).
--   * Expiry: token_expires_at (180 d); rotation every 30 d via heartbeat with a
--     10-minute grace for the previous hash (prev_token_hash/prev_token_valid_until).
--   * Pairings: 10-minute expiry, CAS transitions pending→claimed→consumed.
--
-- Load: heartbeat writes at most once/min/display; reads are cached ≥ 30 s.
-- Apply only with owner approval, then `supabase migration repair --status applied 20261006150300`.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.command_wall_displays (
  id                      text primary key,
  name                    text not null check (char_length(name) between 1 and 48),
  status                  text not null default 'awaiting_handoff'
                            check (status in ('awaiting_handoff', 'active', 'pairing_required', 'revoked')),
  token_hash              text,
  prev_token_hash         text,
  prev_token_valid_until  timestamptz,
  token_issued_at         timestamptz,
  token_expires_at        timestamptz,
  paired_by               text,
  paired_at               timestamptz,
  last_seen_at            timestamptz,
  last_heartbeat          jsonb,
  revoked_at              timestamptz,
  revoked_by              text,
  preset                  text not null default 'national_command'
                            check (preset in ('national_command', 'acquisition_pulse', 'campaign_operations', 'market_intelligence', 'spatial_intelligence', 'custom')),
  theme                   text not null default 'dark' check (theme in ('dark', 'true_black', 'light', 'red_ops')),
  privacy_mode            text not null default 'privacy' check (privacy_mode in ('operations', 'privacy', 'public_safe')),
  oled_protection         text not null default 'low' check (oled_protection in ('off', 'low', 'high')),
  rotation_config         jsonb not null default '{"enabled": false, "steps": []}'::jsonb,
  settings_json           jsonb not null default '{}'::jsonb,
  view_command            jsonb,
  config_version          integer not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- a live credential is always a 64-hex hash, never a raw `lcw_` token
  constraint command_wall_displays_hash_shape check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  constraint command_wall_displays_prev_hash_shape check (prev_token_hash is null or prev_token_hash ~ '^[0-9a-f]{64}$'),
  constraint command_wall_displays_revoked_has_no_token check (status <> 'revoked' or token_hash is null)
);

create unique index if not exists command_wall_displays_token_hash_uq
  on public.command_wall_displays (token_hash) where token_hash is not null;
create unique index if not exists command_wall_displays_prev_token_hash_uq
  on public.command_wall_displays (prev_token_hash) where prev_token_hash is not null;

create table if not exists public.command_wall_pairings (
  id           text primary key,
  code_hash    text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  poll_hash    text not null check (poll_hash ~ '^[0-9a-f]{64}$'),
  status       text not null default 'pending' check (status in ('pending', 'claimed', 'consumed', 'expired')),
  display_id   text references public.command_wall_displays (id) on delete cascade,
  client_key   text,
  client_hint  jsonb,
  claimed_by   text,
  claimed_at   timestamptz,
  consumed_at  timestamptz,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);

create index if not exists command_wall_pairings_code_idx on public.command_wall_pairings (code_hash, created_at desc);
create index if not exists command_wall_pairings_pending_idx on public.command_wall_pairings (created_at) where status = 'pending';

create table if not exists public.command_wall_audit (
  id          bigserial primary key,
  display_id  text not null,
  action      text not null check (action in ('paired', 'repaired', 'connected', 'config_changed', 'view_sent', 'revoked', 'pairing_regenerated', 'token_rotated', 'version_changed')),
  actor       text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists command_wall_audit_display_idx on public.command_wall_audit (display_id, created_at desc);

comment on table public.command_wall_displays is 'Command Wall V1 paired displays: view config + credential hash only. Service role only.';
comment on table public.command_wall_pairings is 'Command Wall V1 single-use pairing rendezvous (10 min). Service role only.';
comment on table public.command_wall_audit is 'Command Wall V1 audit: paired/revoked/config/connected/version. No credentials. Service role only.';

alter table public.command_wall_displays enable row level security;
alter table public.command_wall_pairings enable row level security;
alter table public.command_wall_audit enable row level security;
revoke all on table public.command_wall_displays from anon, authenticated;
revoke all on table public.command_wall_pairings from anon, authenticated;
revoke all on table public.command_wall_audit from anon, authenticated;
revoke all on sequence public.command_wall_audit_id_seq from anon, authenticated;

-- Housekeeping (optional; proposed with the tables): expire stale pairings and
-- keep 90 days of audit. Runs off-hours, touches only these tables.
-- select cron.schedule('command_wall_housekeeping', '17 9 * * *', $$
--   update public.command_wall_pairings set status = 'expired' where status in ('pending', 'claimed') and expires_at < now() - interval '10 minutes';
--   delete from public.command_wall_pairings where created_at < now() - interval '7 days';
--   delete from public.command_wall_audit where created_at < now() - interval '90 days';
-- $$);
