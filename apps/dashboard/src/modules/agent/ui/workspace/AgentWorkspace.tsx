import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Icon } from '../../../../shared/icons'
import { LCButton, LCIconButton, LCSegmented, cx, useLcReducedMotion } from '../../../../shared/lc'
import { RESEARCH_DEPTH_LABELS } from '../../contracts/contracts'
import { useAgentContextSnapshot } from '../../context/agent-context'
import { FIXTURES_AVAILABLE, fixtureBatchSize } from '../../fixtures'
import { OWNER_BRIEF_ORDER } from '../../model/brief-model'
import { progressOf } from '../../model/research-model'
import { isActiveStatus, needsOperator, taskStatus, TASK_STATUS_LABEL } from '../../model/run-status'
import { dismissPreflight, openLivePreflight, refreshLiveCapability, removeRun, selectRun, setUi, snapshotOf, startRun, useAgentUi, useLiveCapability, useRuns, useRunSnapshot, type CenterTab, type RunSnapshot, type WorkspaceLayout } from '../../runtime/agent-store'
import { fmtClock, fmtUsd } from '../format'
import { AgentOrb, ProgressBar, ProvenanceBadge, Shimmer } from '../primitives'
import { LivePreflight } from '../research/MissionPreflight'
import { ResearchCanvas } from '../research/ResearchCanvas'
import { ResearchInspector } from '../research/ResearchInspector'
import { RunStream } from '../stream/RunStream'
import { ApprovalsList } from '../../approvals/ApprovalsList'
import { ConversationIntelPanel } from '../../conversation-intel/ConversationIntelPanel'
import { setIntel, useIntel } from '../../conversation-intel/conversation-intel-model'

const LEFT = { min: 248, max: 440, def: 296 }
const RIGHT = { min: 320, max: 620, def: 404 }

/**
 * THE AGENT WORKSPACE (S3 P2) — the approved three regions:
 *   LEFT    conversations · research jobs · scope (the linked selection) · navigation
 *   CENTRE  the investigation: task header, activity, conclusions, brief
 *   RIGHT   property context, evidence + conflicts, cost
 * The centre has its own material (a deeper, quieter canvas plane) so the
 * investigation reads as the subject and the rails as instruments. Regions
 * resize and collapse; layouts Beside / Cover / Fullscreen (F).
 */
export function AgentWorkspace() {
  const ui = useAgentUi()
  const reduced = useLcReducedMotion()
  return (
    <AnimatePresence initial={false}>
      {ui.wsOpen ? (
        <motion.section key="ws" className={cx('agx', 'agx-ws', `is-${ui.wsLayout}`)} aria-label="Agent workspace"
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.985, x: 18 }} animate={{ opacity: 1, scale: 1, x: 0 }} exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.99, x: 12, transition: { duration: 0.15 } }}
          transition={{ duration: reduced ? 0 : 0.24, ease: [0.16, 1, 0.3, 1] }} style={{ transformOrigin: 'right center' }}>
          <WorkspaceBody />
        </motion.section>
      ) : null}
    </AnimatePresence>
  )
}

