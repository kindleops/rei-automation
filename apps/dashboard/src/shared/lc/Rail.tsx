import type { ReactNode } from 'react'
import { cx } from './cx'
import './lc-data.css'

/**
 * LCRail — the execution rail for deterministic processes.
 *   Closing   Contract → Buyer → EMD → Title → Settlement
 *   Campaign  Audience → Eligible → Queue → Sent → Delivered → Reply
 *   Pipeline  S1 → S10
 * The mechanics are shared (states, connectors, counts, selection); each
 * domain keeps its own labels and meaning. Counts are the caller's real
 * numbers — the rail never computes conversion.
 */

export type LCStepState = 'done' | 'active' | 'waiting' | 'blocked' | 'skipped' | 'idle'

export interface LCRailStep {
  id: string
  label: string
  /** a real count or value for the stage */
  value?: ReactNode
  sub?: ReactNode
  state?: LCStepState
  /** a hold/blocker reason shown under the step */
  note?: ReactNode
}

export interface LCRailProps {
  steps: ReadonlyArray<LCRailStep>
  orientation?: 'horizontal' | 'vertical'
  selected?: string | null
  onSelect?: (id: string) => void
  label: string
  className?: string
  compact?: boolean
}

export function LCRail({ steps, orientation = 'horizontal', selected, onSelect, label, className, compact }: LCRailProps) {
  return (
    <ol className={cx('lc-rail', `is-${orientation}`, compact && 'is-compact', className)} aria-label={label}>
      {steps.map((s, i) => {
        const state = s.state ?? 'idle'
        const inner = (
          <>
            <span className="lc-rail__mark" aria-hidden="true" />
            <span className="lc-rail__text">
              <span className="lc-rail__label">{s.label}</span>
              {s.value !== undefined && s.value !== null ? <b className="lc-rail__value lc-num">{s.value}</b> : null}
              {s.sub ? <span className="lc-rail__sub">{s.sub}</span> : null}
              {s.note ? <span className="lc-rail__note">{s.note}</span> : null}
            </span>
          </>
        )
        return (
          <li
            key={s.id}
            className={cx('lc-rail__step', selected === s.id && 'is-selected')}
            data-state={state}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            {i > 0 ? <span className="lc-rail__link" aria-hidden="true" /> : null}
            {onSelect
              ? <button type="button" className="lc-rail__hit" onClick={() => onSelect(s.id)} aria-pressed={selected === s.id}>{inner}</button>
              : <div className="lc-rail__hit">{inner}</div>}
            <span className="lc-sr-only">{state === 'done' ? 'Completed' : state === 'active' ? 'In progress' : state === 'blocked' ? 'Blocked' : state === 'waiting' ? 'Waiting' : state === 'skipped' ? 'Skipped' : 'Not started'}</span>
          </li>
        )
      })}
    </ol>
  )
}

export interface LCProgressProps {
  /** 0..max; omit for indeterminate */
  value?: number | null
  max?: number
  /** capacity: value against a limit, with an attention threshold */
  threshold?: number
  /** stacked parts (e.g. delivered / failed / pending) — values are counts */
  segments?: ReadonlyArray<{ value: number; tone: 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | 'neutral'; label: string }>
  tone?: 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | 'accent'
  label: string
  /** show "62%" (or the given text) after the bar */
  valueText?: string
  className?: string
}

/** Thin, precise progress: determinate, indeterminate, capacity, stacked. */
export function LCProgress({ value, max = 100, threshold, segments, tone = 'exec', label, valueText, className }: LCProgressProps) {
  const indeterminate = (value === undefined || value === null) && !segments
  const pct = !indeterminate && typeof value === 'number' && max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  const over = typeof threshold === 'number' && typeof value === 'number' && value >= threshold
  const total = segments ? Math.max(max, segments.reduce((s, x) => s + x.value, 0)) : max
  return (
    <div className={cx('lc-progress', indeterminate && 'is-indeterminate', className)}>
      <div
        className="lc-progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={segments ? total : max}
        aria-valuenow={indeterminate ? undefined : segments ? segments.reduce((s, x) => s + x.value, 0) : value ?? undefined}
        aria-valuetext={valueText ?? (indeterminate ? 'In progress' : `${Math.round(pct)}%`)}
      >
        {segments ? (
          segments.map((s) => <i key={s.label} className="lc-progress__seg" data-tone={s.tone} style={{ width: `${total ? (s.value / total) * 100 : 0}%` }} title={`${s.label}: ${s.value.toLocaleString('en-US')}`} />)
        ) : (
          <i className="lc-progress__fill" data-tone={over ? 'attn' : tone} style={indeterminate ? undefined : { width: `${pct}%` }} />
        )}
        {typeof threshold === 'number' && max > 0 ? <span className="lc-progress__limit" style={{ left: `${Math.min(100, (threshold / max) * 100)}%` }} aria-hidden="true" /> : null}
      </div>
      {valueText ? <span className="lc-progress__text lc-num">{valueText}</span> : null}
    </div>
  )
}
