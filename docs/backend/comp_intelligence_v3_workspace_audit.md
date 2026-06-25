# Comp Intelligence Workspace — Phase 0 Audit (Pre-V3 Rebuild)

**Audit date:** 2026-06-25  
**Repository:** `rei-automation`  
**Scope:** `CompIntelligenceWorkspace` and all valuation/data paths it touches **before** the V3 rebuild  
**Method:** Read-only code inspection; no behavioral changes

---

## 1. Executive Summary

Comp Intelligence is a **dual-path, triple-engine** valuation workspace embedded in the Inbox shell. It presents a cinematic map + dossier UI (default **60/40** layout) for subject resolution, comp discovery, similarity scoring, ARV estimation, and offer-input surfacing.

**Current state in one paragraph:** The workspace calls a backend V1 pipeline (`runCompIntelligencePipeline`) that discovers comps, scores them, computes valuation, **persists idempotent rows to `property_valuation_snapshots`**, and publishes in-process valuation events. When the API path is incomplete (unresolved subject, zero comps, or network failure), the hook falls back to a **browser-side direct-RPC pipeline** (`runDirectCompIntelligence`) that bypasses snapshot persistence. Separately, the workspace **recomputes ARV locally** on every comp selection change via `computeArvStats`, merging API numbers when present. A fourth module — `projectCompIntelligenceV3Decision` — already wraps **`calculateAcquisitionDecision` read-only** for V3 semantics, but is **not wired** to any route or UI.

**V3 rebuild implications:**

| Finding | V3 action |
| --- | --- |
| Three live valuation engines with divergent formulas | Collapse to V3 projection as authoritative display |
| User comp toggles are client-only | Decide whether V3 respects operator overrides or re-qualifies |
| API path persists snapshots; direct/local paths do not | Unify persistence contract or mark non-persistent modes explicitly |
| `scoreProperty` writes `property_acquisition_scores` | **Do not call from workspace** — use `calculateAcquisitionDecision` / `projectCompIntelligenceV3Decision` |
| `subscribeValuationEvents` has zero consumers | Wire Acquisition handoff or remove dead event bus |
| V3 Acquisition Engine does not read `property_valuation_snapshots` | Treat snapshots as parallel lineage, not V3 input |

---

## 2. Branch / State Verification Note

| Check | Expected | Observed (2026-06-25) |
| --- | --- | --- |
| Working branch | `inbox-live-fix-local` | **`seller-autopilot`** |
| Baseline commit | `05c05ed` exists | **PASS** — `git cat-file -t 05c05ed` → `commit` |
| `05c05ed` on current HEAD ancestry | present | **PASS** — `05c05ed` is ancestor of `HEAD` |
| `inbox-live-fix-local` tip | — | `4c0a455` (`fix(acquisition): harden storage classification…`) |
| Current `seller-autopilot` tip | — | `885fc64` (`fix(seller-flow): separate recommendation from execution semantics`) |

**Interpretation:** Comp Intelligence source files audited here are present on `seller-autopilot` and include commit `05c05ed` (office/medical office V3 underwriting). The workspace was developed on the inbox-live integration line; current checkout is a **different feature branch**. Re-verify file hashes against `inbox-live-fix-local` before cutting the V3 rebuild branch if strict lineage is required.

---

## 3. Current Frontend Data Flow