function WorkspaceBody() {
  const ui = useAgentUi()
  const snap = useRunSnapshot(ui.activeRunId)
  const onKey = (e: ReactKeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (ui.confirmCancel) setUi({ confirmCancel: null })
      else if (ui.preflight) dismissPreflight()
      else if (ui.wsLayout === 'fullscreen') setUi({ wsLayout: 'cover' })
      else setUi({ wsOpen: false })
    }
    if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setUi({ wsLayout: ui.wsLayout === 'fullscreen' ? 'cover' : 'fullscreen' }) }
  }
  const cols = `${ui.leftCollapsed ? '44px' : `${ui.leftW}px`} 0px minmax(0,1fr) 0px ${ui.rightCollapsed ? '44px' : `${ui.rightW}px`}`
  const showPreflight = Boolean(ui.preflight)
  const intel = useIntel()
  return (
    <div className="agx-ws__inner" onKeyDown={onKey} tabIndex={-1}>
      <header className="agx-ws__head">
        <AgentOrb live={Boolean(snap?.active && snap.research?.running_count)} />
        <div className="agx-ws__title"><b>Agent workspace</b><span className="agx-muted">{showPreflight ? 'Preflight' : snap ? snap.title : 'No run selected'}</span></div>
        <div className="agx-ws__tools">
          <LCSegmented<WorkspaceLayout> size="sm" label="Workspace layout" value={ui.wsLayout} onChange={(v) => setUi({ wsLayout: v })}
            options={[{ value: 'beside', label: 'Beside' }, { value: 'cover', label: 'Cover' }, { value: 'fullscreen', label: 'Fullscreen' }]} />
          <LCIconButton icon="message" label="Back to the dock" size="sm" onClick={() => setUi({ wsOpen: false, dock: 'open' })} />
          <LCIconButton icon="x" label="Close the workspace (runs keep going)" size="sm" onClick={() => setUi({ wsOpen: false })} />
        </div>
      </header>
      <div className="agx-ws__grid" style={{ gridTemplateColumns: cols }}>
        <Region side="left" collapsed={ui.leftCollapsed} label="Runs, scope and navigation"><LeftRail /></Region>
        <Grip side="left" />
        <main className={cx('agx-ws__center', snap && `is-${snap.mode}`)} aria-label="Investigation">
          {intel.open && !showPreflight ? <ConversationIntelPanel />
            : showPreflight ? <div className="agx-canvas is-pre"><div className="agx-canvas__pre"><LivePreflight /></div></div>
            : snap?.research ? <ResearchCanvas snap={snap} /> : snap?.run ? <ConversationCanvas snap={snap} /> : <EmptyCanvas />}
        </main>
        <Grip side="right" />
        <Region side="right" collapsed={ui.rightCollapsed} label="Inspector">
          {intel.open && !showPreflight ? <IntelInspector /> : showPreflight ? <PreflightInspector /> : snap?.research ? <ResearchInspectorFor snap={snap} /> : snap?.run ? <RunInspector snap={snap} /> : <p className="agx-empty">The inspector follows the selected run.</p>}
        </Region>
      </div>
    </div>
  )
}

function ResearchInspectorFor({ snap }: { snap: RunSnapshot }) {
  const ui = useAgentUi()
  const isBatch = snap.properties.length > 1
  const property = isBatch ? snap.properties.find((p) => p.property_id === ui.focusPropertyId) ?? null : snap.properties[0] ?? null
  return <ResearchInspector snap={snap} view={snap.research!} property={property} />
}

function IntelInspector() {
  return (
    <div className="agx-insp">
      <div className="agx-insp__tabs"><b className="agx-insp__t">Shadow policy</b></div>
      <div className="agx-insp__body">
        <section className="agx-panel"><h5>What this is</h5><p>Conversation Engine 2.0 (R1 understanding, R2 composition) runs beside the deterministic engine and records what it understood and would have said. The deterministic engine stays authoritative.</p></section>
        <section className="agx-panel"><h5>What it never does</h5><p>It never sends, queues, or schedules a message, and it never changes a record. STOP, suppression, wrong number, windows and offers are decided by the existing deterministic rules before any model is called.</p></section>
        <section className="agx-panel"><h5>AI reply policy</h5><p>Off. The kill switch is engaged by default. Turning on template auto-reply does not turn on AI replies.</p></section>
      </div>
    </div>
  )
}

