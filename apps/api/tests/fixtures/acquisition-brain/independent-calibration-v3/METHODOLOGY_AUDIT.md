# PR #42 methodology audit

## Original claim (superseded)

PR #42 initially froze `independent_calibration_v3` with 791 examples and claimed one semantic family per example (791 families), presenting the freeze as pre-prediction blind calibration material.

## Findings

1. **Independence inflation:** unique `semantic_family_id` per surface form treated paraphrases as independent observations.
2. **Label authority:** single-agent authored/template corpus without dual-curator adjudication.
3. **Natural language:** ~0.8% historical-style deid; ~99% constructed/adversarial/context authored language.
4. **Context coverage:** 23 context fixtures — insufficient for context-contract matrix.
5. **Routing vs semantics:** production intents (e.g. sold → `wrong_number`) used as if pure semantic gold.
6. **Statistics:** cannot support precision LB ≥ 0.99 or recall LB ≥ 0.95 as independent authority evidence.
7. **Leakage:** exact/normalized filtering was necessary but not a full hardened protocol.

## Correction

| Item | Action |
|---|---|
| Original gold + hashes | **Preserved bit-for-bit** |
| Conceptual version | `acquisition_brain_adversarial_development_pack_v3` |
| Authority confidence | **`may_count_for_authority_confidence = false` for all examples** |
| True families | Clustered construction families (see `true-family-map.json`) |
| Semantic vs routing | Dual-label overlay + contract |
| Independent labeling | Contract + **curators unavailable** status |
| v3.1 | Empty workspace + protocol |
| Verifier | Read-only `verify-frozen-corpus.mjs` |

## Merge posture

Merge as **development/adversarial pack + methodology correction + v3.1 handoff only**.  
Do **not** merge as authority-grade blind calibration.
