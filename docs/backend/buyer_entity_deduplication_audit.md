# Buyer Entity Deduplication Audit (Read-Only)

Audit date: 2026-06-22  
Branch: `buyer-match-production-lock`  
**No production mutations performed.**

## Purpose

Document deterministic identity linkage rules for buyer person, company, and purchase-entity deduplication. Ambiguous identities must be flagged — never silently merged.

## Entity model (canonical separation)

| Entity | Canonical ID | Primary sources |
| --- | --- | --- |
| Buyer person | `buyer_person_id` (target) | Contacts, outreach, phones, emails |
| Buyer company | `buyer_company_id` / `buyer_entity_id` | `buyer_entities_v2`, corp filings |
| Identity relationship | composite key | Officers, registered agent, ownership |
| Buy box | per entity | Explicit prefs + inferred from purchases |
| Purchase event | event row id | `buyer_purchase_events_v2`, `v_buyer_entity_purchases` |
| Deal match | `buyer_match_candidate_id` | `buyer_match_candidates` |

Current production tables primarily expose **`buyer_entities_v2`** + **`buyer_purchase_events_v2`** as the operational grain.

## Deduplication signals (confidence-based)

| Signal | Confidence | Rule |
| --- | --- | --- |
| Exact normalized E.164 phone | 0.95 | Link person identities |
| Exact normalized email | 0.95 | Link person identities |
| Exact entity registration / SOS filing ID | 0.98 | Link company identities |
| Exact domain (company email domain) | 0.90 | Link company identities |
| Exact normalized grantee on repeat purchases | 0.85 | Link purchase entity to buyer_entity |
| Officer ↔ company relationship | 0.80 | Person-company edge |
| Verified mailing address hash | 0.75 | Supporting evidence only |
| Fuzzy name similarity alone | **0.0 merge** | Flag ambiguous — do not merge |

Normalization functions in DB: `normalize_buyer_entity_text`, `normalize_buyer_entity_name` (`20260517172105` migration).

## Duplicate risk areas observed

| Area | Risk | Mitigation |
| --- | --- | --- |
| LLC name variants (LLC / L.L.C. / Holdings) | High | `normalize_buyer_entity_name` stripping suffixes |
| Same buyer, multiple `buyer_key` hashes | Medium | Require phone/email/entity registration match |
| Corporate acquisitions counted as individuals | Medium | `is_corporate_buyer` + institutional classifier |
| Repeat buyer under rotating LLCs | High | Officer/registered-agent graph + purchase velocity |
| Podio legacy vs Supabase v2 entities | High | Do not auto-merge across engines |

## Classification evidence (purchase graph)

| Class | Minimum evidence |
| --- | --- |
| individual | Single natural-person grantee, no corp flag |
| local investor | 2+ purchases same metro, non-corp |
| repeat buyer | 3+ purchases or 2+ in 365d same market |
| corporate buyer | `is_corporate_buyer` or entity suffix |
| institutional | 25+ purchases or fund/REIT name patterns + volume |
| fund | Known fund keywords + multi-market velocity |
| lender-acquired | Grantee matches lender master list |
| government/non-market | Municipal/housing authority patterns |
| unknown | Insufficient evidence — show in diagnostics |

## Ambiguous identity handling

When two entities share partial signals (e.g., similar name, different phones):

1. Do **not** merge in match engine
2. Surface both as separate candidates with `duplicate_risk: ambiguous` metadata
3. Log in dedup report for operator review
4. Hard-exclude only when `duplicate_identity` confirmed with high-confidence collision on same deal

## Recommended backfill migrations (not applied)

1. Materialized `buyer_identity_edges` from phones/emails/entity registrations
2. `buyer_purchase_events_v2` dedupe on `(property_id, sale_date, grantee_normalized, sale_price)`
3. Explicit `buyer_buy_boxes` table with `inferred` vs `explicit` flag
4. Refresh `buyer_geo_rollups_v2` after purchase graph backfill

## Status

**READ-ONLY AUDIT COMPLETE** — awaiting buyer data backfill before dedup merges in production.