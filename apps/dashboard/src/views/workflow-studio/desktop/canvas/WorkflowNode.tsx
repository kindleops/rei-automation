import { memo } from 'react'
import { Icon } from '../../../../shared/icons'
import { FAMILY, terminalTone } from '../lib/families'
import { count as fmtCount, dur } from '../lib/format'
import type { LayoutNode } from './layout'

export type Metric = 'volume' | 'latency' | 'holds' | 'failures' | 'human'

/** What the board knows about a node right now — every field backed by a ledger. */
export interface NodeState {
  /** run inspection: done · current · held · human · failed · skipped · next · off */
  run: 'done' | 'current' | 'held' | 'human' | 'failed' | 'skipped' | 'next' | 'off' | null
  /** what the run recorded at this node ("Unclear", "stays Ownership confirmation") */
  runLabel: string | null
  /** LIVE: runs executing here now · runs parked here (waits, reviews) */
  executing: number
  parked: number
  /** a pulse just reached this node (one restrained impulse) */
  arrived: boolean
  selected: boolean
  dim: boolean
  match: boolean
  /** validation (authoring) */
  invalid: number
  warn: number
  /** simulation: on the simulated path */
  sim: boolean
  simAction: string | null
}

export interface NodeFigures { entered: number; held: number; failed: number; human: number; waiting: number; p50: number | null; measured: boolean }

const STATE_WORD: Record<string, string> = { done: 'Executed', current: 'Here now', held: 'Held', human: 'Waiting on a person', failed: 'Failed', skipped: 'Skipped', next: 'Possible next' }

function figure(f: NodeFigures | null, metric: Metric): { v: string; unit: string; tone?: string } | null {
  if (!f) return null
  switch (metric) {
    case 'latency': return f.measured ? { v: dur(f.p50), unit: 'p50' } : null
    case 'holds': return { v: fmtCount(f.held), unit: 'held', tone: f.held ? 'attn' : undefined }
    case 'failures': return { v: fmtCount(f.failed), unit: 'failed', tone: f.failed ? 'crit' : undefined }
    case 'human': return { v: fmtCount(f.human + f.waiting), unit: 'to a person', tone: f.human + f.waiting ? 'gold' : undefined }
    default: return { v: fmtCount(f.entered), unit: f.entered === 1 ? 'run' : 'runs' }
  }
}

/**
 * One precision glass module. Geometry is the family; detail follows the zoom
 * tier (CSS decides what far / mid / near show, so zooming re-renders nothing).
 */
