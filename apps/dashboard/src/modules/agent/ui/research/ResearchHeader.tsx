import { AnimatePresence, motion } from 'framer-motion'
import { Icon } from '../../../../shared/icons'
import { LCButton, cx, useLcReducedMotion } from '../../../../shared/lc'
import { RESEARCH_DEPTH_LABELS, RESEARCH_PHASE_LABELS } from '../../contracts/contracts'
import { isTerminal, progressOf, type ResearchView } from '../../model/research-model'
import { taskStatus, TASK_STATUS_LABEL } from '../../model/run-status'
import { controlRun, reconnectLive, setUi, useAgentUi, type RunSnapshot } from '../../runtime/agent-store'
import { fmtClock, fmtElapsed, fmtUsd } from '../format'
import { nowWallOf, useTick } from '../hooks'
import { PhaseRail, ProgressBar, ProvenanceBadge, Shimmer } from '../primitives'

const TRANSPORT_LABEL: Record<string, string> = { starting: 'Creating the run', connecting: 'Connecting', streaming: 'Streaming', reconnecting: 'Reconnecting', complete: 'Stream closed', lost: 'Run unavailable', refused: 'Refused', failed_to_start: 'Did not start' }

/**
 * TASK HEADER (S3 P2) — the centre's identity: what this is (tier · LIVE or
 * SIMULATED · where it came from), the subject, the phase, genuine progress
 * (done / planned operations, re-based when planned grows), elapsed since
 * start, the blockers that matter, cost (Quick Scan: structural $0), and the
 * one sentence in shimmer that names the operation actually running now.
 */
export function TaskHeader({ snap, view, propertyId, crumb }: { snap: RunSnapshot; view: ResearchView; propertyId: string | null; crumb?: { label: string; onClick: () => void } | null }) {
  const reduced = useLcReducedMotion()
  const ui = useAgentUi()
  const terminal = isTerminal(view)
  const live = snap.live
  useTick(1000, !terminal && view.state !== 'draft' && snap.record.frozenT === null)
  const p = progressOf(view, propertyId)
  const start = view.confirmed_at ? Date.parse(view.confirmed_at) : view.created_at ? Date.parse(view.created_at) : null
  const end = view.ended_at ? Date.parse(view.ended_at) : nowWallOf(snap)
  const elapsed = start ? end - start : null
  const runningTask = propertyId ? view.tasks.filter((t) => t.state === 'running' && t.property_id === propertyId).sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))[0] ?? null : null
  const current = propertyId ? runningTask?.label ?? null : view.current?.label ?? null
  const running = propertyId ? p.running > 0 : view.running_count > 0
  const st = taskStatus(snap)
  const label = live && (live.status === 'failed_to_start' || live.status === 'lost' || live.status === 'refused') ? live.error ?? TRANSPORT_LABEL[live.status]
    : live && live.status === 'starting' ? 'Creating the run on the server…'
      : live && live.status === 'connecting' && !view.event_count ? 'Connecting to the run stream…'
        : view.state === 'cancelled' ? 'Cancelled — what was gathered before the cancel is kept'
          : view.cancel_requested && !terminal ? 'Cancelling — waiting for the run to confirm'
            : view.state === 'paused' && !running ? 'Paused — no new source operations are being started'
              : terminal ? (view.summary ?? TASK_STATUS_LABEL[st.status])
                : current ?? (view.phase === 'synthesizing' ? 'Synthesizing the brief' : 'Waiting for the next operation')
  const pv = propertyId ? view.properties[propertyId] : null
  const subject = propertyId ? snap.properties.find((x) => x.property_id === propertyId) : snap.properties.length === 1 ? snap.properties[0] : null
  const title = subject?.address ?? (pv?.display_address && pv.display_address !== propertyId ? pv.display_address : null) ?? snap.title
  const sub = subject ? [subject.city, subject.jurisdiction].filter(Boolean).join(' · ') || (snap.mode === 'live' ? `LeadCommand property ${subject.property_id}` : null) : snap.subtitle
  const isBatch = snap.properties.length > 1
  const blockers = [p.blocked ? `${p.blocked} blocked` : null, p.needs_input ? `${p.needs_input} need${p.needs_input === 1 ? 's' : ''} you` : null, p.failed ? `${p.failed} failed` : null, p.unavailable ? `${p.unavailable} unavailable` : null].filter(Boolean) as string[]
  const quick = (view.depth ?? snap.depth) === 'quick'

  return (
    <header className={cx('agx-thead', running && 'is-running', terminal && 'is-terminal', `is-${snap.mode}`)} aria-label="Task">
      <div className="agx-thead__eyebrow">
        {crumb ? <button type="button" className="agx-crumb" onClick={crumb.onClick}><Icon name="chevron-left" size={11} />{crumb.label}</button> : null}
        <span className="agx-thead__tier">{view.depth ? RESEARCH_DEPTH_LABELS[view.depth] : 'Research'}{isBatch && !propertyId ? ` · batch of ${snap.properties.length}` : ''}{quick ? ' · T0 read' : ''}</span>
        <ProvenanceBadge mode={snap.mode} compact />
        {live?.originLabel && !crumb ? <span className="agx-thead__origin">from {live.originLabel}</span> : null}
        {live ? <span className={cx('agx-thead__wire', `is-${live.status}`)} title={live.error ?? undefined}><i aria-hidden="true" />{TRANSPORT_LABEL[live.status]}{live.lastContactAt && live.status === 'streaming' ? ` · ${fmtClock(new Date(live.lastContactAt).toISOString())}` : ''}</span> : null}
        <span className="agx-thead__sp" />
        <ResearchControls snap={snap} view={view} />
      </div>
      <div className="agx-thead__title">
        <h2>{title}</h2>
        {sub ? <p>{sub}</p> : null}
      </div>
      {view.state !== 'draft' ? (
        <>
          <div className="agx-thead__now">
            <span className={cx('agx-pulse', running && !reduced && 'is-on')} aria-hidden="true" />
            <span className="agx-thead__label" aria-live="off">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={label} initial={reduced ? false : { opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -5 }} transition={{ duration: reduced ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}>
                  <Shimmer active={running && !terminal}>{label}</Shimmer>
                </motion.span>
              </AnimatePresence>
            </span>
            <span className="agx-sr" aria-live="polite">{view.phase ? RESEARCH_PHASE_LABELS[view.phase] : ''}</span>
            {live && (live.status === 'reconnecting') ? <button type="button" className="agx-link" onClick={() => reconnectLive(snap.record.runId)}>Retry now</button> : null}
          </div>
          <div className="agx-thead__strip">
            <PhaseRail phase={view.phase} terminal={terminal} />
            <span className="agx-thead__sp" />
            <dl className="agx-thead__facts">
              <div><dt>Operations</dt><dd><b>{p.done}</b><span>/ {p.planned}</span>{view.planned_growth && !propertyId ? <em title="Planned grew after research started — the bar re-bases">+{view.planned_growth}</em> : null}</dd></div>
              <div><dt>Elapsed</dt><dd className="is-mono">{elapsed !== null ? fmtElapsed(elapsed) : '—'}</dd></div>
              {blockers.length ? (
                <div className="is-blockers"><dt>Blockers</dt><dd><button type="button" className="agx-thead__blk" onClick={() => setUi({ inspectorTab: 'property', rightCollapsed: false })}>{blockers.join(' · ')}</button></dd></div>
              ) : null}
              {view.retries ? <div><dt>Retries</dt><dd>{view.retries}</dd></div> : null}
              <div><dt>Cost</dt><dd title="Settled actuals — never the estimate">{quick ? <><b>$0</b><span>structural</span></> : <><b>{fmtUsd(view.accrued_usd)}</b><span>of {fmtUsd(view.cap_usd)}</span></>}</dd></div>
            </dl>
          </div>
          <ProgressBar fraction={p.fraction} label="Operations completed" segments={[
            { value: p.succeeded + p.skipped, tone: 'ok' },
            { value: p.blocked + p.unavailable + p.needs_input, tone: 'blocked' },
            { value: p.failed + p.cancelled, tone: 'failed' },
            { value: p.running, tone: 'running' },
            { value: Math.max(0, p.planned - p.done - p.running - p.needs_input), tone: 'rest' },
          ]} />
        </>
      ) : null}
      {ui.confirmCancel === snap.record.runId ? <CancelSheet snap={snap} /> : null}
    </header>
  )
}

