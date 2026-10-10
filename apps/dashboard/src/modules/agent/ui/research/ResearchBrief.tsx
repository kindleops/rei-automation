import { useMemo, useState, type ReactNode } from 'react'
import { LCButton, LCTooltip, cx } from '../../../../shared/lc'
import { RESEARCH_DEPTH_LABELS, type BriefClaim } from '../../contracts/contracts'
import { composeOwnerBrief, OWNER_BRIEF_ORDER, type OwnerSectionKey } from '../../model/brief-model'
import { EVIDENCE_CLASSES, EVIDENCE_CLASS_META, FRESHNESS_LABEL, contactReadinessOf } from '../../model/evidence-class'
import { ContactReadinessCard } from './ContactReadiness'
import { batchCounters, isTerminal, type PropertyView, type ResearchView } from '../../model/research-model'
import { openLivePreflight, setUi, startRun, type RunSnapshot } from '../../runtime/agent-store'
import { OPPORTUNITY_LABEL, READINESS_LABEL, claimVerdict, fmtDate, fmtDay, fmtDur, fmtUsd, reasonLabel } from '../format'
import { ClassTag, ProvenanceBadge, VerdictTag } from '../primitives'
import { ConflictInspector } from './ResearchInspector'

/**
 * RESEARCH BRIEF (S3 P6) — the owner's order:
 *   1 Acquisition recommendation · 2 Supporting findings · 3 Confidence +
 *   verification gaps · 4 Economics + assumptions · 5 Evidence + citations ·
 *   6 Conflicts + unavailable information · 7 Next recommended actions.
 * Sections fill as brief.section events arrive. Every claim keeps its source,
 * evidence status, confidence and freshness. Nothing here is the UI's own
 * opinion: the recommendation is the run's classification; when the run did
 * not classify, section 1 says so. Actions are handoffs — none send, write or
 * spend.
 */
