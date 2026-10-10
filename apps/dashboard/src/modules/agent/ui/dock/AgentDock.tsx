import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Icon } from '../../../../shared/icons'
import { LCIconButton, cx, useLcReducedMotion } from '../../../../shared/lc'
import { RESEARCH_DEPTH_LABELS } from '../../contracts/contracts'
import { useAgentContextSnapshot, type AgentContextSnapshot, type ContextChip } from '../../context/agent-context'
import { DEFAULT_ASK, FIXTURES_AVAILABLE } from '../../fixtures'
import { isTerminal, progressOf } from '../../model/research-model'
import { featuredRun, isActiveStatus, needsOperator, taskStatus, TASK_STATUS_LABEL, type TaskStatus } from '../../model/run-status'
import { openLivePreflight, refreshLiveCapability, selectRun, setUi, snapshotOf, startRun, useAgentUi, useLiveCapability, useRuns, useRunSnapshot, type RunSnapshot } from '../../runtime/agent-store'
import { fmtClock, fmtElapsed, fmtUsd } from '../format'
import { AgentOrb, ProgressBar, ProvenanceBadge, Shimmer } from '../primitives'
import { nowWallOf, useTick } from '../hooks'
import { RunStream } from '../stream/RunStream'

export const DOCK_MIN = 380
export const DOCK_MAX = 560

const CAPABILITIES = [
  { id: 'quick', label: '/quick-scan', hint: 'Quick Scan the linked property — LIVE, read-only, $0', live: true },
  { id: 'research', label: '/research', hint: 'Deep Research replay — SIMULATED fixture', live: false },
  { id: 'blocked', label: '/research-blocked', hint: 'Blocked county + conflict replay — SIMULATED', live: false },
  { id: 'batch', label: '/batch', hint: '25-property batch replay — SIMULATED', live: false },
] as const

/**
 * THE AGENT DOCK (arch §9.1, S3 P1) — mounted once by the desktop shell, so
 * it persists across navigation. Top to bottom: what the agent can see (the
 * context strip follows the focused app and the linked selection), the
 * featured task (needs-you → running → recent), then either the run stream,
 * or a useful idle state: the one live action that applies here, recent
 * runs, and the simulated design fixtures — clearly separated.
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
  const ctx = useAgentContextSnapshot()
  const cap = useLiveCapability()
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const snaps = useSnaps()
  // a live run may already know the linked property's address (EG publishes the id only)
  const knownAddress = ctx.property?.id && !ctx.property.address ? snaps.flatMap((s) => (s.mode === 'live' ? s.properties : [])).find((p) => p.property_id === ctx.property!.id && !p.address.startsWith('Property ••'))?.address ?? null : null
  const chips = ctx.chips.filter((c) => !removed.has(c.id)).map((c) => (c.kind === 'property' && knownAddress ? { ...c, label: knownAddress } : c))
  const conv = useRunSnapshot(ui.dockRunId)
  const featured = featuredRun(snaps.filter((s) => s.record.runId !== ui.dockRunId))
  const streamRef = useRef<HTMLDivElement>(null)
  useTick(1000, Boolean(conv?.active) && conv?.record.frozenT === null)

  useEffect(() => { if (cap.status === 'unknown') void refreshLiveCapability() }, [cap.status])

  // follow the stream while it grows (scrolling up stops following)
  const follow = useRef(true)
  useEffect(() => {
    const el = streamRef.current
    if (el && follow.current && conv) el.scrollTop = el.scrollHeight
  })

  const onKey = (e: ReactKeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setUi({ dock: 'closed' }) } }
  const counts = useCounts(snaps)
  const run = conv?.run ?? null
  const elapsed = run?.created_at ? (run.ended_at ? Date.parse(run.ended_at) : nowWallOf(conv!)) - Date.parse(run.created_at) : 0

  return (
    <div className="agx-dock__inner" onKeyDown={onKey}>
      <DockResizer />
      <header className="agx-dock__head">
        <AgentOrb live={counts.running > 0} />
        <div className="agx-dock__title">
          <b>LeadCommand Agent</b>
          <span className="agx-dock__sum">{[counts.running ? `${counts.running} running` : null, counts.waiting ? `${counts.waiting} need${counts.waiting === 1 ? 's' : ''} you` : null, counts.blocked ? `${counts.blocked} blocked` : null].filter(Boolean).join(' · ') || 'Idle'}</span>
        </div>
        <LCIconButton icon="maximize" label="Expand to the workspace" shortcut={['⌘', '⇧', 'J']} size="sm" onClick={() => selectRun(featured?.record.runId ?? ui.activeRunId, { wsOpen: true })} />
        <LCIconButton icon="chevron-right" label="Collapse to the spine" size="sm" onClick={() => setUi({ dock: 'spine' })} />
        <LCIconButton icon="x" label="Close the agent" shortcut={['⌘', 'J']} size="sm" onClick={() => setUi({ dock: 'closed' })} />
      </header>

      <ContextStrip chips={chips} onRemove={(id) => setRemoved((s) => new Set([...s, id]))} />

      {featured ? <TaskCard s={featured} /> : null}

      <div className="agx-dock__stream" ref={streamRef} onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24 }}>
        {conv?.run ? (
          <>
            <div className="agx-runhead">
              <div className="agx-runhead__t"><b>{run!.title}</b><ProvenanceBadge mode={conv.mode} compact /></div>
              <div className="agx-runhead__m"><span>{TASK_STATUS_LABEL[taskStatus(conv).status]}</span><span>{fmtElapsed(elapsed)}</span><span>{fmtUsd(run!.accrued_usd)} of {fmtUsd(run!.cap_usd)} cap</span><button type="button" className="agx-link" onClick={() => setUi({ dockRunId: null })}>Close conversation</button></div>
            </div>
            <RunStream snap={conv} />
          </>
        ) : <IdleState ctx={ctx} snaps={snaps} featuredId={featured?.record.runId ?? null} />}
      </div>

      <Composer onSend={(text) => startRun('conversation', { operatorText: text, open: 'dock' })} chips={chips} ctx={ctx} />
    </div>
  )
}

/* ── context: follows the focused app and the linked selection ────────── */

