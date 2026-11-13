import { type ReactNode } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import { LCButton, LCEmpty, LCError, LCMonogram, LCProgress, LCSkeleton, LCStatus, LCTooltip, cx, type LCTone } from '../../../shared/lc'
import { handleObjectClick, objectAttrs, openObjectBeside } from '../../desktop/objects'
import type { WfFailure } from '../api/wf-client'
import type { WfEmployee, WfRef } from '../api/wf-types'
import { assignmentMeta, missionMeta, relTime, type Progress } from '../model/wf-model'
import { dedupeRefs, REF_NOUN, refText, refToObject } from '../model/wf-refs'
import { useWfNav } from './wf-context'

const SHORT_NOUN: Record<WfRef['type'], string> = { property: 'Property', thread: 'Thread', opportunity: 'Deal', job: 'Job', assignment: 'Assignment', mission: 'Mission', employee: 'Employee', market: 'Market' }

const REF_ICON: Record<WfRef['type'], IconName> = {
  property: 'home', thread: 'message', opportunity: 'trending-up', job: 'cpu', assignment: 'list', mission: 'target', employee: 'user', market: 'globe',
}

/**
 * A record link. Property / conversation / deal open BESIDE Workforce in the
 * workspace (click or ⌘-click), ⇧-click inspects; missions, assignments and
 * employees open inside Workforce; a runtime job is shown, not opened.
 */
export function WfRefChip({ r, quiet, short }: { r: WfRef; quiet?: boolean; short?: boolean }) {
  const nav = useWfNav()
  const obj = refToObject(r)
  const noun = REF_NOUN[r.type]
  const text = short ? SHORT_NOUN[r.type] : refText(r)
  const internal = r.type === 'mission' || r.type === 'assignment' || r.type === 'employee'
  if (!obj && !internal) {
    return (
      <span className={cx('wf-ref', 'is-static', quiet && 'is-quiet')} data-ref={r.type} title={`${noun} ${r.id}`}>
        <Icon name={REF_ICON[r.type]} size={11} />
        <span className="wf-ref__t">{text}</span>
      </span>
    )
  }
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (obj) { handleObjectClick(e, obj, () => { openObjectBeside(obj) }); return }
    if (r.type === 'mission') nav.openMission(r.id)
    else if (r.type === 'employee') nav.openEmployee(r.id)
    else nav.openAssignment(r.id)
  }
  const hint = obj ? `${noun}: open beside (⇧-click to inspect)` : `${noun}: open in Workforce`
  return (
    <button type="button" className={cx('wf-ref', quiet && 'is-quiet', short && 'is-short')} data-ref={r.type} onClick={onClick} title={short ? `${refText(r)} · ${hint}` : hint} {...objectAttrs(obj)}>
      <Icon name={REF_ICON[r.type]} size={11} />
      <span className="wf-ref__t">{text}</span>
      {obj ? <Icon name="arrow-up-right" size={10} className="wf-ref__go" /> : null}
    </button>
  )
}

export function WfRefs({ refs, max = 6, quiet, short }: { refs: ReadonlyArray<WfRef>; max?: number; quiet?: boolean; short?: boolean }) {
  const list = dedupeRefs(refs)
  if (!list.length) return null
  return (
    <span className="wf-refs">
      {list.slice(0, max).map((r) => <WfRefChip key={`${r.type}:${r.id}`} r={r} quiet={quiet} short={short} />)}
      {list.length > max ? <span className="wf-refs__more">+{list.length - max}</span> : null}
    </span>
  )
}

/** "Unknown", with the reason one hover away (and inline when there is room). */
export function WfUnknown({ reason, inline }: { reason?: string | null; inline?: boolean }) {
  const body = (
    <span className="wf-unknown" tabIndex={reason ? 0 : undefined}>
      <span className="wf-unknown__v">Unknown</span>
      {inline && reason ? <span className="wf-unknown__r">{reason}</span> : null}
    </span>
  )
  return reason && !inline ? <LCTooltip content={reason}>{body}</LCTooltip> : body
}

export function WfAssignmentState({ status, quiet }: { status: string; quiet?: boolean }) {
  const m = assignmentMeta(status)
  return m.state ? <LCStatus state={m.state} label={m.label} quiet={quiet} /> : <LCStatus label={m.label} tone={m.tone} quiet hollow />
}

export function WfMissionState({ status }: { status: string }) {
  const m = missionMeta(status)
  return m.state ? <LCStatus state={m.state} label={m.label} /> : <LCStatus label={m.label} tone={m.tone} />
}

export function WfKind({ kind }: { kind: 'ai' | 'human' }) {
  return <span className={cx('wf-kind', `is-${kind}`)} title={kind === 'ai' ? 'AI employee' : 'Human'}>{kind === 'ai' ? 'AI' : 'Human'}</span>
}

export function WfAvatar({ e, size = 28 }: { e: Pick<WfEmployee, 'display_name' | 'employee_id' | 'kind'>; size?: number }) {
  return (
    <span className={cx('wf-avatar', `is-${e.kind}`)} style={{ width: size, height: size }}>
      <LCMonogram name={e.display_name} seed={e.employee_id} size={size} />
    </span>
  )
}

