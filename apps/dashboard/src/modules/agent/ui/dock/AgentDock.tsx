import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Icon } from '../../../../shared/icons'
import { LCIconButton, cx, useLcReducedMotion } from '../../../../shared/lc'
import { RESEARCH_DEPTH_LABELS } from '../../contracts/contracts'
import { isTerminal, progressOf } from '../../model/research-model'
import { featuredRun, isActiveStatus, needsOperator, taskStatus, TASK_STATUS_LABEL, type TaskStatus } from '../../model/run-status'
import { selectRun, setUi, snapshotOf, useAgentUi, useRuns, type RunSnapshot } from '../../runtime/agent-store'
import { globalKeyAction, modelIndicator } from '../../ask/ask-model'
import { activeThread, newThread, requestFocus, runningTurn, setPalette, showHistory, useAsk } from '../../ask/ask-store'
import { AskPanel } from '../../ask/ui/AskPanel'
import { useAskContext } from '../../ask/ui/use-ask-context'
import { fmtElapsed, fmtUsd } from '../format'
import { AgentOrb, ProgressBar, ProvenanceBadge, Shimmer } from '../primitives'
import { nowWallOf, useTick } from '../hooks'

export const DOCK_MIN = 380
export const DOCK_MAX = 560

/**
 * THE AGENT DOCK (arch §9.1; 8.5.10 Cursor-grade composer) — mounted once
 * by the desktop shell, so it persists across navigation. Top to bottom: the
 * thread title + actions (new · history · palette · workspace), a running
 * Quick Scan task when there is one, then the ask panel: the thread's turns
 * (step timeline, answer, evidence) and the composer (context pills, @ and /,
 * model, budget). Strictly read-only; the server gates every call.
 */
export function AgentDock() {
  const ui = useAgentUi()
  const reduced = useLcReducedMotion()
  const open = ui.dock === 'open' && !ui.wsOpen
  const spine = ui.dock === 'spine' && !ui.wsOpen
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.aside key="dock" className="agx agx-dock" style={{ width: ui.dockWidth }} aria-label="LeadCommand agent"
          initial={reduced ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.985 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, x: 24, scale: 0.985, transition: { duration: 0.15 } }}
          transition={{ duration: reduced ? 0 : 0.22, ease: [0.16, 1, 0.3, 1] }}>
          <DockBody />
        </motion.aside>
      ) : spine ? (
        <motion.aside key="spine" className="agx agx-spine" aria-label="LeadCommand agent (collapsed)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : 0.15 }}>
          <Spine />
        </motion.aside>
      ) : null}
    </AnimatePresence>
  )
}

function useSnaps(): RunSnapshot[] {
  const runs = useRuns()
  return runs.map((r) => snapshotOf(r.runId)).filter((s): s is RunSnapshot => Boolean(s))
}

function useCounts(snaps: RunSnapshot[]) {
  let running = 0; let waiting = 0; let blocked = 0
  for (const s of snaps) {
    const st = taskStatus(s).status
    if (needsOperator(st)) waiting += 1
    else if (st === 'blocked') blocked += 1
    else if (isActiveStatus(st)) running += 1
  }
  return { running, waiting, blocked }
}

function Spine() {
  const snaps = useSnaps()
  const { running, waiting, blocked } = useCounts(snaps)
  return (
    <button type="button" className="agx-spine__btn" onClick={() => setUi({ dock: 'open' })} aria-label={`Open the agent${running ? ` — ${running} running` : ''}${waiting ? ` — ${waiting} waiting on you` : ''}${blocked ? ` — ${blocked} blocked` : ''}`}>
      <AgentOrb live={running > 0} size={22} />
      {running ? <span className="agx-spine__n is-live" title="Running">{running}</span> : null}
      {waiting ? <span className="agx-spine__n is-wait" title="Waiting on you">{waiting}</span> : null}
      {blocked ? <span className="agx-spine__n is-block" title="Blocked">{blocked}</span> : null}
      <span className="agx-spine__label">Agent</span>
    </button>
  )
}

function DockBody() {
  const ui = useAgentUi()
  const s = useAsk()
  const snaps = useSnaps()
  const counts = useCounts(snaps)
  const featured = featuredRun(snaps)
  const showTask = featured ? (isActiveStatus(taskStatus(featured).status) || needsOperator(taskStatus(featured).status)) : false
  const { autoChips, quickScan, suggestions } = useAskContext()
  const thread = activeThread(s)
  const asking = Boolean(runningTurn(s))
  const model = modelIndicator(s.status.data)

  // Esc closes the dock (the composer closes its popover first); ⌘K inside
  // the agent focuses the composer instead of opening the Command Deck
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); setUi({ dock: 'closed' }); return }
    if (globalKeyAction(e, { insideAgent: true }) === 'focus-composer') { e.preventDefault(); e.stopPropagation(); requestFocus('dock') }
  }
  const sub = [asking ? 'Researching…' : null, counts.running ? `${counts.running} scan${counts.running === 1 ? '' : 's'} running` : null, counts.waiting ? `${counts.waiting} need${counts.waiting === 1 ? 's' : ''} you` : null].filter(Boolean).join(' · ') || (model.primary ? `Read-only · ${model.primary}` : 'Read-only research')

  return (
    <div className="agx-dock__inner ak-dock" onKeyDown={onKey}>
      <DockResizer />
      <header className="ak-head">
        <AgentOrb live={asking || counts.running > 0} size={18} />
        <div className="ak-head__t">
          <b>{s.view === 'history' ? 'History' : thread?.title ?? 'Agent'}</b>
          <span>{sub}</span>
        </div>
        <LCIconButton icon="plus" label="New question" size="sm" onClick={() => newThread()} />
        <LCIconButton icon="clock" label="History" size="sm" selected={s.view === 'history'} onClick={() => showHistory(s.view !== 'history')} />
        <LCIconButton icon="command" label="Pop out to the palette" shortcut={['⌘', '⇧', 'L']} size="sm" onClick={() => { setUi({ dock: 'closed' }); setPalette(true) }} />
        {snaps.length ? <LCIconButton icon="maximize" label="Open the research workspace" shortcut={['⌘', '⇧', 'J']} size="sm" onClick={() => selectRun(featured?.record.runId ?? ui.activeRunId, { wsOpen: true })} /> : null}
        <LCIconButton icon="chevron-right" label="Collapse to the spine" size="sm" onClick={() => setUi({ dock: 'spine' })} />
        <LCIconButton icon="x" label="Close the agent" shortcut={['⌘', 'J']} size="sm" onClick={() => setUi({ dock: 'closed' })} />
      </header>
      {showTask && featured ? <div className="ak-task"><TaskCard s={featured} /></div> : null}
      <AskPanel surface="dock" autoChips={autoChips} onClose={() => setUi({ dock: 'closed' })} quickScan={quickScan} suggestions={suggestions} />
    </div>
  )
}

