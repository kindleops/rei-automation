import { memo } from 'react'
import { Icon } from '../../../../shared/icons'
import { FAMILY, terminalTone } from '../families'
import type { LayoutNode } from './layout'

export type Overlay = 'volume' | 'latency' | 'holds' | 'failures' | 'human'

/** the split decision form's point depth */
const SPLIT = 16

export interface NodeFigures {
  entered: number
  held: number
  failed: number
  human: number
  waiting: number
  p50: number | null
  measured: boolean
}

export interface NodePaint {
  selected: boolean
  dim: boolean
  match: boolean
  live: boolean
  /** run inspection: 'path' (executed) · 'current' (where the run is) · 'skipped' */
  run: 'path' | 'current' | 'skipped' | 'failed' | 'held' | null
  heat: number
}

export const fmtCount = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
export const fmtMs = (ms: number | null) => (ms === null || !Number.isFinite(ms) ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`)

function figureFor(f: NodeFigures | null, overlay: Overlay): { v: string; unit: string } | null {
  if (!f) return null
  switch (overlay) {
    case 'latency': return f.measured ? { v: fmtMs(f.p50), unit: 'p50' } : { v: '—', unit: 'not timed' }
    case 'holds': return { v: fmtCount(f.held), unit: 'held' }
    case 'failures': return { v: fmtCount(f.failed), unit: 'failed' }
    case 'human': return { v: fmtCount(f.human + f.waiting), unit: 'human' }
    default: return { v: fmtCount(f.entered), unit: 'runs' }
  }
}

/**
 * One glass node. Geometry is the family (entry capsule, glass rectangle,
 * split decision, timing capsule, gold-edged human plane, stacked subworkflow,
 * small terminal, handoff portal); detail is the zoom tier (CSS decides what a
 * tier shows, so zooming never re-renders a node).
 */
export const CanvasNode = memo(function CanvasNode({ n, figures, paint, overlay, pressure, tokens = 0, impulse = 0, onSelect, onHover }: {
  n: LayoutNode
  figures: NodeFigures | null
  paint: NodePaint
  overlay: Overlay
  pressure: string | null
  /** runs executing at this node right now (LIVE) */
  tokens?: number
  /** bumps once per new run arriving here — one restrained impulse */
  impulse?: number
  onSelect: (key: string) => void
  onHover?: (key: string | null) => void
}) {
  const meta = FAMILY[n.family]
  const tone = n.family === 'TERMINAL' ? terminalTone(n.node?.terminal) : meta.tone
  const fig = figureFor(figures, overlay)
  const isGroup = Boolean(n.group)
  const summary = isGroup ? `${n.members.length} steps${n.group?.summary ? ` · ${n.group.summary}` : ''}` : n.node?.summary || null
  const cls = [
    'ws3-node', `is-${isGroup ? 'stack' : meta.shape}`, `is-${tone}`,
    paint.selected && 'is-selected', paint.dim && 'is-dim', paint.match && 'is-match', paint.live && 'is-live',
    paint.run && `is-run-${paint.run}`, pressure && 'is-pressure', n.node?.optional && 'is-optional',
  ].filter(Boolean).join(' ')
  const secondary = figures && overlay === 'volume'
    ? (figures.failed ? { v: figures.failed, l: 'failed', t: 'bad' } : figures.held ? { v: figures.held, l: 'held', t: 'held' } : figures.human ? { v: figures.human, l: 'review', t: 'human' } : null)
    : null
  return (
    <div
      className={cls}
      data-node={n.key}
      data-family={n.family}
      role="button"
      tabIndex={0}
      aria-label={`${meta.label}: ${n.label}${fig ? ` · ${fig.v} ${fig.unit}` : ''}`}
      aria-pressed={paint.selected}
      style={{ left: n.x - n.w / 2, top: n.y - n.h / 2, width: n.w, height: n.h, ['--heat' as string]: paint.heat }}
      onClick={(e) => { e.stopPropagation(); onSelect(n.key) }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(n.key) } }}
      onPointerEnter={onHover ? () => onHover(n.key) : undefined}
      onPointerLeave={onHover ? () => onHover(null) : undefined}
    >
      {meta.shape === 'split' && !isGroup ? (
        <svg className="ws3-node__shape" width={n.w} height={n.h} viewBox={`0 0 ${n.w} ${n.h}`} aria-hidden>
          <polygon points={`${SPLIT},0.5 ${n.w - SPLIT},0.5 ${n.w - 0.5},${n.h / 2} ${n.w - SPLIT},${n.h - 0.5} ${SPLIT},${n.h - 0.5} 0.5,${n.h / 2}`} />
          <line x1={n.w - SPLIT - 18} y1={n.h / 2} x2={n.w - 10} y2={n.h / 2} />
        </svg>
      ) : <span className="ws3-node__plate" aria-hidden />}
      {isGroup ? <span className="ws3-node__stack" aria-hidden /> : null}
      <span className="ws3-node__glyph" aria-hidden><Icon name={meta.icon} /></span>
      <span className="ws3-node__text">
        <b className="ws3-node__label">{n.node?.short || n.label}</b>
        <small className="ws3-node__meta">{isGroup ? 'Group' : meta.label}{summary ? ` · ${summary}` : ''}</small>
      </span>
      {fig ? (
        <span className={`ws3-node__fig${fig.v === '0' ? ' is-zero' : ''}`}>
          <b>{fig.v}</b><small>{fig.unit}</small>
          {secondary ? <em className={`is-${secondary.t}`}>{fmtCount(secondary.v)} {secondary.l}</em> : null}
        </span>
      ) : null}
      {pressure ? <span className="ws3-node__pressure">{pressure}</span> : null}
      {tokens > 0 ? (
        <span className="ws3-node__tokens" aria-label={`${tokens} active`}>
          {Array.from({ length: Math.min(3, tokens) }, (_, i) => <i key={i} />)}
          {tokens > 3 ? <b>+{tokens - 3} active</b> : <b>{tokens} active</b>}
        </span>
      ) : null}
      {impulse ? <span key={impulse} className="ws3-node__impulse" aria-hidden /> : null}
      {n.node?.handoff ? <span className="ws3-node__handoff" aria-hidden><Icon name="arrow-up-right" /></span> : null}
      <i className="ws3-port is-in" aria-hidden />
      {n.family !== 'TERMINAL' ? <i className="ws3-port is-out" aria-hidden /> : null}
    </div>
  )
})
