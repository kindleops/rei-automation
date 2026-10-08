# Entity Graph: contact discovery and history (integration packet)

**For:** whoever owns the Entity Graph release candidate on `main`.
**Status:** specification + regression baseline only. **There is no competing implementation.** Fold this into the existing RC work; do not branch a second Entity Graph.
**Approved by:** Ryan, 2026-10-08.

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

1. **Read model.**
   - Add a read-only view or RPC, `public.property_contact_candidates`, as specified in HANDOFF.md §"Required read model". Unapplied migrations use the `PROPOSED_` filename prefix.
   - It gets one row per (property_id, person_key, phone), with:
     - `relationship_role`;
     - `contact_state`;
     - `provenance` (source list);
     - tri-state restriction columns.
2. **Service** (`apps/api/src/lib/domain/entity-graph/entity-graph-service.js`, line numbers at `fa12ff7b`):
   - `:1603-1608`: replace `eligible: !row.wrong_number_at`, `suppressed: false`, `optedOut: false`, `lastContacted: null` and `lastResponse: null` with values from the read model, plus the history join.
   - `timeline: []` at `:1938`, `:2050`, `:2095`, `:2160` and `:2225`: populate it from the real events:
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
