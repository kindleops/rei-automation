# Independent calibration v2 → development remediation

**Immutable:** `../independent-calibration-v2/` gold labels, hashes, predictions, and report are frozen. Do not edit them.

**This directory** records remediation after blind evaluation:

- `remediation-manifest.json` — every inspected v2 example with prior expected/classifier results, error category, remediation rule, and `development_after_blind_evaluation: true`
- `development-fixtures.json` — development-only regression cases derived from v2 failures (corrected labels where gold/context was insufficient)

These examples **must not** be counted in future blind calibration metrics (v3+).
