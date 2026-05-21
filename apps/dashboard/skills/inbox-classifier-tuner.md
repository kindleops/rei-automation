# Inbox Classifier Tuner

## Purpose
Maintain and refine the SQL-based intent classifier (`nexus_inbox_priority_classify`) to ensure inbound messages are accurately categorized for priority handling and workflow automation.

## When to use
- When a user reports a misclassified message (e.g., "STOP" message appearing in "Hot Leads").
- When a new intent category needs to be added to the system.
- When refining priority bucket assignments (Priority, Hidden, Suppressed).

## Exact steps
1. **Identify the Pattern**: Find the specific message body and direction that was misclassified.
2. **Review Existing Logic**: Examine the `nexus_inbox_priority_classify` function in `supabase/migrations/20260508030000_inbox_truth_rebuild.sql`.
3. **Draft the Fix**: Update the `CASE` statement in the SQL function. Use `body_pad` for phrase matching (e.g., `body_pad LIKE '% stop %'`) to avoid partial word matches.
4. **Update Regression Tests**: Add a new test case to the `DO $$ ... ASSERT ... $$` block in the migration file to prevent future regressions.
5. **Apply to Supabase**: Run the updated `CREATE OR REPLACE FUNCTION` block in the Supabase SQL Editor.
6. **Verify with Proof Script**: Run the integrity proof script to confirm the fix works as expected.
   ```bash
   node scripts/proof/inbox-integrity.mjs
   ```

## Safety rules
- **Never** modify the classifier without adding or updating a regression test case.
- **Always** use `LOWER()` and `TRIM()` (or the pre-calculated `body_norm`/`body_pad`) for matching.
- **Check** that the `show_in_priority_inbox` boolean correctly reflects the intended visibility for the new classification.

## Commands to run
- `node scripts/proof/inbox-integrity.mjs`: Runs regression tests for the classifier.
- `node scripts/dump-inbox-v.mjs`: Dumps the current view state to see how messages are being classified in real-time.
- `node scripts/check-thread-state.mjs`: Checks the specific state of a thread to see if manual overrides are affecting classification.

## Proof requirements
- "All regression checks passed" notice in the Supabase SQL Editor output.
- `node scripts/proof/inbox-integrity.mjs` showing "✅ Correct: [pattern] classified as [intent]".

## “Do not” rules
- Do not use broad `LIKE '%...%'` matches that could catch unrelated words (e.g., `LIKE '%no%'` would match "notary"). Use `body_pad` with spaces.
- Do not forget to account for `latest_direction` (only `inbound` should typically trigger priority classifications).
- Do not break the "Opt-Out" or "Hostile" categories, as these are critical for compliance.
