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
  /**
   * Optional substring match against the rendered TEXT. Needed when the offending
   * element carries no class — an inline `style={{ fontSize: 10 }}` on a bare
   * <span> is indistinguishable from any other span by selector alone.
   */
  text?: string
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
  {
    selector: 'nx-load-more-btn',
    lane: 'C',
    reason:
      'inbox-density-25.css:42 — 10.5px, and :47 colours it rgba(140,168,200,0.36) ⇒ 1.96:1. '
      + 'Both are in the sidebar density sheet Lane C owns; already DEFERRED by '
      + 'scripts/lc-responsive-audit.mjs, so the runtime gate must agree with the static one.',
  },
  {
    selector: 'span',
    text: 'INVESTOR OPPORTUNITY SCORE',
    lane: 'E',
    reason:
      'IntelligencePanel.tsx renders this and its "/100" sibling with an inline '
      + 'style={{ fontSize: \'10px\' }} (e.g. :1386). Inline styles outrank every '
      + 'stylesheet, so only the owning lane can raise them. Already DEFERRED by '
      + 'scripts/lc-responsive-audit.mjs, which lists IntelligencePanel.tsx.',
  },
  {
    selector: 'span',
    text: '/100',
    lane: 'E',
    reason: 'Same inline 10px declaration as the score label above (IntelligencePanel.tsx:1386).',
  },
  {
    selector: 'nx-pic-',
    lane: 'E',
    reason:
      'Property intelligence card labels. Lane G repairs the measured CONTRAST failures from '
      + 'lc-responsive.css; the remaining sub-11px declarations live in IntelligencePanel.tsx '
      + '(inline style, e.g. :1386 fontSize 10px) which Lane E owns.',
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

export function isKnownGap(selector: string, text = ''): KnownGap | undefined {
  return KNOWN_GAPS.find(
    (g) => selector.includes(g.selector) && (!g.text || text.includes(g.text)),
  )
}

export const STRICT = process.env.LC_GATE_STRICT === '1'

/**
 * §16.6 landmarks, the skip link and the focus trap are shipped by Lane A's
 * shell rebuild (`shared/ui/SkipLink`, `shared/ui/useFocusTrap`,
 * `ShellTopRail` with `role="banner"` + `<nav aria-label="Global navigation">`,
 * and `<main id="lc-main">` in `CommandCenterApp`). Lane G's branch forks from
 * eeee5bd8, which predates all of it, so those assertions CANNOT pass here and
 * rebuilding them would duplicate Lane A's work.
 *
 * The gate therefore probes the DOM for Lane A's shell instead of hard-coding
 * an expectation: it reports on this branch and ENFORCES automatically once the
 * lanes are integrated. No flag for Lane H to remember to flip.
 */
export const SHELL_PROBE = () => ({
  main: !!document.querySelector('#lc-main, main, [role="main"]'),
  skipLink: !!document.querySelector('.lc-skip-link, a[href="#lc-main"]'),
  rail: !!document.querySelector('.lc-rail, [role="banner"]'),
})

export type ShellProbe = ReturnType<typeof SHELL_PROBE>

export function partitionGaps<T extends { selector: string; text?: string }>(rows: T[]): {
  failures: T[]
  deferred: (T & { lane: string })[]
} {
  if (STRICT) return { failures: rows, deferred: [] }
  const failures: T[] = []
  const deferred: (T & { lane: string })[] = []
  for (const row of rows) {
    const gap = isKnownGap(row.selector, row.text ?? '')
    if (gap) deferred.push({ ...row, lane: gap.lane })
    else failures.push(row)
  }
  return { failures, deferred }
}