function PreflightInspector() {
  return (
    <div className="agx-insp">
      <div className="agx-insp__tabs"><b className="agx-insp__t">Before launch</b></div>
      <div className="agx-insp__body">
        <section className="agx-panel"><h5>What a Quick Scan reads</h5><p>LeadCommand’s own records for the property: the record summary, recorded documents (mortgages, liens, foreclosure), valuation lanes, comps, buyer activity and market context — plus deterministic checks such as vendor-vs-record contradictions and stale vendor flags.</p></section>
        <section className="agx-panel"><h5>What it never does</h5><p>No external calls, no model calls, no paid lookups, no writes, no sends, no changes to any record. It cannot promote a finding to a canonical field.</p></section>
        <section className="agx-panel"><h5>Where results go</h5><p>Into this workspace as a live, read-only run. It keeps going while you navigate and survives a reload.</p></section>
      </div>
    </div>
  )
}

function Region({ side, collapsed, label, children }: { side: 'left' | 'right'; collapsed: boolean; label: string; children: ReactNode }) {
  const key = side === 'left' ? 'leftCollapsed' : 'rightCollapsed'
  return (
    <aside className={cx('agx-region', `is-${side}`, collapsed && 'is-collapsed')} aria-label={label}>
      {collapsed ? (
        <button type="button" className="agx-region__spine" onClick={() => setUi({ [key]: false })} aria-label={`Expand ${label}`}>
          <Icon name={side === 'left' ? 'chevron-right' : 'chevron-left'} size={14} /><span>{side === 'left' ? 'Runs' : 'Inspector'}</span>
        </button>
      ) : (
        <>
          <button type="button" className="agx-region__fold" onClick={() => setUi({ [key]: true })} aria-label={`Collapse ${label}`}><Icon name={side === 'left' ? 'chevron-left' : 'chevron-right'} size={12} /></button>
          <div className="agx-region__scroll">{children}</div>
        </>
      )}
    </aside>
  )
}

function Grip({ side }: { side: 'left' | 'right' }) {
  const ui = useAgentUi()
  const start = useRef<{ x: number; w: number } | null>(null)
  const b = side === 'left' ? LEFT : RIGHT
  const cur = side === 'left' ? ui.leftW : ui.rightW
  const collapsed = side === 'left' ? ui.leftCollapsed : ui.rightCollapsed
  const set = (w: number) => setUi(side === 'left' ? { leftW: Math.round(Math.max(b.min, Math.min(b.max, w))) } : { rightW: Math.round(Math.max(b.min, Math.min(b.max, w))) })
  if (collapsed) return <span />
  return (
    <div className={cx('agx-grip', `is-${side}-region`)} role="separator" aria-orientation="vertical" aria-label={`Resize the ${side === 'left' ? 'runs' : 'inspector'} region`} aria-valuemin={b.min} aria-valuemax={b.max} aria-valuenow={cur} tabIndex={0}
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => { start.current = { x: e.clientX, w: cur }; e.currentTarget.setPointerCapture(e.pointerId) }}
      onPointerMove={(e) => { if (!start.current) return; const dx = e.clientX - start.current.x; set(side === 'left' ? start.current.w + dx : start.current.w - dx) }}
      onPointerUp={() => { start.current = null }}
      onDoubleClick={() => set(b.def)}
      onKeyDown={(e) => { if (e.key === 'ArrowLeft') set(cur + (side === 'left' ? -16 : 16)); if (e.key === 'ArrowRight') set(cur + (side === 'left' ? 16 : -16)) }} />
  )
}

/* ── LEFT: conversations · research jobs · scope · navigation ─────────── */

