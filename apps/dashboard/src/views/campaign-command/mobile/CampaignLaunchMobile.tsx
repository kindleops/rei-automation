import { useEffect, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { getQueueControlSettings } from '../../../lib/api/backendClient'

/**
 * Campaign Creator — LAUNCH, mobile 393pt.
 *
 * One question: exactly what happens if the operator presses the button?
 *
 * The answer is the top line, then a compact execution plan (START / PACE /
 * LIMIT / DURATION), then routing as operational confirmation, then the system
 * automation state, then blockers and warnings kept structurally distinct, then
 * a final action derived from the campaign's actual state.
 *
 * No launch semantics are invented here. The READY count is the same canonical
 * figure REACH reads; pacing, caps and duration come from computeLaunchEstimates;
 * blockers/warnings are supplied by the modal; queue and auto-reply modes are read
 * from system_control. Nothing on this screen implies an action the state cannot
 * actually perform.
 */

const nf = (n: number) => n.toLocaleString()

/** Canonical queue execution modes. Legacy `paused` normalizes to stopped. */
const QUEUE_MODE_LABEL: Record<string, string> = {
  normal: 'Normal',
  stopped: 'Stopped',
  paused: 'Stopped',
  scoped_canary_only: 'Canary only',
}

/** A queue mode that will not drain this campaign is a launch-relevant fact. */
const queueHolds = (mode: string | null) => mode != null && mode !== 'normal'

const formatWhen = (value: string): string => {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

/** "Now" means the scheduled instant has effectively already arrived. */
const startsNow = (value: string): boolean => {
  if (!value.trim()) return true
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return true
  return d.getTime() <= Date.now() + 120_000
}

export interface LaunchPlan {
  effectiveSends: number
  dailyVolume: number
  spacingSeconds: number
  durationLabel: string
  spanDays: number
}

export function CampaignLaunchMobile({
  ready,
  schedulable,
  schedulableLoading,
  schedulableBlockers,
  firstScheduledAt,
  lastScheduledAt,
  maxTargets,
  plan,
  scheduledAt,
  routing,
  savedCampaignId,
  campaignTimezone,
  insideContactWindow,
  blockers,
  warnings,
  previewLoading,
  activationProgress,
  isLaunching,
  isSaving,
  isPersisting,
  canActivate,
  canSchedule,
  canSaveDraft,
  onActivate,
  onSchedule,
  onSaveDraft,
  onEditSchedule,
  onEditPacing,
  onEditLimit,
  onResolveBlocker,
}: {
  ready: number | null
  /** Exact audience Schedule can hand off, after template render + lint. */
  schedulable: number | null
  schedulableLoading: boolean
  schedulableBlockers: Record<string, number> | null
  firstScheduledAt: string | null
  lastScheduledAt: string | null
  maxTargets: number
  plan: LaunchPlan
  scheduledAt: string
  routing: { covered: number; crossState: number; unrouted: number } | null
  savedCampaignId: string | null
  campaignTimezone: string
  insideContactWindow: boolean
  blockers: string[]
  warnings: string[]
  previewLoading: boolean
  activationProgress: string | null
  isLaunching: boolean
  isSaving: boolean
  isPersisting: boolean
  canActivate: boolean
  canSchedule: boolean
  canSaveDraft: boolean
  onActivate: () => void
  onSchedule: () => void
  onSaveDraft: () => void
  onEditSchedule: () => void
  onEditPacing: () => void
  onEditLimit: () => void
  onResolveBlocker: () => void
}) {
  const [queueMode, setQueueMode] = useState<string | null>(null)
  const [autoMode, setAutoMode] = useState<string | null>(null)
  // The system per-run cap actually bounds how many rows reach the queue.
  const [runLimit, setRunLimit] = useState<number | null>(null)

  // System state is read-only context, and never blocks this screen rendering.
  useEffect(() => {
    let dead = false
    void getQueueControlSettings().then((res) => {
      if (dead || !res.ok) return
      const d = (res.data?.diagnostics ?? {}) as Record<string, unknown>
      setQueueMode(d.queue_execution_mode ? String(d.queue_execution_mode) : null)
      setAutoMode(d.auto_reply_mode ? String(d.auto_reply_mode) : null)
      const lim = Number(d.queue_run_limit)
      setRunLimit(Number.isFinite(lim) && lim > 0 ? lim : null)
    })
    return () => { dead = true }
  }, [])

  const now = startsNow(scheduledAt)
  const blocked = blockers.length > 0
  // The cap binds when it lands below what is actually ready — that is the
  // difference between "8,975 will send" and "1,000 will send".
  // SCHEDULABLE is the preflight's planned_target_count — the audience that
  // survives template selection, render and lint. It is NOT the graph READY
  // count: Miami Commercial is 5 READY / 0 schedulable, every one blocked on the
  // blank-greeting lint. Until the preflight answers we show READY and say so,
  // rather than promising a number Schedule cannot honour.
  const schedulableKnown = schedulable != null
  // What will ACTUALLY be handed to the queue.
  //
  // The LIMIT row previously showed only the campaign's max-target cap, so a
  // campaign reading "1,000 of 14,147 ready" queued 50 rows — the system
  // per-run cap (queue_run_limit) binds below the campaign cap and the operator
  // was never told. Show the binding constraint, and name which one it is.
  const systemBound = runLimit != null && runLimit < plan.effectiveSends
  const capBound = systemBound ? runLimit! : plan.effectiveSends
  // The binding constraint is whichever is smallest: the campaign cap, the
  // system per-run cap, or what can actually render.
  const willQueue = schedulableKnown ? Math.min(capBound, schedulable!) : capBound
  const capBinds = ready != null && ready > 0 && willQueue < ready
  // Duration is only meaningful once there is a real volume and a real pace.
  /**
   * Duration from the number this launch will actually queue.
   *
   * plan.durationLabel is computed from effectiveSends (the campaign cap), so a
   * launch showing "LIMIT 50 · PACE 750/day · DURATION ~2 days" was describing
   * the discarded 1,000 cap: 50 messages at 45s apart is ~37 minutes, not two
   * days. When the preflight returns a real window we use it verbatim; otherwise
   * we recompute from willQueue, the real spacing and the daily volume.
   */
  const preflightWindowMinutes = firstScheduledAt && lastScheduledAt
    ? Math.max(0, (new Date(lastScheduledAt).getTime() - new Date(firstScheduledAt).getTime()) / 60000)
    : null

  const realDurationLabel = (() => {
    if (willQueue <= 0) return '—'
    if (preflightWindowMinutes != null && Number.isFinite(preflightWindowMinutes)) {
      if (preflightWindowMinutes < 1) return 'under a minute'
      if (preflightWindowMinutes < 90) return `~${Math.round(preflightWindowMinutes)} min`
      const hours = preflightWindowMinutes / 60
      if (hours < 24) return `~${hours.toFixed(hours < 10 ? 1 : 0)} hr`
      return `~${Math.ceil(hours / 24)} days`
    }
    const perDay = Math.max(1, plan.dailyVolume)
    const days = Math.ceil(willQueue / perDay)
    if (days > 1) return `~${days} days`
    const seconds = Math.max(0, willQueue - 1) * Math.max(1, plan.spacingSeconds)
    if (seconds < 60) return 'under a minute'
    const mins = Math.round(seconds / 60)
    return mins < 90 ? `~${mins} min` : `~${(mins / 60).toFixed(1)} hr`
  })()

  const durationKnown = willQueue > 0 && realDurationLabel !== '—'

  /**
   * The final action is derived from state. When the campaign cannot launch the
   * primary control states the next required step instead of offering a launch
   * that would fail.
   */
  const action = blocked
    ? { label: blockers[0], kind: 'blocked' as const, run: onResolveBlocker }
    : !schedulableKnown && !schedulableLoading && savedCampaignId
      ? { label: 'Unable to verify schedulable audience — retry', kind: 'blocked' as const, run: onResolveBlocker }
    : schedulableKnown && schedulable === 0
      ? { label: 'Nothing schedulable — fix message personalization', kind: 'blocked' as const, run: onResolveBlocker }
    : isLaunching || isPersisting || previewLoading || schedulableLoading
      ? {
          label: isLaunching
            ? (activationProgress ?? 'Working…')
            : isPersisting ? 'Saving campaign…'
              : schedulableLoading ? 'Checking message readiness…' : 'Counting targets…',
          kind: 'busy' as const,
          run: () => {},
        }
      : now
        ? canActivate
          ? { label: `Activate now · ${nf(willQueue)}`, kind: 'go' as const, run: onActivate }
          : { label: 'Save draft', kind: 'draft' as const, run: onSaveDraft }
        : canSchedule
          ? { label: `Schedule · ${formatWhen(scheduledAt)}`, kind: 'go' as const, run: onSchedule }
          : { label: 'Save draft', kind: 'draft' as const, run: onSaveDraft }

  return (
    <div className="clx">
      {/* The answer, scoped so it cannot be read as a global figure.
          When renderability differs from graph READY the two are shown
          separately — a single number would be a promise Schedule cannot keep. */}
      <section className={`clx__answer${blocked || (schedulableKnown && schedulable === 0) ? ' is-blocked' : ''}`}>
        {/* Never present READY as the schedulable answer. Until the preflight
            resolves, the headline is explicitly unresolved — substituting the
            contact-ready figure would be the exact lie this screen exists to
            stop (Miami reads 5 contact ready and 0 schedulable). */}
        <span className="clx__answer-value">
          {schedulableKnown ? nf(schedulable!) : '—'}
        </span>
        <span className="clx__answer-unit">
          {schedulableKnown ? 'SCHEDULABLE' : 'SCHEDULABLE'}
        </span>
        <span className="clx__answer-scope">
          {savedCampaignId ? 'this campaign · saved' : 'this campaign · draft'}
        </span>
        {schedulableLoading && !schedulableKnown && (
          <span className="clx__answer-sub">Checking message readiness…</span>
        )}
        {!schedulableLoading && !schedulableKnown && savedCampaignId && (
          <span className="clx__answer-sub">Unable to verify schedulable audience — retry</span>
        )}
        {schedulableKnown && ready != null && schedulable! < ready && (
          <span className="clx__answer-sub">
            {nf(ready)} contact ready · {nf(ready - schedulable!)} blocked by message personalization
          </span>
        )}
        {!schedulableKnown && ready != null && (
          <span className="clx__answer-scope">{nf(ready)} contact ready — schedulable not yet verified</span>
        )}
      </section>

      <section className="cdb__band">
        <div className="cdb__key">
          EXECUTION PLAN
          <em>{now ? 'starts immediately' : 'scheduled'}</em>
        </div>
        <div className="cdb__rows">
          <button type="button" className="cdb__row clx__row" onClick={onEditSchedule}>
            <span className="cdb__row-label">START</span>
            <span className="cdb__row-value is-text">{now ? 'Now' : formatWhen(scheduledAt)}</span>
            <Icon name="chevron-right" size={14} />
          </button>
          <button type="button" className="cdb__row clx__row" onClick={onEditPacing}>
            <span className="cdb__row-label">PACE</span>
            <span className="cdb__row-value is-text">
              {nf(plan.dailyVolume)}/day · {plan.spacingSeconds}s apart
            </span>
            <Icon name="chevron-right" size={14} />
          </button>
          <button type="button" className={`cdb__row clx__row${capBinds ? ' is-capped' : ''}`} onClick={onEditLimit}>
            <span className="cdb__row-label">LIMIT</span>
            <span className="cdb__row-value is-text">
              {nf(willQueue)} of {ready != null ? nf(ready) : '—'} ready
            </span>
            <Icon name="chevron-right" size={14} />
          </button>
          {durationKnown && (
            <div className="cdb__row">
              <span className="cdb__row-label">DURATION</span>
              <span className="cdb__row-value is-text">{realDurationLabel}</span>
            </div>
          )}
        </div>
        {capBinds && (
          <p className="clx__note is-capped">
            {systemBound
              ? `System per-run cap of ${nf(runLimit ?? 0)} binds below the campaign cap of ${nf(maxTargets)} — only ${nf(willQueue)} of ${nf(ready ?? 0)} ready will be queued by this launch.`
              : `Max-target cap of ${nf(maxTargets)} binds below the ${nf(ready ?? 0)} ready — the rest will not be queued by this launch.`}
          </p>
        )}
        {!insideContactWindow && (
          <p className="clx__note">
            Outside the {campaignTimezone} contact window — sending begins at the next window opening.
          </p>
        )}
      </section>

      {/* Routing as operational confirmation, not a second funnel. */}
      {routing && (
        <section className="cdb__band">
          <div className="cdb__key">
            SENDER ROUTING
            <em>targeted audience · {routing.unrouted === 0 ? 'all routes live' : 'partial coverage'}</em>
          </div>
          <div className="clx__routes">
            <div className="clx__route">
              <span className="clx__route-value">{nf(routing.covered)}</span>
              <span className="clx__route-label">LOCAL</span>
            </div>
            <div className={`clx__route${routing.crossState === 0 ? ' is-nil' : ''}`}>
              <span className="clx__route-value">{nf(routing.crossState)}</span>
              <span className="clx__route-label">CROSS-STATE</span>
            </div>
            <div className={`clx__route${routing.unrouted === 0 ? ' is-nil' : ' is-bad'}`}>
              <span className="clx__route-value">{nf(routing.unrouted)}</span>
              <span className="clx__route-label">NO ROUTE</span>
            </div>
          </div>
        </section>
      )}

      {/* System automation state — shown only when it constrains this launch. */}
      {(queueHolds(queueMode) || (autoMode && autoMode !== 'disabled')) && (
        <section className="cdb__band">
          <div className="cdb__key">AUTOMATION</div>
          <div className="cdb__rows">
            {queueHolds(queueMode) && (
              <div className="cdb__row">
                <span className="cdb__row-label">Send queue</span>
                <span className="cdb__row-value is-text clx__hold">
                  {QUEUE_MODE_LABEL[queueMode ?? ''] ?? queueMode}
                </span>
              </div>
            )}
            {autoMode && autoMode !== 'disabled' && (
              <div className="cdb__row">
                <span className="cdb__row-label">Auto-reply</span>
                <span className="cdb__row-value is-text">{autoMode.replace(/_/g, ' ')}</span>
              </div>
            )}
          </div>
          {queueHolds(queueMode) && (
            <p className="clx__note is-hold">
              Queue is {String(QUEUE_MODE_LABEL[queueMode ?? ''] ?? queueMode).toLowerCase()} system-wide — rows will be created but nothing sends until it returns to normal.
            </p>
          )}
        </section>
      )}

      {/* Blocker: cannot launch. Warning: may launch, operator should know. */}
      {blockers.length > 0 && (
        <section className="cdb__band clx__stop">
          <div className="cdb__key">
            BLOCKERS
            <span className="cdb__count">{blockers.length} must clear</span>
          </div>
          <div className="cdb__rows">
            {blockers.map((b) => (
              <div key={b} className="cdb__row">
                <span className="cdb__row-label clx__reason">{b}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {schedulableKnown && ready != null && schedulable! < ready && schedulableBlockers && (
        <section className="cdb__band">
          <div className="cdb__key">
            NOT SCHEDULABLE
            <em>blocked before queue handoff</em>
          </div>
          <div className="cdb__rows">
            {Object.entries(schedulableBlockers)
              .filter(([, n]) => Number(n) > 0)
              .sort((a, b) => Number(b[1]) - Number(a[1]))
              .slice(0, 5)
              .map(([reason, n]) => (
                <div key={reason} className="cdb__row">
                  <span className="cdb__row-label clx__reason">
                    {reason === 'TEMPLATE_RENDER_LINT_FAILURE' ? 'Message personalization incomplete' : reason.replace(/_/g, ' ')}
                  </span>
                  <span className="cdb__row-value">{nf(Number(n))}</span>
                </div>
              ))}
          </div>
        </section>
      )}

      {warnings.length > 0 && (
        <section className="cdb__band">
          <div className="cdb__key">
            WARNINGS
            <em>launch is allowed</em>
          </div>
          <div className="cdb__rows">
            {warnings.map((w) => (
              <div key={w} className="cdb__row">
                <span className="cdb__row-label clx__reason">{w}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="clx__actions">
        <button
          type="button"
          className={`clx__primary is-${action.kind}`}
          onClick={action.run}
          disabled={action.kind === 'busy'}
        >
          {action.label}
        </button>
        {action.kind !== 'draft' && (
          <button
            type="button"
            className="clx__secondary"
            onClick={onSaveDraft}
            disabled={isSaving || isPersisting || !canSaveDraft}
          >
            {isSaving ? 'Saving…' : 'Save draft'}
          </button>
        )}
      </div>
    </div>
  )
}
