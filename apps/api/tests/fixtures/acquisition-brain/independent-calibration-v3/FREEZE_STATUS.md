# Acquisition Brain adversarial development pack v3 — preserved freeze

## Conceptual version

`acquisition_brain_adversarial_development_pack_v3`

## Original frozen artifacts (immutable)

| Field | Value |
|---|---|
| Original corpus version string | `independent_calibration_v3` |
| Original HEAD (PR #42 first freeze commit) | `cb9f05bf5e496fbceae5ebe921ad5922bda1df53` |
| gold_labels_jsonl_sha256 | `dcbfdea9b54e60dceeaca750be7db4ba67de9f5169ba0e77e90437c3816d7b3d` |
| manifest_json_sha256 | `571a81af0d83d0f527b761076e68d55428670b556e30c41e2bd1f44cbdd13c8a` |
| examples | 791 (EN 507 / ES 284) |

## Authority use

**Forbidden.** Every example:

- `calibration_status = development_after_methodology_review`
- `may_count_for_authority_confidence = false`

(See `methodology-overlay.jsonl` — gold file is not rewritten.)

## Predictions

**None.** Do not run classifier predictions against this pack for authority qualification.

## Verify

```bash
node apps/api/tests/fixtures/acquisition-brain/independent-calibration-v3/verify-frozen-corpus.mjs
```

Read-only. Rebuild of frozen gold must fail closed.