/* ── the featured task (active task prominence) ───────────────────────── */

const STATUS_TONE: Record<TaskStatus, string> = { starting: 'run', running: 'run', waiting: 'wait', approval: 'wait', blocked: 'block', complete: 'ok', partial: 'block', failed: 'fail', cancelled: 'quiet', lost: 'fail' }

function TaskCard({ s }: { s: RunSnapshot }) {
  const r = s.research
  const { status, detail } = taskStatus(s)
  useTick(1000, isActiveStatus(status) && s.record.frozenT === null)
  const p = r ? progressOf(r) : null
  const start = r?.confirmed_at ? Date.parse(r.confirmed_at) : r?.created_at ? Date.parse(r.created_at) : null
  const elapsed = start ? (r?.ended_at ? Date.parse(r.ended_at) : nowWallOf(s)) - start : null
  const kind = r ? (r.property_count > 1 || s.properties.length > 1 ? `Batch · ${s.properties.length || r.property_count}` : r.depth ? RESEARCH_DEPTH_LABELS[r.depth] : 'Research') : 'Conversation'
  const running = status === 'running' && Boolean(r?.running_count)
  return (
    <button type="button" className={cx('agx-task', `is-${STATUS_TONE[status]}`)} onClick={() => selectRun(s.record.runId, { wsOpen: true })} aria-label={`Open ${s.title} in the workspace`}>
      <span className="agx-task__top">
        <span className="agx-task__kind">{kind}</span>
        <ProvenanceBadge mode={s.mode} compact />
        <span className={cx('agx-task__state', `is-${STATUS_TONE[status]}`)}><i aria-hidden="true" />{TASK_STATUS_LABEL[status]}</span>
      </span>
      <b className="agx-task__title">{s.title}</b>
      <span className="agx-task__now">
        {running ? <span className="agx-pulse is-on" aria-hidden="true" /> : null}
        <Shimmer active={running}>{detail ?? (r && isTerminal(r) ? r.summary ?? 'Complete' : 'Waiting for the next event')}</Shimmer>
      </span>
      {p && p.planned ? <ProgressBar fraction={p.fraction} label="Operations complete" segments={[{ value: p.succeeded + p.skipped, tone: 'ok' }, { value: p.blocked + p.unavailable + p.needs_input, tone: 'blocked' }, { value: p.failed + p.cancelled, tone: 'failed' }, { value: p.running, tone: 'running' }, { value: Math.max(0, p.planned - p.done - p.running - p.needs_input), tone: 'rest' }]} /> : null}
      <span className="agx-task__meta">
        {p && p.planned ? <span>{p.done}/{p.planned} operations</span> : null}
        {elapsed !== null ? <span>{fmtElapsed(elapsed)}</span> : null}
        {r ? <span>{s.depth === 'quick' ? '$0 · read-only' : `${fmtUsd(r.accrued_usd)} of ${fmtUsd(r.cap_usd)}`}</span> : null}
        <span className="agx-task__open">Open <Icon name="chevron-right" size={11} /></span>
      </span>
    </button>
  )
}

/** Left-edge grip: drag or arrow keys, 380–560px, persisted; double-click resets. */
function DockResizer() {
  const ui = useAgentUi()
  const start = useRef<{ x: number; w: number } | null>(null)
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => { start.current = { x: e.clientX, w: ui.dockWidth }; e.currentTarget.setPointerCapture(e.pointerId) }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => { if (!start.current) return; setUi({ dockWidth: Math.round(Math.max(DOCK_MIN, Math.min(DOCK_MAX, start.current.w + (start.current.x - e.clientX)))) }) }
  const onUp = () => { start.current = null }
  return (
    <div className="agx-grip is-left" role="separator" aria-orientation="vertical" aria-label="Resize the agent dock" aria-valuemin={DOCK_MIN} aria-valuemax={DOCK_MAX} aria-valuenow={ui.dockWidth} tabIndex={0}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={() => setUi({ dockWidth: 420 })}
      onKeyDown={(e) => { if (e.key === 'ArrowLeft') setUi({ dockWidth: Math.min(DOCK_MAX, ui.dockWidth + 16) }); if (e.key === 'ArrowRight') setUi({ dockWidth: Math.max(DOCK_MIN, ui.dockWidth - 16) }) }} />
  )
}
