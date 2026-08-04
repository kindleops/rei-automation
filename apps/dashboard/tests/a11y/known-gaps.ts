/**
 * Defects that are REAL and MEASURED but sit inside a surface another lane owns
 * and is already changing on its own branch. Lane G reports them instead of
 * editing the same declarations, because a value-level edit to a line another
 * lane is rewriting is a merge conflict for no benefit.
 *
 * Run with LC_GATE_STRICT=1 to fail on these — that is what Lane H should do
 * AFTER integration, when every lane's fix is in one tree.
 *
 * Every entry must name the owning lane and the evidence.
 */
export type KnownGap = {
  /** Substring match against the audit's `selector` field. */
  selector: string
  lane: string
  reason: string
}

export const KNOWN_GAPS: KnownGap[] = [
  /* ── §2.1 type floor ─────────────────────────────────────────────────── */
  {
    selector: 'nx-cat-nav__',
    lane: 'C',
    reason:
      'inbox-workspace-layout.css:303/309 — 8px/9px. ui/lane-c-inbox already raises both to 12px.',
  },
  {
    selector: 'nx-row25__',
    lane: 'C',
    reason: 'inbox-workspace-layout.css:455 — 10px. Raised to 12px on ui/lane-c-inbox.',
  },
  {
    selector: 'nx-prop-flags__',
    lane: 'C',
    reason: 'inbox-workspace-layout.css:394/400 — 8.5px/9.5px. Raised to 12px on ui/lane-c-inbox.',
  },
  {
    selector: 'nx-cc-row__',
    lane: 'C',
    reason: 'inbox-workspace-layout.css:899/906/915 — 10px/10.5px, still sub-floor on ui/lane-c-inbox.',
  },
  {
    selector: 'dossier',
    lane: 'E',
    reason: 'dossier.css carries 23 sub-11px declarations; Lane E owns that file.',
  },

  /* ── §16.1 contrast ──────────────────────────────────────────────────── */
  {
    selector: 'dch-',
    lane: 'D',
    reason:
      'deal command header meta/labels declare rgba(...) alpha 0.48-0.62 at 11px ⇒ 3.0-4.1:1. '
      + 'Owned by the conversation/deal-header lane; token-level fix belongs with the header rebuild.',
  },
]

export function isKnownGap(selector: string): KnownGap | undefined {
  return KNOWN_GAPS.find((g) => selector.includes(g.selector))
}

export const STRICT = process.env.LC_GATE_STRICT === '1'

export function partitionGaps<T extends { selector: string }>(rows: T[]): {
  failures: T[]
  deferred: (T & { lane: string })[]
} {
  if (STRICT) return { failures: rows, deferred: [] }
  const failures: T[] = []
  const deferred: (T & { lane: string })[] = []
  for (const row of rows) {
    const gap = isKnownGap(row.selector)
    if (gap) deferred.push({ ...row, lane: gap.lane })
    else failures.push(row)
  }
  return { failures, deferred }
}
