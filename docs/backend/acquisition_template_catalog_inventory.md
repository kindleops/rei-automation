# Acquisition Template Catalog Inventory

**Generated:** 2026-06-22  
**Mode:** Read-only audit — no production mutations  
**Resolver version:** 2.0.0  
**Status:** READY FOR FULL TEMPLATE CATALOG MIGRATION (code); data migration pending

## Executive Summary

| Metric | Count |
|--------|------:|
| **Total reachable templates (confirmed sources)** | **8,771** |
| Supabase `sms_templates` (canonical runtime) | 8,668 |
| Local registry candidates | 67 |
| CSV catalogs (lifecycle + underwriting + test) | 36 |
| Podio/legacy (live count unknown) | TBD |
| Operator-reported universe | ~10,000 |

Supabase is the **canonical production runtime source**. All other sources require import/normalization — not discard.

## Source Inventory

### 1. Supabase `sms_templates` (canonical runtime)

| Field | Value |
|-------|-------|
| Total rows | 8,668 |
| Enabled (`is_active=true`, lifecycle=enabled) | 8,668 |
| Disabled | 0 |
| Retired | 0 |
| Draft (explicit) | 0 |
| Production reachable | Yes |
| Migration requirement | Normalize metadata; assign lifecycle; retire duplicates |

**Lifecycle contract (runtime):**

- `draft` — not selectable
- `enabled` — selectable when metadata matches
- `disabled` — not selectable
- `retired` — historical only

`review_required` and `approved_for_automatic_reply` are **legacy aliases**, not runtime gates.

### 2. Local template registry

| Field | Value |
|-------|-------|
| Path | `apps/api/src/lib/domain/templates/local-template-registry.js` |
| Total | 67 |
| Enabled | 67 |
| Production reachable | No (dev/fallback registry) |
| Migration requirement | Import to Supabase with lifecycle metadata |

### 3. CSV catalogs

| File | Rows |
|------|-----:|
| `docs/templates/lifecycle-sms-template-pack.csv` | 4 |
| `docs/templates/underwriting-template-pack.csv` | 12 |
| `tests/helpers/test-templates.csv` | 20 |
| **Total** | **36** |

Production reachable: No. Merge into Supabase or deprecate after import verification.

### 4. Podio / legacy

| Field | Value |
|-------|-------|
| Paths | `apps/api/src/lib/podio/apps/templates.js`, `find-template.js` |
| Total | Unknown without live Podio query |
| Production reachable | Legacy path only |
| Migration requirement | Historical import to Supabase |

### 5. S1 preview pack (proposed additions only)

| Field | Value |
|-------|-------|
| Path | `apps/api/supabase/seeds/acquisition_s1_template_pack.preview.json` |
| Templates | 16 (EN/ES/RU) |
| `do_not_apply_to_production` | true |
| Role | Reference/proposed missing-template additions |

## Language Coverage (Supabase)

16 canonical languages verified in catalog:

| Canonical | ISO | Templates | Enabled | Stages | Primary use cases |
|-----------|-----|----------:|--------:|--------|-------------------|
| English | en | 587 | 587 | S1–S3 | ownership_check, consider_selling, seller_asking_price |
| Spanish | es | 587 | 587 | S1–S3 | ownership_check, consider_selling, seller_asking_price |
| Portuguese | pt | 587 | 587 | S1–S3 | ownership_check, consider_selling, seller_asking_price |
| Russian | ru | 479 | 479 | S1–S3 | ownership_check, consider_selling, seller_asking_price |
| German | de | 479 | 479 | S1–S3 | ownership_check, consider_selling, seller_asking_price |
| French | fr | 479 | 479 | S1–S3 | ownership_check, consider_selling, seller_asking_price |
| Italian | it | 479 | 479 | S1–S3 | ownership_check, consider_selling, seller_asking_price |
| Hebrew | he | 479 | 479 | S1–S3 | ownership_check, consider_selling, seller_asking_price |
| Japanese | ja | 479 | 479 | S1–S3 | ownership_check, consider_selling, seller_asking_price |
| Mandarin | zh | 479 | 479 | S1–S3 | ownership_check, consider_selling, seller_asking_price |
| Arabic | ar | 479 | 479 | S1–S3 | ownership_check, consider_selling, seller_asking_price |
| Vietnamese | vi | 479 | 479 | S1–S3 | ownership_check, consider_selling, seller_asking_price |
| Greek | el | 479 | 479 | S1–S3 | ownership_check, consider_selling, seller_asking_price |
| Polish | pl | 479 | 479 | S1–S3 | ownership_check, consider_selling, seller_asking_price |
| Korean | ko | 479 | 479 | S1–S3 | ownership_check, consider_selling, seller_asking_price |
| Asian Indian (Hindi or Other) | hi | 479 | 479 | S1–S3 | ownership_check, consider_selling, seller_asking_price |

Malformed/unknown language values: **0** in Supabase catalog.

Full machine-readable inventory: `apps/api/scripts/proof/template-catalog-inventory-report.json`

## S1 Preview Pack vs Full Catalog

| Preview template | Language | Status | Existing count |
|------------------|----------|--------|---------------:|
| S1 Ownership T1 | EN | equivalent_exists | 44 |
| S1 Ownership T1 | ES | equivalent_exists | 308 |
| S1 Ownership T1 | RU | equivalent_exists | 306 |
| S1 Ownership Follow-Up T2 | EN/ES/RU | **missing** | 0 |
| S1 Who Is This | EN/ES/RU | **missing** | 0 |
| S1 Wrong Person | EN/ES/RU | **missing** | 0 |
| S1 Not Owner | EN/ES/RU | **missing** | 0 |
| S1 Entity/Rep | EN | **missing** | 0 |

**Recommendations (preview only — not applied):**

- Add follow-up and clarification use-case templates across all 16 catalog languages
- Do not promote the 16-template preview as the S1 catalog — 8,668 Supabase rows already exist
- Review near-duplicates in existing `ownership_check` EN rows (44 variants) before adding preview EN T1

## Migration Plan

### Phase 1 — Metadata normalization (no sends)

1. Assign explicit `metadata.lifecycle_status` to all 8,668 rows
2. Mark duplicate historical rows `retired`
3. Normalize `use_case`, `stage_code`, `touch_number`, `language` via `template-metadata-normalization.js`
4. Import 67 local registry templates as `draft` for operator review

### Phase 2 — Legacy source import

1. Query Podio template app for remaining ~1,200 rows (estimated gap to 10K)
2. Deduplicate against Supabase by `use_case + language + stage + body hash`
3. Import net-new rows as `draft`; promote to `enabled` only after metadata validation

### Phase 3 — Runtime cutover

1. Route all autonomous replies through `template-runtime-resolver.js`
2. Deprecate CSV `template_resolver.js` English-fallback path
3. Retire Podio runtime reads

## Deterministic Metadata Cleanup Plan

| Issue | Action |
|-------|--------|
| `consider_selling` rows tagged S1 | Remap stage to S2 via normalization preview script |
| Missing `touch_number` metadata | Infer from `is_first_touch` / `is_follow_up` |
| Legacy `safe_for_auto_reply=false` on enabled rows | Preserve field; do not block enabled templates |
| Duplicate EN ownership_check (44 variants) | Rank by delivery/reply rate; retire lower performers |

Preview script: `apps/api/scripts/proof/template-metadata-cleanup-preview.mjs`