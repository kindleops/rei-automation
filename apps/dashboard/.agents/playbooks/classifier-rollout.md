# Playbook: Classifier Rollout

Use this playbook to update message classification logic without breaking existing thread categories.

## 1. Audit Current State
- Run `scripts/proof-classifier.mjs` to see current category distribution.
- Identify "Unknown" or "General" threads that should be reclassified.

## 2. Pattern Testing
- Use the `classifier-tuning` skill to generate new regex patterns.
- Test patterns against a temporary SQL query before updating the view.

## 3. Shadow Run
- Create a temporary view `nexus_inbox_threads_v_v2` with the new logic.
- Compare the `priority_marker` output between the current and new view.

## 4. Migration
- Once validated, create a migration that uses `CREATE OR REPLACE VIEW nexus_inbox_threads_v`.
- Note: This will automatically propagate to `inbox_threads_hydrated`.

## 5. Verification
- Check the Inbox UI to ensure threads have the expected markers.
- Monitor for "fragmentation" if the new logic changes how threads are grouped (rare).