function LeftRail() {
  const ui = useAgentUi()
  const runs = useRuns()
  const ctx = useAgentContextSnapshot()
  const cap = useLiveCapability()
  const snaps = runs.map((r) => snapshotOf(r.runId)).filter((s): s is RunSnapshot => Boolean(s))
  const research = snaps.filter((s) => s.research)
  const conversations = snaps.filter((s) => s.run)
  const groups = [
    { id: 'waiting', label: 'Needs you', items: research.filter((s) => needsOperator(taskStatus(s).status)) },
    { id: 'active', label: 'Running', items: research.filter((s) => { const st = taskStatus(s).status; return isActiveStatus(st) && !needsOperator(st) }) },
    { id: 'done', label: 'History', items: research.filter((s) => !isActiveStatus(taskStatus(s).status)) },
  ]
  const active = useRunSnapshot(ui.activeRunId)
  const [fxOpen, setFxOpen] = useState(false)
  const pid = ctx.property?.id ?? null
  const canScan = Boolean(pid) && cap.status === 'available'
  return (
    <div className="agx-left">
      <ApprovalsList />
      <section className="agx-left__scope" aria-label="Scope">
        <h5>Scope</h5>
        {pid ? (
          <div className="agx-scopecard">
            <span className="agx-scopecard__k"><Icon name="home" size={11} />Linked {ctx.property?.sourceLabel ? `· ${ctx.property.sourceLabel}` : 'selection'}</span>
            <b>{ctx.property?.address ?? `Property ••${pid.replace(/[^a-z0-9]/gi, '').slice(-4)}`}</b>
            <LCButton size="sm" variant={canScan ? 'primary' : 'secondary'} icon="radar" block disabled={!canScan}
              onClick={() => openLivePreflight({ propertyIds: [pid], addresses: [ctx.property?.address ?? null], originApp: ctx.property?.sourceApp ?? ctx.app, originLabel: `${ctx.property?.sourceLabel ?? ctx.appLabel ?? 'Linked'} selection` })}>
              Quick Scan · live
            </LCButton>
            <small>{canScan ? '$0 · read-only · AI off · preflight first' : cap.status === 'unavailable' ? <>{cap.reason} <button type="button" className="agx-link" onClick={() => void refreshLiveCapability()}>Check again</button></> : 'Checking the live route…'}</small>
          </div>
        ) : <p className="agx-muted">Select a property in Entity Graph — it becomes the scope here.</p>}
        {ctx.selection && ctx.selection.count > 1 ? (
          <div className="agx-scopecard is-sel">
            <span className="agx-scopecard__k"><Icon name="layers" size={11} />Entity Graph selection</span>
            <b>{ctx.selection.count} properties selected</b>
            <LCButton size="sm" variant="secondary" icon="radar" block disabled={cap.status !== 'available'}
              onClick={() => openLivePreflight({ propertyIds: ctx.selection!.property_ids, addresses: ctx.selection!.property_ids.map(() => null), originApp: 'entity-graph', originLabel: 'Entity Graph selection' })}>Quick Scan selection · live</LCButton>
            <small>Preflight shows the exact batch the server accepts and how many it defers.</small>
          </div>
        ) : null}
      </section>

      {groups.map((g) => g.items.length ? (
        <section key={g.id} className="agx-left__grp" aria-label={g.label}>
          <h5>{g.label}<small>{g.items.length}</small></h5>
          {g.items.map((s) => <RunItem key={s.record.runId} s={s} active={ui.activeRunId === s.record.runId && !ui.preflight} />)}
        </section>
      ) : null)}
      {conversations.length ? (
        <section className="agx-left__grp" aria-label="Conversations">
          <h5>Conversations<small>{conversations.length}</small></h5>
          {conversations.map((s) => <RunItem key={s.record.runId} s={s} active={ui.activeRunId === s.record.runId} />)}
        </section>
      ) : null}
      {!snaps.length ? <p className="agx-empty">No runs yet. Runs keep going while you navigate and survive a reload.</p> : null}

      {active?.research && !ui.preflight ? <NavSection snap={active} /> : null}

      <section className="agx-left__grp" aria-label="Conversation intelligence">
        <h5>Conversation intelligence<small>shadow</small></h5>
        <LCButton size="sm" variant="quiet" icon="message" block onClick={() => setIntel({ open: true })}>Review inbound decisions</LCButton>
        <p className="agx-muted">Read-only. AI understanding + drafts on real inbound; nothing sends.</p>
      </section>

      {FIXTURES_AVAILABLE ? <section className={cx('agx-left__grp', 'agx-left__fx')} aria-label="Design fixtures">
        <button type="button" className="agx-left__fxh" onClick={() => setFxOpen((o) => !o)} aria-expanded={fxOpen}><h5>Design fixtures <span className="agx-sim">SIMULATED</span></h5><Icon name={fxOpen ? 'chevron-up' : 'chevron-down'} size={12} /></button>
        {fxOpen ? (
          <div className="agx-left__fxb">
            <div className="agx-left__btns">
              <LCButton size="sm" variant="quiet" icon="radar" onClick={() => startRun('single-deep', { open: 'workspace' })}>Deep replay</LCButton>
              <LCButton size="sm" variant="quiet" icon="shield" onClick={() => startRun('blocked-conflict', { open: 'workspace' })}>Blocked + conflict</LCButton>
              <LCButton size="sm" variant="quiet" icon="layers" onClick={() => startRun('batch-25', { open: 'workspace' })}>Batch of {fixtureBatchSize()}</LCButton>
            </div>
            <p className="agx-muted">Recorded event logs on synthetic properties — nothing is fetched, priced or reasoned. Always labelled SIMULATED.</p>
          </div>
        ) : null}
      </section> : null}
    </div>
  )
}