```mermaid
flowchart TB
  subgraph Shell["Inbox Shell"]
    IP[InboxPage.tsx]
    IP -->|lazy import| CIW[CompIntelligenceWorkspace]
  end

  subgraph Hook["useCompIntelligence"]
    CANON[resolveCanonicalProperty]
    API_TRY[fetchCompIntelligence]
    GATE{subject resolved AND comps > 0?}
    DIRECT[runDirectCompIntelligence]
    STATE[payload + dataSource + pipelineState]
  end

  subgraph Backend["API Path (V1 Pipeline)"]
    ROUTE["GET /api/cockpit/properties/:id/comp-intelligence"]
    SVC[runCompIntelligencePipeline]
    SUBJ[loadCanonicalSubjectProperty]
    DISC[discoverCompsForSubject]
    VAL[computeValuationOutputs]
    PERSIST[persistValuationSnapshotIfChanged]
    EVENT[publishValuationReadyEvent]
    ROUTE --> SVC --> SUBJ --> DISC --> VAL --> PERSIST --> EVENT
  end

  subgraph DirectRPC["Direct-RPC Fallback (Browser)"]
    LOAD[loadSubjectComps RPC]
    SCORE[scoreComp + autoIncludeStrongest]
    DVAL[computeValuation median PPSF]
    LOAD --> SCORE --> DVAL
  end

  subgraph LocalUI["Client-Side Recompute"]
    MAP[mapEvidenceToCompCandidate]
    TOGGLE[User include/exclude toggles]
    ARV[computeArvStats + calculateWholesaleDeal]
    MERGE[Merge pipelineValuation over local]
    MAP --> TOGGLE --> ARV --> MERGE
  end

  CIW --> Hook
  CANON --> API_TRY
  API_TRY --> ROUTE
  API_TRY --> GATE
  GATE -->|yes| STATE
  GATE -->|no| DIRECT
  API_TRY -->|catch| DIRECT
  DIRECT --> LOAD
  DIRECT --> STATE
  STATE --> MAP
  MERGE --> CIW
```

**Trigger chain:** `propertyId`, `radius`, `monthsBack`, `assetClass` changes → `useEffect` → `refresh(AbortSignal)` → API-first → optional direct fallback.

---

## 4. API-First Path

### Entry

| Layer | File | Function |
| --- | --- | --- |
| Hook | `apps/dashboard/src/domain/comp-intelligence/useCompIntelligence.ts` | `refresh()` |
| Client | `apps/dashboard/src/domain/comp-intelligence/comp-intelligence-api.ts` | `fetchCompIntelligence()` |
| Route | `apps/api/src/app/api/cockpit/properties/[property_id]/comp-intelligence/route.js` | `GET` |
| Service | `apps/api/src/lib/domain/comp-intelligence/comp-intelligence-service.js` | `runCompIntelligencePipeline()` |

### Query parameters

`radius`, `monthsBack`, `assetClass`, `thread_key`, `opportunity_id`, `master_owner_id`, `persist` (default `true` — **note:** `persist` is parsed by the route but **not passed** into snapshot logic; persistence is unconditional inside the service when ARV is ready).

### Success gate (hook)

API response is accepted as authoritative **only when**:

```ts
data?.subject?.is_subject_resolved && (data.discovery?.counts?.total ?? 0) > 0
```

Otherwise `runDirectCompIntelligence` runs. This means a valid API response with **zero comps** (explainable blocked state) is **discarded** in favor of the direct path.

### Pipeline stages (backend)

1. **`loadCanonicalSubjectProperty`** — canonical subject contract `comp_intelligence_subject_v1`
2. **`discoverCompsForSubject`** — RPC `get_comp_candidates_for_subject` with expansion steps; market fallback via `v_recent_sold_comps` when coordinates unresolved
3. **`calculateCompMatchScore`** (backend `comp-scoring.js`) — mirrors frontend scoring
4. **`detectOutliers`** + **`autoIncludeStrongest`** — top 40% (min 2, max 6) force-included
5. **`computeValuationOutputs`** — weighted PPSF/PPU ARV (`comp_intelligence_valuation_v1`)
6. **`deriveValuationState`** — explicit pipeline state machine
7. **`persistValuationSnapshotIfChanged`** — SHA-256 input hash idempotency
8. **`publishValuationReadyEvent`** — in-process event bus

### Model version

`comp_intelligence_valuation_v1` (`valuation-pipeline.js`)

---

## 5. Direct-RPC Fallback Path

### When it runs

| Condition | Behavior |
| --- | --- |
| API returns null / network error | Catch block → direct RPC |
| API returns data but `!is_subject_resolved` OR `counts.total === 0` | Direct RPC after API attempt |
| Direct RPC also fails | `setError`, `payload = null` |

### Entry

`apps/dashboard/src/domain/comp-intelligence/direct-pipeline.ts` → `runDirectCompIntelligence()`

