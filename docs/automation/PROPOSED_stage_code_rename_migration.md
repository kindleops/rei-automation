# PROPOSED (NOT APPLIED) — Lifecycle stage code rename migration

Status: **proposal only**. Nothing in this document has been applied to the database. Requires explicit approval before execution.

## What the code change already did (no migration needed)

The canonical ten-stage **order** was corrected in code with **zero database changes**, because stages are persisted as
**semantic strings** and the affected S7–S9 string values were left unchanged:

| # | code string (unchanged) | old label → new label |
|---|---|---|
| 7 | `disposition` | Disposition → **Dispo** (moved from position 8 → 7) |
| 8 | `under_contract` | Under Contract → **Under Contract With Buyer** (moved 7 → 8) |
| 9 | `prepared_to_close` | Prepared to Close → **Escrow** |

Only ordinal position (`LIFECYCLE_STAGE_ORDER`), `number`, and display `label` moved. The string values stay valid under the
existing `acquisition_opportunities_stage_check` CHECK constraint, so no write can be rejected and no view/consumer keyed on
the strings breaks.

**Evidence a data migration is not required for the order fix** (read-only queries, 2026-07-12, project `lcppdrmrdfblstpcbgpf`):

- `inbox_thread_state.lifecycle_stage` distinct values in production: `offer_interest` (4717), `ownership_confirmation` (984),
  `closed` (132), `asking_price` (14). **No row** holds `under_contract`, `disposition`, or `prepared_to_close`.
- Across `acquisition_opportunities.acquisition_stage`, `seller_automation_executions/steps.lifecycle_stage`,
  `message_events`, `send_queue`, `active_negotiations`, `deal_thread_state`: the only S4–S10 codes present are
  `property_condition`, `offer`, `formal_contract` (S4–S6, positions unchanged). **Zero rows** hold any S7/S8/S9 code.
- `inbox_thread_state.lifecycle_stage` has **no** CHECK constraint (free text). Only `acquisition_opportunities.acquisition_stage`
  is CHECK-constrained.

Because the affected codes have zero rows and their positions are the only thing that changed, existing deal meaning is
preserved exactly: every persisted stage string maps to the same milestone; only the labels/ordinals for the (empty) S7–S9
codes were corrected.

## What this proposal adds — the literal code-string rename

To make the internal identifiers match the canonical names (`under_contract` → `under_contract_with_buyer`,
`prepared_to_close` → `escrow`), a migration is required **only** because `acquisition_opportunities.acquisition_stage`
carries a CHECK constraint that does not list the new strings. Renaming in code without this migration would cause any future
write of `under_contract_with_buyer`/`escrow` to that column to be rejected.

### Affected surfaces

| Layer | Item | Change |
|---|---|---|
| DB constraint | `acquisition_opportunities_stage_check` | add `under_contract_with_buyer`, `escrow`; (optionally) drop legacy `under_contract`, `prepared_to_close` after backfill |
| DB rows | `acquisition_opportunities.acquisition_stage` | 0 rows to backfill (`under_contract`→`under_contract_with_buyer`, `prepared_to_close`→`escrow`) |
| DB rows | `inbox_thread_state.lifecycle_stage` / `seller_stage` / `stage`, `seller_automation_executions/steps.lifecycle_stage`, `message_events.*stage*`, `send_queue.*stage*`, `deal_thread_state.universal_stage` | 0 rows to backfill (none carry the affected codes) |
| DB views | ~40 `v_*` / `*_view` / `*_hydrated` reading a stage column | no DDL if they pass the string through; re-create only those with a hardcoded literal of the old code (none found referencing `under_contract`/`prepared_to_close` literals in view bodies — verify at apply time) |
| API code | `LIFECYCLE_STAGE_CODES`/`UNIVERSAL_STAGE_CODES` string values, alias maps (already forward-compatible: `under_contract_with_buyer` and `escrow` normalize today) | flip primary value; keep old strings as read-aliases |
| API code | `seller-flow-automation-adapter.js` (`buyerContractSignal`/`escrowSignal`), `followup-policy-registry.js`, `resolve-seller-stage-transition.js`, `seller-lifecycle-stage-registry.js` | reference by constant key — auto-follow the value change |
| Dashboard | `domain/lead-state/universal-lead-state-registry.ts`, `domain/pipeline/pipeline-canonical-taxonomy.ts`, map/closing display files keyed on the string | flip value; add old-string aliases in the normalizer |
| Tests | resolver/registry/pipeline tests referencing the string literals | update literals |

### Proposed migration SQL (DDL — do not apply without approval)

```sql
BEGIN;

-- 1. Backfill (0 rows expected; safe no-op if empty).
UPDATE public.acquisition_opportunities
   SET acquisition_stage = CASE acquisition_stage
       WHEN 'under_contract'    THEN 'under_contract_with_buyer'
       WHEN 'prepared_to_close' THEN 'escrow'
       ELSE acquisition_stage END
 WHERE acquisition_stage IN ('under_contract','prepared_to_close');

-- 2. Replace the CHECK constraint to allow the new canonical codes while
--    retaining the legacy strings for one deploy cycle (belt-and-suspenders).
ALTER TABLE public.acquisition_opportunities
  DROP CONSTRAINT acquisition_opportunities_stage_check;
ALTER TABLE public.acquisition_opportunities
  ADD CONSTRAINT acquisition_opportunities_stage_check CHECK (
    acquisition_stage = ANY (ARRAY[
      'ownership_confirmation','offer_interest','asking_price','property_condition',
      'offer','formal_contract',
      'disposition','under_contract_with_buyer','escrow','closed',
      -- retained legacy aliases (removed in a later cleanup migration):
      'under_contract','prepared_to_close',
      'needs_review','interest_qualification','price_discovery','underwriting',
      'decision_and_offer','contract_to_close'
    ])
  );

COMMIT;
```

### Proof the rename preserves deal meaning

- 0 rows carry the renamed codes, so no deal's stage is reinterpreted.
- The milestone semantics are unchanged (see `firstUnresolvedIdx`): `disposition` = post-seller-contract Dispo,
  `under_contract(_with_buyer)` = buyer under contract, `prepared_to_close`/`escrow` = escrow. The rename is a label of the same
  milestone, not a re-bucketing.
- Read-aliases (`under_contract`, `prepared_to_close`) remain in the normalizers, so any historical string still resolves to the
  same canonical stage during and after the transition.

### Rollout order (when approved)

1. Apply migration (constraint accepts both old and new strings).
2. Deploy the code value flip (writes new strings; reads both via aliases).
3. Later cleanup migration: drop the legacy `under_contract`/`prepared_to_close` from the CHECK once no writer emits them.
