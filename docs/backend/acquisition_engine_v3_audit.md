# Acquisition Decision Engine — V3 Audit (Phase 0)

**Date:** 2026-06-20
**Author:** Engine V3 refactor (Phase 0 — audit before implementation)
**Scope:** Read-only audit of the live `public` schema and the existing engine. **No production data was modified. No migrations were applied. No migration repair was run.**
**Engine under audit:** `apps/api/src/lib/acquisition/acquisitionDecisionEngine.js` (3,667 lines, single module).
**DB:** Supabase project `lcppdrmrdfblstpcbgpf` (`real-estate-automation`), Postgres 17.

---

## 1. Executive summary

The V2 engine can emit catastrophically wrong, **autonomously-actionable** offers (a $173M cash offer on a $391K Austin duplex; a $20.99M offer on a $309K Caldwell house). The root cause is **not** a bad formula constant — it is that the engine treats **rows as transactions** and **never validates a comp's consideration against any independent anchor**.

The contamination is **systemic, not anecdotal**. The comp source (`recently_sold_properties`, 55,893 rows) contains **193 distinct "broadcast" considerations repeated across 3,794 parcels** spanning many ZIPs/cities on a single date — i.e., one institutional **package/portfolio price stamped onto every parcel in the package**. `7,470 / 55,893` (~13%) of comp rows carry a `sale_price > $3M`, the overwhelming majority on small SFRs. `buyer_purchase_events_v2` mirrors the same corrupted distribution (it shares lineage).

The good news: **the raw data already contains the fields needed to detect and neutralize this** (`apn_parcel_id`, `buyer_name_clean`/`buyer_key`, `sale_date`/`recording_date`, `document_type`, and a usable buyer registry in `buyer_entities_v2`). The V2 engine simply never used them, and the **primary comp view (`v_recent_sold_comps`) does not expose them**.

---

## 2. Live anomaly reproduction (BEFORE)

Pulled from `public.property_acquisition_scores` (persisted V2 output):

| property_id | address | subject est. value | comp_count | valuation_mid | valuation_conf | recommended_cash_offer | decision_tier |
|---|---|---:|---:|---:|---:|---:|---|
| 2136762817 | 5314 Atascosa Dr, Austin TX (Multifamily 2-4, 2u, 1,776sf) | $391,000 | **1** | **$332,498,300** | 55 | **$173,028,700** | CREATIVE_TERMS |
| 242567952 | 1711 N Illinois Ave, Caldwell ID (SFR, 1,550sf) | $309,000 | 12 | **$30,871,400** | **81** | **$20,994,500** | CREATIVE_TERMS |
| 2130847744 | 6310 Cambridge Glen Ln, Houston TX (SFR, 1,356sf) | $156,000 | 12 | $208,200 | 69 | $80,900 | CREATIVE_TERMS ✅ plausible |

**Anomaly 1 contaminating comp identified (live):** `2000 E Stassney Ln, Austin TX 78744`, Multi-Family, 2 units, 1,728 sf, `sale_price = $332,500,000`, sale_date 2025-04-09 — **same ZIP (78744) and near-identical physical profile** to the subject duplex. The value `$332,500,000` is **not unique to this row**: it appears on dozens of unrelated SFRs across Fort Worth, Houston, Spring, Humble, Arlington, Pflugerville, Elgin, Hockley, Kennedale on four shared dates (2025-01-16, 04-09, 07-16, 10-22). It is a **broadcast package/sentinel value**, not a duplex sale.

**Anomaly 2 (Caldwell):** the persisted score still shows 12 comps → $30.87M mid, confidence 81, offer $20.99M (computed 2026-06-20). The specific source rows were not reproducible by a narrow value+geo filter today (the comp set is recomputed per run and the underlying data has refreshed), but the **mechanism** — many parcels sharing one package consideration and one date — is reproduced at far larger scale across the table (see §4).

**2130847744 is the "good" control:** its 12 comps were *not* contaminated (the broadcast prices fell outside its radius/window, or were a minority that MAD removed), so its $208K valuation is plausible. This is exactly the case the refactor must **preserve**.

---

## 3. Exact root causes in V2 (with code references)

All line numbers in `apps/api/src/lib/acquisition/acquisitionDecisionEngine.js`.

1. **Rows are treated as independent transactions — no clustering.** `loadComparableProperties` (3391) merges three sources and de-dups on a key of `property_id | address | sale_date | sale_price` (3470-3480). A package sale split across **different** parcels has different `property_id` and `address`, so all N parcels survive as N "independent" comps. There is **no** grouping by `(buyer, date, consideration, document, APN-spread)`. → Anomaly 2 (12 "comps"), and the systemic 3,794-parcel problem.

2. **No independent plausibility anchor.** `adjustedCompPrice` (1165) blends PPSF/PPU/raw and then clamps the result to **the comp's own sale price** `clamp(blended, salePrice*0.55, salePrice*1.65)` (1230). A $332.5M consideration produces a ~$332.5M adjusted comp. Nothing compares the comp to the subject AVM, tax assessment, lane PPSF/PPU ceilings, or neighborhood medians.

3. **Outlier removal is disabled exactly when it's needed.** `removeOutliers` (1348) returns early with **no filtering for `< 5` comps** (1349). Anomaly 1 had **1** comp → straight through. And for `≥ 5` comps it uses median/MAD on `adjusted_price` (1352-1355); when the contamination is the **majority / identical** (a broadcast price), the median *is* the contaminated value and MAD ≈ 0 → nothing is rejected. → Anomaly 2.

