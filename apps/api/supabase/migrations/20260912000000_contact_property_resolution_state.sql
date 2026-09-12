-- V2-1 — durable contact-resolution state.
--
-- NOT APPLIED. Written as a reviewable artifact; applying it is a production
-- schema change and needs explicit authorization.
--
-- WHY COLUMNS AND NOT A NEW TABLE. public.contact_outreach_state is already
-- the first-class contact x property relation (9,054 rows; it carries
-- podio_property_id, canonical_e164, to_email, channel, dnc, suppression_*).
-- What it cannot express is the OWNERSHIP ROLE of that pairing, so the
-- waterfall has no durable way to answer "which contacts have we already tried
-- and ruled out for this property". Putting that in `metadata` would bury
-- load-bearing state in an opaque blob on a relation that already exists.
--
-- WHY IT MATTERS. Without these columns, a contact rejected for a property is
-- indistinguishable from one never tried, so the waterfall can re-select a
-- contact the seller already told us is wrong.

alter table public.contact_outreach_state
  -- Role of THIS contact for THIS property. Never a property-level fact: a
  -- value of 'not_owner' says one pairing failed, never that the property has
  -- no owner to find.
  add column if not exists contact_property_role text
    check (contact_property_role is null or contact_property_role in (
      'unknown', 'confirmed_owner', 'not_owner', 'former_owner',
      'referral_source', 'suppressed'
    )),

  -- Set when the pairing is ruled out for ownership outreach. The waterfall
  -- excludes any row with rejected_at set, which is what stops the loop.
  add column if not exists rejected_at timestamptz,
  add column if not exists rejection_reason text,

  -- Distinguishes a compliance suppression (channel-scoped, outranks the
  -- waterfall) from a contact-graph rejection (pair-scoped, drives it).
  -- Conflating these is exactly the defect V2-1 fixes.
  add column if not exists suppression_scope text
    check (suppression_scope is null or suppression_scope in (
      'contact_property_pair', 'channel_compliance'
    )),

  -- Provenance for a contact that entered via a human referral rather than
  -- enrichment, so the two can be told apart later.
  add column if not exists referral_source_referral_id uuid,
  add column if not exists contact_origin text
    check (contact_origin is null or contact_origin in ('contact_graph', 'referral'));

-- The waterfall's hot path: "eligible candidates for this property, excluding
-- anything already rejected". Partial, because rejected rows are the minority
-- and the index only needs to serve exclusion.
create index if not exists contact_outreach_state_property_rejected_idx
  on public.contact_outreach_state (podio_property_id)
  where rejected_at is not null;

create index if not exists contact_outreach_state_property_role_idx
  on public.contact_outreach_state (podio_property_id, contact_property_role);

comment on column public.contact_outreach_state.contact_property_role is
  'Ownership role of this contact FOR THIS PROPERTY. Pair-scoped: not_owner never means the property has no owner.';
comment on column public.contact_outreach_state.suppression_scope is
  'contact_property_pair = contact-graph rejection (drives the waterfall); channel_compliance = opt-out/DNC (outranks it).';