function NavSection({ snap }: { snap: RunSnapshot }) {
  const ui = useAgentUi()
  const views: Array<{ id: CenterTab; label: string }> = [{ id: 'activity', label: 'Activity' }, { id: 'sources', label: 'Sources' }, { id: 'brief', label: 'Brief' }]
  const jump = (k: string) => {
    setUi({ centerTab: 'brief' })
    requestAnimationFrame(() => document.getElementById(`agx-brief-${snap.record.runId}-${k}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }
  return (
    <section className="agx-left__grp agx-nav" aria-label="Navigate this run">
      <h5>Navigate</h5>
      <div className="agx-nav__views">{views.map((v) => <button key={v.id} type="button" className={cx('agx-nav__v', ui.centerTab === v.id && 'is-on')} onClick={() => setUi({ centerTab: v.id })}>{v.label}</button>)}</div>
      <ol className="agx-nav__brief">{OWNER_BRIEF_ORDER.map((s) => <li key={s.key}><button type="button" onClick={() => jump(s.key)}><span>{s.n}</span>{s.label}</button></li>)}</ol>
    </section>
  )
}

function RunItem({ s, active }: { s: RunSnapshot; active: boolean }) {
  const r = s.research
  const p = r ? progressOf(r) : null
  const { status, detail } = taskStatus(s)
  const running = status === 'running' && Boolean(r?.running_count)
  const kind = r ? (s.properties.length > 1 ? `Batch · ${s.properties.length}` : r.depth ? RESEARCH_DEPTH_LABELS[r.depth] : s.depth ? RESEARCH_DEPTH_LABELS[s.depth] : 'Research') : 'Conversation'
  return (
    <div className={cx('agx-runitem', active && 'is-active', running && 'is-live', `is-${s.mode}`, `is-st-${status}`)}>
      <button type="button" className="agx-runitem__btn" onClick={() => selectRun(s.record.runId)}>
        <span className="agx-runitem__k"><i className={cx('agx-runitem__mode', `is-${s.mode}`)} aria-hidden="true" />{kind}<span className="agx-runitem__st">{TASK_STATUS_LABEL[status]}</span></span>
        <b>{s.title}</b>
        <span className="agx-runitem__m">{running && detail ? <Shimmer active>{detail}</Shimmer> : <>{s.mode === 'live' ? 'Live' : 'Simulated'} · {fmtClock(new Date(s.record.createdAt).toISOString())}{r && r.depth !== 'quick' && s.mode === 'fixture' ? ` · ${fmtUsd(r.accrued_usd)}` : ''}</>}</span>
        {p && p.planned ? <ProgressBar fraction={p.fraction} label="Progress" /> : null}
      </button>
      <button type="button" className="agx-runitem__x" aria-label="Remove from history" onClick={() => removeRun(s.record.runId)}><Icon name="x" size={10} /></button>
    </div>
  )
}

/* ── CENTRE (conversation) ───────────────────────────────────────────── */

function ConversationCanvas({ snap }: { snap: RunSnapshot }) {
  const run = snap.run!
  const st = taskStatus(snap)
  return (
    <div className="agx-canvas is-conversation">
      <header className="agx-thead">
        <div className="agx-thead__eyebrow"><span className="agx-thead__tier">Conversation</span><ProvenanceBadge mode={snap.mode} compact /><span className="agx-thead__sp" /></div>
        <div className="agx-thead__title"><h2>{run.title}</h2><p>{TASK_STATUS_LABEL[st.status]} · {fmtUsd(run.accrued_usd)} of {fmtUsd(run.cap_usd)} cap · AI is off in S3 — this is a recorded turn</p></div>
      </header>
      <div className="agx-canvas__body"><div className="agx-col is-lead"><div className="agx-col__scroll"><RunStream snap={snap} wide /></div></div></div>
    </div>
  )
}

function EmptyCanvas() {
  const ctx = useAgentContextSnapshot()
  const cap = useLiveCapability()
  const pid = ctx.property?.id ?? null
  return (
    <div className="agx-canvas is-empty">
      <div className="agx-hello">
        <AgentOrb live={false} size={34} />
        <h2>Nothing running</h2>
        <p>{pid ? 'A property is linked. A Quick Scan reads its LeadCommand records — live, read-only, $0 — after a preflight.' : 'Select a property in Entity Graph to Quick Scan it, or open a design fixture (simulated) from the left rail.'}</p>
        <div className="agx-hello__acts">
          {pid ? <LCButton variant="primary" icon="radar" disabled={cap.status !== 'available'} onClick={() => openLivePreflight({ propertyIds: [pid], addresses: [ctx.property?.address ?? null], originApp: ctx.property?.sourceApp ?? ctx.app, originLabel: `${ctx.property?.sourceLabel ?? ctx.appLabel ?? 'Linked'} selection` })}>Quick Scan · live</LCButton> : null}
          {FIXTURES_AVAILABLE ? <LCButton variant="quiet" icon="layers" onClick={() => startRun('single-deep', { open: 'workspace' })}>Open a simulated replay</LCButton> : null}
        </div>
      </div>
    </div>
  )
}

/* ── RIGHT (conversation) ────────────────────────────────────────────── */

function RunInspector({ snap }: { snap: RunSnapshot }) {
  const run = snap.run!
  const approvals = run.items.filter((i) => i.kind === 'approval')
  const tools = run.items.filter((i) => i.kind === 'tool')
  return (
    <div className="agx-insp">
      <div className="agx-insp__tabs"><b className="agx-insp__t">Run</b><ProvenanceBadge mode={snap.mode} compact /></div>
      <div className="agx-insp__body">
        <section className="agx-panel"><h5>Context</h5>{run.items.filter((i) => i.kind === 'context').map((i) => <p key={i.key}>{i.kind === 'context' ? i.label : ''}</p>)}</section>
        <section className="agx-panel"><h5>Approvals</h5>{approvals.length ? approvals.map((a) => a.kind === 'approval' ? <p key={a.key}><b>{a.approval.title}</b> — {a.state}{a.approval.brake ? ' · braked' : ''}</p> : null) : <p className="agx-muted">None</p>}</section>
        <section className="agx-panel"><h5>Tool calls</h5>{tools.map((t) => t.kind === 'tool' ? <p key={t.key}>{t.tier} · {t.label} <span className="agx-muted">{t.state}</span></p> : null)}</section>
        <section className="agx-cost"><h5>Cost</h5><dl><div><dt>Cap</dt><dd>{fmtUsd(run.cap_usd)}</dd></div><div><dt>Actual</dt><dd><b>{fmtUsd(run.accrued_usd)}</b></dd></div></dl><p className="agx-muted">Fixture prices. Only decision summaries are shown — never reasoning.</p></section>
      </div>
    </div>
  )
}