4. **Duplication is rewarded as "consistency" and "depth."** `calculateValuation` (1411): `dispersion = stddev/mid`; identical duplicated comps → dispersion ≈ 0 → `consistencyScore = clamp(100 - dispersion*180) = 100` (1433) and `depthScore = clamp(count/8*100) = 100` (1430). This is precisely the **confidence 81 / consistency 100** seen in Anomaly 2. Effective sample size is never corrected for correlated rows.

5. **Contaminated valuation propagates into the investor ceiling and the offer.** `calculateInvestorCeiling` (1538) falls back to `valuation.mid * factor` when no buyer events qualify (1571-1593). `offerCalculation` (2524) sets `valuationCeiling = valuation.mid * maxArvFactor - repairs` (2543) and, when investor confidence `< 45`, blends `valuationCeiling*0.75 + behaviorCeiling*0.25` (2549). For Austin: even though `investor_ceiling_mid` was a sane $424K, the $332.5M valuation dominated 75% of the effective ceiling → **$173M offer**. The offer is **not** bounded by a conservative buyer exit.

6. **Asset lanes are too coarse; mismatched lanes comp freely.** `canonicalAssetType` (580) + `assetFamily` (607) collapse everything into `residential | multifamily | commercial | land | other`. `assetCompatible` (1105) returns true for any same-family pair, so **condo ↔ SFR**, **duplex ↔ 200-unit apartment** (both "multifamily"), and **storage ↔ office ↔ strip** (all "commercial") are mutually eligible. There are no DUPLEX/TRIPLEX/FOURPLEX, MF size-band, storage, retail, office, or land sub-lanes.

7. **Confidence can reach 100 with comps regardless of quality.** `calculateAcquisitionDecision` (2865): `confidenceCap = selected.length ? 100 : 45`. Any non-empty comp set unlocks full confidence.

8. **No hard invariants.** Nothing enforces `offer ≤ conservative buyer exit`, `value ≤ K× anchor`, single-comp share caps, NaN/Infinity guards, or unit normalization.

---

## 4. Systemic contamination scope (live evidence)

`recently_sold_properties` (n = 55,893):

| metric | value |
|---|---:|
| rows with `sale_price > $3M` | **7,470** (13.4%) |
| rows with `sale_price > $50M` | 2,184 |
| broadcast considerations (same price on ≥4 parcels across ≥3 ZIPs) | **193** |
| parcels inside those broadcast clusters | **3,794** |

Representative broadcast clusters (one consideration → many unrelated parcels, one date, often one buyer):

| consideration | parcels | distinct ZIPs | distinct cities | date(s) |
|---:|---:|---:|---:|---|
| $1,029,832,300 | 89 | 38 | 21 | 2024-04-18 |
| $751,093,560 | 92 | 18 | 8 | 2025-12-15 |
| $627,220,020 | 84 | 38 | 21 | 2024-09-30..10-01 |
| $577,233,300 | 87 | 42 | 25 | 2024-11-26..12-02 |
| $332,500,000 | (Anomaly 1) | many | many | 4 dates |

`buyer_purchase_events_v2` (n = 55,479) shows an **identical** price histogram (same considerations, same counts, frequently `distinct_buyers = 1`) → it is derived from the same ingest and exhibits the same package-broadcast pattern. These are **real institutional package acquisitions** — extremely valuable as **demand** signals, but the **per-parcel price is fiction**.

---

## 5. Source inventory & grain

Legend — Conf = audit confidence in the field's meaning. ✅ present / ⚠ partial / ❌ absent.

### `properties` (subject; n≈ scored universe) — **rich**
- **Grain:** one row per subject property. **Price:** `estimated_value`, `mls_current_listing_price`, `sale_price`/`sale_date` (last sale). **Asset:** `asset_class/subclass/subtype/type`, `asset_type_confidence`, `normalized_asset_class`, `land_use`, `county_land_use_code`, `zoning`, `commercial_units`, `multifamily_units`, `storage_units`, `strip_center_units`, `is_vacant_land`, `is_infill_lot`. **Physical:** `building_square_feet`, `lot_square_feet/acreage`, `total_bedrooms/baths`, `year_built/effective_year_built`, `building_condition`, `avg_sqft_per_unit`. **Income:** `monthly_rent`, `rent_estimate`, `gross_monthly_income`, `gross_annual_income`, `noi_estimate`, `cap_rate` (sparse). **Debt/creative:** `total_loan_balance`, `total_loan_amt`, `total_loan_payment`, `lien_position`, `lien_type`, `lienholder_name`, `active_lien`, `equity_amount/percent`. **Distress:** full foreclosure/preforeclosure/auction/default/tax-delinquent. **Parcel:** `apn_parcel_id`. **Buyer/seller identity:** owner only (no transaction counterparties). **Conf:** High.
- **Limitations:** income/debt fields are sparsely populated; `cap_rate`/`noi_estimate` not reliable for income lanes.

