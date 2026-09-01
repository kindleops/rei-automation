-- Record the deal-aware assignment-margin policy on the immutable ADE snapshot.
--
-- The flat DEFAULT_TARGET_ASSIGNMENT_FEE ($15,000) made expected margin ~flat in
-- dollars (2.1% of ceiling on a $1.2M deal). The margin is now sized from the
-- deal itself, so a sent or accepted offer must be able to prove permanently
-- WHY it preserved the spread it did -- which policy version ran, what evidence
-- it saw, and what minimum/target/protected/max it produced.
--
-- Append-only table: these columns are written once per run and never updated
-- (enforced by acquisition_score_snapshots_immutable trigger).

alter table public.acquisition_score_snapshots
  add column if not exists assignment_margin_policy jsonb,
  add column if not exists assignment_margin_policy_version text,
  add column if not exists target_assignment_fee numeric;

comment on column public.acquisition_score_snapshots.assignment_margin_policy is
  'Deal-aware assignment-margin policy inputs/outputs for this run (minimum/target/protected/max, pct, reasons). Immutable, so an offer can permanently prove why it preserved the spread it did.';
