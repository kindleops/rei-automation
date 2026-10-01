import type { ReactNode } from 'react'

/**
 * Chart kit for the workstation — one geometry vocabulary for every chart:
 * hairline recessive grid, 2px lines, ≥8px markers with a surface ring,
 * values in ink tokens (never the series colour), a compact tooltip that
 * enhances and never gates (the comp list and matrix are the table view).
 */

export function ChartFrame({ title, aside, note, children, className }: { title: ReactNode; aside?: ReactNode; note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <figure className={`ciw-chart${className ? ` ${className}` : ''}`}>
      <figcaption className="ciw-chart__head">
        <span className="ciw-chart__title">{title}</span>
        {aside ? <span className="ciw-chart__aside">{aside}</span> : null}
      </figcaption>
      {children}
      {note ? <p className="ciw-chart__note">{note}</p> : null}
    </figure>
  )
}

/** A compact tooltip anchored inside the chart box: value first, label second. */
export function ChartTip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(8, x + 12), Math.max(8, width - 220))
  return (
    <div className="ciw-tip" style={{ left, top: Math.max(4, y - 8) }} role="status">
      {children}
    </div>
  )
}

export function LegendKey({ tone, shape = 'dot', children }: { tone: 'set' | 'added' | 'cand' | 'excl' | 'attn' | 'subject' | 'engine' | 'operator' | 'context'; shape?: 'dot' | 'ring' | 'line' | 'band' | 'diamond'; children: ReactNode }) {
  return (
    <span className="ciw-key">
      <i className={`ciw-key__mark is-${shape}`} data-tone={tone} aria-hidden="true" />
      {children}
    </span>
  )
}