### Data sources

- **Subject:** `resolveCanonicalProperty({ dealContext, thread, opportunityId })` → `toCanonicalSubject()`
- **Comps:** `loadSubjectComps(property_id, radius, monthsBack, 100)` from `commandMapData.ts` (Supabase RPC from browser)

### Default parameter mismatch

| Parameter | Workspace default | Direct pipeline default |
| --- | --- | --- |
| `radius` | `1` (hook) | `3` |
| `monthsBack` | `6` | `12` |

Fallback invocations pass hook values, but the **module defaults differ** if called without args.

### Scoring differences vs API

- Simpler `scoreComp()` heuristic when `similarity_score` absent (distance + price + sqft only)
- `INCLUSION_THRESHOLD = 45` — same threshold constant as backend
- `autoIncludeStrongest()` — identical 40% / min 2 / max 6 policy as `comp-discovery.js`

### Valuation (`computeValuation`)

- **Median PPSF** (not score-weighted) × subject sqft → ARV
- Fallback: mean sale price
- `as_is_value = ARV × 0.82` (differs from V1 `arv - repair_estimate`)
- `repair_estimate = sqft × 20` flat (no condition tiers)
- `target_offer = ARV × 0.70 - repair`
- `max_allowable_offer = ARV × 0.75 - repair`
- `investor_reality = ARV × 0.85`

### Side effects

**None.** No snapshot writes, no events, no acquisition score writes.

---

## 6. Every Local / Backend Valuation Calculation (3 Engines + V3 Projection)

### Engine A — Backend V1 (`valuation-pipeline.js`)

**ID:** `comp_intelligence_valuation_v1`

| Output | Formula |
| --- | --- |
| ARV (SFH) | `round(weightedPpsf × sqft / 1000) × 1000` |
| ARV (MF) | `round(weightedPpu × units / 1000) × 1000` |
| ARV fallback | Mean included sale prices |
| Weight | `similarity_score / sum(scores)` per included comp |
| Confidence | `(totalScore / (n × 100) + countBoost - penalties) × 100`, cap 98 |
| `as_is_value` | `max(0, arv - repair_estimate)` |
| `repair_estimate` | Subject repair field OR `sqft × (15|25|45)` by condition |
| `investor_reality` | **`ARV × 0.85`** |
| `target_offer` | **`ARV × 0.70 - repair_estimate`** |
| `max_allowable_offer` | **`ARV × 0.75 - repair_estimate`** |
| `retail_ceiling` | Max included comp sale price |

### Engine B — Frontend local (`CompIntelligenceWorkspace.tsx` → `computeArvStats`)

**ID:** implicit client engine (no `model_version` string)

| Output | Formula |
| --- | --- |
| ARV | Same weighted PPSF/PPU logic as Engine A |
| Confidence | `(totalScore / (n × 100)) × 100 + countBoost - dataPenalty`, cap 98 |
| `repairEstimate` | `subject.estimated_repair_cost` OR condition-tier sqft multiplier |
| Offers | **`calculateWholesaleDeal()`** from `apps/dashboard/src/lib/underwriting/calculator.ts` |
| `targetOffer` | `(ARV × 0.70) - repairs - assignmentFee` |
| `maxAllowableOffer` | `(ARV × 0.75) - repairs - assignmentFee` |
| `conservativeOffer` | `ARV × 0.65 - repair - assignmentFee` |
| `buyerExitPrice` | **`ARV × 0.85`** |
| `expectedAssignmentLow/High` | `assignmentFee` and `assignmentFee × 1.5` |

**Merge rule** (`arvStats` useMemo): when `pipelineValuation.arv` exists, local computation runs but API overwrites `arv`, `confidence`, `repairEstimate`, `targetOffer`, `maxAllowableOffer`, `buyerExitPrice`.

**Critical gap:** User comp include/exclude toggles recalculate Engine B but **do not** re-call API or update snapshots.

### Engine C — Direct-RPC (`direct-pipeline.ts` → `computeValuation`)

**ID:** `comp_intelligence_direct_v1`

