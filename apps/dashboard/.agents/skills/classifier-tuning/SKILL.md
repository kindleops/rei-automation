# Classifier Tuning

## Overview
This skill outlines how to safely tune the `nexus_inbox_priority_classify` SQL function, which is responsible for intent detection and priority bucketing.

## Tuning Workflow
1. Identify the unhandled or incorrectly handled phrase (e.g., "stop texting me now").
2. Open `supabase/migrations/..._inbox_truth_rebuild.sql` (or the latest active migration).
3. Find the `nexus_inbox_priority_classify` function.
4. The function normalizes the input into `body_norm` (alphanumeric only) and `body_pad` (spaced for boundary matching).
5. Add the new phrase to the appropriate `WHEN` clause using `body_pad LIKE '% new phrase %'`.

## Intent Categories
- `opt_out`: DNC signals, stops, wrong numbers.
- `wrong_person`: Explicitly wrong contact.
- `not_interested`: Not selling, don't ask again.
- `hostile_or_legal`: Threats, harassment, lawsuits.
- `price_anchor`: Sent a numeric price or dollar amount.
- `potential_interest`: Positive signals.
- `info_request`: Asking who the sender is.

## Anti-Patterns & Known Failures
- **Anti-Pattern**: Using `body_norm LIKE '%stop%'`. This will incorrectly flag words like "nonstop". **Always use `body_pad` with space boundaries.**
- **Anti-Pattern**: Forgetting `LOWER()` on raw checks.
- **Known Failure**: Commas or periods in numbers ($100,000) breaking regex if not using `raw_body_lower`.

## Production Validation
You MUST run the inline regression tests built into the migration file, or run the external proof script:
`node scripts/proof-classifier.mjs`

## Resources
- `.agents/skills/classifier-tuning/examples/`
- `.agents/skills/classifier-tuning/patterns/`
- `.agents/skills/classifier-tuning/known_failures/`
- `.agents/skills/classifier-tuning/test_cases/`
