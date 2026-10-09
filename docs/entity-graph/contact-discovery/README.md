# Entity Graph: contact discovery and history (integration packet)

**For:** the Entity Graph owner, on `release/cloudflare-production`.
**Status:** specification and regression baseline. **Entity Graph 8.5.0 (`91b4f873`) already implements part of it. Extend that implementation; do not build a second one.**
**Approved by:** Ryan, 2026-10-08. Reconciled with 8.5.0 on 2026-10-09.

## Reconciliation with 8.5.0 (`91b4f873`), from reading the code

### Already live
- **Linked contact candidates.** Produced by `contactCandidates()` in `apps/api/src/lib/domain/entity-graph/entity-graph-outreach-state.js`.
  - Prospects linked through `linked_property_ids_json`, shown with masked numbers.
  - Each is tagged `resolved_owner`, `graph_person` or `linked_unresolved`, with evidence.
- **SMS eligibility** is the builder's own readiness rule (`propertySmsEligibility`). Candidates never change it.
- **Last contact** (inbox thread + graph timestamps), **campaign membership** (count + latest) and the **thread suppression flag** per property.
- **Add to Campaign** pins property IDs on drafts only, through the builder's gates.

### Partial
- Candidates are looked up **only when the campaign graph has no phone for the property**. Hidden phones on properties that already show one phone are not surfaced. In baseline sample A, most of the 936 hidden associations sit on such properties.
- At most 12 linked prospects are read and 6 shown per property.
- **No non-owner role.** `likely_renting`, `reach_phone` (best-contact reach role) and occupant evidence are not classified. Renters fall into `linked_unresolved`. A renter can also read `resolved_owner` when the vendor links it to the owner's master owner.
- **History** is latest-contact only: no `send_queue` statuses or holds (e.g. `blocked_by_health_guard`), and no `message_events` timeline.

### Missing
- The dossier still hard-codes `suppressed: false` and `optedOut: false` (`entity-graph-service.js:1979-1980`, `:1998-1999`, `:2529-2530`). `timeline: []` remains at `:2312`, `:2430`, `:2475`, `:2540`, `:2614`, `:2637` and `:2656`.
- Tri-state restrictions are not shown: `sms_suppression_list`, `automation_suppressions`, `contact_outreach_state.dnc`, vendor-DNC `unknown`.
- Queue overlap (active/held queue rows per candidate phone) is not shown.

### Narrowly scoped fix (inside the existing implementation)
All inside `entity-graph-outreach-state.js` / `entity-graph-service.js`; no new read model.
1. Look up candidates for **every** property in the request, not only gap properties. Mark phones already in the graph `inCampaignGraph: true` (that field already exists).
2. Add a `role` field next to `resolution`, from evidence only:
   - `likely_renting` → `renter_or_occupant`;
   - best-contact `reach_phone` → `reach_relative`;
   - otherwise unchanged.
   Never derive `resolved_owner` for a prospect whose own flags say renter.
3. Add `restrictions` per candidate phone, tri-state, from `sms_suppression_list`, `phones.wrong_number_at`, `contact_outreach_state` and vendor DNC (missing = `unknown`).
4. Add queue overlap per property: count of non-terminal `send_queue` rows plus held rows with their reason.
5. Replace the hard-coded dossier `suppressed` / `optedOut` and the empty `timeline` with the same reads.

Gates: eligibility untouched (keep the `contact discovery … eligibility untouched` test green), no owner promotion, no target writes.

### Regression against the live model
The before/after run against 8.5.0's live model was **not executed in this session** (production read permission). The command is below.

| File | What it is |
|---|---|
| [HANDOFF.md](HANDOFF.md) | Defects measured on production (read-only), required read model, roles, contact states, UI, acceptance criteria |
| [regression/contact_discovery_regression.py](regression/contact_discovery_regression.py) | Seeded, read-only before/after measurement (outputs counts only, no phone numbers) |
| [regression/baseline-20261008.json](regression/baseline-20261008.json) | BEFORE numbers: 936 hidden associations / 922 phones in sample A, 448 / 448 in sample B |

## Non-negotiables

The PR must make all of these hold:

- **Zero automatic identity promotions.**
  - No writes to `seller.*` resolution tables.
  - No changes to `campaign_target_graph` identity or eligibility fields.
  - No row is shown as `owner` or `independently_corroborated` without that evidence.
