import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { cx } from '../../../../shared/lc'
import { RESEARCH_DEPTH_LABELS } from '../../contracts/contracts'
import { contactReadinessOf, evidenceClassOf } from '../../model/evidence-class'
import { ContactReadinessMark } from './ContactReadiness'
import { batchCounters, isTerminal, progressOf, type FindingView, type ResearchView } from '../../model/research-model'
import { setUi, useAgentUi, type RunSnapshot } from '../../runtime/agent-store'
import { OPPORTUNITY_LABEL, fmtUsd } from '../format'
import { ClassTag, ProgressBar, Shimmer } from '../primitives'

const STATE_LABEL: Record<string, string> = { queued: 'Queued', running: 'Researching', completed: 'Complete', completed_partial: 'Partial', budget_stopped: 'Stopped · budget', cancelled: 'Cancelled', failed: 'Failed', skipped_fresh: 'Fresh · skipped' }

type Lens = 'all' | 'discoveries' | 'blockers' | 'active' | 'done'

/**
 * BATCH TRIAGE (S3 P7) — one dense row per property: status, the findings
 * that matter (discoveries first, then verified), blockers, depth and the
 * ACTUAL settled cost. Lenses narrow the list; ↑/↓ (or j/k) move, Enter
 * opens. Opening a property never stops the batch, and coming back restores
 * the lens, the selection and the scroll position. No percentages are
 * computed that the events don't support.
 */