export const WorkflowNode = memo(function WorkflowNode({ n, figures, metric, state, onSelect, onToggleGroup }: {
  n: LayoutNode
  figures: NodeFigures | null
  metric: Metric
  state: NodeState
  onSelect: (key: string) => void
  onToggleGroup?: (groupKey: string) => void
}) {
  const meta = FAMILY[n.family]
  const tone = n.family === 'TERMINAL' ? terminalTone(n.node?.terminal) : meta.tone
  const isGroup = Boolean(n.group)
  const fig = figure(figures, metric)
  const summary = isGroup ? `${n.members.length} steps${n.group?.summary ? ` · ${n.group.summary}` : ''}` : n.node?.summary || null
  const secondary = figures && metric === 'volume' && !state.run
    ? (figures.failed ? { v: figures.failed, l: 'failed', t: 'crit' } : figures.held ? { v: figures.held, l: 'held', t: 'attn' } : figures.human ? { v: figures.human, l: 'to a person', t: 'gold' } : null)
    : null
  const parkedWord = n.family === 'HUMAN_REVIEW' || n.family === 'APPROVAL' ? 'waiting on you' : n.family === 'WAIT' || n.family === 'RETRY' ? 'waiting' : 'parked'
  const cls = [
    'wsn', state.selected && 'is-selected', state.dim && 'is-dim', state.match && 'is-match',
    state.executing > 0 && 'is-active', state.parked > 0 && 'is-parked', state.arrived && 'is-arrived',
    state.run && `is-run-${state.run}`, state.invalid && 'is-invalid', !state.invalid && state.warn && 'is-warn', state.sim && 'is-sim',
    n.node?.optional && 'is-optional', isGroup && 'is-group',
  ].filter(Boolean).join(' ')
  const aria = `${isGroup ? 'Group' : meta.label}: ${n.label}${fig ? ` · ${fig.v} ${fig.unit}` : ''}${state.run && state.run !== 'off' ? ` · ${STATE_WORD[state.run] || ''}` : ''}${state.invalid ? ` · ${state.invalid} issue${state.invalid === 1 ? '' : 's'}` : ''}`
  return (
    <div
      className={cls}
      data-tone={tone}
      data-shape={isGroup ? 'stack' : meta.shape}
      data-family={n.family}
      role="button"
      tabIndex={0}
      aria-label={aria}
      aria-pressed={state.selected}
      onClick={(e) => { e.stopPropagation(); onSelect(n.key) }}
      onDoubleClick={(e) => { if (n.group && onToggleGroup) { e.stopPropagation(); onToggleGroup(n.group.key) } }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(n.key) } }}
    >
      {meta.shape === 'split' && !isGroup ? (
        <svg className="wsn__shape" viewBox={`0 0 ${n.w} ${n.h}`} preserveAspectRatio="none" aria-hidden>
          <polygon points={`12,0.5 ${n.w - 12},0.5 ${n.w - 0.5},${n.h / 2} ${n.w - 12},${n.h - 0.5} 12,${n.h - 0.5} 0.5,${n.h / 2}`} />
        </svg>
      ) : <span className="wsn__plate" aria-hidden />}
      {isGroup || meta.shape === 'stack' ? <span className="wsn__stack" aria-hidden /> : null}
      <span className="wsn__glyph" aria-hidden>
        <Icon name={isGroup ? 'layers' : meta.icon} size={13} />
        {meta.shape === 'timer' && state.parked ? <svg className="wsn__arc" viewBox="0 0 28 28"><circle cx="14" cy="14" r="12" /></svg> : null}
      </span>
      <span className="wsn__text">
        <b className="wsn__label">{n.node?.short || n.label}</b>
        <small className="wsn__meta">{state.run && state.runLabel ? state.runLabel : `${isGroup ? 'Group' : meta.label}${summary ? ` · ${summary}` : ''}`}</small>
      </span>
      {state.run && state.run !== 'off' && state.run !== 'next' ? (
        <span className="wsn__mark" data-run={state.run} aria-hidden>
          <Icon name={state.run === 'done' ? 'check' : state.run === 'failed' ? 'x' : state.run === 'held' ? 'pause' : state.run === 'human' ? 'user' : state.run === 'skipped' ? 'slash' : 'activity'} size={11} />
        </span>
      ) : fig ? (
        <span className="wsn__fig" data-tone={fig.tone}>
          <b className="lc-num">{fig.v}</b>
          <small>{fig.unit}</small>
        </span>
      ) : null}
      {secondary ? <em className="wsn__sub" data-tone={secondary.t}>{fmtCount(secondary.v)} {secondary.l}</em> : null}
      {state.executing > 0 || state.parked > 0 ? (
        <span className="wsn__live" aria-label={`${state.executing} executing · ${state.parked} ${parkedWord}`}>
          {state.executing > 0 ? <span className="is-exec"><i />{state.executing} executing</span> : null}
          {state.parked > 0 ? <span className="is-park"><i />{state.parked} {parkedWord}</span> : null}
        </span>
      ) : null}
      {state.invalid ? <span className="wsn__issue" aria-hidden>{state.invalid}</span> : null}
      {state.sim && state.simAction ? <span className="wsn__would">{state.simAction}</span> : null}
      {n.node?.handoff ? <span className="wsn__portal" aria-hidden><Icon name="arrow-up-right" size={10} /></span> : null}
      <i className="wsn__port is-in" aria-hidden />
      {n.family !== 'TERMINAL' ? <i className="wsn__port is-out" aria-hidden /> : null}
    </div>
  )
})
