import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon, type IconName } from '../icons'
import { LCButton } from './Button'
import { cx } from './cx'
import './lc-states.css'
import { LC_STATES, type LCStateKey, type LCTone } from './states-model'

/**
 * State language — one way to say loading, empty, failed, live, and the
 * product's operational states.
 */

export interface LCStatusProps {
  /** a shared state, or a custom label + tone */
  state?: LCStateKey
  label?: ReactNode
  tone?: LCTone
  quiet?: boolean
  hollow?: boolean
  title?: string
  className?: string
}

export function LCStatus({ state, label, tone, quiet, hollow, title, className }: LCStatusProps) {
  const def = state ? LC_STATES[state] : null
  const t = tone ?? def?.tone ?? 'neutral'
  return (
    <span className={cx('lc-status', (quiet ?? def?.quiet) && 'is-quiet', hollow && 'is-hollow', className)} data-tone={t} title={title}>
      <span className="lc-status__dot" aria-hidden="true" />
      {label ?? def?.label}
    </span>
  )
}

/* ── LIVE ───────────────────────────────────────────────────────────────── */

export interface LCLiveProps {
  /** true when the source answered within its cadence */
  live: boolean
  /** when the data last landed (ms); a change rings the dot once */
  updatedAt?: number | null
  /** stale = answered once but missed its cadence */
  stale?: boolean
  label?: string
  className?: string
}

/** ● LIVE — tiny, calm, no blinking. One ring when new data actually lands. */
export function LCLive({ live, updatedAt, stale, label, className }: LCLiveProps) {
  const [ring, setRing] = useState(false)
  const last = useRef(updatedAt)
  useEffect(() => {
    if (updatedAt && last.current && updatedAt !== last.current) {
      setRing(true)
      const t = window.setTimeout(() => setRing(false), 1500)
      last.current = updatedAt
      return () => window.clearTimeout(t)
    }
    last.current = updatedAt
  }, [updatedAt])
  const text = label ?? (!live ? 'Paused' : stale ? 'Delayed' : 'Live')
  const at = updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null
  return (
    <span className={cx('lc-live', !live && 'is-off', live && stale && 'is-stale', ring && 'is-arrived', className)} title={at ? `Updated ${at}` : undefined}>
      <span className="lc-live__dot" aria-hidden="true" />
      {text}
    </span>
  )
}

/* ── SKELETON ───────────────────────────────────────────────────────────── */

export interface LCSkeletonProps {
  /** shape presets matching real layouts */
  shape?: 'lines' | 'rows' | 'metric' | 'chart' | 'block'
  count?: number
  height?: number | string
  className?: string
  style?: CSSProperties
  label?: string
}

/** A placeholder in the real layout's shape. Never a spinner, never "Loading…". */
export function LCSkeleton({ shape = 'lines', count = 3, height, className, style, label = 'Loading' }: LCSkeletonProps) {
  return (
    <div className={cx('lc-skeleton', `is-${shape}`, className)} style={style} role="status" aria-busy="true" aria-label={label}>
      {shape === 'metric' ? (
        <>
          <i className="lc-skel" style={{ width: '38%', height: 10 }} />
          <i className="lc-skel" style={{ width: '62%', height: 28 }} />
          <i className="lc-skel" style={{ width: '46%', height: 10 }} />
        </>
      ) : shape === 'chart' ? (
        <i className="lc-skel" style={{ width: '100%', height: height ?? 220, borderRadius: 14 }} />
      ) : shape === 'block' ? (
        <i className="lc-skel" style={{ width: '100%', height: height ?? 120, borderRadius: 14 }} />
      ) : shape === 'rows' ? (
        Array.from({ length: count }, (_, i) => (
          <span key={i} className="lc-skeleton__row">
            <i className="lc-skel" style={{ width: 28, height: 28, borderRadius: 8 }} />
            <span className="lc-skeleton__col">
              <i className="lc-skel" style={{ width: `${62 - ((i * 13) % 24)}%`, height: 10 }} />
              <i className="lc-skel" style={{ width: `${38 - ((i * 7) % 14)}%`, height: 8 }} />
            </span>
            <i className="lc-skel" style={{ width: 54, height: 10 }} />
          </span>
        ))
      ) : (
        Array.from({ length: count }, (_, i) => <i key={i} className="lc-skel" style={{ width: `${92 - ((i * 17) % 38)}%`, height: 10 }} />)
      )}
    </div>
  )
}

/* ── EMPTY ──────────────────────────────────────────────────────────────── */

export interface LCEmptyProps {
  /** product words, short: "No active closings", "Today is clear" */
  title: string
  body?: ReactNode
  icon?: IconName
  action?: { label: string; onClick: () => void }
  /** a positive empty ("Today is clear") reads calmer than a missing one */
  tone?: 'calm' | 'neutral'
  compact?: boolean
  className?: string
}

export function LCEmpty({ title, body, icon, action, tone = 'neutral', compact, className }: LCEmptyProps) {
  return (
    <section className={cx('lc-empty', `is-${tone}`, compact && 'is-compact', className)} aria-label={title}>
      {icon ? <span className="lc-empty__glyph" aria-hidden="true"><Icon name={icon} size={compact ? 15 : 18} /></span> : null}
      <h3 className="lc-empty__title">{title}</h3>
      {body ? <p className="lc-empty__body">{body}</p> : null}
      {action ? <LCButton variant="secondary" size="sm" onClick={action.onClick}>{action.label}</LCButton> : null}
    </section>
  )
}

/* ── ERROR ──────────────────────────────────────────────────────────────── */

export interface LCErrorProps {
  /** what failed, in product words: "Campaign performance didn't load" */
  what: string
  /** whether what's on screen is older data, and how old */
  staleSince?: number | null
  /** what the operator can do */
  onRetry?: () => void
  retryLabel?: string
  /** short technical reason for the tooltip — never shown raw */
  detail?: string
  compact?: boolean
  className?: string
}

/** One coherent failure: what failed, whether data is stale, what to do. */
export function LCError({ what, staleSince, onRetry, retryLabel = 'Try again', detail, compact, className }: LCErrorProps) {
  const stale = staleSince ? new Date(staleSince).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null
  return (
    <section className={cx('lc-error', compact && 'is-compact', className)} role="alert" title={detail}>
      <span className="lc-error__glyph" aria-hidden="true"><Icon name="alert-circle" size={compact ? 14 : 16} /></span>
      <div className="lc-error__text">
        <b>{what}</b>
        <span>{stale ? `Showing what loaded at ${stale}.` : 'Nothing older is available to show.'}</span>
      </div>
      {onRetry ? <LCButton variant="secondary" size="sm" icon="refresh-cw" onClick={onRetry}>{retryLabel}</LCButton> : null}
    </section>
  )
}

/* ── KBD ────────────────────────────────────────────────────────────────── */
export function LCKbd({ keys }: { keys: string[] }) {
  return <span className="lc-kbds">{keys.map((k) => <kbd key={k} className="lc-kbd">{k}</kbd>)}</span>
}