| Output | Formula |
| --- | --- |
| ARV | **Median PPSF** × sqft (not weighted) |
| Confidence | `72` if ≥3 included, `55` if ≥1, else `0` |
| `as_is_value` | **`ARV × 0.82`** |
| Offers | `ARV × 0.70/0.75 - repair` (no assignment fee) |

### Engine D — V3 Projection (exists, not wired to UI)

**File:** `apps/api/src/lib/domain/comp-intelligence/comp-intelligence-v3-projection.js`  
**ID:** `acquisition_decision_engine` V3 via `buildV3Decision`

| Property | Value |
| --- | --- |
| Entry | `projectCompIntelligenceV3Decision(propertyId, …)` |
| Core call | `calculateAcquisitionDecision({ v3Enabled, v3CompCandidates, … })` |
| Persistence | **Explicitly disabled** (`read_only: true`, no snapshot/score/event writes) |
| Comp loading | `loadComparableProperties` + `loadV3CompCandidates` (Acquisition loaders, not Comp Intelligence discovery) |
| Qualification | `qualifyComps()` for transaction evidence mapping |
| Route | **None** — module is orphaned from HTTP surface |

### Scoring engine (shared semantics, separate from valuation)

`calculateCompMatchScore` exists in:

- Frontend: `CompIntelligenceWorkspace.tsx` (lines 175–301)
- Backend: `apps/api/src/lib/domain/comp-intelligence/comp-scoring.js`

Both use the same 100-point rubric (distance 20, asset 20, property type 10, sqft/units 15, beds/baths 10, year 10, recency 10, condition 5). Labels: Elite ≥90, Strong ≥80, Usable ≥70, Weak ≥55.

---

## 7. Persistence Side Effects and Downstream Events

### What writes

| Writer | Table | When |
| --- | --- | --- |
| `persistValuationSnapshotIfChanged` | `property_valuation_snapshots` | API path, `arv` present, state `ready` or `ready_with_limitations` |
| `valuation-snapshot/route.js` POST | `property_valuation_snapshots` | Manual cockpit POST |
| `scoreProperty` | `property_acquisition_scores` | **Not invoked by Comp Intelligence** |

### Idempotency

- `buildValuationInputHash()` — SHA-256 over `property_id`, coords, model version, included comp IDs, ARV, confidence, search mode
- Skip insert when `comp_methodology.input_hash` matches latest row for property

### Snapshot payload highlights (`buildSnapshotPayload`)

Populated: `estimated_arv`, medians, low/high, repair, offers, comp counts, `included_comps` / `excluded_comps` JSON, `comp_methodology`  
**Explicitly null:** `expected_assignment_low`, `expected_assignment_high`, `buyer_demand_score`

### Events (`valuation-events.js`)

- **Version:** `comp_intelligence.valuation.ready.v1`
- **Published when:** snapshot persisted OR existing `snapshot_id` on idempotent skip
- **Dedup key:** `property_id:input_hash`
- **Subscribers:** **`subscribeValuationEvents` is only defined in `valuation-events.js` — zero production consumers found**

### What does NOT write

- Direct-RPC fallback
- Frontend `computeArvStats` / comp toggles
- `projectCompIntelligenceV3Decision`

---

## 8. Component Hierarchy

```
CompIntelligenceWorkspace
├── [empty] ci-empty-state
└── [active] ci-workspace (is-pane-{25|50|75|100}, is-layout-{full|…}, is-mode-{value|market|model})
    ├── ci-workspace__map-col
    │   ├── ci-map-canvas | ci-map-no-coords-wrap
    │   ├── MapCommandCenter
    │   ├── CompHoverTooltip (AnimatePresence)
    │   └── CompDetailPopover (AnimatePresence)
    └── ci-panel (motion.div)
        ├── DossierHeader
        │   └── StreetviewThumb
        ├── ValuationCommandBar
        ├── [mapMode switch]
        │   ├── market → MarketEvidencePanel
        │   ├── model → ValuationModelPanel
        │   └── value (default):
        │       ├── ValuationHeroCard → CompConfidenceBadge
        │       ├── EvidenceQualityStrip → EvidencePill[]
        │       ├── ValuationAgentRail
        │       ├── OfferWaterfallMini
        │       ├── SubjectDataGapAlert (conditional)
        │       ├── ValuationPipelineStatus
        │       ├── CompNavigatorStrip
        │       └── ci-list-section → CompEvidenceCard[]
        │           └── StreetviewThumb, Metric, score strips
        └── (internal helpers: HeroMetric, ModelRow, makeRadiusGeoJson, …)
```

