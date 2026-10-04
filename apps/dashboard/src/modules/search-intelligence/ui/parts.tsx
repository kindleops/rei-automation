import type { ReactNode } from 'react'
import { cx, LCStatus, LCTooltip } from '../../../shared/lc'
import { UNAVAILABLE_COPY, formatMetric, type Metric, type UnavailableReason } from '../domain/metrics'
import { LIFECYCLE_LABEL } from '../domain/lifecycle'
import type { ConnectionState, ObjectRef, PageCopy, PageStatus, Provenance, SearchProperty } from '../domain/types'
import { CONNECTION_LABEL, CONNECTION_TONE } from '../providers/registry'
import { ACCENT_VAR, STATUS_LABEL, STATUS_TONE, fmt, useSi, type Tone } from './si-context'

/* ── atoms ──────────────────────────────────────────────────────────────── */

export function StatusPill({ status }: { status: PageStatus }) {
  return <LCStatus label={STATUS_LABEL[status]} tone={STATUS_TONE[status]} quiet={status === 'PLANNED' || status === 'RESEARCHED'} />
}

export function ConnectionPill({ state }: { state: ConnectionState }) {
  return <LCStatus label={CONNECTION_LABEL[state]} tone={CONNECTION_TONE[state]} hollow={state === 'NOT_CONFIGURED' || state === 'NOT_APPLICABLE'} quiet />
}

export function LifecyclePill({ property }: { property: SearchProperty }) {
  return <span className="si-life" data-step={property.lifecycle}>{LIFECYCLE_LABEL[property.lifecycle]}</span>
}

export function BrandMark({ property, size = 8 }: { property: SearchProperty; size?: number }) {
  return <i className="si-brand" style={{ width: size, height: size, background: ACCENT_VAR[property.accent] }} aria-hidden="true" />
}

/** A figure with its label. `value` is a plan count (never a measure) or a pre-formatted string. */
export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="si-stat" data-tone={tone}>
      <span className="si-stat__v">{value}</span>
      <span className="si-stat__l">{label}</span>
      {sub ? <span className="si-stat__s">{sub}</span> : null}
    </div>
  )
}

/** A thin, honest meter (0..1). */
export function Meter({ value, tone = 'ok', label }: { value: number; tone?: Tone; label: string }) {
  const v = Math.max(0, Math.min(1, value))
  return (
    <span className="si-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} data-tone={tone}>
      <i style={{ width: `${v * 100}%` }} />
    </span>
  )
}

/** A stacked status bar of plan counts. */
export function StatusBar({ counts, total }: { counts: Partial<Record<PageStatus, number>>; total: number }) {
  const order: PageStatus[] = ['INDEXED', 'PUBLISHED', 'READY', 'QA', 'BUILDING', 'COPY_READY', 'RESEARCHED', 'PLANNED', 'NEEDS_WORK']
  return (
    <span className="si-sbar" aria-label="Page status distribution">
      {order.map((s) => (counts[s] ? (
        <LCTooltip key={s} content={`${STATUS_LABEL[s]} · ${fmt(counts[s]!)}`}>
          <i data-tone={STATUS_TONE[s]} data-status={s} style={{ flexGrow: counts[s]! / Math.max(1, total) }} />
        </LCTooltip>
      ) : null))}
    </span>
  )
}

/** Renders a Metric: a value with its provider + date, or the reason in words. Never a fallback digit. */
export function MetricCell({ metric, unit = 'count', compact }: { metric: Metric<number>; unit?: 'count' | 'rate' | 'position'; compact?: boolean }) {
  if (metric.state === 'UNAVAILABLE') {
    return <span className={cx('si-na', compact && 'is-compact')} title={UNAVAILABLE_COPY[metric.reason].body}>{compact ? '—' : UNAVAILABLE_COPY[metric.reason].title}</span>
  }
  return <span className="si-num" title={`${metric.provider} · through ${metric.through}`}>{formatMetric(metric, unit)}</span>
}

/** A deliberate empty state for a live surface. */
export function Unavailable({ reason, detail, children }: { reason: UnavailableReason; detail?: ReactNode; children?: ReactNode }) {
  const c = UNAVAILABLE_COPY[reason]
  return (
    <section className="si-unavail" aria-label={c.title}>
      <span className="si-unavail__ring" aria-hidden="true" />
      <h3>{c.title}</h3>
      <p>{detail ?? c.body}</p>
      {children}
    </section>
  )
}

/** Copy field: approved text, source text marked COPY NOT APPROVED, or the marker alone. */
export function CopyField({ label, text, copy }: { label: string; text: string | null; copy: PageCopy }) {
  const approved = copy.state === 'APPROVED'
  return (
    <div className="si-copy">
      <span className="si-copy__l">{label}</span>
      {text ? <span className={cx('si-copy__t', !approved && 'is-unapproved')}>{text}</span> : <span className="si-copy__none">Not in source</span>}
      {!approved ? <span className="si-copy__flag">COPY NOT APPROVED</span> : null}
    </div>
  )
}

export function ProvenanceLine({ source }: { source: Provenance }) {
  const bits = [source.label, source.path, source.branch, source.commit, source.capturedAt && `captured ${source.capturedAt}`].filter(Boolean)
  return <span className="si-prov" title={source.repo ?? undefined}>{bits.join(' · ')}</span>
}

export function SectionHead({ title, meta, children }: { title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <header className="si-head">
      <div className="si-head__t">
        <h2>{title}</h2>
        {meta ? <span className="si-head__m">{meta}</span> : null}
      </div>
      {children ? <div className="si-head__a">{children}</div> : null}
    </header>
  )
}

/** A clickable object reference (opens the inspector). */
export function ObjLink({ to, children, className }: { to: ObjectRef; children: ReactNode; className?: string }) {
  const { actions } = useSi()
  return <button type="button" className={cx('si-obj', className)} onClick={(e) => { e.stopPropagation(); actions.inspect(to) }}>{children}</button>
}
