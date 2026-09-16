/**
 * WHEN MAY OPENING A PAGE COMMISSION A MATCH RUN?
 *
 * A read must never trigger a write by accident. The workspace's inline
 * version of this decision had two defects that both produced real production
 * match runs:
 *
 *  1. It gated on `candidates.length === 0`, and a separate envelope bug meant
 *     candidates never loaded — so EVERY visit to a property whose last run
 *     was over six hours old ordered a fresh one.
 *
 *  2. It treated `latestRun === null` as "no run exists" when it also means
 *     "the runs query has not returned yet". Its 400ms timer raced that query.
 *     Locally the runs won the race and nothing happened; against production
 *     on 2026-09-16 the query was slower and merely opening the page created
 *     run 5833ab4a, 63 minutes after the previous run and well inside the
 *     6-hour staleness window.
 *
 * Extracted here so the rule is one testable decision rather than a condition
 * entangled with effect timing.
 */

export const AUTO_RUN_STALE_MS = 6 * 60 * 60 * 1000

export interface AutoRunInput {
  /** Has the run history actually been READ? Not "is it empty". */
  runsLoaded: boolean
  /** Newest known run, or null when there genuinely is none. */
  latestRunCreatedAt?: string | number | Date | null
  /** Candidates currently held for this property. */
  candidateCount: number
  paused?: boolean
  running?: boolean
  /** Already decided for this property in this session. */
  alreadyDecided?: boolean
  now?: number
}

export type AutoRunDecision =
  | { run: true; reason: 'no_run_exists' | 'run_is_stale' }
  | { run: false; reason: 'runs_not_loaded' | 'paused' | 'already_running' | 'already_decided' | 'has_candidates' | 'run_is_fresh' }

export function decideAutoRun(input: AutoRunInput): AutoRunDecision {
  if (input.paused) return { run: false, reason: 'paused' }
  if (input.running) return { run: false, reason: 'already_running' }
  if (input.alreadyDecided) return { run: false, reason: 'already_decided' }

  // The load-bearing guard. Absent run history is not an absent run.
  if (!input.runsLoaded) return { run: false, reason: 'runs_not_loaded' }

  if (input.candidateCount > 0) return { run: false, reason: 'has_candidates' }

  const raw = input.latestRunCreatedAt
  if (raw === null || raw === undefined || raw === '') return { run: true, reason: 'no_run_exists' }

  const at = new Date(raw as string).getTime()
  // An unparseable timestamp is not evidence of staleness — treat the run as
  // present and fresh rather than ordering work on a bad date.
  if (!Number.isFinite(at)) return { run: false, reason: 'run_is_fresh' }

  const now = input.now ?? Date.now()
  return now - at > AUTO_RUN_STALE_MS
    ? { run: true, reason: 'run_is_stale' }
    : { run: false, reason: 'run_is_fresh' }
}