**Parent mount:** `InboxPage.tsx` lazy-loads workspace into `nx-workspace-surface--map` with `thread`, `dealContext`, `paused`, `paneWidth`, `layoutMode`.

**Hook wiring:** `useCompIntelligence({ thread, dealContext, radius, monthsBack, assetClass, paused })` — `dataSource` and `refresh` are destructured but prefixed `_` (unused in UI).

---

## 9. Responsive Behavior

### Layout system

| Class | Layout |
| --- | --- |
| Default / `is-layout-full` | Grid **62% / 38%** map / panel (emergency correction block); flex fallback **60% / 40%** |
| `is-pane-75` | ~54% / 46% |
| `is-pane-50` | Stacked: map ~32vh, panel fills remainder |
| `is-pane-25` | Map hidden; panel 100% |
| `@media (max-width: 1100px)` | Single column, map ~44vh |
| `@media (max-width: 980px)` | Column, map 38vh |

### Theme support

- Dark (default), light (`[data-nexus-theme="light"]`), red_ops
- `prefers-reduced-motion` respected

### Map

- MapLibre GL, Carto dark matter style
- Subject pin + radius GeoJSON polygon
- Comp pins with price chips; hover/click interactions

### Known layout tension

CSS contains **both** flex-based 60/40 rules and later grid 62/38 emergency overrides — both active via cascade. V3 rebuild should consolidate to one layout contract.

---

## 10. Current Tests List

### API critical tests

| File | Coverage |
| --- | --- |
| `apps/api/tests/critical/comp-intelligence-coordinate-resolver.test.mjs` | `parseCoordinate`, `resolveCanonicalCoordinates`, zero rejection, alias/raw_payload precedence |
| `apps/api/tests/critical/comp-intelligence-scoring.test.mjs` | `calculateCompMatchScore`, inclusion threshold, missing price exclusion |
| `apps/api/tests/critical/comp-intelligence-direct-pipeline.test.mjs` | Threshold bounds, coordinate parse, scoring shape without sqft |

### Proof / verification scripts

| File | Role |
| --- | --- |
| `scripts/proof/comp-intelligence-production-verify.mjs` | Live DB sample: properties coords, RPC comp counts |

### Dashboard UI tests

| File | Coverage |
| --- | --- |
| `apps/dashboard/tests/ui/canonical-release-validation.spec.ts` | `/comp-intelligence` route health, dark theme screenshot |

### Not covered (gaps)

- `useCompIntelligence` API-first vs fallback branching
- `computeArvStats` / `calculateWholesaleDeal` integration
- Snapshot persistence idempotency (unit)
- `projectCompIntelligenceV3Decision` (no dedicated test file found)
- Comp toggle → local ARV drift vs API authority
- `ValuationPipelineStatus` copy vs actual `dataSource`

---

## 11. Themes

1. **Evidence-first cockpit** — Map canvas + dossier, not a form-based CRUD screen
2. **Deterministic scoring** — Explainable 100-point rubric with per-dimension bars
3. **Operator override** — Include/exclude toggles without backend round-trip
4. **Pipeline honesty** — `ValuationPipelineStatus` surfaces blocked/limited states (when API data used)
5. **Sound design** — `vcc:sound:*` custom events on scan complete, confidence thresholds, comp toggle
6. **Separation of concerns (stated)** — Comments: valuation here; buyer demand in Buyer Match; final offers in Offer Engine
7. **Cinematic dark UI** — Glass panels, gradients, Framer Motion transitions
8. **Parallel valuation lineages** — Comp Intelligence V1 snapshots ≠ Acquisition V3 decision engine inputs