/** Pause / Resume / Cancel with the exact semantics. Live Quick Scans cancel only (they take seconds). */
export function ResearchControls({ snap, view }: { snap: RunSnapshot; view: ResearchView }) {
  const terminal = isTerminal(view)
  const live = snap.live
  if (terminal || view.state === 'draft') return null
  if (live && ['failed_to_start', 'lost', 'refused', 'starting'].includes(live.status)) return null
  const runId = snap.record.runId
  const pending = view.cancel_requested || Boolean(live?.cancelPosted)
  return (
    <div className="agx-controls">
      {snap.mode === 'fixture' ? (view.paused
        ? <LCButton size="sm" variant="secondary" icon="play" onClick={() => controlRun(runId, 'resume')}>Resume</LCButton>
        : <LCButton size="sm" variant="quiet" icon="pause" disabled={pending} onClick={() => controlRun(runId, 'pause')}>Pause</LCButton>) : null}
      <LCButton size="sm" variant="quiet" icon="x" disabled={pending} onClick={() => setUi({ confirmCancel: runId })}>{pending ? 'Cancelling…' : 'Cancel'}</LCButton>
    </div>
  )
}

function CancelSheet({ snap }: { snap: RunSnapshot }) {
  const runId = snap.record.runId
  const live = snap.mode === 'live'
  return (
    <div className="agx-cancel" role="alertdialog" aria-label="Cancel research">
      <b>Cancel this {live ? 'Quick Scan' : 'research'}?</b>
      <ul>
        {live ? (
          <>
            <li>The server stops at the next read boundary.</li>
            <li>Reads already returned stay in the activity and the brief.</li>
            <li>Nothing to settle — a Quick Scan accrues no cost.</li>
          </>
        ) : (
          <>
            <li>Queued source operations are cancelled.</li>
            <li>Running operations stop at their next source boundary.</li>
            <li>An in-flight model call can’t be recalled — it settles at its real cost, marked “after cancel”.</li>
            <li>Findings gathered so far stay in the brief.</li>
          </>
        )}
      </ul>
      <div className="agx-cancel__acts">
        <LCButton size="sm" variant="quiet" onClick={() => setUi({ confirmCancel: null })} autoFocus>Keep running</LCButton>
        <LCButton size="sm" variant="danger" onClick={() => { setUi({ confirmCancel: null }); controlRun(runId, 'cancel') }}>Cancel {live ? 'scan' : 'research'}</LCButton>
      </div>
    </div>
  )
}
