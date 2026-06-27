# Comp Intelligence Workspace Recovery Audit

**Date:** 2026-06-26
**Primary Regression Subject:** 8734 W Vale Dr, Phoenix, AZ 85037 (property_id: 24554327)
**Observed Symptom:** Subject card issues, severely limited comp card data, $61K–$4M "sale range", 75 raw sales treated as comps, missing buyer/transaction details, slow UI, poor qualification.

## 1. Canonical Subject-Property Response

- Loaded via `resolveCanonicalProperty` (dashboard) + `loadCanonicalSubjectProperty` (API) + `fetchCanonicalSubjectProperty`.
- Falls back to `properties` table or `v_recent_sold_comps`.
- For 24554327:
  - address: "8734 W Vale Dr, Phoenix, Az 85037"
  - SFR, 1 unit, ~1228 sqft, 1991 built, estimated_value ~326000, last sale 88000 (2000-07-28), owner "Pedro Trust" (Individual).
  - Coordinates not always present in fallback; RPC uses v_recent_sold_comps first.
- `fetchPropertyRecord` enriches.
- Subject resolution is mostly working but can be market fallback.

## 2. Initial Comp Discovery Query

- `discoverCompsForSubject` → RPC `get_comp_candidates_for_subject(p_subject_property_id, radius, monthsBack, limit)`
- Or market fallback `v_recent_sold_comps`.
- RPC definition (from DB):
  - Subject lookup in v_recent_sold_comps or properties (normalizes asset_class).
  - Candidates from v_recent_sold_comps WHERE is_usable_comp=true, sale_date recent, distance <= radius.
  - Computes crude similarity_score (sqft, beds, baths, year, asset match penalties).
  - Returns up to 100, ordered by score/desc date.
- For subject 1mi/12mo: ~15 SFR results, prices ~90k–385k (e.g. 90k with sqft=0 or 1172, 280k etc.).
- For 5mi/24mo: min 60,060 max 4,073,022 across 100 rows. Includes low-price (distressed/old/small?) and high (larger homes?).

## 3. Expanded Search Query

- `findMoreComps` uses `getNextExpansionStep` ladder (0.5/6m → 1/6 → 1.5/12 → 3/12 → 5/24).
- Updates radius/monthsBack, logs added sales.
- Re-runs full pipeline. No cancellation in some paths → stale requests possible.
- Expansion pulls in more outliers because base filter (is_usable_comp) is too permissive.

## 4. V3 Transaction Evidence

- `projectCompIntelligenceV3Decision` (read-only):
  - loadSubjectProperty
  - loadComparableProperties (often RPC again)
  - loadV3CompCandidates (RPC + batch buyer_comp_raw_v2 + buyer_entities_v2)
  - calculateAcquisitionDecision
  - qualifyComps (from acquisition/transactionQualification)
- transaction_evidence comes from qualification map or degraded.
- qualification uses transactionQualification, asset lane, etc.
- However, UI often fell back to raw discovery.candidates or displayEvidence from all rows when V3 degraded or not authoritative.
- Evidence role/universe/qualification_status set, but frontend cards only consumed limited fields (beds/baths/sqft/lot/year/ppsf/type).

## 5. Direct-RPC / Recovered Evidence

- `runDirectCompIntelligence` (frontend direct-pipeline.ts)
- Uses `loadSubjectComps` / `loadMarketComps` (commandMapData.ts → probably same views/RPC).
- mapCandidatesToDegradedEvidence when API fails or insufficient.
- Used as fallback, populates transaction_evidence with "Recovered public-record sale".
- Contributes to "preliminary" evidence, which was mixed into lists without strict tiering.

## 6-9. Enrichment (Property, Transaction, Buyer, Owner/Company)