### `recently_sold_properties` (PRIMARY comp base; n=55,893)
- **Grain:** **one row per parcel**, *not per transaction*. **Price:** `sale_price` (⚠ contains package/broadcast considerations), `mls_sold_price`. **Date:** `sale_date`, `recording_date`. **Buyer identity:** `buyer_name`/`buyer_name_clean`/`buyer_key` ✅. **Seller identity:** `owner_name`/`owner_name_clean`/`owner_key`/`is_corporate_owner`/`out_of_state_owner` ✅. **Doc identity:** ❌ no deed/instrument/document number. **Parcel:** `apn_parcel_id` ✅. **Asset/physical:** `property_type/class`, `county_land_use_code`, `units_count`, `building_square_feet`, beds/baths, year built, `construction_type`, `exterior_walls`, `renovation_level_classification`. **Income:** ❌. **Conf:** High on grain.
- **Duplication risk:** **HIGH** — package considerations broadcast across many parcels (§4). **Package-sale risk:** **HIGH**. Clustering keys available: `(buyer_key|buyer_name_clean, sale_date, sale_price)` across distinct `apn_parcel_id`.

### `v_recent_sold_comps` (VIEW; the path the engine actually uses via RPC)
- **Grain:** per parcel (wraps the comp base). **Exposes:** address, lat/lng, `sale_date`, `sale_price`, `mls_*`, `units_count`, physical, `normalized_asset_class`, `computed_ppsf`, `sale_source`, `is_recent_6_months`, `is_usable_comp`.
- **CRITICAL GAP:** **does NOT expose** `buyer_name/buyer_key`, `owner/seller`, `apn_parcel_id`, `recording_date`, or any document field. → The **primary comp path is structurally blind to transaction identity.** V3 needs an **additive** view extension to surface clustering keys. Interim: cluster by `(sale_price, sale_date, address-batch)` which still catches broadcasts.

### `buyer_comp_properties_v2` (modeled comp; "advanced" source)
- **Grain:** per parcel. **Rich:** `apn_parcel_id`, `last_sale_doc_type`, `document_type`, `recording_date`, `sale_date`, `sale_price`, `sale_price_source`, `auction_date`, `default_date`, `legal_description`, `total_loan_amount/balance/payment`, `lienholder_name`, `tax_*`, `assessed_*`, `calculated_*_value`, full physical, `hoa_*`, `mls_*`, `ppsf/ppu/ppbd`, `comp_confidence_score`, `deal_grade`, `batch_id`, `source_record_id/source_deal_id`. **Buyer/seller identity:** ❌ (no buyer/seller name columns). **Conf:** High.
- **Use:** best source for **channel classification** (`document_type`, `sale_price_source`, `auction_date`) and physical detail; lacks counterparty identity for clustering.

### `buyer_purchase_events_v2` (buyer-side fact; n=55,479)
- **Grain:** per (buyer, parcel) purchase event; **links** to comp via `comp_property_id`, to entity via `buyer_entity_id`. **Identity:** `buyer_key`, `buyer_name`, `buyer_type`, `is_corporate_buyer`, `out_of_state_owner` ✅. **Price:** `purchase_price` (⚠ same broadcast contamination), `purchase_price_source`. **Date:** `purchase_date`, `recording_date`. **Doc:** `document_type`. **Dedup:** `source_dedup_key` ✅. **Conf:** High.
- **Use:** investor/institutional **demand** and buyer-behavior; cluster by `(buyer_key, purchase_date, purchase_price)`. **Do not** use per-parcel price from package clusters as a comp.

### `buyer_entities_v2` (buyer registry — **already exists**)
- **Grain:** one row per canonical buyer (`buyer_key`). **Has:** `normalized_buyer_name`, `is_corporate_buyer`, `is_repeat_buyer`, `mailing_address_*`, `purchase_count(_180d/_365d)`, `markets_active`, `counties_active`, `zips_active`, `preferred_asset_classes`, `preferred_price_min/max`, `avg_purchase_price`, `median_purchase_price`, `avg_ppsf`, `avg_units`, `investor_score`, `velocity_score`, `corporate_buyer_score`, `dispo_priority_score`. **Conf:** High.
- **Use:** the seed for V3 buyer-entity resolution + institutional registry + observed buy-box. Build **on** this, not from scratch. Multiple mailing addresses/subsidiaries per parent will require an additive alias layer.

### `property_valuation_snapshots` (parallel valuation)
- **Grain:** per property valuation snapshot. **Has:** `estimated_arv`, `median_sale_price/ppsf/ppu`, `low/high_value`, `repair_estimate`, `conservative_offer`, `target_offer`, `max_allowable_offer`, `buyer_exit_price`, `included/excluded_comp_count`, `included/excluded_comps` (jsonb), `comp_methodology`, `asset_class`. **Conf:** Medium (separate lineage; may itself be contaminated downstream).

### `property_acquisition_scores` (engine output)
- **Columns (live):** `property_id`(text), `valuation_low/mid/high`, `valuation_confidence`, `comp_count`, `weighted_comp_score`, `investor_ceiling_low/mid/high`, `buyer_demand_score`, `liquidity_score`, `estimated_repairs`, `recommended_cash_offer`, `minimum_acceptable_offer`, `expected_assignment_fee`, `subject_to_score`, `seller_finance_score`, `lease_option_score`, `novation_score`, `best_strategy`, `aos_score`, `confidence`, `decision_tier`, `evidence`(jsonb), `computed_at`, `created_at`, the pressure/situation scores, `owner_situation_primary/scores`, `recommended_conversation_angle`, `recommended_offer_stack`(jsonb).
- **Missing for V3 (additive migration needed):** `engine_version/model_version/formula_version`, `input_data_as_of`, `canonical_asset_lane`+confidence, separate valuation universes (retail/investor/institutional/income/liquidation), `conservative_buyer_exit`, novation/creative term blocks, return metrics, multi-dimensional confidence, `execution_state`, anomaly flags, transaction-cluster summary, active feature flags. **No `scored_at`** (use `computed_at`).

