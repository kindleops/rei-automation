-- V2-1B — durable contact×property resolution state.
--
-- WHY A NEW RELATION RATHER THAN COLUMNS ON contact_outreach_state.
--
-- The first draft of this migration added contact_property_role / rejected_at
-- to public.contact_outreach_state, on the belief that it was the canonical
-- contact x property relation. Auditing the live schema showed it is not:
--
--   * it is UNIQUE on (podio_master_owner_id, to_phone_number)
--     -- grain is contact x OWNER, not contact x PROPERTY;
--   * only 3,025 of its 9,054 rows carry a podio_property_id at all;
--   * 12 owners in the graph hold MULTIPLE properties (up to 7), and 11
--     phones are linked to more than one property.
--
-- So a role stored there would be owner-scoped. Rejecting a contact for one
-- property would silently reject them for every other property that owner
-- holds -- the precise inversion of the invariant this work exists to
-- protect. Widening that unique index is not an option either:
-- outreach-service.js upserts against it by name
-- (onConflict: "podio_master_owner_id,to_phone_number"), so changing the key
-- breaks a live writer.
--
-- This is therefore the FIRST table at the property x contact grain, not a
-- duplicate of one. contact_outreach_state keeps its job (per-owner outreach
-- cadence, suppression windows, touch counts) and is untouched by this
-- migration -- no column added, no index changed, no row rewritten.
--
-- NO INFERENCE ON EXISTING DATA. This migration creates an empty table. It
-- backfills nothing. A contact with no row here is UNKNOWN, which is exactly
-- what history is: we never asked most of them. Guessing `not_owner` from a
-- stale suppression, or `confirmed_owner` from a vendor record, would
-- manufacture ownership evidence no seller ever gave.

create table if not exists public.contact_property_resolution (
  id uuid primary key default gen_random_uuid(),

  -- The grain. Both halves are required: this row is meaningless without
  -- knowing WHICH pairing it describes.
  property_id text not null,
  contact_phone_e164 text not null,

  -- Convenience linkage, deliberately nullable: identity resolution can
  -- improve later and must not block recording a rejection now.
  master_owner_id text,
  prospect_id text,

  -- Role of THIS contact for THIS property. Absence means unknown; there is
  -- deliberately no DEFAULT, so a row is never created asserting a role
  -- nobody established.
  contact_property_role text
    check (contact_property_role is null or contact_property_role in (
      'unknown', 'confirmed_owner', 'not_owner', 'former_owner',
      'referral_source', 'suppressed'
    )),

  -- The exclusion signal the waterfall reads. A row with rejected_at set is
  -- never selected again for this property; this is what makes the anti-loop
  -- guarantee survive a process restart.
  rejected_at timestamptz,
  rejection_reason text,

  -- Separates a compliance suppression (channel-scoped, outranks the
  -- waterfall and must never trigger it) from a contact-graph rejection
  -- (pair-scoped, drives it). Conflating these is the defect V2-1 fixes.
  suppression_scope text
    check (suppression_scope is null or suppression_scope in (
      'contact_property_pair', 'channel_compliance'
    )),

  -- Referral provenance: how this contact entered the graph for this
  -- property, so a human-referred contact can be told from an enriched one.
  contact_origin text
    check (contact_origin is null or contact_origin in ('contact_graph', 'referral')),
  referral_id uuid,
  referred_by_phone_e164 text,

  -- Idempotency for referral execution. Unique when present, so replaying the
  -- same inbound event cannot produce a second contact/thread.
  referral_identity_key text,

  -- Provenance of the decision itself.
  source_message_id text,
  source_thread_key text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One row per pairing. This is the durability guarantee: re-processing the
  -- same rejection updates a row instead of appending a second one.
  constraint contact_property_resolution_pair_key
    unique (property_id, contact_phone_e164)
);

-- The waterfall's hot path: "which contacts are already ruled out for this
-- property". Partial, because only rejected rows need to be excluded.
create index if not exists contact_property_resolution_rejected_idx
  on public.contact_property_resolution (property_id)
  where rejected_at is not null;

create index if not exists contact_property_resolution_role_idx
  on public.contact_property_resolution (property_id, contact_property_role);

-- Referral idempotency: a duplicate execution collides instead of forking a
-- second identity.
-- Plain UNIQUE, not partial: Postgres permits unlimited NULLs in a unique
-- index, and a PARTIAL index cannot be targeted by PostgREST's on_conflict
-- (the inference must match the predicate), which broke the referral upsert
-- at runtime. Caught by the real-database durability run, not by the mock.
alter table public.contact_property_resolution
  add constraint contact_property_resolution_referral_key
  unique (referral_identity_key);

comment on table public.contact_property_resolution is
  'Contact x PROPERTY ownership-resolution state. Distinct from contact_outreach_state, which is contact x OWNER outreach cadence and cannot express per-property role.';
comment on column public.contact_property_resolution.contact_property_role is
  'Pair-scoped. not_owner means this pairing failed -- NEVER that the property has no owner to find.';
comment on column public.contact_property_resolution.rejected_at is
  'Set when the pairing is ruled out. The waterfall excludes these, which is what stops the loop across process restarts.';
comment on column public.contact_property_resolution.suppression_scope is
  'contact_property_pair = contact-graph rejection (drives the waterfall); channel_compliance = opt-out/DNC (outranks it, never triggers it).';