export function ResearchBrief({ snap, view, property, onSection }: { snap: RunSnapshot; view: ResearchView; property: PropertyView | null; onSection?: (key: OwnerSectionKey) => void }) {
  const terminal = isTerminal(view)
  const b = useMemo(() => composeOwnerBrief(view, property, snap.sources, terminal), [view, property, snap.sources, terminal])
  const ops = view.sources.filter((s) => !property || s.property_id === property.property_id)
  const retrieved = ops.filter((s) => s.status === 'retrieved').length + view.tasks.filter((t) => (!property || t.property_id === property.property_id) && t.task_id.startsWith('tool:') && t.state === 'succeeded').length
  const dur = view.confirmed_at && (view.ended_at ?? view.last_at) ? Date.parse(view.ended_at ?? view.last_at!) - Date.parse(view.confirmed_at) : null
  const status = view.state === 'cancelled' ? 'Cancelled · partial' : view.state === 'completed_partial' ? 'Complete · partial' : view.state === 'failed' ? 'Failed · partial' : terminal ? 'Complete' : b.status === 'writing' ? 'Writing' : 'Researching'
  const subject = property ? snap.properties.find((p) => p.property_id === property.property_id) : snap.properties[0]
  const title = subject?.address ?? property?.display_address ?? snap.title
  const [handoff, setHandoff] = useState(false)
  const cr = useMemo(() => contactReadinessOf(view.findings, view.findingOrder, property?.property_id ?? null), [view.findings, view.findingOrder, property?.property_id])


  return (
    <article className={cx('agx-brief', terminal && 'is-final', `is-${snap.mode}`)} aria-label="Research brief">
      <header className="agx-brief__head">
        <div className="agx-brief__title">
          <span className="agx-eyebrow">{view.depth ? RESEARCH_DEPTH_LABELS[view.depth] : 'Research'} brief</span>
          <h3>{title}</h3>
          <ProvenanceBadge mode={snap.mode} compact />
        </div>
        <dl className="agx-brief__facts">
          <div><dt>Status</dt><dd>{status}</dd></div>
          <div><dt>Date · duration</dt><dd>{fmtDate(view.confirmed_at ?? view.created_at)}{dur ? ` · ${fmtDur(dur)}` : ''}</dd></div>
          <div><dt>Reads</dt><dd>{retrieved} returned{b.unavailable.length ? ` · ${b.unavailable.length} failed` : ''} · {b.confidence.unavailable} finding{b.confidence.unavailable === 1 ? '' : 's'} without a value</dd></div>
          <div><dt>Cost</dt><dd>{view.depth === 'quick' ? '$0 · structural' : <>{fmtUsd(view.accrued_usd)} <small>settled</small></>}</dd></div>
        </dl>
      </header>

      <OwnerSection runId={snap.record.runId} onSection={onSection} k="recommendation" empty={!b.recommendation.opportunity}>
        {b.recommendation.opportunity || b.recommendation.readiness ? (
          <div className="agx-rec">
            <div className="agx-rec__cls">
              <span className="agx-rec__k">Opportunity</span>
              {b.recommendation.opportunity ? <span className={cx('agx-opp', `is-${b.recommendation.opportunity}`)}>{OPPORTUNITY_LABEL[b.recommendation.opportunity]}</span> : <span className="agx-muted">Not classified</span>}
            </div>
            <div className="agx-rec__cls">
              <span className="agx-rec__k">Campaign eligibility</span>
              {b.recommendation.readiness ? <span className={cx('agx-ready', `is-${b.recommendation.readiness}`)}><i />{READINESS_LABEL[b.recommendation.readiness]}</span> : <span className="agx-muted">Not classified</span>}
            </div>
            {b.recommendation.summary ? <p className="agx-rec__sum">{b.recommendation.summary}</p> : null}
            {b.recommendation.discoveries.length ? <div className="agx-rec__keys">{b.recommendation.discoveries.map((f) => <span key={f.finding_id} className="agx-key is-discovery">{f.display_value}</span>)}</div> : null}
            <p className="agx-muted">Opportunity and campaign eligibility are separate classifications — a strong opportunity never upgrades eligibility.</p>
          </div>
        ) : <p className="agx-muted">{terminal ? 'The run did not classify this property — no recommendation is made without one.' : 'Written when the run classifies the property.'}</p>}
        {cr ? <ContactReadinessCard cr={cr} compact /> : null}
      </OwnerSection>

      <OwnerSection runId={snap.record.runId} onSection={onSection} k="findings" empty={!b.findings.some((f) => f.arrived)}>
        {b.findings.filter((f) => f.arrived).length ? b.findings.filter((f) => f.arrived).map((f) => (
          <div key={f.key} className="agx-osub is-arrived">
            <h6>{f.label}</h6>
            <ul>{f.claims.map((c, i) => <ClaimLine key={i} c={c} view={view} />)}</ul>
          </div>
        )) : <Pending terminal={terminal} writing={b.status === 'writing'} />}
        {terminal && b.findings.some((f) => !f.arrived) ? <p className="agx-muted">Not covered in this pass: {b.findings.filter((f) => !f.arrived).map((f) => f.label).join(' · ')}</p> : null}
      </OwnerSection>

      <OwnerSection runId={snap.record.runId} onSection={onSection} k="confidence">
        <div className="agx-conf">
          <span><b>{b.confidence.verified}</b> verified</span>
          <span><b>{b.confidence.awaiting}</b> awaiting verification</span>
          {b.confidence.inferred ? <span><b>{b.confidence.inferred}</b> inferred</span> : null}
          <span className={b.confidence.contradicted ? 'is-bad' : ''}><b>{b.confidence.contradicted}</b> contradicted</span>
          <span><b>{b.confidence.unavailable}</b> no value</span>
          {b.confidence.lowest !== null ? <span>lowest standing <b>{b.confidence.lowest.toFixed(2)}</b></span> : null}
        </div>
        {b.confidence.gaps.length ? <ul className="agx-gaps">{b.confidence.gaps.map((g) => <li key={g}>{g}</li>)}</ul> : <p className="agx-muted">{terminal ? 'No verification gaps were reported.' : 'Gaps are listed as operations finish.'}</p>}
      </OwnerSection>

      <OwnerSection runId={snap.record.runId} onSection={onSection} k="economics" empty={!b.economics.applicable || !b.economics.claims.length}>
        {b.economics.claims.length ? <ul>{b.economics.claims.map((c, i) => <ClaimLine key={i} c={c} view={view} />)}</ul> : null}
        {b.economics.assumptions.length ? <div className="agx-osub"><h6>Assumptions</h6><ul className="agx-gaps">{b.economics.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></div> : null}
        <p className="agx-muted">{b.economics.note}</p>
      </OwnerSection>

      <OwnerSection runId={snap.record.runId} onSection={onSection} k="evidence" empty={!b.evidence.length}>
        {b.evidence.length ? (
          <>
            <div className="agx-evsum">{EVIDENCE_CLASSES.filter((c) => b.byClass[c]).map((c) => <span key={c}><ClassTag cls={c} compact /><b>{b.byClass[c]}</b></span>)}</div>
            <ol className="agx-cites">
              {b.evidence.map((e, i) => (
                <li key={e.finding.finding_id} className={cx(`is-c-${e.cls}`, e.finding.contradicted_by && 'is-contradicted')}>
                  <button type="button" onClick={() => setUi({ selectedFindingId: e.finding.finding_id, selectedSourceKey: null, inspectorTab: 'evidence', rightCollapsed: false })}>
                    <span className="agx-cites__n">[{i + 1}]</span>
                    <span className="agx-cites__t"><b>{e.finding.display_value ?? '— no value —'}</b><small>{e.source?.name ?? 'Source not reported'} · {EVIDENCE_CLASS_META[e.cls].short}{e.finding.retrieved_at ? ` · retrieved ${fmtDay(e.finding.retrieved_at)}` : ''} · {FRESHNESS_LABEL[e.finding.freshness_state]}</small>{e.finding.citation ? <cite>{e.finding.citation}</cite> : null}</span>
                  </button>
                </li>
              ))}
            </ol>
          </>
        ) : <Pending terminal={terminal} writing={false} what="Evidence" />}
      </OwnerSection>

      <OwnerSection runId={snap.record.runId} onSection={onSection} k="conflicts" empty={!b.conflicts.length && !b.unavailable.length && !b.risks.length}>
        {b.conflicts.map((c) => <ConflictInspector key={c.id} c={c} mode={snap.mode} compact />)}
        {b.unavailable.length ? (
          <div className="agx-osub">
            <h6>Unavailable information</h6>
            <ul className="agx-unav">{b.unavailable.map(({ task, reason }) => <li key={task.task_id} className={`is-${task.state}`}><b>{task.label}</b><span>{reasonLabel(reason) || reason} — not evidence of absence{task.alternatives.length ? ` · continued via ${task.alternatives.join(' · ')}` : ''}</span></li>)}</ul>
          </div>
        ) : null}
        {b.risks.length ? <div className="agx-osub"><h6>Risks & unresolved</h6><ul>{b.risks.map((c, i) => <ClaimLine key={i} c={c} view={view} />)}</ul></div> : null}
        {!b.conflicts.length && !b.unavailable.length && !b.risks.length ? <p className="agx-muted">{terminal ? 'No conflicts, and every operation returned a value.' : 'Nothing so far.'}</p> : null}
      </OwnerSection>

      <OwnerSection runId={snap.record.runId} onSection={onSection} k="next">
        {b.next.length ? <ul>{b.next.map((c, i) => <ClaimLine key={i} c={c} view={view} />)}</ul> : <p className="agx-muted">{terminal ? 'The run recommended no further investigation.' : 'Written at the end of the run.'}</p>}
        {terminal ? (
          <div className="agx-brief__acts">
            <LCButton size="sm" variant="secondary" icon="refresh-cw" onClick={() => (snap.mode === 'live' && snap.live ? openLivePreflight({ propertyIds: snap.live.propertyIds, addresses: snap.properties.map((p) => p.address), originApp: snap.live.originApp, originLabel: snap.live.originLabel }) : startRun(snap.record.scenarioId!, { open: 'workspace' }))}>{snap.mode === 'live' ? 'Quick Scan again' : 'Replay again'}</LCButton>
            <LCTooltip content="Deep Research ($0.75 cap) is a paid tier — disabled in S3"><span><LCButton size="sm" variant="quiet" icon="target" disabled>Investigate further</LCButton></span></LCTooltip>
            <LCButton size="sm" variant="quiet" icon="eye" onClick={() => setUi({ centerTab: 'sources', inspectorTab: 'evidence', rightCollapsed: false })}>View evidence</LCButton>
            <LCTooltip content="Compare 2–4 briefs side by side — S6"><span><LCButton size="sm" variant="quiet" icon="layout-split" disabled>Compare properties</LCButton></span></LCTooltip>
            <LCButton size="sm" variant="secondary" icon="send" onClick={() => setHandoff((h) => !h)} aria-expanded={handoff}>Add to Campaign…</LCButton>
            {handoff ? (
              <div className="agx-handoff" role="note">
                <b>Add to Campaign hands off — it never sends.</b>
                <p>It opens Entity Graph’s existing Add-to-Campaign sheet with {snap.properties.length === 1 ? 'this property id' : `these ${snap.properties.length} property ids`}: draft only, graph-derived eligibility, dedupe against existing campaigns. Opportunity never upgrades contact readiness.</p>
                <p className="agx-muted">{snap.mode === 'fixture' ? 'Unavailable here: these are synthetic fixture properties.' : 'Not wired in S3 (no unauthorized production action from the agent). Use Entity Graph’s Add to campaign directly.'} Outbound is paused by the owner.</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </OwnerSection>
    </article>
  )
}

function OwnerSection({ runId, k, children, empty, onSection }: { runId: string; k: OwnerSectionKey; children: ReactNode; empty?: boolean; onSection?: (key: OwnerSectionKey) => void }) {
  const meta = OWNER_BRIEF_ORDER.find((s) => s.key === k)!
  return (
    <section id={`agx-brief-${runId}-${k}`} className={cx('agx-osec', `is-${k}`, empty && 'is-empty')} aria-label={meta.label} onFocus={() => onSection?.(k)}>
      <h4><span className="agx-osec__n">{meta.n}</span>{meta.label}</h4>
      <div className="agx-osec__body">{children}</div>
    </section>
  )
}

function Pending({ terminal, writing, what }: { terminal: boolean; writing: boolean; what?: string }) {
  if (terminal) return <p className="agx-muted">{what ?? 'Nothing'} reported in this pass.</p>
  return <span className={cx('agx-skel', writing && 'is-writing')} aria-hidden="true"><i /><i /></span>
}

function ClaimLine({ c, view }: { c: BriefClaim; view: ResearchView }) {
  const v = claimVerdict(c, view.findings)
  return (
    <li className={cx('agx-claim', `is-${v}`, c.is_inference && 'is-inference')}>
      <span className="agx-claim__text">{c.text}{c.is_inference ? <em> (inference)</em> : null}</span>
      <span className="agx-claim__meta">
        <VerdictTag verdict={v} compact />
        {c.source_name ? <span>{c.source_name}</span> : null}
        {c.confidence > 0 ? <span title="Rule output, not a model's self-report">conf {c.confidence.toFixed(2)}</span> : null}
        <span className={`is-${c.freshness_state}`}>{FRESHNESS_LABEL[c.freshness_state]}</span>
      </span>
    </li>
  )
}

/** Batch-level summary line. */
export function BatchSummary({ view }: { view: ResearchView }) {
  const c = batchCounters(view)
  return <p className="agx-muted">{c.completed} of {c.total} briefs written · {c.discoveries} high-priority findings · {c.ops_blocked} blocked operations</p>
}