### `census_geo_metrics` (Stage 5 context)
- **Grain:** per geo (`geo_level` tract/zcta/county, `geoid`). **Allowed:** `median_household_income`, `vacancy_rate`, `renter_rate`, `owner_occupancy_rate`, `median_year_built`, `housing_age`, totals (`total_population/households/housing_units`, occupied/vacant/owner/renter units), pre-computed `*_heat_score`, `acquisition_pressure_score`, `source_year`, `variables`(jsonb), `raw`(jsonb). **Conf:** Medium.
- **Guardrail:** `variables`/`raw` jsonb may contain protected-class fields — the V3 Census allowlist must read **only** the named market columns above and never iterate `raw`.

### `campaign_target_graph` (downstream consumer)
- Carries `acquisition_score`, `cash_offer`, `estimated_value`, `equity_*`, owner-financial `net_asset_value`/`buying_power`/`income`. **Risk:** contaminated `cash_offer` propagates here. **Guardrail:** owner-financial fields must **never** reduce intrinsic property value (mission §21/§32).

---

## 6. Comp loader & RPC lineage

`loadComparableProperties` (engine 3391) does:
1. `rpc('get_comp_candidates_for_subject', { p_subject_property_id, p_radius_miles, p_months_back, p_limit:100 })` → ids → detail from **`v_recent_sold_comps`** (identity-blind). **Primary.**
2. If RPC empty → fallback scan of `recently_sold_properties` filtered by zip/market/state, `limit 100`.
3. **Always** also scans `buyer_comp_properties_v2` filtered by zip/market, `limit 150` ("advanced").
4. Merge + de-dup on `property_id|address|sale_date|sale_price` (does **not** collapse cross-parcel packages).

`loadBuyerPurchases` (3484): `buyer_purchase_events_v2` filtered by zip/market/state, `order purchase_date desc, limit 250`.