---

## 12. Fields Populated vs Rendered

### Subject fields

| Field | API canonical | Direct RPC | Rendered in UI |
| --- | --- | --- | --- |
| `property_id` | ✅ | ✅ | implicit |
| Address / city / state / zip | ✅ evidence wrappers | ✅ | DossierHeader |
| `latitude/longitude` | ✅ | ✅ | Map pin, Street View |
| `square_feet` | ✅ | ✅ | Header, data-gap alert |
| `units` | ✅ | ✅ | MF header, data-gap |
| `year_built` | ✅ | ✅ | Header (API); comps only in cards |
| `condition` | ✅ (often null source) | ❌ hardcoded null | Header, repair tier |
| `estimated_value` | ✅ (often null) | ❌ null | Outlier detection only |
| `coordinate_source` | ✅ | ✅ | Status chips, pipeline panel |

### Comp fields

| Field | API discovery | Direct RPC | Rendered |
| --- | --- | --- | --- |
| `similarity_score` / reasoning | ✅ full scoring object | ⚠️ empty `{}` reasoning | Score bars, labels |
| `sold_price/date/source` | ✅ | ✅ | Cards, map pins |
| `ppsf/ppu` | ✅ computed | ✅ | Metrics, ARV basis |
| `year_built` | ✅ from row | ✅ from row | ⚠️ mapped to `null` in `mapEvidenceToCompCandidate` |
| `isInstitutionalBuyer` | ❌ not populated | ❌ | UI badges always off |
| `buyerType/buyerName` | ❌ | ❌ | Source filter "Buyer" ineffective |
| `arvWeight` | ❌ | ❌ | **Client-computed** from scores |

### Valuation fields

| Field | Engine A | Engine B | Engine C | Rendered |
| --- | --- | --- | --- | --- |
| `arv` | ✅ | ✅ (merged) | ✅ | ValuationHeroCard (animated) |
| `confidence` | ✅ | ✅ (merged) | ✅ | Badge, map health |
| `target_offer` | `0.70×ARV−repair` | wholesale MAO | `0.70×ARV−repair` | Waterfall, agent rail |
| `max_allowable_offer` | `0.75×ARV−repair` | MAO ceiling | `0.75×ARV−repair` | Evidence strip |
| `investor_reality` | `0.85×ARV` | `0.85×ARV` | `0.85×ARV` | Hero metrics |
| `conservative_offer` | = target in snapshot | `0.65×ARV−…` | ❌ | ❌ not shown |
| V3 execution state | ❌ | ❌ | ❌ | ❌ |
| V3 universes / qualification | ❌ | ❌ | ❌ | ❌ |

### Cosmetic / non-functional controls

| Control | Effect |
| --- | --- |
| `valuationMode` select (Residential/MF/Land/Commercial) | **UI only** — does not change API `valuationType` or scoring lane |
| `ci-run-btn` | Display only — no `onClick` handler |
| `_dataSource` | Computed but not shown to operator |

---

## 13. `property_valuation_snapshots` Consumers and V1→V3 Influence Trace

### Table writers

| Path | File |
| --- | --- |
| Auto (Comp Intelligence API) | `valuation-pipeline.js` → `persistValuationSnapshotIfChanged` |
| Manual POST | `apps/api/src/app/api/cockpit/properties/[property_id]/valuation-snapshot/route.js` |

### Table readers / consumers

| Consumer | Usage |
| --- | --- |
| `valuation-snapshot/route.js` GET | Latest snapshot per property |
| `run-buyer-match/route.js` | Fetches latest before buyer match job |
| `push-to-underwriting/route.js` | Fetches latest for underwriting handoff |
| `buyer-match-engine.js` | `valuation_snapshot_id` in idempotency key |
| `buyer-match-job-service.js` | Stores `valuation_snapshot_id` on job rows |
| `deal-dossier-schema.js` | Schema metadata (`valuation.estimated_value`, `equity_percent`) |
| `20260526174304_create_deal_context_index.sql` | `valuation_by_property` CTE + lateral joins into deal context JSON |
| `20260529181259_inbox_live_v2_canonical_threads.sql` | `estimated_arv` from `valuation_data->property_valuation_snapshot` |

