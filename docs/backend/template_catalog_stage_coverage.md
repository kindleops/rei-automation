# Template Catalog Stage Coverage Audit

Read-only audit of production `sms_templates` (2026-06-23). No catalog mutations performed.

## Summary

| Metric | Value |
|--------|------:|
| Total templates | 8,668 |
| Enabled (`is_active=true`) | 8,668 |
| Malformed (missing stage/use_case/language/body) | 2 |
| Duplicate body clusters | 1,638 |

## Stage Coverage Matrix

| Stage | Templates | Use cases | Languages |
|-------|----------:|----------:|----------:|
| S1 | 4,637 | 1 | 16 |
| S2 | 1,861 | 1 | 16 |
| S3 | 761 | 1 | 16 |
| S4A | 54 | 1 | 9 |
| S4B | 53 | 1 | 9 |
| S4C | 37 | 5 | 9 |
| S5A | 182 | 11 | 9 |
| S5B | 2 | 1 | 1 |
| S5C | 2 | 1 | 1 |
| S5D | 2 | 1 | 1 |
| S6A | 22 | 6 | 2 |
| S6B | 354 | 45 | 9 |
| S6C | 58 | 11 | 9 |
| S6D | 89 | 9 | 9 |
| S6E | 342 | 38 | 9 |
| S1F | 4 | 1 | 1 |
| S2F | 34 | 9 | 9 |
| S3F | 3 | 1 | 1 |
| SP (special) | 141 | 15 | 9 |
| MF1–MF5 | 28 | 5 | 3 |

## Stage 1 — Ownership

Primary use case: `ownership_check` (4,637 templates across 16 languages).

Follow-up slot `ownership_check_follow_up` (S1F): 4 English templates.

Gaps: no dedicated wrong-person / wrong-number / opt-out acknowledgment slots outside SP stage in this inventory pass.

## Stage 2 — Selling Interest

Primary use case: `consider_selling` (1,861 templates, 16 languages).

Follow-ups concentrated in S2F (34 templates, 9 use cases) including Spanish persona follow-ups.

## Stage 3 — Asking Price

Primary use case: `seller_asking_price` (761 templates, 16 languages).

Follow-up: `asking_price_follow_up` (S3F, 3 English).

## Stage 4 — Condition and Underwriting

S4A `price_works_confirm_basics`, S4B `price_high_condition_probe`, S4C creative/seller-finance probes.

English exact-language coverage is strongest; long-tail languages rely on translated bulk sets.

## Stage 5 — Offer and Negotiation

S5A dominates (182 templates, 11 use cases). S5B/C/D are minimal (2 templates each).

Objection and persona variants exist primarily under S5A and S6B.

## Stage 6 — Contract to Close

Distributed across S6A–S6E (865 templates total) with S6B (354) and S6E (342) carrying the broadest use-case spread.

## Language Coverage

| Language | Templates |
|----------|----------:|
| Spanish | 762 |
| Portuguese | 587 |
| Mandarin | 586 |
| Polish | 586 |
| Vietnamese | 586 |
| Hebrew | 586 |
| Korean | 586 |
| Italian | 576 |
| Japanese | 479 |
| French | 479 |
| German | 479 |
| Greek | 479 |
| Hindi/Indian | 479 |
| Arabic | 479 |
| Russian | 479 |
| English | 460 |

English is under-represented versus auto-translated long-tail language bulk imports for S1/S2/S3.

## Follow-up Coverage Matrix

| Stage | Follow-up stage | Templates | Notes |
|-------|-----------------|----------:|-------|
| S1 | S1F | 4 | English only |
| S2 | S2F | 34 | Mixed languages, persona variants |
| S3 | S3F | 3 | English only |
| S4 | (embedded in S4C) | 37 | Creative/monthly-payment follow-ups |
| S5 | S6A/B/C/D/E | 865 | Negotiation/contract follow-ups split by sub-stage |
| S6 | S6B–S6E | 843 | Closing coordination spread |

## Duplicate / Malformed

- **Duplicate body clusters:** 1,638 groups share identical `template_body` text (mostly multilingual S1/S2/S3 bulk imports).
- **Malformed metadata:** 2 rows missing `stage_code`.

## Audit Method

Paginated SQL against production `sms_templates`:

```sql
SELECT stage_code, COUNT(*) AS templates, COUNT(DISTINCT use_case) AS use_cases, COUNT(DISTINCT language) AS languages
FROM sms_templates GROUP BY stage_code ORDER BY stage_code;
```

No writes performed.