**RPC/view definition** for `get_comp_candidates_for_subject` / `v_recent_sold_comps` was not found in `apps/api/supabase/migrations` (only referenced in `20260526174304_create_deal_context_index.sql`) → consistent with the known **migration drift** (repo migrations ≠ prod's real history). The view exists in prod; its definition must be treated as prod-authoritative and extended additively.

---

## 7. PGRST204 / schema-cache risks

- The engine's `SELECT` constants are hand-maintained column lists against tables/views. Adding V3 columns to `property_acquisition_scores` (or selecting new comp columns) **before PostgREST refreshes its schema cache** will throw `PGRST204` on upsert/select.
- V2 already has partial tolerance: `isOptionalSourceMissing` (3066), `isMissingColumnError` (3070), `missingColumnName` (3078), `optionalEnrichmentQuery` (3111), `optionalQuery` (3192). **Required** sources still throw (correct — must fail loud).
- **Mitigation for V3:** additive migrations only; new persisted columns must be nullable; the writer must degrade gracefully if a new column is absent (write-subset) and **log loudly** rather than convert a required failure into an empty result. Reload PostgREST schema cache after migration.

---

## 8. Fields available to fix it (feasibility)

Transaction clustering is feasible **today** on the identity-bearing sources:
- **Sold base / buyer events:** cluster `(buyer_key | buyer_name_clean, sale_date | purchase_date, consideration)` across distinct `apn_parcel_id`/`property_id`; flag **package** when one `(price,date[,buyer])` spans ≥ K parcels or ≥ M ZIPs.
- **Primary view path:** until `v_recent_sold_comps` is extended, cluster on `(sale_price, sale_date, address-batch)` — still catches every broadcast in §4.
- **Plausibility anchors (independent of comps):** subject `estimated_value`, `assessed_total_value`, lane PPSF/PPU ceilings, Census `median_home_value`/`median_household_income` (low weight).
- **Buyer resolution:** `buyer_entities_v2` already provides canonical key, corporate flag, buy-box, velocity.

---

## 9. Remediation → V3 module map

| Failure (§3) | V3 module(s) | Stage |
|---|---|---|
| Rows≠transactions; packages | `transactionClustering.js` | 1 |
| No plausibility anchor; price implausible | `transactionQualification.js`, `modelConstants.js` | 1 |
| Outlier logic defeated | clustering + qualification (pre-valuation) | 1 |
| Duplication→fake consistency/depth | effective-sample-size in clustering; confidence model | 1/5 |
| Contaminated value→ceiling→offer | hard invariants + `offerEconomics.js` (buyer-exit-anchored) | 2 |
| Coarse asset lanes | `assetClassification.js` | 1 |
| Confidence cap too loose | `confidenceModel.js` | 5 |
| No invariants/gates | `acquisitionInvariants.js`, `executionGates.js` | 1/2 |

---

## 10. Safety attestation

- All queries were **read-only** `SELECT`. No `INSERT/UPDATE/DELETE/DDL`. No migrations applied. No `supabase migration repair`. No SMS/queue/provider activity. Production scoring behavior is unchanged by this audit.
- New V3 code lands as **new modules + tests**, default-off behind feature flags, with **no rewiring of the live engine** until explicitly authorized.

---

## 11. Required migrations (to be generated, not applied)

1. **Additive** columns on `property_acquisition_scores` for V3 lineage/universes/execution-state/anomaly/cluster-summary (§5).
2. **Additive** extension of `v_recent_sold_comps` to surface `apn_parcel_id`, `buyer_name_clean`/`buyer_key`, `owner_key`, `recording_date`, source lineage (§6) — enables identity-based clustering on the primary path.
3. (Stage 5) buyer alias/parent layer over `buyer_entities_v2` for institutional registry.

Migration state is **drifted** (repo ≠ prod). Generate files; **do not** apply or repair without explicit authorization and a prod-history reconciliation.

---

## 12. Live join-lineage audit (Item 5A, 2026-06-21)

Proven against prod (read-only) before rewiring the loader.

### Candidate → source identity chain
- `get_comp_candidates_for_subject(p_subject_property_id, p_radius_miles, p_months_back, p_limit)` returns rows keyed by **`comp_id` (uuid)** plus `property_id`, address, `asset_class` (normalized, e.g. `single_family`), `sale_price`, `sale_date`, `mls_sold_price/date`, beds/baths/sqft/units/year, `building_condition`, `construction_type`, `distance_miles`, `similarity_score`, `comp_confidence_score`. **No buyer / APN / document / recording fields.**
- **`comp_id` === `v_recent_sold_comps.id` === `buyer_comp_raw_v2.id`** — verified **5000/5000** (and 8/8 on the Houston probe). This is the deterministic primary-path identity key.
- `v_recent_sold_comps.id` is **NOT** equal to `buyer_comp_properties_v2.id` nor `recently_sold_properties.id` (0/5000 each). Candidate `property_id` matches `recently_sold_properties`/`buyer_comp_properties_v2` only ~1/8 of the time — those are different datasets; do not join candidates to them by `property_id`.

### Identity fields available on `buyer_comp_raw_v2` (by `id`)
`owner_name` / `owner_1_name` (grantee = comp buyer), `apn_parcel_id`, `document_type` / `last_sale_doc_type`, `recording_date`, `sale_price`/`saleprice`, `mls_sold_price`, `is_corporate_owner`, `out_of_state_owner`, `owner_address_full` (buyer mailing), `total_loan_amt`/`balance`/`payment`, `lienholder_name`, `subdivision_name`, `school_district_name`. Table: 47,985 rows; 40,351 with owner; 31,759 priced+owner.

### Dead / mismatched joins (do NOT use)
- `buyer_purchase_events_v2.comp_property_id` is **NULL for all 55,479 rows** → the event→comp FK is unusable; cannot enrich comp buyers from purchase events.
- `recently_sold_properties.buyer_key` (`buyer_…`) ≠ `buyer_entities_v2.buyer_key` (`bk_…`) — different schemes (0/5000).
- `buyer_entities_v2` joins by **`normalized_buyer_name`** = `lower(strip-entity-suffix(name))` — deterministic but sparse for comp buyers (**208/5000 ≈ 4%**); use only as bonus buy-box/velocity enrichment, never required.

### Cardinality / rates
- candidate↔`buyer_comp_raw_v2`: **1:1**, ~100% match, collision rate 0 (uuid PK).
- candidate buyer identity coverage: governed by `buyer_comp_raw_v2.owner_name` (~84% have owner). Rows without owner → `IDENTITY_UNRESOLVED` (pricing eligibility reduced/removed).
- `sale_price = 0` is common in candidates (non-sales / current-owner records) → channel = NON_SALE, excluded from pricing.

### Decision
Production-compatible enrichment = `candidate.comp_id → buyer_comp_raw_v2` (batch `.in('id', ids)`), buyer archetype from `owner_name` + `is_corporate_owner`, optional `buyer_entities_v2` by normalized name. **No migration required.** The previously generated `v_recent_sold_comp_identity` (which selected from `recently_sold_properties`) is the **wrong source** for the primary path and is amended in this pass (see §14). The blind `buyer_comp_properties_v2` ZIP pull in the V2 loader is the contamination/cross-lane vector and is removed from the V3 path.

---

## Item 5C — Income Intelligence Foundation: data-source audit

*Read-only audit (repo grep + live Supabase introspection, project `lcppdrmrdfblstpcbgpf`). No writes, no DDL.*

### Headline finding

Across **24,972** properties with `units_count >= 2`:

| Field | Coverage | Notes / basis |
|---|---|---|
| `monthly_rent` | **0%** | column exists, entirely null |
| `rent_estimate` | **0%** | entirely null |
| `gross_monthly_income` / `gross_annual_income` | **0%** | entirely null |
| `noi_estimate` | **0%** | entirely null |
| `cap_rate` | **0%** | entirely null |
| `building_square_feet` | **100%** | present everywhere |
| `units_count` | **100%** | present (selection key) |
| `tax_amt` | **~99.1%** (24,756) | public tax record → `PROVIDER_REPORTED`/`ACTUAL` candidate |
| `total_loan_balance` | numeric on 100% | **but 59% are `0`** (14,704) — ambiguous *free-and-clear* vs *missing-coded-as-zero* |
| `total_loan_payment` | numeric on 100% | annual payment/balance ratio ≈ **0.36** (implausible for P&I) → treat as `PROVIDER_REPORTED`, **low reliability** for DSCR |
| `total_loan_amt` | numeric on 100% | original loan amount |
| `past_due_amount` | **0%** | null on income assets |
| `mls_current_listing_price` | ~0% (10 rows) | negligible |

`properties.raw_payload_json` was probed across 4,000 income rows: the **only** income-adjacent keys present are `tax_amt`, `total_loan_*`, `units_count` (and `_1` duplicates). **No** rent / lease / occupancy / income / NOI / cap / expense keys exist in the raw provider payload. There is **no** rent-roll, lease, rental-comparable, operating-statement, or underwriting/override table in the schema (`rent_comp|rental_comp|lease|rent_roll|underwrit|operating_statement` → 0 tables).

**Conclusion:** live income valuation is data-blocked. Rent, occupancy, NOI, cap rate, and operating expenses must be treated as `UNKNOWN` (never zero); NOI/cap/GRM stay provisional. The only qualified income-adjacent evidence today is **property taxes** (~99%) and **debt** (present but low-reliability and zero-ambiguous). Comparable PPU/PPSF (from `buyer_comp_raw_v2`) remains the only qualified valuation path for most income properties. Do not fabricate rents/NOI/cap/expenses.

### Source inventory (income-relevant)

| Source | Grain | Income-relevant fields | Basis / reliability | Join key | Suitable for auto-UW? |
|---|---|---|---|---|---|
| `properties` | 1/property | `monthly_rent`,`rent_estimate`,`gross_monthly_income`,`gross_annual_income`,`noi_estimate`,`cap_rate` (all 0%); `tax_amt`(99%),`total_loan_balance/payment/amt`(100% numeric),`past_due_amount`(0%) | tax=PROVIDER; rent/NOI/cap=absent; loan=PROVIDER_REPORTED low-rel | `property_id` | tax: yes; rent/NOI/cap: no; debt: shadow only |
| `properties.raw_payload_json` | 1/property | tax, loan, units only (no rent/income) | PROVIDER raw | `property_id` | no new income signal |
| `buyer_comp_raw_v2` | 1/comp | `tax_amt`,`total_loan_*`,`past_due_amount`,`mls_current_listing_price`,`tax_delinquent*` | PROVIDER (DataTree-class) | `id`=comp_id | PPU/PPSF + tax evidence: yes |
| `property_cash_offer_snapshots` | 1/offer-snapshot | `estimated_mortgage_balance`,`estimated_mortgage_payment` | SYSTEM_INFERRED (modeled) | `property_id` | debt: modeled fallback only |
| `census_geo_metrics` | 1/geo | `median_household_income`,`renter_rate`,`renter_occupied_units`,`owner_occupancy_rate`,`vacancy_rate`,`vacant_housing_units` | PROVIDER (Census ACS) | geo (zip/tract) | market-level rent-demand/occupancy proxy only — NOT property rent |
| `thread_ai_state` | 1/thread (6,049) | `occupancy_status` (**0% populated**) | OWNER_REPORTED (when present) | thread→property | conversation occupancy: structurally ready, empty today |
| `prospects`,`master_owners`,`inbox_*_hydrated` | 1/owner or thread | `portfolio_total_loan_balance/payment/tax_amount`,`past_due_amount`,`est_household_income`,`likely_renting` | PROVIDER rollups | owner/property | owner-level debt rollups; not per-asset income |
| `recently_sold_properties` | 1/sold | `mls_current_listing_price`,`raw_payload` | PROVIDER | property | sale evidence; no rent |

### Reliability flags

- **Debt zero-ambiguity:** `total_loan_balance = 0` (59% of income assets) cannot be distinguished between *free-and-clear* (actual 0) and *missing*. The canonical loader treats provider `0` balance as `OWNER_REPORTED`-equivalent **`PROVIDER_REPORTED` with a free-and-clear flag + reduced confidence**, never as a verified ACTUAL zero that authorizes subject-to.
- **Payment reliability:** annualized `total_loan_payment / total_loan_balance` ≈ 0.36 is implausible for amortizing P&I → flagged `PROVIDER_REPORTED`, low confidence; insufficient alone to make subject-to/seller-finance *underwritten*.
- **Census is geo-level**, never a property rent. May only feed `MARKET_MODELED` market-rent priors and occupancy context, clearly labeled.
- **Conversation occupancy** (`thread_ai_state.occupancy_status`) is the designed home for `OWNER_REPORTED` facts but is currently 0% populated — an enrichment target, not a present source.

---

## Item 5C — Read-only coverage report (live, no persistence)

*Source: `properties` where `units_count >= 2` (total 24,972). Read-only census; nothing persisted.*

### By canonical lane

| Lane | Count | Actual rent | Est rent | NOI | Cap | Tax | Debt (numeric) | Debt > 0 | Payment > 0 | Sqft | Units |
|---|---|---|---|---|---|---|---|---|---|---|---|
| DUPLEX | 13,855 | 0% | 0% | 0% | 0% | 99.2% | 100% | 38.2% | 38.4% | 100% | 100% |
| TRIPLEX | 3,639 | 0% | 0% | 0% | 0% | 99.6% | 100% | 46.6% | 46.7% | 100% | 100% |
| FOURPLEX | 2,386 | 0% | 0% | 0% | 0% | 99.0% | 100% | 46.3% | 46.5% | 100% | 100% |
| MULTIFAMILY_5_20 | 4,199 | 0% | 0% | 0% | 0% | 99.0% | 100% | 39.8% | 41.0% | 100% | 100% |
| MULTIFAMILY_21_99 | 720 | 0% | 0% | 0% | 0% | 98.6% | 100% | 54.2% | 54.7% | 100% | 100% |
| MULTIFAMILY_100_PLUS | 173 | 0% | 0% | 0% | 0% | 94.2% | 100% | 55.5% | 55.5% | 100% | 100% |

### By state (top 8, income assets)

| State | Count | Tax | Debt > 0 | Any rent |
|---|---|---|---|---|
| FL | 6,366 | 98.3% | 32.3% | 0% |
| IL | 5,442 | 99.3% | 36.4% | 0% |
| CA | 4,896 | ~100% | 65.1% | 0% |
| TX | 1,350 | 98.8% | 35.0% | 0% |
| RI | 893 | 100% | 49.7% | 0% |
| MN | 838 | 99.9% | 33.1% | 0% |
| PA | 822 | 98.2% | 40.0% | 0% |
| CT | 733 | 100% | 46.9% | 0% |

**Coverage conclusions:**
- **Rent / NOI / cap / occupancy: 0% in every lane and state.** No conflicts and no stale records exist because there are no income records at all.
- **Square feet + unit count: 100%** — comp PPU/PPSF valuation is fully supported.
- **Taxes: ~99%** — usable property-specific expense evidence (`PROVIDER_REPORTED`).
- **Debt: numeric on 100%, but only 38–55% have a positive balance** (rest are `0` = ambiguous free-and-clear vs missing). Payment present on a similar share; reliability low (see audit §reliability). Debt may seed *shadow* subject-to/seller-finance only — never authorize.
- Alternate-source coverage gain is **negligible**: `raw_payload_json`, comps, and census contain no per-property rent/NOI/occupancy.

---

## Item 5C — Enrichment plan (ranked)

| # | Gap | Lanes affected | Source class | Importance | Coverage gain | Confidence impact | Effort | Dependency | Required before |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Owner-reported rent / occupancy** via existing seller conversations (`thread_ai_state.occupancy_status` + new extraction) | all income | already present pipeline, 0% populated → conversation extraction | High | Medium (only engaged leads) | OWNER_REPORTED (med) | Med — extraction contract exists (this pass); wire population later | shadow underwriting per-deal |
| 2 | **Tax → expense seeding** (taxes already ~99%) connect into expense model | all income | data present, not connected | High | High | raises expense completeness | Low | none | shadow |
| 3 | **Debt-aware shadow subject-to** using present loan balance/payment (flag zero-ambiguous, low confidence) | 2–4 + MF | data present, low reliability | Med | High (numeric) | low (provider) | Low | none | shadow only — NOT authorization |
| 4 | **Rent-roll / lease document upload** (verified actual rent + occupancy) | all income | document upload (new) | High | High where obtained | ACTUAL/VERIFIED (high) | Med — UI + parser | document pipeline | underwritten income value |
| 5 | **Qualified rental comparables** (actual signed rents) | all income | new approved provider OR MLS-derived | High | High | COMPARABLE_DERIVED (med) | High | provider/legal — UNVERIFIED today | qualified market rent |
| 6 | **Observed cap-rate evidence** (qualified single-asset sale + time-aligned NOI) | MF 5+ | derivable once NOI exists; needs both sale + NOI | Med | Low (rare) | OBSERVED (high) | Med | depends on #4/#5 | qualified cap model |
| 7 | **Provider rent estimate** (e.g. AVM rent) | all income | current provider IF it offers rent | Med | High if available | PROVIDER_REPORTED (low/med) | Low | provider capability **UNVERIFIED** | market-rent prior |
| 8 | **Actual operating statements / T-12** | MF 5+ | document upload | Med | Low (large deals only) | ACTUAL (high) | Med | document pipeline | underwritten NOI for 5+ |

**Notes:** No provider rent capability is claimed as available — items #5 and #7 are explicitly gated on *unverified* provider capability. Items #1–#3 are achievable with data/pipelines already in the repo and are the highest-leverage near-term moves; none enable autonomous execution.

---

## Item 5D — Self-Storage Intelligence & Underwriting (live audit, 2026-06-22)

Read-only observations from production Supabase `real-estate-automation`
(`lcppdrmrdfblstpcbgpf`). No production data was written.

### 1. Inventory & classification

Likely self-storage records identified from `public.properties` by ORing the
storage boolean flags, the `storage_units` numeric column, and a keyword scan
over the asset-classification text fields (`property_type`, `asset_class`,
`asset_subtype`, `normalized_asset_class`, `asset_label`, `land_use`, `zoning`,
`original_property_type`, `commercial_property_type`). Keywords: self storage,
mini storage, mini warehouse, storage facility, storage unit(s), climate
controlled storage, vehicle/RV/boat storage, warehouse storage, storage condo,
portable storage.

| Signal | Count |
| --- | ---: |
| **Likely self-storage properties (any signal)** | **376** |
| `is_storage` / `is_storage_facility` = true | 372 |
| `is_self_storage` / `is_self_storage_facility` = true | **0 (never populated)** |
| `is_mini_storage` / `is_mini_storage_facility` = true | **0 (never populated)** |
| `storage_units` not null | **0 (never populated)** |
| keyword-only (no boolean flag) | 4 |

Classification is coarse/binary — only a generic `is_storage` flag is populated.
The data does **not** distinguish self-storage facility vs. mini-warehouse vs.
storage condominium vs. portable/mobile-storage business vs. vehicle/RV/boat
storage. `asset_type_confidence` is null for all 376.

### 2. Markets / states & physical variants

| State | Count | Avg bldg sqft | <10k sqft | 10k–50k | >50k |
| --- | ---: | ---: | ---: | ---: | ---: |
| CA | 205 | 6,034 | 185 | 15 | 5 |
| TX | 97 | 24,455 | 30 | 53 | 14 |
| AZ | 27 | 44,860 | 3 | 14 | 10 |
| FL | 17 | 26,816 | 5 | 8 | 4 |
| GA | 13 | 18,136 | 6 | 5 | 2 |
| NV | 8 | 28,543 | 2 | 5 | 1 |
| WA | 5 | 56,978 | 0 | 1 | 4 |
| PA | 3 | 1,629 | 3 | 0 | 0 |
| MN | 1 | 226 | 1 | 0 | 0 |

**Misclassification / package risk is material.** The CA cohort (205; 90% under
10k sqft; avg ~6k sqft) is dominated by records too small to be genuine
multi-building facilities — almost certainly garages, individual storage
*condominiums*, or properties carrying a storage land-use code rather than
operating facilities. TX/AZ/FL (avg 24k–45k sqft, majority 10k–50k) are
physically plausible facilities. **The classifier applies a physical-
plausibility gate (building/NRSF floor) before treating a storage-flagged record
as a genuine facility**, and never assumes a storage flag implies an operating
facility.

### 3. Operating-data coverage (critical finding)

Across all 376 likely-storage records:

| Field | Coverage | Note |
| --- | ---: | --- |
| `building_square_feet` (GBA proxy) | 376 / 376 (100%) | gross only — **no NRSF column exists** |
| `lot_square_feet` | 376 / 376 (100%) | land/expansion proxy |
| `units_count` > 0 | 111 / 376 (29.5%) | parcel/garage units — **not** storage rentable units |
| `storage_units` | 0 / 376 | column exists, never populated |
| `noi_estimate` | 0 / 376 | **no NOI anywhere** |
| `cap_rate` | 0 / 376 | **no cap rate anywhere** |
| `monthly_rent` / `rent_estimate` | 0 / 376 | **no rent anywhere** |
| `mls_current_listing_price` | 0 / 376 | no asking price |
| occupancy / economic occupancy | n/a | **no column exists** |
| unit mix / climate-control / drive-up / vehicle spaces | n/a | **no column exists** |
| expense lines (taxes/ins/payroll/mgmt/utilities/repairs/…) | n/a | **no column exists** |
| ancillary income (tenant insurance/admin/late/merch/truck) | n/a | **no column exists** |
| debt terms (balance/rate/maturity/balloon/covenants) | n/a | not on `properties` for storage |

**Zero genuine storage operating data exists in production.** The only known
facts are physical size (GBA proxy + lot) and a coarse storage flag.

### 4. Qualified comparable transactions

Storage transactions searched in both fact tables by matching `property_type` /
`normalized_asset_class` against the storage keyword set:

| Source | Storage rows | With price | With sqft | States |
| --- | ---: | ---: | ---: | ---: |
| `buyer_comp_raw_v2` | **0** | 0 | 0 | 0 |
| `buyer_purchase_events_v2` | **0** | 0 | 0 | 0 |

The buyer transaction universe is **residential-only**: `single_family`
(48,533), `multifamily` (5,046), `apartment` (1,900). No commercial, no
warehouse, no self-storage transactions at all. Storage buyer-identity coverage
is 0%; storage package/portfolio rate is undefined (no transactions).

### 5. Source / record-grain summary

| Table / view | Grain | Storage-relevant fields | Source | Coverage | Reliability | Join key | As-of | Underwriting suitability |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `public.properties` | 1 / property | `is_storage*`, `building_square_feet`, `lot_square_feet`, `units_count`, `property_type`, `asset_*`, `land_use`, `zoning` | provider import | size 100%; flags binary; operating 0% | LOW for facility-truth; OK for size | `property_id` | `asset_classified_at` (sparse) | physical size + provisional classification only |
| `public.buyer_comp_raw_v2` | 1 / comp sale | `property_type`, `normalized_asset_class`, `sale_price`, `building_square_feet`, `property_address_state`, `sale_date` | provider/MLS | 0 storage rows | n/a for storage | identity keys | `sale_date` | none for storage |
| `public.buyer_purchase_events_v2` | 1 / buyer purchase | `normalized_asset_class`, `purchase_price`, `sqft`, `buyer_type`, `property_state` | derived | 0 storage rows (residential-only) | n/a for storage | `normalized_buyer_name` | event date | none for storage |
| `public.buyer_entities_v2` | 1 / buyer | `buyer_type`, `preferred_asset_classes[]`, `avg/median_purchase_price` | derived | no storage preference observed | n/a | `normalized_buyer_name` | rollup | none for storage |

### 6. Conclusion → engine behavior

The self-storage model is built to be **correct when evidence exists**, but on
the **current production inventory it returns DATA_REQUIRED / PROVISIONAL_
SCENARIO for every record** — never a fabricated qualified value, NOI, cap rate,
or authorized offer. Item 5D therefore ships deterministic, source-traceable
storage models + a class-first qualifier that gates on real evidence depth;
supplements tests with **clearly-labeled deterministic fixtures** (not a
production sample); and leaves all outbound execution and persistence disabled.
No storage-specific migration is required — the canonical income snapshot
(JSONB + structured provenance) absorbs all storage fields (mission §20).