### V1 → V3 influence trace

```
Comp Intelligence V1 API
  → computeValuationOutputs (weighted PPSF, 0.70/0.75/0.85 formulas)
  → property_valuation_snapshots INSERT (idempotent)
  → publishValuationReadyEvent (no subscribers)
        ↓
        ├→ Buyer Match (reads snapshot_id for idempotency + context)
        ├→ Push to Underwriting (reads snapshot fields)
        ├→ Deal context / inbox views (estimated_arv display)
        └→ Deal dossier schema (financial field definitions)

Acquisition Engine V3
  → loadSubjectProperty + loadComparableProperties + loadV3CompCandidates
  → qualifyComps → buildV3Decision
  ✗ Does NOT read property_valuation_snapshots
  ✗ Does NOT subscribe to valuation events
```

**Conclusion:** `property_valuation_snapshots` is a **downstream evidence artifact** for Buyer Match, underwriting, and inbox financial display. It is **not** an input to V3 decision math. V3 rebuild must either (a) feed V3 projection directly into the workspace, or (b) deliberately keep snapshots as a separate "V1 evidence record" with clear labeling.

---

## 14. Can Comp Intelligence Safely Invoke `scoreProperty` Without Persistence?

### `scoreProperty` (acquisitionDecisionEngine.js)

```js
export async function scoreProperty(propertyId, deps = {}) {
  // loads subject, comps, buyer purchases, V3 candidates
  const decision = calculateAcquisitionDecision({ … });
  const row = scoreRowFromDecision(normalizedId, decision, now);
  const score = await persister(row, deps);  // ← ALWAYS writes
  return { ok: true, score, evidence };
}
```

**Always persists** to `property_acquisition_scores` via `persistAcquisitionScore` unless a test injects a mock persister.

### `calculateAcquisitionDecision`

- Pure (sync) decision function
- Optional V3 path via `ACQUISITION_ENGINE_V3_ENABLED`
- **No database writes**

### Existing safe wrapper

`projectCompIntelligenceV3Decision` already documents and enforces:

```js
projection_meta: {
  read_only: true,
  persisted: false,
  score_table_write: false,
  snapshot_write: false,
  event_publication: false,
}
```

### Verdict

| API | Safe for read-only Comp Intelligence? |
| --- | --- |
| `scoreProperty` | **NO** — always writes acquisition scores |
| `calculateAcquisitionDecision` | **YES** — use directly or via `projectCompIntelligenceV3Decision` |
| `runCompIntelligencePipeline` | **NO** for read-only — writes snapshots + emits events |

**V3 rebuild recommendation:** Expose `projectCompIntelligenceV3Decision` on a dedicated GET route (or extend comp-intelligence route with `?engine=v3&persist=false`) and make the workspace render `decision_projection` as authoritative. Never call `scoreProperty` from the workspace refresh loop.

---

## 15. Problems Verified from Mission Brief

