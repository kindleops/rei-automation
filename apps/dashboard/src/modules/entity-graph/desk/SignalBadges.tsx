/**
 * Signal badges — one colored chip per signal (property-signals.ts):
 * distress (red) · opportunity (green) · risk (amber) · neutral (grey),
 * already ordered by severity (distress first).
 *
 * EVERY signal is listed (owner, 2026-10-08: "the Signals cell shows '+4' —
 * it must LIST ALL signals"). There is no "+N" anywhere: the chips wrap, and
 * the grid gives the row the height the wrapped list needs (signalLines).
 */
import { cx } from '../../../shared/lc'
import type { PropertySignal } from '../mobile/property-signals'

export function SignalBadges({ signals, size = 'sm' }: { signals: PropertySignal[]; size?: 'sm' | 'md' }) {
  if (!signals.length) return <span className="egdk-cell-none">—</span>
  return (
    <span className={cx('egdk-sigs', 'is-wrap', size === 'md' && 'is-md')}>
      {signals.map((s) => <span key={s.key} className={cx('egdk-sig', `is-${s.tone}`)}>{s.label}</span>)}
    </span>
  )
}

/* chip metrics (entity-graph-desk.css .egdk-sig, 11px / 560): ~6.3px per character + 16px padding, 4px gap */
const CHAR_PX = 6.3
const CHIP_PAD = 16
const GAP = 4

/** How many lines the chips take in a cell `widthPx` wide (cell padding included). Pure — tested. */
export function signalLines(labels: readonly string[], widthPx: number, cellPadPx = 20): number {
  if (!labels.length) return 1
  const inner = Math.max(60, widthPx - cellPadPx)
  let lines = 1
  let used = 0
  for (const l of labels) {
    const w = Math.min(inner, Math.ceil(l.length * CHAR_PX + CHIP_PAD))
    if (used > 0 && used + GAP + w > inner) { lines += 1; used = w } else used += (used > 0 ? GAP : 0) + w
  }
  return lines
}

/** Row height for a wrapped signal list: 20px chips, 4px row gap, 5px top/bottom breathing room. */
export const signalRowHeight = (lines: number, base: number): number => Math.max(base, 10 + lines * 20 + (lines - 1) * 4)
