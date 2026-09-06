# W8C Shadow Buyer Fit — v1 design and frozen benchmark

**Status:** frozen · shadow-only · `observed_buybox_fit_v1`
**Serving run:** `w8c_w8c_buyer_intelligence_v1.0.0_a4f20ced6a54c9d5`
**Scope:** ranks W8C buyers *inside its own shadow output only*. It does not
affect REI buyer-match ranking, `matchScore`, `matchGrade`, MAO, offer pricing,
offers, campaigns, outreach, suppressions, `send_queue`, seller priority, or
autonomous workflows.

## 1. Frozen scoring decision

```
score = 100 × ( Σ wᵢ·fᵢ / Σ wᵢ over AVAILABLE dimensions ) × (0.7 + 0.3 · evidenceConfidence)
```

| dimension | weight | note |
|---|---|---|
| geography | **0.40** | zip 1.00 · county 0.85 · state 0.45 · mismatch 0.00 |
| asset | **0.20** | match 1.00 · adjacent family 0.60 · mismatch 0.00 |
| characteristics | **0.05** | sqft and units only |
| robust price | **0.00** | **calculated and displayed, never ranked** |

Ties break deterministically: **score → evidenceConfidence → evidenceDepth → buyerRef**.

A missing dimension is **unknown, not mismatch** — it drops out of the weighted
mean rather than scoring zero, so a buyer is never penalised for what we failed
to observe. Evidence multiplies within `[0.7, 1.0]`; it can temper or firm a fit
but can never create one.

### Why price is not ranked

W8B robust price bands describe **historical purchase-price behaviour**. The REI
subject supplies **estimated market value**. These are not the same quantity: the
measured `acquisition_price / estimated_value` ratio across 2,600 observations is
median **0.788** with a p10–p90 spread of **0.53–1.14**.

Weighting price degraded ranking **monotonically** (full-set Top-10):

| price weight | 0.00 | 0.05 | 0.10 | 0.15 | 0.30 |
|---|---|---|---|---|---|
| Top-10 | 56.01% | 55.79% | 54.39% | 53.87% | 52.32% |

Calibrating the subject by the 0.788 median still lost (52.77% vs 57.20%), so
**no silent recalibration is applied**. Price remains permitted to:
calculate, display, and **cap a descriptive label** — a subject outside every
observed band cannot be called a *strong observed fit*. Capping changes the
label only; it cannot change rank or the numeric score.

### Permitted language

`strong observed fit` · `partial observed fit` · `weak observed fit` ·
`not evaluable`. Never *guaranteed*, *probable*, or *likely to buy*.

## 2. Eligibility

Ranking candidates are **only** buyers with a real W8B-derived buybox row:
**528** of 40,487 canonical buyers. No buybox is synthesized for the other
39,959 — absent one, the answer is `insufficient_evidence`.

## 3. Leakage-control methodology

For each historical acquisition (buyer *B*, property *P*, date *D*):

- every candidate profile is rebuilt from acquisitions **strictly before *D***
  (`acquired_on < D`), so the test acquisition never feeds any profile —
  including *B*'s own;
- same-day acquisitions are excluded from priors, so a buyer closing several on
  one day cannot use those siblings as evidence;
- the candidate pool is point-in-time: buyers with ≥3 strictly-prior
  acquisitions as of *D*;
- robust bounds are recomputed as `max(0, p25 − 1.5·IQR)` / `p75 + 1.5·IQR`,
  the formula that reproduces the published bands exactly (core
  185,000–220,000 → robust 132,500–272,500) and explains the 151 zero lower
  bounds in production.

**Known limitation.** True historical W8B/W8C *confidence* values cannot be
reconstructed from the serving layer — the views expose only the current run's
aggregate. `evidenceConfidence` in the backtest therefore derives from depth and
recency only. This is a monotone transform applied identically to every
candidate, so it cannot advantage the actual buyer, but it is **not** a
point-in-time reproduction of the production confidence inputs.

Subject features for the backtest were read from the comp corpus, because the
REI property join yields only **1** buyer with enough history. The runtime
evaluator reads only the approved `reivesti` serving views.

## 4. Frozen benchmark

Population: **1,358** eligible historical events · candidate coverage 99.78% ·
no-candidate rate 0.00% · candidate pool size **min 5 / median 269 / max 477**.

### Headline — temporal holdout (1,166 events on/after 2026-01-01)

| metric | adopted evaluator |
|---|---|
| Top-1 | **17.58%** |
| Top-10 | **52.57%** |
| mean rank | **20.3** |

> **Pre-2026 performance is inflated and must not be used as the headline.**
> The eligible pool grows from 31 buyers (2020) to 103 (2026-01) to 472
> (2026-07). The selection era shows ~41% Top-1 purely because it ranks against
> a far smaller pool. The held-out era above is the honest number.

### Full-set comparison

| config | Top-1 | Top-10 | mean rank | ties |
|---|---|---|---|---|
| popularity baseline (depth only) | **3.84%** | 21.40% | 76.0 | 1123 |
| geography only | **19.34%** | 55.50% | 18.8 | 791 |
| geo + asset | 20.22% | 55.42% | 18.8 | 780 |
| **adopted** (geo + asset + chars) | **20.74%** | 57.20% | 18.1 | 243 |
| proposed, price-weighted 0.30 | 18.89% | 52.32% | 20.6 | 147 |

The popularity baseline is far below every scored config, so geography is doing
real work rather than proxying "this buyer buys a lot". Pessimistic
tie-breaking (actual buyer placed last among equals) moves the adopted config
only 20.74% → 20.37%, so the result is not a tie-break artifact.

### By prior acquisition depth (adopted)

| prior depth | n | Top-1 | Top-10 |
|---|---|---|---|
| 3–4 | 435 | **7.36%** | **30.57%** |
| 5–9 | 441 | **14.97%** | **49.43%** |
| 10+ | 479 | **38.20%** | **88.52%** |

### Dimension elimination (354,794 candidate evaluations)

geography mismatch **69.96%** · robust price zero-fit **25.82%** ·
asset mismatch **6.51%**.

## 5. Runtime query shape

One property-panel request issues a **fixed 8 SQL statements**, independent of
buyer count (verified at 4 and 40 buyers):

1. `reivesti.buyer_intelligence_version`
2. `reivesti.property_historical_buyers` (by property)
3–5. `reivesti.buyer_summary` / `buyer_behavior` / `buyer_buybox` — batched
   `WHERE buyer_entity_id = ANY($1::text[])`
6. candidate load — `FROM reivesti.buyer_buybox` (bounded to 528)
7. subject property — `public.properties`
8. REI comparison — `public.buyer_match_candidates`

Enrichment was previously an N+1 (3 statements per buyer; 17 for a 4-buyer
property). Every statement runs inside `BEGIN READ ONLY` with an 8s
`statement_timeout`, and any failure degrades to the existing shadow-unavailable
state.

## 6. Privacy and identity

REI and W8C buyer namespaces are **disjoint**; `property_id` is the only shared
namespace and no crosswalk is fabricated. Company-name agreement is an
observational lead, never confirmed identity. Person entity IDs are
`person:{individual_key}` upstream, so only `person:anon_<16 hex>` leaves the
server layer. No `individual_key`, phone, email, raw payload, or private
provenance reaches browser output, logs, or errors.
