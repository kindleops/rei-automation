# True independent blind-v3.1 collection protocol

## Preconditions

1. Isolated Curator A and Curator B available (not the classifier author)
2. Adjudicator available for disagreements
3. Development pack v3 treated only as **prior exclusion corpus**, not gold seed

## Steps

1. **Draft collection plan** per candidate × language with sample-size targets from `STATISTICAL_SAMPLE_SIZE_REQUIREMENTS.md`
2. **Source mix target:** ≥50% deidentified historical or independently collected natural conversational seller language; authored only for boundaries; adversarial for safety
3. **De-identify** to zero PII (no names, phones, exact addresses, emails, production IDs)
4. **Curator A** labels with semantic+routing dual fields, no classifier access
5. **Curator B** labels independently
6. Record disagreements; adjudicate
7. Report agreement %, Cohen’s κ, disagreement/adjudication/unresolved counts
8. **True family grouping** (multi-paraphrase families allowed; one construction = one family)
9. **Hardened leakage audit** against all priors including development pack v3
10. **Freeze** gold + hashes (immutable); wall-clock must not rewrite frozen content
11. **Verify** with a read-only verifier that reproduces hashes
12. **Separate PR** for predictions only after freeze

## Candidate groups

1. Context-validated ownership confirmation  
2. Clear seller request for proposal  
3. Explicit seller asking-price disclosure  

English and Spanish are **separate** populations.

## Failure modes that force `insufficient_independent_support`

- Paraphrase inflation without true families
- Single-agent labels
- <300 independent predicted-positive opportunities when claiming precision LB
- <~60 gold-positive families when claiming recall LB with zero-FN assumption (more if FNs expected)
- Context matrix incomplete
- Natural language share <50% for a qualifying candidate/language
