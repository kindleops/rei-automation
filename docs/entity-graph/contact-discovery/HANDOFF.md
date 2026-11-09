# Hand-off to the Entity Graph implementation agent: contact discovery and history (2026-10-08)
- **Status:** specification + regression baseline. **No competing code written.**
- **Goal:** integrate this into the current Entity Graph release-candidate work (RC 8.x on main). Integration steps: [README.md](README.md).
- **Owner approval:** Ryan, 2026-10-08.
- **Boundaries:**
  - Read-only data access for discovery.
  - Canonical identity resolution is not modified.
  - Campaign eligibility and final-send rules are unchanged.
  - Discovered candidates **never** become campaign recipients automatically.

## Defects (measured on production, read-only)
1. **Phones hidden when owner resolution is incomplete.**
   - The campaign_target_graph seller bridge (DB function `fn_refresh_campaign_target_graph_seller_batch`, seller-model path; its SQL is not version-controlled in this repo as of `fa12ff7b`) projects a phone only from `seller.property_best_contact_v1.legal_phone`.
   - Resolution states `ambiguous`, `unresolved` (`OWNRES_NO_CANDIDATES`), missing row and `entity_owned` get no phone, even when `public.prospects` (linked via `linked_property_ids_text`, phones in `phones_json`) holds vendor owner phones.
2. **Confirmed resolutions without a phone.**
   - 2,065 graph rows are `confirmed` + `missing_phone`.
   - In a 200-row sample: **169** have only `reach_phone` (non-legal-owner role); **29** have no best-contact phone at all.
   - The bridge never projects `reach_phone`. Show it as a reach/relative contact, **not** as an owner phone.
3. **UI misreports history and restrictions** (`apps/api/src/lib/domain/entity-graph/entity-graph-service.js`):
   - contact ladder "eligible" = `!wrong_number_at` only;
   - `suppressed` and `optedOut` are hard-coded `false`; `lastContacted` / `lastResponse` are `null` (`:1603-1608` at `fa12ff7b`);
   - `timeline` is always `[]` (`:1938`, `:2050`, `:2095`, `:2160`, `:2225` at `fa12ff7b`).

## Required read model: `property_contact_candidates`
Read-only view/RPC. One row per **(property_id, person_key, phone)**, unioning:

| Source | Fields |
|---|---|
| campaign_target_graph | canonical_e164, identity_alignment, seller_person_key, blocker_flags (vendor_dnc, …), wrong_number, post-contact suppression |
| seller.property_best_contact_v1 | legal_phone (+role/type/callable), reach_phone (+role), excluded_vendor_dnc, excluded_wrong_number |
| seller.property_owner_resolution_v1 | owner_resolution_status, match_method, conflict_status, candidate_count, reason_codes |
| public.prospects (linked_property_ids_text → property) | full_name, likely_owner, likely_renting, matching_flags, person_flags_text, cnam (vendor), rank_position/confidence, phones_json[] (type, carrier, activity, score) |
| public.phones | phone_type, activity_status, wrong_number_at, owner_display_name |
| History | send_queue (all statuses + holds), campaign_targets (campaign name/status), message_events (in/out), contact_outreach_state (dnc, suppression_until, touch_count) |
| Restrictions | sms_suppression_list (active), automation_suppressions (active), contact_property_resolution rejections (opt_out, not_owner, wrong_person_reply, family_member, former_owner…) |

**Relationship role** (from evidence, never inferred upward): `owner`, `co_owner`, `prospective_owner_contact` (vendor likely-owner, unresolved), `reach_relative`, `renter`, `occupant`, `unresolved`, `historical` (only in history).

**Contact state (display):**
1. `no_contact_record`
2. `prospect_phone_ownership_unresolved`
3. `vendor_associated_owner_phone`
4. `independently_corroborated` (owner reply / carrier-name retrieved by us)
5. `identity_conflict` (+ `possible_deceased_owner`)
6. `existing_campaign_target`
7. `already_contacted`
8. `held_or_suppressed`

**Restriction fields use tri-state values:** `true` / `false` / `unknown`. A missing vendor-DNC record is **`unknown`, never `false`**.

**History** is reconciled at property, person, phone and exact person-phone pair level, and shown in `timeline` with real events: queue status changes, sends, deliveries, inbound replies, suppressions, campaign target membership.

## UI
- **Dossier "Contacts" tab:** every candidate with evidence chips (source, role, resolution, CNAM-vendor, activity, DNC tri-state), history counts, campaign memberships and queue holds (with reasons, e.g. `blocked_by_health_guard: blocked_template_id`).
- **Browse filter:** `contact_state` (+ role). The research universe stays independent of SMS eligibility.
- **Action "Review for campaign":** a gated step through the existing campaign services (`preview-targets` / build-targets). No direct insertion.

## Regression baseline and before/after protocol
Script: [`regression/contact_discovery_regression.py`](regression/contact_discovery_regression.py). Seeded and reproducible:
- sample A: `md5(property_id||'rg20261008')`, 2,000 graph rows;
- sample B: `md5(property_id||'seed20261008')`, 600 missing_phone rows.

**Baseline (BEFORE)** ([`regression/baseline-20261008.json`](regression/baseline-20261008.json)):

| | Sample A (2,000) | Sample B (600 missing_phone) |
|---|---|---|
| Properties with no visible phone | 448 | 600 |
| Hidden property-phone associations | 936 (922 distinct phones; 634 properties) | 448 (448 phones; 272 properties) |
| Hidden historical-contacted phones | 74 | 38 |

Hidden associations by class, sample A:
| Class | Count |
|---|---|
| Vendor likely-owner phone (by resolution: entity_owned 171 / confirmed 118 / medium 109 / ambiguous 99 / conflicting 15 / unresolved 15 / high 3) | 530 |
| Renter / occupant | 150 |
| Unresolved prospect | 147 |
| Historical contacted | 74 |
| Reach | 12 |
| Suppressed / wrong number | 4 |

**AFTER, acceptance criteria:**
- The read model returns ≥ the same associations per property.
- Every row carries role, state and provenance.
- **0** rows newly classified `owner` or `independently_corroborated` without that evidence.
- **0** changes to `seller.*` resolution tables or `campaign_target_graph` eligibility fields.
- **0** new `campaign_targets` rows.
- History, timeline and restrictions match production counts for the sample.
- The campaign-draft hand-off goes only through existing services.

## Coordination items
- **Campaign-scoped recipient exclusion** (2439 / Miami Test): separate branch `feat/campaign-recipient-exclusion` (pushed; PROPOSED migration, **not applied**). Design is a dedicated table `public.campaign_recipient_exclusions` (active rows only), not campaign metadata. Once that table exists, show an active row as restriction `campaign_excluded` on the candidate for that campaign. Until it is applied, show the restriction as `unknown`, and do not read `campaigns.metadata`.
- **Exact-property selection** (`feat/campaign-exact-selection`): the "Review for campaign" action should hand off through `POST /api/cockpit/campaigns/preview-selection` (read-only) and the existing `properties.property_id in [...]` explicit-selection draft path.
