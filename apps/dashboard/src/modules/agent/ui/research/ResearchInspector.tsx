import { useMemo, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { LCTabs, cx } from '../../../../shared/lc'
import { EXTENDED_EVIDENCE_STATUS_META } from '../../contracts/contracts'
import { conflictsFor, type ConflictAnalysis } from '../../model/conflict-model'
import { EVIDENCE_CLASS_META, FRESHNESS_LABEL, contactReadinessOf, evidenceClassOf, findingTypeLabel, limitationsOf } from '../../model/evidence-class'
import { ContactReadinessCard } from './ContactReadiness'
import { findingsByPanel, type FindingView, type ResearchView } from '../../model/research-model'
import { setUi, useAgentUi, type InspectorTab, type RunSnapshot, type SubjectProperty } from '../../runtime/agent-store'
import { findingVerdict, fmtClock, fmtDay, fmtUsd, statusLabel, authorityLabel } from '../format'
import { ClassTag, Favicon, SimTag, VerdictTag } from '../primitives'

const PANELS: Array<{ id: string; label: string }> = [
  { id: 'ownership', label: 'Ownership' },
  { id: 'taxes_liens', label: 'Taxes & liens' },
  { id: 'financial_risk', label: 'Financial risk' },
  { id: 'distress', label: 'Distress timeline' },
  { id: 'listing', label: 'Listing' },
  { id: 'comps', label: 'Comps' },
  { id: 'buyers', label: 'Investor demand & market' },
  { id: 'contact', label: 'Outreach & eligibility' },
]

/**
 * CONTEXTUAL INSPECTOR (S3 P2 right region) — property context, evidence,
 * conflicts and cost. Every finding carries its evidence class (official ·
 * LeadCommand · vendor · derived · unavailable), its source, retrieval date,
 * freshness and what it can and cannot prove. Conflicts open the inspector
 * (P5) — a conclusion appears only when the server resolved the group.
 */
export function ResearchInspector({ snap, view, property }: { snap: RunSnapshot; view: ResearchView; property: SubjectProperty | null }) {
  const ui = useAgentUi()
  const pid = property?.property_id ?? null
  const conflicts = useMemo(() => conflictsFor(view, snap.sources, pid), [view, snap.sources, pid])
  const unresolved = conflicts.filter((c) => c.status === 'unresolved').length
  const items = [
    { id: 'property' as const, label: 'Property' },
    { id: 'evidence' as const, label: 'Evidence', count: unresolved || null, tone: unresolved ? 'attn' as const : undefined },
    { id: 'cost' as const, label: 'Cost' },
  ]
  return (
    <div className="agx-insp">
      <div className="agx-insp__tabs">
        <LCTabs<InspectorTab> label="Inspector" variant="line" value={ui.inspectorTab} onChange={(id) => setUi({ inspectorTab: id })} items={items} />
      </div>
      <div className="agx-insp__body">
        {ui.inspectorTab === 'property' ? <PropertyPanels snap={snap} view={view} property={property} conflicts={conflicts} /> : null}
        {ui.inspectorTab === 'evidence' ? <EvidencePanel snap={snap} view={view} conflicts={conflicts} /> : null}
        {ui.inspectorTab === 'cost' ? <CostPanel snap={snap} view={view} pid={pid} /> : null}
      </div>
    </div>
  )
}

function PropertyPanels({ snap, view, property, conflicts }: { snap: RunSnapshot; view: ResearchView; property: SubjectProperty | null; conflicts: ConflictAnalysis[] }) {
  const pid = property?.property_id ?? null
  const byPanel = useMemo(() => findingsByPanel(view, pid), [view, pid])
  const blockers = view.tasks.filter((t) => (!pid || t.property_id === pid) && ['blocked', 'unavailable', 'needs_input', 'failed'].includes(t.state))
  const key = view.findingOrder.map((id) => view.findings[id]).filter((f) => (!pid || f.property_id === pid) && !['unavailable', 'blocked'].includes(f.evidence_status) && !f.contradicted_by)
  const minConf = key.length ? Math.min(...key.map((f) => f.confidence)) : null
  const unresolved = conflicts.filter((c) => c.status === 'unresolved')
  const cr = useMemo(() => contactReadinessOf(view.findings, view.findingOrder, pid), [view.findings, view.findingOrder, pid])
  if (!property) return <p className="agx-empty">Choose a property in the batch to inspect it. The batch keeps running.</p>
  const anyFindings = PANELS.some((p) => (byPanel[p.id] ?? []).length)
  return (
    <>
      <section className="agx-ident">
        <div className="agx-ident__addr"><b>{property.address}</b>{property.synthetic ? <span className="agx-synth">Synthetic</span> : <span className="agx-real">LeadCommand record</span>}</div>
        {property.city || property.jurisdiction ? <p>{[property.city, property.jurisdiction].filter(Boolean).join(' · ')}</p> : null}
        {property.asset ? <p className="agx-ident__spec">{[property.asset, property.beds_baths, property.sqft ? `${property.sqft.toLocaleString()} sqft` : null, property.year_built ? `built ${property.year_built}` : null].filter(Boolean).join(' · ')}</p> : null}
        {property.owner_display ? <p className="agx-ident__spec">Owner of record: {property.owner_display}{property.synthetic ? ' (synthetic)' : ''}</p> : null}
        {!property.synthetic ? <p className="agx-ident__spec">Property id <code>{property.property_id}</code></p> : null}
        <div className="agx-ident__stats">
          <span><b>{key.length}</b> standing finding{key.length === 1 ? '' : 's'}</span>
          {minConf !== null ? <span>lowest confidence <b>{minConf.toFixed(2)}</b></span> : null}
          {unresolved.length ? <button type="button" className="agx-ident__conf" onClick={() => setUi({ inspectorTab: 'evidence' })}>{unresolved.length} unresolved conflict{unresolved.length === 1 ? '' : 's'}</button> : null}
        </div>
      </section>
      {cr ? <ContactReadinessCard cr={cr} /> : null}
      {blockers.length ? (
        <section className="agx-panel is-blockers" aria-label="Blockers">
          <h5>Blockers & open questions</h5>
          {blockers.map((t) => <p key={t.task_id} className={`agx-blocker is-${t.state}`}><b>{t.state === 'needs_input' ? 'Needs your input' : t.state === 'blocked' ? 'Blocked' : t.state === 'failed' ? 'Failed' : 'Unavailable'}</b> {t.label}{t.alternatives.length ? <small> · continuing via {t.alternatives.join(' · ')}</small> : null}</p>)}
        </section>
      ) : null}
      {PANELS.map((p) => {
        const fs = byPanel[p.id] ?? []
        if (!fs.length && anyFindings) return null
        return (
          <section key={p.id} className={cx('agx-panel', !fs.length && 'is-empty')} aria-label={p.label}>
            <h5>{p.label}{fs.length ? <small>{fs.length}</small> : null}</h5>
            {fs.length ? fs.map((f) => <FindingCard key={f.finding_id} f={f} view={view} snap={snap} />) : <p className="agx-muted">Nothing reported yet</p>}
          </section>
        )
      })}
      {anyFindings ? <p className="agx-muted agx-insp__note">Panels with nothing reported are hidden. Nothing reported is not the same as nothing found.</p> : null}
      <section className="agx-panel" aria-label="Acquisition economics">
        <h5>Acquisition economics</h5>
        <p className="agx-muted">{view.depth === 'diligence' ? 'Lane-labelled estimate at synthesis — never an authorized offer.' : view.depth === 'quick' ? 'Not computed by a Quick Scan (read-only, $0).' : 'An Acquisition Diligence output — not computed in this pass.'}</p>
      </section>
    </>
  )
}

function FindingCard({ f, view, snap }: { f: FindingView; view: ResearchView; snap: RunSnapshot }) {
  const src = f.source_id ? snap.sources[f.source_id] ?? null : null
  const cls = evidenceClassOf(f, src)
  const verdict = findingVerdict(f)
  const by = f.contradicted_by ? view.findings[f.contradicted_by] : null
  const arrival = f.arrived_event_id > snap.arrivalFloor
  const downgradeLive = Boolean(f.contradicted_by) && f.updated_event_id > snap.arrivalFloor
  const ui = useAgentUi()
  return (
    <div className={cx('agx-find', `is-c-${cls}`, `is-${verdict}`, f.is_discovery && 'is-discovery', arrival && 'is-arrival', f.contradicted_by && 'is-contradicted', downgradeLive && 'is-downgrading', ui.selectedFindingId === f.finding_id && 'is-selected')} key={`${f.finding_id}:${f.contradicted_by ? 'x' : 'o'}`}>
      <button type="button" className="agx-find__btn" onClick={() => setUi({ selectedFindingId: f.finding_id, selectedSourceKey: null, inspectorTab: 'evidence' })}>
        <span className="agx-find__top"><ClassTag cls={cls} compact /><VerdictTag verdict={verdict} compact /></span>
        <span className="agx-find__val">
          <span className="agx-find__claim">{f.display_value ?? (f.evidence_status === 'blocked' ? 'Blocked — no value read' : 'Unavailable — no value')}</span>
          {f.is_inference ? <em> (inference)</em> : null}
        </span>
        <span className="agx-find__prov">
          {src || f.source_name ? <span className="agx-find__src">{src?.name ?? f.source_name}</span> : <span className="agx-find__src is-none">Source not reported</span>}
          {f.retrieved_at ? <span>retrieved {fmtDay(f.retrieved_at)}</span> : f.observed_at ? <span>observed {fmtDay(f.observed_at)}</span> : null}
          <span className={`is-${f.freshness_state}`}>{FRESHNESS_LABEL[f.freshness_state]}{f.fresh_until && f.freshness_state !== 'stale' ? ` until ${fmtDay(f.fresh_until)}` : ''}</span>
          {f.confidence > 0 ? <span>conf {f.confidence.toFixed(2)}</span> : null}
        </span>
        {by ? <span className="agx-find__by">Contradicted by {by.display_value ?? 'a stronger source'}{by.retrieved_at ? ` · ${fmtDay(by.retrieved_at)}` : ''}</span> : null}
      </button>
    </div>
  )
}

function EvidencePanel({ snap, view, conflicts }: { snap: RunSnapshot; view: ResearchView; conflicts: ConflictAnalysis[] }) {
  const ui = useAgentUi()
  const op = ui.selectedSourceKey ? view.sources.find((s) => s.key === ui.selectedSourceKey) ?? null : null
  const taskId = op?.task_id ?? (ui.selectedSourceKey ? ui.selectedSourceKey.replace(/:[^:]*$/, '') : null)
  const task = taskId ? view.tasks[view.taskIndex[taskId]] ?? view.tasks[view.taskIndex[ui.selectedSourceKey ?? '']] ?? null : null
  const finding = ui.selectedFindingId ? view.findings[ui.selectedFindingId] ?? null : null
  const sourceId = op?.source_id ?? task?.source_id ?? finding?.source_id ?? null
  const src = sourceId ? snap.sources[sourceId] ?? null : null
  const related = task ? task.finding_ids.map((id) => view.findings[id]).filter(Boolean) : finding ? [finding] : []
  return (
    <>
      {conflicts.length ? (
        <section className="agx-conflicts" aria-label="Conflict inspector">
          <h5>Conflict inspector <small>{conflicts.length}</small></h5>
          {conflicts.map((c) => <ConflictInspector key={c.id} c={c} mode={snap.mode} />)}
        </section>
      ) : null}
      {src || task ? (
        <section className="agx-drawer" aria-label="Evidence">
          <header>
            <Favicon source={src} size={28} />
            <div><b>{src?.name ?? task?.tool ?? 'Read'}<SimTag mode={snap.mode} /></b><small>{src ? `${authorityLabel(src)}${src.access_mode ? ` · ${src.access_mode.replace(/_/g, ' ')}` : ''}${src.jurisdiction ? ` · ${src.jurisdiction}` : ''}` : 'T0 read tool'}</small></div>
          </header>
          <dl>
            {src?.host ? <div><dt>Host</dt><dd>{src.host}{src.test_data ? <small> (fixture — not resolvable)</small> : null}</dd></div> : null}
            <div><dt>Negative claims</dt><dd>{src?.supports_negative ? 'Supported — registered as complete for this type' : '“None found” can’t be claimed from it'}</dd></div>
            {op ? <div><dt>Status</dt><dd>{op.status}{op.bytes ? ` · ${Math.round(op.bytes / 1024).toLocaleString()} KB` : ''}{op.retrieved_at && op.status === 'retrieved' ? ` · retrieved ${fmtDay(op.retrieved_at)}` : ''}</dd></div> : null}
            {task?.started_at ? <div><dt>Recorded</dt><dd>{fmtClock(task.started_at)}{task.ended_at ? ` → ${fmtClock(task.ended_at)}` : ''}{task.rows !== null ? ` · ${task.rows} rows` : ''}</dd></div> : null}
            {task?.result_summary ? <div><dt>Result</dt><dd>{task.result_summary}</dd></div> : null}
          </dl>
          {task?.steps.length ? <ol className="agx-steps">{task.steps.map((s) => <li key={s.event_id} className={`is-${s.status}`}><span>{s.status}</span><time>{fmtClock(s.at)}</time>{s.detail ? <em>{s.detail}</em> : null}</li>)}</ol> : null}
          {task?.observations.length ? (
            <div className="agx-cite">
              <h6>Extracted observations</h6>
              {task.observations.map((o, i) => <blockquote key={i}><p>{o.display_value}</p>{o.citation ? <cite>{o.citation}</cite> : null}</blockquote>)}
            </div>
          ) : null}
          <div className="agx-drawer__links">
            {snap.mode === 'fixture' ? <span className="agx-muted">Fixture source — there is no original page to open. No screenshot.</span> : <span className="agx-muted">Internal record — opens in its LeadCommand app. Screenshots only where the source registry permits.</span>}
          </div>
        </section>
      ) : !conflicts.length ? <p className="agx-empty">Select an operation, a source or a finding to see its evidence, provenance and limits.</p> : null}
      {related.map((f) => <EvidenceDetail key={f.finding_id} f={f} view={view} snap={snap} />)}
    </>
  )
}

function EvidenceDetail({ f, view, snap }: { f: FindingView; view: ResearchView; snap: RunSnapshot }) {
  const src = f.source_id ? snap.sources[f.source_id] ?? null : null
  const cls = evidenceClassOf(f, src)
  const m = EVIDENCE_CLASS_META[cls]
  return (
    <section className={cx('agx-ev', `is-c-${cls}`)} aria-label="Finding provenance">
      <header><ClassTag cls={cls} /><VerdictTag verdict={findingVerdict(f)} compact /></header>
      <p className="agx-ev__val"><b>{f.display_value ?? '— no value —'}</b>{f.is_inference ? <em> (inference)</em> : null}</p>
      <dl className="agx-ev__prov">
        <div><dt>Finding</dt><dd>{findingTypeLabel(f.finding_type)}</dd></div>
        <div><dt>Evidence</dt><dd>{f.evidence_label ?? statusLabel(f.evidence_status)} — {EXTENDED_EVIDENCE_STATUS_META[f.evidence_status]?.description ?? ''}</dd></div>
        {f.provenance ?? src?.provenance ? <div><dt>Provenance</dt><dd>{f.provenance ?? src?.provenance}</dd></div> : null}
        <div><dt>Source</dt><dd>{src ? `${src.name} · ${authorityLabel(src)}` : f.source_name ?? 'Not reported'}</dd></div>
        <div><dt>Retrieved</dt><dd>{f.retrieved_at ? fmtDay(f.retrieved_at) : '—'}{f.observed_at ? ` · observed ${fmtDay(f.observed_at)}` : ''}</dd></div>
        <div><dt>Freshness</dt><dd className={`is-${f.freshness_state}`}>{FRESHNESS_LABEL[f.freshness_state]}{f.fresh_until ? ` · fresh until ${fmtDay(f.fresh_until)}` : ''}</dd></div>
        <div><dt>Confidence</dt><dd>{f.confidence.toFixed(2)} · {f.confidence_band}{f.is_inference ? ' · capped at 0.60 (inference)' : ''}</dd></div>
        {f.citation ? <div><dt>Citation</dt><dd><cite>{f.citation}</cite></dd></div> : null}
      </dl>
      <div className="agx-ev__proves"><b>What it proves</b><p>{m.proves}</p></div>
      <div className="agx-ev__limits"><b>Limitations</b><ul>{limitationsOf(f, src).map((l) => <li key={l}>{l}</li>)}</ul></div>
      {f.history.length > 1 ? (
        <ol className="agx-hist" aria-label="Status history">
          {f.history.map((h, i) => <li key={h.event_id}>{i === 0 ? 'Arrived' : h.contradicted_by ? 'Downgraded' : 'Updated'} · {statusLabel(h.evidence_status)} · conf {h.confidence.toFixed(2)}{h.contradicted_by ? ` · contradicted by ${view.findings[h.contradicted_by]?.display_value ?? h.contradicted_by}` : ''}</li>)}
        </ol>
      ) : null}
    </section>
  )
}

/** P5 — competing claims, support, conclusion only when decisive, else Unresolved + reason + follow-up. */
export function ConflictInspector({ c, mode, compact }: { c: ConflictAnalysis; mode: RunSnapshot['mode']; compact?: boolean }) {
  const [open, setOpen] = useState(!compact)
  return (
    <article className={cx('agx-cfx', `is-${c.status}`)} aria-label={`Conflict: ${c.label}`}>
      <header className="agx-cfx__head">
        <span className={cx('agx-cfx__state', `is-${c.status}`)}>{c.status === 'unresolved' ? 'Unresolved' : c.status === 'agree' ? 'Sources agree' : 'Resolved by rule'}</span>
        <b>{c.label}</b>
        {compact ? <button type="button" className="agx-link" onClick={() => setOpen((o) => !o)}>{open ? 'Less' : 'Inspect'}</button> : null}
      </header>
      <div className="agx-cfx__claims">
        {c.claims.map((cl) => (
          <div key={cl.finding_id} className={cx('agx-cfx__claim', `is-${cl.role}`, `is-c-${cl.cls}`)}>
            <span className="agx-cfx__role">{cl.role === 'preferred' ? 'Best supported' : cl.role === 'overruled' ? 'Overruled' : cl.role === 'agreeing' ? 'Agrees' : 'Competing claim'}</span>
            <span className="agx-cfx__val">{cl.text}</span>{cl.finding?.display_value && cl.finding.display_value !== cl.text ? <span className="agx-cfx__fv">{cl.finding.display_value}</span> : null}
            <span className="agx-cfx__src"><Favicon source={cl.source} size={14} />{cl.source?.name ?? 'Source not reported'}<SimTag mode={mode} /></span>
            {open ? <ul className="agx-cfx__sup">{cl.support.map((s) => <li key={s}>{s}</li>)}</ul> : <ClassTag cls={cl.cls} compact />}
          </div>
        ))}
      </div>
      {open ? (
        <div className="agx-cfx__body">
          {c.conclusion ? (
            <div className="agx-cfx__concl"><Icon name="check" size={12} /><div><b>Conclusion: {c.conclusion.text}</b><p>Why preferred: {c.conclusion.reason}</p></div></div>
          ) : c.status === 'unresolved' ? (
            <div className="agx-cfx__concl is-open"><Icon name="alert-circle" size={12} /><div><b>No conclusion — unresolved</b><p>{c.unresolved_reason}</p></div></div>
          ) : null}
          {c.status !== 'agree' ? <div className="agx-cfx__sec"><b>Remaining uncertainty</b><ul>{c.uncertainty.map((u) => <li key={u}>{u}</li>)}</ul></div> : null}
          {c.follow_up.length ? <div className="agx-cfx__sec"><b>Required follow-up</b><ul>{c.follow_up.map((u) => <li key={u}>{u}</li>)}</ul></div> : null}
          <p className="agx-muted">Nothing is promoted to a canonical record while a conflict is open. Overruled claims are kept, marked — never deleted.</p>
        </div>
      ) : null}
    </article>
  )
}

function CostPanel({ snap, view, pid }: { snap: RunSnapshot; view: ResearchView; pid: string | null }) {
  const tasks = view.tasks.filter((t) => (!pid || t.property_id === pid) && (t.billable || t.cost_usd > 0))
  const est = view.estimate
  const quick = (view.depth ?? snap.depth) === 'quick'
  return (
    <section className="agx-cost" aria-label="Cost">
      {quick ? (
        <div className="agx-cost__zero"><b>$0.00</b><p>Quick Scan is $0 structurally: no billable operation can be planned, and the server refuses one. Reads of LeadCommand records cost nothing.</p></div>
      ) : <p className="agx-muted">{snap.mode === 'fixture' ? 'Fixture prices. ' : ''}Estimate, reserved and actual are separate numbers and never collapse into one.</p>}
      <dl>
        <div><dt>Estimate</dt><dd>{quick ? '$0 (structural)' : est ? `${fmtUsd(est.low_usd)}–${fmtUsd(est.high_usd)}` : '—'} {!quick ? <small>{est?.basis === 'worst_case' ? 'worst case — no measured history' : 'measured p50–p90'}</small> : null}</dd></div>
        <div><dt>Hard cap</dt><dd>{quick ? '$0.00' : fmtUsd(view.cap_usd)}</dd></div>
        <div><dt>Reserved</dt><dd>{fmtUsd(view.reserved_usd)} <small>worst case, before each call</small></dd></div>
        <div><dt>Actual (settled)</dt><dd><b>{fmtUsd(view.accrued_usd)}</b></dd></div>
        <div><dt>Remaining</dt><dd>{quick ? '—' : fmtUsd(view.remaining_usd)}</dd></div>
      </dl>
      <h6>Billable operations</h6>
      {tasks.length ? <ul className="agx-cost__ops">{tasks.map((t) => <li key={t.task_id}><span>{t.label}</span><b>{t.state === 'running' ? 'reserved' : fmtUsd(t.cost_usd)}</b></li>)}</ul> : <p className="agx-muted">None — LeadCommand reads and official open-data lookups are $0.</p>}
    </section>
  )
}