- **Zero automatic campaign-target additions.**
  - Discovery never inserts `campaign_targets` or `send_queue` rows.
  - "Review for campaign" only hands off to the existing services (see step 5).
- **Restrictions are tri-state** (`true` / `false` / `unknown`). A missing vendor-DNC record is `unknown`, never `false`. Nothing is hard-coded `false`.

## Integration steps

1. **Read model.** Superseded by 8.5.0's `getEntityGraphOutreachState` / `contactCandidates`. Extend those (see "Narrowly scoped fix" above) instead of adding a view.
   - Original spec, for reference: a read-only view or RPC `public.property_contact_candidates`, as in HANDOFF.md §"Required read model". Unapplied migrations use the `PROPOSED_` filename prefix.
   - It gets one row per (property_id, person_key, phone), with:
     - `relationship_role`;
     - `contact_state`;
     - `provenance` (source list);
     - tri-state restriction columns.
2. **Service** (`apps/api/src/lib/domain/entity-graph/entity-graph-service.js`, line numbers at `91b4f873`):
   - `:1979-1982`, `:1998-1999` and `:2529-2530`: replace the hard-coded `suppressed: false`, `optedOut: false`, `lastContacted: null` and `lastResponse: null` with real values.
   - `timeline: []` at `:2312`, `:2430`, `:2475`, `:2540`, `:2614`, `:2637` and `:2656`: populate it from the real events:
     - send_queue status changes, including holds and their reasons (e.g. `blocked_by_health_guard: blocked_template_id`);
     - sends, deliveries and inbound replies (`message_events`);
     - suppressions (`sms_suppression_list`, `automation_suppressions`, `contact_outreach_state`);
     - `campaign_targets` membership.
   - Reconcile history at four levels: property, person, phone and exact person-phone pair.
3. **Dossier "Contacts" tab.**
   - List every candidate with evidence chips: source, role, resolution, vendor CNAM, activity, and DNC (tri-state).
   - Show history counts, campaign memberships and queue holds with their reasons.
   - Reach and relative phones are labelled as such, never as owner phones.
4. **Browse.**
   - Add filters for `contact_state` and role.
   - The research universe stays independent of SMS eligibility.
5. **"Review for campaign".**
   - Hand off through `POST /api/cockpit/campaigns/preview-selection` (read-only; branch `feat/campaign-exact-selection`).
   - Then use the existing explicit-selection draft path (`properties.property_id in [...]` target filter + `checkExplicitTargetContainment`).
   - No direct inserts.
6. **Campaign exclusions** (branch `feat/campaign-recipient-exclusion`; migration is PROPOSED and **not applied**).
   - After that table is applied, show an active `public.campaign_recipient_exclusions` row as restriction `campaign_excluded` for that campaign.
   - Until then, show `unknown`.
   - Do not read `campaigns.metadata` for exclusions.

## Acceptance (run before merge)

```sh
# read-only libpq session (PGHOST/PGUSER/PGDATABASE + ~/.pgpass); the script forces default_transaction_read_only
cd docs/entity-graph/contact-discovery/regression
python3 contact_discovery_regression.py \
  --visible-relation public.property_contact_candidates:phone_e164 --out after-$(date +%Y%m%d).json
python3 contact_discovery_regression.py --compare baseline-20261008.json after-$(date +%Y%m%d).json
```

**PASS requires all of the following:**
- `--compare` exits 0. Every BEFORE association is exposed: sample A ≥ 2,106 and sample B ≥ 448, with 0 still hidden.
- Every row carries a role, a state and provenance.
- Spot-checked against production for the sample, history, timeline and restriction counts match.
- Before/after snapshots show:
  - 0 new `campaign_targets` rows;
  - 0 new `send_queue` rows;
  - 0 changed `seller.*` rows;
  - 0 changed `campaign_target_graph` eligibility fields.
- Known case 2439 (Miami Test) shows the following, read-only:
  - the existing target;
  - the held queue row (`blocked_by_health_guard`);
  - the vendor-DNC state as `unknown`.

## Out of scope for this packet

- Changing identity resolution.
- Changing send eligibility or final-dispatch rules (owned by the 8.4.7 sending-safety owners).
- Queueing, launching or sending.
