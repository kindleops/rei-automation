# Independent calibration v3.1 — empty workspace

**Status:** Protocol-ready empty workspace. **No gold. No predictions.**

This directory is the handoff surface for **true independent blind curation**.

## Do not

- Copy `independent-calibration-v3` / development-pack examples into v3.1 gold
- Use PR #41 remediation fixtures as held-out gold
- Allow the agent that edited `classify.js` to be sole labeler
- Run predictions before dual-curator freeze
- Populate `AUTHORITY_INTENT_ALLOWLIST` from development pack results

## Required reading before collection

- `../independent-calibration-v3/INDEPENDENT_LABELING_CONTRACT.md`
- `../independent-calibration-v3/SEMANTIC_VS_ROUTING_LABEL_CONTRACT.md`
- `../independent-calibration-v3/STATISTICAL_SAMPLE_SIZE_REQUIREMENTS.md`
- `../independent-calibration-v3/CONTEXT_COVERAGE_REQUIREMENTS.md`
- `../independent-calibration-v3/LEAKAGE_AUDIT_PROTOCOL.md`
- `COLLECTION_PROTOCOL.md` (this directory)

## Files

| File | Role |
|---|---|
| `COLLECTION_PROTOCOL.md` | Step-by-step independent curation |
| `schema.json` | Gold row schema (semantic + routing dual labels) |
| `manifest.template.json` | Empty frozen template |
| `gold-labels.jsonl` | **Empty** until dual-curator freeze |
| `immutable-content-hashes.template.json` | Hash slots |

When isolated curators complete adjudication, freeze gold → write immutable hashes → only then run predictions in a **separate** PR.
