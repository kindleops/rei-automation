# Independent labeling contract (true blind-v3.1)

## Hard rule

The coding agent that edited `classify.js` or reviewed PR #41 **cannot** be the sole gold-label authority for blind calibration used in authority decisions.

## Dual-curator protocol

1. **Curator A** labels without access to:
   - classifier rule bodies
   - classifier predictions
   - Curator B labels
2. **Curator B** labels independently without seeing Curator A
3. **Disagreements** are recorded with both labels and rationales
4. **Third-party adjudication** resolves disagreements
5. **Final gold** freezes only after adjudication
6. **Annotator provenance** recorded per example
7. **Inter-annotator agreement** reported:
   - percent agreement
   - Cohen’s κ (primary intent / semantic outcome)
   - disagreement count
   - adjudication count
   - unresolved ambiguity count

## Fields frozen after adjudication

All fields in `SEMANTIC_VS_ROUTING_LABEL_CONTRACT.md`, plus:

- `annotator_a_id` (opaque)
- `annotator_b_id` (opaque)
- `adjudicator_id` (opaque or null)
- `agreement_status` (`agree` | `disagreed_adjudicated` | `unresolved_ambiguous`)

## Current status (this repository session)

| Item | Status |
|---|---|
| Isolated Curator A available | **no** |
| Isolated Curator B available | **no** |
| Third-party adjudicator available | **no** |
| Dual independent labels present | **no** |
| Cohen’s κ | **n/a — no dual labels** |
| Agreement % | **n/a** |
| Disagreement count | **n/a** |
| Adjudication count | **0** |
| Unresolved ambiguity count | **n/a** |
| Independent curation still required | **yes** |

**Stop condition:** without isolated curators, true blind-v3.1 gold **must not** be claimed. Only the empty v3.1 workspace and protocol are prepared.
