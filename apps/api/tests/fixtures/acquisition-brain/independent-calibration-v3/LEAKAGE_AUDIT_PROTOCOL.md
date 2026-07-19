# Hardened leakage audit protocol

Applies before freezing any **blind** corpus (v3.1+). Development pack v3 original audit is preserved for history; this protocol supersedes claims of sufficiency.

## Prior corpora to exclude against

- independent-calibration-v1 (if present)
- independent-calibration-v2 gold + neighbors + context
- development seeds (EN/ES)
- PR #41 remediation development fixtures
- acquisition_brain_adversarial_development_pack_v3 (this pack) once v3.1 starts

## Checks (all required)

1. Exact string match  
2. Normalized match (case, whitespace, punctuation, accents)  
3. Character n-gram similarity (e.g. 3-gram Jaccard / cosine) with review threshold  
4. Token-set similarity (Jaccard) with review threshold  
5. Shared source lineage (same historical message / same template seed lineage)  
6. Semantic-family lineage (same true construction family as prior held-out or development)  
7. Translation-equivalent review (manual bilingual pairs; not merely distinct family IDs)  
8. Manual review of suspicious pairs  

## Reporting

Every exclusion must record:

- example ID (or draft ID)
- matched prior ID / corpus
- method that triggered
- reason code

## Development pack v3 note

Original freeze reported exact/normalized pass after 12 exclusions, but **did not** meet the full hardened protocol above for authority-grade claims.