| # | Problem | Verified evidence |
| --- | --- | --- |
| 1 | **Triple valuation engines** produce different ARV/offer numbers | Engines A/B/C formulas differ (weighted vs median PPSF; wholesale MAO vs simple 0.70/0.75; assignment fees) |
| 2 | **API authority erodes on comp toggle** | `toggleSelected` / `toggleExcluded` only update React state → `computeArvStats` reruns; no API/snapshot update |
| 3 | **Fallback discards valid API blocked states** | Hook requires `counts.total > 0`; zero-comp API responses trigger direct RPC |
| 4 | **V3 not integrated in workspace** | `comp-intelligence-v3-projection.js` exists; no route; UI shows V1 outputs only |
| 5 | **Valuation event bus is dead** | `subscribeValuationEvents` has zero consumers outside `valuation-events.js` |
| 6 | **Hardcoded Maps API key fallback** | `MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY \|\| 'AIzaSyAhOk7KZkduU4qywmrlq5ZqSOtgktHYiFk'` |
| 7 | **Institutional / buyer comp signals never populate** | `mapEvidenceToCompCandidate` sets `isInstitutionalBuyer: false`; source filter "Buyer" ineffective |
| 8 | **`valuationMode` is cosmetic** | No backend call uses selected mode; `inferValuationMode` only sets local state |
| 9 | **Direct vs API default param drift** | direct-pipeline defaults `radius=3, monthsBack=12` vs hook `1, 6` |
| 10 | **`year_built` dropped in UI mapping** | `mapEvidenceToCompCandidate` sets `yearBuilt: null` despite API providing it |
| 11 | **Snapshot assignment fields null** | `buildSnapshotPayload` sets `expected_assignment_low/high: null` while UI computes them locally |
| 12 | **Parallel lineages confuse acquisition** | Snapshots use V1 formulas; V3 uses separate comp loaders — no single source of truth |
| 13 | **`scoreProperty` unsafe for preview** | Would write `property_acquisition_scores` on every workspace load if mis-wired |
| 14 | **Layout CSS dual definitions** | Flex 60/40 and grid 62/38 both present — maintenance hazard |
| 15 | **Run button non-functional** | `ci-run-btn` has no click handler; scanning is automatic only |
| 16 | **`dataSource` invisible** | Operator cannot see whether they're on API vs direct-RPC path |
| 17 | **Don Diego class of bugs partially fixed** | Coordinate resolver fixed per production audit; thin-market zero-included still possible with explainable state |
| 18 | **Confidence can hit 100 with any comps in Acquisition V2** | Documented in `acquisition_engine_v3_audit.md` — separate from Comp Intelligence but relevant if V3 projection is wired |

---

## Appendix A — Key File Index

| Path | Role |
| --- | --- |
| `apps/dashboard/src/views/comp-intelligence/CompIntelligenceWorkspace.tsx` | Workspace UI, local scoring, `computeArvStats` |
| `apps/dashboard/src/domain/comp-intelligence/useCompIntelligence.ts` | Data hook, API-first + fallback |
| `apps/dashboard/src/domain/comp-intelligence/direct-pipeline.ts` | Browser RPC fallback engine |
| `apps/dashboard/src/domain/comp-intelligence/comp-intelligence-api.ts` | Backend HTTP client |
| `apps/api/src/lib/domain/comp-intelligence/comp-intelligence-service.js` | V1 orchestrator |
| `apps/api/src/lib/domain/comp-intelligence/valuation-pipeline.js` | V1 valuation + snapshot persistence |
| `apps/api/src/lib/domain/comp-intelligence/comp-discovery.js` | Comp search + auto-include |
| `apps/api/src/lib/domain/comp-intelligence/comp-scoring.js` | Backend similarity scoring |
| `apps/api/src/lib/domain/comp-intelligence/valuation-events.js` | In-process event bus |
| `apps/api/src/lib/domain/comp-intelligence/comp-intelligence-v3-projection.js` | Read-only V3 wrapper (unwired) |
| `apps/api/src/lib/acquisition/acquisitionDecisionEngine.js` | `calculateAcquisitionDecision`, `scoreProperty` |
| `apps/api/src/lib/acquisition/v3DecisionPipeline.js` | `buildV3Decision` orchestrator |

---

## Appendix B — Formula Quick Reference

| Concept | V1 Backend | Frontend local | Direct RPC | V3 (when wired) |
| --- | --- | --- | --- | --- |
| ARV basis | Weighted PPSF/PPU | Weighted PPSF/PPU | Median PPSF | Universe reconciliation |
| Investor exit | ARV × 0.85 | ARV × 0.85 | ARV × 0.85 | `buyerExit` model |
| Target offer | ARV × 0.70 − repair | MAO wholesale calc | ARV × 0.70 − repair | `cash_offer.recommended_cash_offer` |
| Max offer | ARV × 0.75 − repair | MAO ceiling | ARV × 0.75 − repair | `cash_offer.maximum_cash_offer` |
| Persists | Snapshots | Nothing | Nothing | Nothing (projection) |

---

*End of Phase 0 audit. No code was modified during this documentation pass.*