export function WfProgress({ p, label, compact }: { p: Progress; label: string; compact?: boolean }) {
  if (!p.total) return <span className="wf-progress-none">No assignments yet</span>
  const segs = [
    { value: p.done, tone: 'ok' as const, label: 'completed' },
    { value: p.active, tone: 'exec' as const, label: 'working' },
    { value: p.waiting, tone: 'neutral' as const, label: 'waiting' },
    { value: p.blocked + p.failed, tone: 'crit' as const, label: 'blocked or failed' },
  ].filter((s) => s.value > 0)
  return (
    <div className={cx('wf-progress', compact && 'is-compact')}>
      <LCProgress segments={segs} max={Math.max(1, p.total - p.cancelled)} label={label} valueText={`${p.done} of ${p.total - p.cancelled} completed`} />
      {!compact ? (
        <span className="wf-progress__legend">
          <span className="wf-progress__done"><b className="lc-num">{p.done}</b>/<span className="lc-num">{p.total - p.cancelled}</span>&nbsp;done</span>
          {p.active ? <span><i data-tone="exec" />{p.active} working</span> : null}
          {p.waiting ? <span><i data-tone="neutral" />{p.waiting} waiting</span> : null}
          {p.blocked ? <span><i data-tone="crit" />{p.blocked} blocked</span> : null}
          {p.failed ? <span><i data-tone="crit" />{p.failed} failed</span> : null}
          {p.queued ? <span><i data-tone="hollow" />{p.queued} queued</span> : null}
        </span>
      ) : null}
    </div>
  )
}

/** A section's failure, said truthfully: not enabled (with the switches), signed out, denied, or failed with retry. */
export function WfFailureState({ failure, what, onRetry, staleSince, compact }: { failure: WfFailure; what: string; onRetry?: () => void; staleSince?: number | null; compact?: boolean }) {
  if (failure.state === 'not_enabled') {
    return (
      <LCEmpty
        icon="shield"
        title="Workforce is not enabled on this server"
        body={<span className="wf-next">{failure.next}</span>}
        compact={compact}
        className="wf-off"
      />
    )
  }
  if (failure.state === 'session' || failure.state === 'denied') {
    return <LCEmpty icon="key" title={failure.message} body={failure.next ?? undefined} compact={compact} className="wf-off" />
  }
  return <LCError what={what} detail={`${failure.code} · ${failure.message}`} onRetry={onRetry} staleSince={staleSince ?? null} compact={compact} />
}

/** Loading / failure / content, in the real layout's shape. */
export function WfLoad<T>({ view, what, shape = 'rows', count = 4, children }: { view: { data: T | null; failure: WfFailure | null; loading: boolean; at: number | null; retry: () => void }; what: string; shape?: 'rows' | 'lines' | 'block' | 'metric'; count?: number; children: (data: T) => ReactNode }) {
  if (view.data) {
    return (
      <>
        {view.failure ? <WfFailureState failure={view.failure} what={what} onRetry={view.retry} staleSince={view.at} compact /> : null}
        {children(view.data)}
      </>
    )
  }
  if (view.failure) return <WfFailureState failure={view.failure} what={what} onRetry={view.retry} />
  return <LCSkeleton shape={shape} count={count} label={what} />
}

export function WfPanel({ title, aside, children, className, icon, flush }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; icon?: IconName; flush?: boolean }) {
  return (
    <section className={cx('wf-panel', flush && 'is-flush', className)}>
      {title || aside ? (
        <header className="wf-panel__h">
          <span className="wf-panel__t">{icon ? <Icon name={icon} size={13} /> : null}{title}</span>
          {aside ? <span className="wf-panel__a">{aside}</span> : null}
        </header>
      ) : null}
      {children}
    </section>
  )
}

export function WfStat({ label, value, sub, tone, unknown }: { label: string; value: ReactNode; sub?: ReactNode; tone?: LCTone | null; unknown?: string | null }) {
  return (
    <div className="wf-stat" data-tone={tone ?? undefined}>
      <span className="wf-stat__l">{label}</span>
      <span className="wf-stat__v lc-num">{unknown !== undefined && unknown !== null ? <WfUnknown reason={unknown} /> : value}</span>
      {sub ? <span className="wf-stat__s">{sub}</span> : null}
    </div>
  )
}

export function WfSectionHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="wf-sh">
      <div className="wf-sh__t">
        <h2>{title}</h2>
        {sub ? <p>{sub}</p> : null}
      </div>
      {actions ? <div className="wf-sh__a">{actions}</div> : null}
    </header>
  )
}

export function WfEmptyNote({ title, body }: { title: string; body?: ReactNode }) {
  return <LCEmpty title={title} body={body} compact tone="calm" />
}

export function WfMore({ onClick, loading, label = 'Load older' }: { onClick: () => void; loading?: boolean; label?: string }) {
  return <div className="wf-more"><LCButton variant="quiet" size="sm" icon="chevron-down" loading={loading} onClick={onClick}>{label}</LCButton></div>
}

export function WfTime({ iso, now }: { iso: string | null | undefined; now: number }) {
  const text = relTime(iso, now)
  if (!text || !iso) return <span className="wf-time is-none">Not recorded</span>
  return <time className="wf-time" dateTime={iso} title={new Date(iso).toLocaleString('en-US')}>{text}</time>
}