function ContextStrip({ chips, onRemove }: { chips: ContextChip[]; onRemove: (id: string) => void }) {
  // plain keyed rows with a CSS arrival (an exit animation could leave a stale app chip behind on fast navigation)
  return (
    <div className="agx-dock__ctx" aria-label="What the agent can see">
      <span className="agx-dock__ctxk">Sees</span>
      <div className="agx-dock__chips">
        {chips.length ? chips.map((c) => <span key={c.id} className="agx-dock__chipw"><Chip chip={c} onRemove={() => onRemove(c.id)} /></span>) : <span className="agx-muted">Nothing — the agent sees only what you type.</span>}
      </div>
    </div>
  )
}

function Chip({ chip, onRemove }: { chip: ContextChip; onRemove: () => void }) {
  return (
    <span className={cx('agx-ctxchip', `is-${chip.kind}`)}>
      <Icon name={chip.kind === 'property' ? 'home' : 'layers'} size={11} />
      <b>{chip.label}</b>{chip.detail ? <small>{chip.detail}</small> : null}
      <button type="button" aria-label={`Remove ${chip.label} from the context`} onClick={onRemove}><Icon name="x" size={9} /></button>
    </span>
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

/* ── idle: the one live action here, recent runs, then the fixtures ───── */

function IdleState({ ctx, snaps, featuredId }: { ctx: AgentContextSnapshot; snaps: RunSnapshot[]; featuredId: string | null }) {
  const cap = useLiveCapability()
  const [fixturesOpen, setFixturesOpen] = useState(false)
  const recent = snaps.filter((s) => s.record.runId !== featuredId).slice(0, 4)
  const pid = ctx.property?.id ?? null
  const known = pid ? snaps.find((s) => s.mode === 'live' && s.properties.some((p) => p.property_id === pid && !p.address.startsWith('Property ••'))) : null
  const address = ctx.property?.address ?? known?.properties.find((p) => p.property_id === pid)?.address ?? null
  const liveReady = cap.status === 'available'
  const canScan = Boolean(pid) && liveReady
  const scan = () => { if (pid) openLivePreflight({ propertyIds: [pid], addresses: [address], originApp: ctx.property?.sourceApp ?? ctx.app, originLabel: `${ctx.property?.sourceLabel ?? ctx.appLabel ?? 'Linked'} selection` }) }
  return (
    <div className="agx-idle">
      <section className="agx-idle__primary" aria-label="Suggested action">
        <span className="agx-eyebrow">Suggested here</span>
        <button type="button" className={cx('agx-act', 'is-primary', !canScan && 'is-disabled')} disabled={!canScan} onClick={scan}>
          <span className="agx-act__ic"><Icon name="radar" size={16} /></span>
          <span className="agx-act__t">
            <b>{pid ? `Quick Scan ${address ?? 'the linked property'}` : 'Quick Scan a property'}</b>
            <small>{!pid ? 'Select a property in Entity Graph — the dock picks it up as context.' : liveReady ? 'Reads LeadCommand records for this property · $0 · read-only · AI off · preflight first' : cap.status === 'checking' || cap.status === 'unknown' ? 'Checking that the live route is available…' : cap.reason ?? 'Live Quick Scan is unavailable on this API.'}</small>
          </span>
          {canScan ? <span className="agx-act__badge">Live</span> : null}
        </button>
        {ctx.selection && ctx.selection.count > 1 ? (
          <button type="button" className={cx('agx-act', !liveReady && 'is-disabled')} disabled={!liveReady}
            onClick={() => openLivePreflight({ propertyIds: ctx.selection!.property_ids, addresses: ctx.selection!.property_ids.map((id) => (ctx.selection!.focused?.property_id === id ? ctx.selection!.focused.address : null)), originApp: 'entity-graph', originLabel: 'Entity Graph selection' })}>
            <span className="agx-act__ic"><Icon name="layers" size={15} /></span>
            <span className="agx-act__t"><b>Quick Scan the {ctx.selection.count} selected properties</b><small>The server takes the first test batch and says how many it defers · $0 · read-only</small></span>
          </button>
        ) : null}
        {!liveReady && cap.status === 'unavailable' ? <button type="button" className="agx-link agx-idle__retry" onClick={() => void refreshLiveCapability()}>Check again</button> : null}
      </section>

      {recent.length ? (
        <section className="agx-idle__recent" aria-label="Recent runs">
          <span className="agx-eyebrow">Recent</span>
          {recent.map((s) => {
            const st = taskStatus(s).status
            return (
              <button key={s.record.runId} type="button" className="agx-recent" onClick={() => (s.run ? setUi({ dockRunId: s.record.runId }) : selectRun(s.record.runId, { wsOpen: true }))}>
                <span className={cx('agx-recent__dot', `is-${STATUS_TONE[st]}`)} aria-hidden="true" />
                <span className="agx-recent__t"><b>{s.title}</b><small>{TASK_STATUS_LABEL[st]} · {fmtClock(new Date(s.record.createdAt).toISOString())}</small></span>
                <span className={cx('agx-recent__mode', `is-${s.mode}`)}>{s.mode === 'live' ? 'Live' : 'Sim'}</span>
              </button>
            )
          })}
        </section>
      ) : null}

      <section className="agx-idle__can" aria-label="What the agent can do now">
        <span className="agx-eyebrow">In S3 the agent can</span>
        <ul>
          <li><b>Quick Scan</b> a linked property — live, read-only, $0</li>
          <li><b>Keep runs going</b> while you navigate — they survive reload</li>
          <li className="is-off"><b>Not yet:</b> model answers, Deep Research, Diligence, writes or sends</li>
        </ul>
      </section>

      {FIXTURES_AVAILABLE ? <section className={cx('agx-idle__fx', fixturesOpen && 'is-open')} aria-label="Design fixtures">
        <button type="button" className="agx-idle__fxh" onClick={() => setFixturesOpen((o) => !o)} aria-expanded={fixturesOpen}>
          <span className="agx-eyebrow">Design fixtures</span><span className="agx-sim">SIMULATED</span><Icon name={fixturesOpen ? 'chevron-up' : 'chevron-down'} size={12} />
        </button>
        {fixturesOpen ? (
          <div className="agx-idle__fxl">
            <FixtureRow icon="radar" title="Deep Research replay" sub="Synthetic property · recorded log" onClick={() => startRun('single-deep', { open: 'workspace' })} />
            <FixtureRow icon="shield" title="Blocked county + conflict" sub="Tax collector refuses automated access" onClick={() => startRun('blocked-conflict', { open: 'workspace' })} />
            <FixtureRow icon="layers" title="25-property batch" sub="Pilot counties · concurrency 2" onClick={() => startRun('batch-25', { open: 'workspace' })} />
            <FixtureRow icon="message" title="Recorded conversation" sub={`“${DEFAULT_ASK}”`} onClick={() => setUi({ composer: DEFAULT_ASK })} />
          </div>
        ) : null}
      </section> : null}
    </div>
  )
}

function FixtureRow({ icon, title, sub, onClick }: { icon: string; title: string; sub: string; onClick: () => void }) {
  return (
    <button type="button" className="agx-act is-fixture" onClick={onClick}>
      <span className="agx-act__ic"><Icon name={icon as 'radar'} size={14} /></span>
      <span className="agx-act__t"><b>{title}</b><small>{sub}</small></span>
    </button>
  )
}

/* ── composer ──────────────────────────────────────────────────────────── */

function Composer({ onSend, chips, ctx }: { onSend: (text: string) => void; chips: ContextChip[]; ctx: AgentContextSnapshot }) {
  const ui = useAgentUi()
  const cap = useLiveCapability()
  const ta = useRef<HTMLTextAreaElement>(null)
  const text = ui.composer
  const slash = text.startsWith('/') ? text.slice(1).toLowerCase() : null
  const caps = slash !== null ? CAPABILITIES.filter((c) => (c.live || FIXTURES_AVAILABLE) && c.label.slice(1).startsWith(slash)) : []
  useEffect(() => { const el = ta.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(160, el.scrollHeight)}px` }, [text])
  useEffect(() => { ta.current?.focus({ preventScroll: true }) }, [])
  const send = () => {
    const t = text.trim()
    if (!t) return
    if (t.startsWith('/')) { runCap(caps[0]?.id); return }
    if (!FIXTURES_AVAILABLE) return // AI is off: there is no model to answer, and no recorded turn ships in production
    setUi({ composer: '' })
    onSend(t)
  }
  const runCap = (id: string | undefined) => {
    setUi({ composer: '' })
    if (id === 'quick' && ctx.property?.id && cap.status === 'available') openLivePreflight({ propertyIds: [ctx.property.id], addresses: [ctx.property.address], originApp: ctx.property.sourceApp ?? ctx.app, originLabel: `${ctx.property.sourceLabel ?? ctx.appLabel ?? 'Linked'} selection` })
    else if (id === 'research') startRun('single-deep', { open: 'workspace' })
    else if (id === 'blocked') startRun('blocked-conflict', { open: 'workspace' })
    else if (id === 'batch') startRun('batch-25', { open: 'workspace' })
  }
  return (
    <div className="agx-composer">
      {caps.length ? (
        <ul className="agx-caps" role="listbox" aria-label="Capabilities">
          {caps.map((c) => {
            const off = c.live && (!ctx.property?.id || cap.status !== 'available')
            return <li key={c.id} role="option" aria-selected={false} aria-disabled={off}><button type="button" disabled={off} onClick={() => runCap(c.id)}><b>{c.label}<span className={cx('agx-caps__mode', c.live ? 'is-live' : 'is-sim')}>{c.live ? 'Live' : 'Sim'}</span></b><small>{off ? (ctx.property?.id ? cap.reason ?? 'Live route unavailable' : 'Select a property first') : c.hint}</small></button></li>
          })}
        </ul>
      ) : null}
      <textarea ref={ta} value={text} rows={1} placeholder="Ask LeadCommand…  / capabilities" aria-label="Message the agent"
        onChange={(e) => setUi({ composer: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
      <div className="agx-composer__foot">
        <span className="agx-muted">{chips.length ? `${chips.length} context item${chips.length === 1 ? '' : 's'}` : 'No context'} · AI is off{FIXTURES_AVAILABLE ? <> — a typed question replays a <b className="agx-sim-ink">simulated</b> recorded turn</> : ' — use / for Quick Scan'}</span>
        <button type="button" className="agx-send" disabled={!text.trim() || (!FIXTURES_AVAILABLE && !text.trim().startsWith('/'))} onClick={send} aria-label="Send"><Icon name="send" size={14} /></button>
      </div>
    </div>
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
