# Independent calibration v3 — collection specification

**Status:** Gold corpus frozen pre-prediction. See `collection-report.json` and `immutable-content-hashes.json`.

**Do not author v3 examples while reading `classify.js` implementation details.**

Generate or curate the corpus **after PR #41 is merged**, independently of remediation development fixtures and of independent-calibration-v1/v2 gold.

## Purpose

Fresh blind held-out evidence for narrow authority candidates, per language. Results from v2 and development fixtures **must not** be re-used as held-out support.

## Candidates (narrow)

| Candidate ID | Positive production intent | Notes |
|---|---|---|
| `clear_ownership_confirmation` | `ownership_confirmed` | Affirmative ownership only |
| `clear_seller_requests_proposal` | `asks_offer` | Seller requests proposal/terms/numbers |
| `clear_asking_price_disclosure` | `asking_price_provided` | Seller stating asking/desired amount only |

Spanish variants may share intents with language stratification.

## Size targets (per candidate × language)

| Requirement | Minimum |
|---|---|
| Independent predicted-positive opportunities (for precision LB) | **≥ 300** |
| Gold-positive support (for recall LB) | Sufficient for recall lower bound ≥ product gate (document in report) |
| Adversarial neighboring negatives | Substantial (recommended ≥ gold-positive count) |
| Semantic-family overlap with development / v1 / v2 | **0** |
| Independently audited labels | Required before predictions |
| Immutable content hash before predictions | Required |

## Prohibitions

- No semantic-family overlap with development seeds, v2 remediation fixtures, or prior calibration gold
- No v3 examples authored from classifier rule source or from reading remediation patches
- No allowlist population from development-only results
- No prediction artifacts in the PR that only freezes this schema
- No production SMS, TextGrid, queue authority, or business-state mutation during collection

## Labeling requirements

Each example must include:

- `calibration_example_id`
- `semantic_family_id` (unique family; no punctuation-only clones)
- `language` / `language_code`
- `deidentified_raw_text`
- `preceding_outbound_use_case` (when short-reply context is material)
- `expected_primary_intent`
- `expected_secondary_intents`
- `expected_authority_candidate` or `adversarial_*`
- `labeling_rationale`
- `source_category` (`authored` | `adversarial` | `context` | `historical_style_deid`)
- `independent_example_flag: true`
- `text_sha256` / `normalized_text_sha256`

Short yes/no must bind to **validated** outbound use case labels (ownership / proposal / asking_price / condition), not free-floating ownership.

Price positives require evidence of **seller asking / desired amount**. Neighbors must cover ZIP, year, sqft, phone, rent, taxes, mortgage, repairs, purchase history, ARV, buyer hypothetical, and explicit negation.

## Process (post-merge)

1. Curate examples **without** reading production rule bodies
2. Freeze gold + family map + write `immutable-content-hashes.json`
3. Run predictions once on frozen hash
4. Write calibration report
5. Only then consider allowlist PR if gates pass

## Files in this directory (PR #41)

| File | Role |
|---|---|
| `COLLECTION_SPEC.md` | This specification |
| `schema.json` | Empty frozen JSON schema for future gold rows |
| `manifest.template.json` | Empty manifest template |
| `.gitkeep` | Placeholder |

**Gold frozen. No predictions in this corpus freeze. Collection report present.**