export function BatchBoard({ snap, view, arrivalFloor, compact }: { snap: RunSnapshot; view: ResearchView; arrivalFloor: number; compact?: boolean }) {
  const ui = useAgentUi()
  const c = batchCounters(view)
  const [lens, setLens] = useState<Lens>('all')
  const byId = useMemo(() => Object.fromEntries(snap.properties.map((p) => [p.property_id, p])), [snap.properties])
  const now = view.current?.property_id ? byId[view.current.property_id] : null
  const terminal = isTerminal(view)
  const tableRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const findingsBy = new Map<string, FindingView[]>()
    for (const fid of view.findingOrder) { const f = view.findings[fid]; if (!findingsBy.has(f.property_id)) findingsBy.set(f.property_id, []); findingsBy.get(f.property_id)!.push(f) }
    const ids = view.propertyOrder.length ? view.propertyOrder : snap.properties.map((p) => p.property_id)
    return ids.map((id) => {
      const pv = view.properties[id]
      const fs = findingsBy.get(id) ?? []
      const meaningful = fs.filter((f) => !f.contradicted_by && f.evidence_status !== 'unavailable' && f.evidence_status !== 'blocked')
        .sort((a, b) => Number(b.is_discovery) - Number(a.is_discovery) || b.confidence - a.confidence)
      const tasks = view.tasks.filter((t) => t.property_id === id)
      const blockers = tasks.filter((t) => ['blocked', 'unavailable', 'failed', 'needs_input'].includes(t.state))
      const cost = tasks.reduce((s, t) => s + (t.cost_usd || 0), 0)
      const running = tasks.some((t) => t.state === 'running')
      const p = progressOf(view, id)
      return { id, pv, p, cr: contactReadinessOf(view.findings, view.findingOrder, id), top: meaningful.slice(0, 2), more: Math.max(0, meaningful.length - 2), discovery: meaningful.some((f) => f.is_discovery), blockers, cost, running, state: pv?.state ?? 'queued' }
    })
  }, [view, snap])

  const visible = rows.filter((r) => lens === 'all' ? true : lens === 'discoveries' ? r.discovery : lens === 'blockers' ? r.blockers.length > 0 : lens === 'active' ? r.state === 'running' || r.state === 'queued' : !['running', 'queued'].includes(r.state))
  const counts = { all: rows.length, discoveries: rows.filter((r) => r.discovery).length, blockers: rows.filter((r) => r.blockers.length).length, active: rows.filter((r) => r.state === 'running' || r.state === 'queued').length, done: rows.filter((r) => !['running', 'queued'].includes(r.state)).length }

  const open = (id: string | null) => setUi({ focusPropertyId: id, selectedSourceKey: null, selectedFindingId: null, inspectorTab: 'property' })
  const onKey = (e: ReactKeyboardEvent) => {
    const i = visible.findIndex((r) => r.id === ui.focusPropertyId)
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); const n = visible[Math.min(visible.length - 1, i + 1)]; if (n) { open(n.id); focusRow(n.id) } }
    if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); const n = visible[Math.max(0, i - 1)]; if (n) { open(n.id); focusRow(n.id) } }
    if (e.key === 'Escape' && ui.focusPropertyId) { e.stopPropagation(); open(null) }
  }
  const focusRow = (id: string) => requestAnimationFrame(() => tableRef.current?.querySelector<HTMLElement>(`[data-pid="${CSS.escape(id)}"]`)?.focus({ preventScroll: false }))
  const depth = view.depth ? RESEARCH_DEPTH_LABELS[view.depth] : '—'

  return (
    <section className={cx('agx-batch', compact && 'is-compact')} aria-label="Batch triage">
      <div className="agx-batch__metrics">
        <Metric label="Properties" value={`${c.completed}/${c.total}`} sub={`${c.running} running · ${c.queued} queued${c.skipped ? ` · ${c.skipped} fresh` : ''}`} />
        <Metric label="Source ops" value={String(c.ops_ok)} sub={`${c.ops_blocked} blocked · ${c.ops_failed} failed`} tone={c.ops_blocked ? 'attn' : undefined} />
        <Metric label="Discoveries" value={String(c.discoveries)} sub="classification-changing findings" tone={c.discoveries ? 'gold' : undefined} />
        <Metric label="Actual cost" value={view.depth === 'quick' ? '$0' : fmtUsd(view.accrued_usd)} sub={view.depth === 'quick' ? 'structural' : `${fmtUsd(view.remaining_usd)} left of ${fmtUsd(view.cap_usd)}`} />
      </div>
      <ProgressBar fraction={c.total ? c.completed / c.total : 0} label="Properties complete" segments={[
        { value: c.completed - c.partial, tone: 'ok' }, { value: c.partial, tone: 'blocked' }, { value: c.cancelled, tone: 'failed' }, { value: c.running, tone: 'running' }, { value: c.queued, tone: 'rest' },
      ]} />
      <p className="agx-batch__now">
        {terminal ? (view.summary ?? 'Batch complete') : now ? <>Investigating <b>{now.address}</b> <span className="agx-muted">{now.synthetic ? '(synthetic) · ' : ''}{now.jurisdiction ?? ''}</span> — <Shimmer active>{view.current?.label}</Shimmer></> : 'Waiting for the next property'}
      </p>
      <div className="agx-batch__lens" role="toolbar" aria-label="Triage lens">
        {(['all', 'discoveries', 'blockers', 'active', 'done'] as Lens[]).map((l) => (
          <button key={l} type="button" className={cx('agx-tl__lg', lens === l && 'is-on', `is-l-${l}`)} aria-pressed={lens === l} disabled={l !== 'all' && !counts[l]} onClick={() => setLens(l)}>
            {l === 'all' ? 'All' : l === 'discoveries' ? 'With discoveries' : l === 'blockers' ? 'With blockers' : l === 'active' ? 'In progress' : 'Done'}<small>{counts[l]}</small>
          </button>
        ))}
      </div>
      <div className={cx('agx-btable', compact && 'is-compact')} role="grid" aria-label="Properties in this batch" ref={tableRef} onKeyDown={onKey}>
        <div className="agx-btable__tr is-head" role="row">
          <span role="columnheader">Property</span><span role="columnheader">Status</span><span role="columnheader">Findings</span>
          {!compact ? <><span role="columnheader" className="agx-btable__blk">Blockers</span><span role="columnheader" className="agx-btable__cr">Contact</span><span role="columnheader" className="agx-btable__depth">Depth</span><span role="columnheader" className="agx-btable__cost is-num">Cost</span></> : <span role="columnheader">Blk</span>}
          <span role="columnheader">Opportunity</span>
        </div>
        {visible.map((r, i) => {
          const p = byId[r.id]
          const sel = ui.focusPropertyId === r.id
          return (
            <div key={r.id} role="row" tabIndex={sel || (!ui.focusPropertyId && i === 0) ? 0 : -1} data-pid={r.id} aria-selected={sel}
              className={cx('agx-btable__tr', `is-${r.state}`, sel && 'is-selected', r.discovery && 'is-discovery', r.pv && r.pv.last_event_id > arrivalFloor && r.state !== 'queued' && 'is-arrival')}
              onClick={() => open(sel ? null : r.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(sel ? null : r.id) } }}>
              <span role="gridcell" className="agx-btable__addr"><b>{p?.address ?? r.pv?.display_address ?? r.id}</b><small>{p?.jurisdiction ?? ''}{r.p.planned ? `${p?.jurisdiction ? ' · ' : ''}${r.p.done}/${r.p.planned} ops` : ''}</small></span>
              <span role="gridcell" className="agx-btable__state"><i />{r.running ? <Shimmer active>{STATE_LABEL[r.state]}</Shimmer> : STATE_LABEL[r.state] ?? r.state}</span>
              <span role="gridcell" className="agx-btable__finds">
                {r.top.length ? r.top.map((f) => {
                  const cls = evidenceClassOf(f, f.source_id ? snap.sources[f.source_id] ?? null : null)
                  return <span key={f.finding_id} className={cx('agx-bf', f.is_discovery && 'is-discovery', `is-c-${cls}`)} title={`${f.display_value ?? ''} — ${f.citation ?? ''}`}><ClassTag cls={cls} compact /><em>{f.display_value}</em></span>
                }) : <span className="agx-muted">{r.state === 'queued' ? '—' : 'None yet'}</span>}
                {r.more ? <small>+{r.more}</small> : null}
              </span>
              {!compact ? (
                <>
                  <span role="gridcell" className={cx('agx-btable__blk', r.blockers.length && 'is-on')}>{r.blockers.length ? summarizeBlockers(r.blockers.map((t) => t.state)) : <span className="agx-muted">—</span>}</span>
                  <span role="gridcell" className="agx-btable__cr"><ContactReadinessMark cr={r.cr} /></span>
                  <span role="gridcell" className="agx-btable__depth" title={depth}>{view.depth === 'quick' ? 'Quick' : view.depth === 'deep' ? 'Deep' : view.depth === 'diligence' ? 'Diligence' : depth}</span>
                  <span role="gridcell" className="agx-btable__cost is-num">{view.depth === 'quick' ? '$0' : r.state === 'queued' ? '—' : fmtUsd(r.cost)}</span>
                </>
              ) : <span role="gridcell" className={cx('agx-btable__blk', r.blockers.length && 'is-on')}>{r.blockers.length || '—'}</span>}
              <span role="gridcell">{r.pv?.opportunity_class && r.pv.opportunity_class !== 'unknown' ? <span className={cx('agx-opp', `is-${r.pv.opportunity_class}`)}>{OPPORTUNITY_LABEL[r.pv.opportunity_class]}</span> : r.pv?.opportunity_class === 'unknown' ? <span className="agx-opp is-unknown" title={OPPORTUNITY_LABEL.unknown}>Unknown</span> : <span className="agx-muted">—</span>}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function summarizeBlockers(states: string[]): string {
  const n = (s: string) => states.filter((x) => x === s).length
  return [n('needs_input') ? `${n('needs_input')} input` : null, n('blocked') ? `${n('blocked')} blocked` : null, n('unavailable') + n('failed') ? `${n('unavailable') + n('failed')} n/a` : null].filter(Boolean).join(' · ')
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'attn' | 'gold' }) {
  return (
    <div className={cx('agx-metric', tone && `is-${tone}`)}>
      <span>{label}</span>
      <b>{value}</b>
      <small>{sub}</small>
    </div>
  )
}