- In V3 loader: batch on buyer_comp_raw_v2 (for identity: owner_name, doc_type, recording, etc.), buyer_entities_v2 (normalized_buyer_name, purchase_count, etc.).
- compIdentityEnrichment.js, buyerIdentityResolution.
- But many fields (condition, repairs, construction details, financing, package status beyond flag, seller/grantor full, flood, zoning) come from buyer_comp_raw_v2 or properties — often null/ sparse in imported data.
- No deep joins for condition/repair estimates in core comp path (some in acquisition but not projected to UI contract).
- Frontend projection (adapters/compDecisionProjection, transactionEvidenceAdapter, comp-display) only mapped ~15 fields into CompTransactionEvidence.
- Result: cards showed only basic, many blanks.
- Buyer: raw owner_name, some entity from buyer_entities, but not fully normalized to Individual/LLC/etc in all paths.
- No full seller/grantee in evidence for many rows.
- Missing transaction qualification details (arm's length, distressed flags) not always surfaced.

## 10. Final Frontend Projection

- useCompIntelligence: apiData or direct → enrich/merge → payload with transaction_evidence + discovery.candidates.
- Workspace: displayEvidence = filterByMapMode (pricing_eligibility), then useCompEvidenceFilters (old quality based on score/authority).
- computeMarketSummary(rows) = all priced rows → low/median/high → polluted by outliers.
- Cards (PropertyCompCard): limited mapping from evidence row.
- No full canonical contract → missing MLS vs public vs buyer-purchase, entity types, condition, etc.
- Map markers from same.
- Selection just highlights, drawer was weak/inline table.
- Radius/date changes trigger full refresh without good abort/caching → slow/clunky.
- State: useState + effects, no virtualization, full re-renders.
- Subject header not sticky in all states; could disappear in filters.

## Root Causes of $61K–$4M Contamination

- **Discovery filter too loose**: is_usable_comp only requires price/date/coords/address/zip + recent. No price sanity, no strict asset/subtype/unit match, no min similarity gate before return. RPC returns "candidates" not "qualified comps".
- **Summary & lists used raw**: computeMarketSummary + cards used `displayEvidence` / discovery rows (or all transaction_evidence) instead of post-qualification "qualified" subset. V3 qualification was applied but not always enforced for primary UI metrics/summary.
- **No separation of tiers in UI**: All/Strong/Usable/Review/Excluded not canonical; mixed authority (prelim) with match quality. High price variance treated as "comps".
- **Data source issues**: buyer_comp_raw_v2 (source of v_recent_sold_comps) includes wide variety (flips? distressed? different effective sizes? import artifacts like sqft=0, future dates in sample data). Duplicates possible. 85037 Phoenix area has price diversity; without unit/beds/sqft tight + asset lane + transaction type filters, outliers dominate.
- **Expansion without re-qualification**: Larger radius/date pulls more variance before V3/qualification.
- **Missing gates**: No consistent "same property type", unit count exact, price/sqft outlier removal, package/distressed exclusion at discovery or summary layer. V3 qualifyComps exists but UI fell to degraded/raw.
- **Weak contract**: Frontend didn't receive/project full fields (buyer entity, transaction channel, condition, financing, provenance) → incomplete cards + inability to filter properly in UI.
- **State/perf**: Full reloads on filter/radius, no cache key on (subject+radius+months+filters), no abort → feels slow, results flicker or stale.

**Not primarily wrong asset class** (mostly SFR in samples), but insufficient post-discovery qualification + using unfiltered for stats + sparse source data + incomplete projection.

## Recommendations (for later phases)

- One canonical projection contract (as in Phase 1).
- Discovery returns raw "sales"; separate qualify step produces Qualified/Review/Excluded.
- Summary always on Qualified only; show raw range only as secondary note.
- Stricter RPC or post-filter (asset, units, sqft tolerance, price per unit sanity, transaction flags).
- Enrich more fields into evidence (buyer type, channel, condition, etc.).
- Frontend contract + controls + perf as specified.
- Honest "data not available" labels.
- Cache projections by search params.

## Data Sample for Subject (1mi/12mo RPC)

See tool output: prices 90k-385k, mostly single_family SFR, varying sqft/year, one duplicate address, some low similarity.

For 5mi/24mo: explicitly 60k-4M+ (confirmed via direct RPC call on get_comp_candidates_for_subject).

V3 should filter further via qualifyComps / asset lane / evidence role.

**Key finding on contamination:** The broad range originates in the permissive `v_recent_sold_comps.is_usable_comp` + RPC distance/recent filter + soft similarity (no hard price/outlier/strict unit/condition gate at discovery). UI previously fed raw/ displayEvidence (not post-qualification) to computeMarketSummary, causing polluted "Comps Found" range/median. Qualified filter added in this pass restricts summary to pricing_eligible / ACCEPTED.

Many "missing" fields in cards due to:
- buyer_comp_raw_v2 / properties sparse on condition, financing, exact buyer entity type, package flag details, seller full.
- Frontend projection (evidence) and cards only mapped subset (fixed by adding buyer/channel/source/role in this pass).
- No full CompView contract until Phase 1.

Enrichment joins (buyer_entities_v2) happen in V3 loader but not always projected to every evidence row or card.

## Lifecycle Summary

Canonical → (subject record) → Discovery (RPC/view) → V3 load/qualify/decision (acquisition engine) → map to evidence → frontend payload → filters/summary/cards (currently insufficiently filtered + limited fields).

Contamination originates in permissive discovery + UI consuming un-qualified rows for key metrics.

(End of initial forensic notes. Expand with exact row audits per phase as UI stabilized.)