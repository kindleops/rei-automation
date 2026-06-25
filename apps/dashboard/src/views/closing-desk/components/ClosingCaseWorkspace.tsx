import { useMemo } from 'react'
import type { ClosingCase } from '../../../domain/closing-desk/closing-desk.types'
import { boardColumnLabel } from '../../../domain/closing-desk/closing-board'
import { milestoneLabel } from '../../../domain/closing-desk/closing-milestones'
import { orderIssues } from '../../../domain/closing-desk/closing-issues'
import { buildCopilotReadout } from '../../../domain/closing-desk/closing-copilot'
import { ClosingHealthBadge } from './ClosingHealthBadge'

const money = (v: number | null) => (v === null ? null : `$${v.toLocaleString()}`)
const date = (v: string | null) => (v ? new Date(v).toLocaleDateString() : null)
const bool = (v: boolean | null) => (v === null ? null : v ? 'Yes' : 'No')

function Val({ children }: { children: string | null }) {
  if (children === null || children === '') return <span className="cd-absent">Not projected</span>
  return <>{children}</>
}

function KV({ k, v }: { k: string; v: string | null }) {
  return (
    <div>
      <span className="k">{k}</span>
      <span className="v"><Val>{v}</Val></span>
    </div>
  )
}

export interface ClosingCaseWorkspaceProps {
  closingCase: ClosingCase
  onClose: () => void
}

export function ClosingCaseWorkspace({ closingCase: c, onClose }: ClosingCaseWorkspaceProps) {
  const copilot = useMemo(() => buildCopilotReadout(c), [c])
  const issues = useMemo(() => orderIssues(c.issues), [c.issues])
  const isFixture = c.provenance.fields.identity === 'fixture'

  return (
    <div className="cd-drawer-overlay" role="dialog" aria-modal="true" aria-label={`Closing case ${c.displayName}`} onClick={onClose}>
      <div className="cd-drawer" onClick={(e) => e.stopPropagation()}>
        <header className="cd-drawer__head">
          <div>
            <p className="eyebrow" style={{ margin: 0, fontSize: 10, letterSpacing: '0.2em', color: 'var(--nx-accent,#38bdf8)' }}>CLOSING CASE</p>
            <h2 style={{ margin: '2px 0', fontSize: 17 }}>{c.displayName}</h2>
            <ClosingHealthBadge health={c.health} />
          </div>
          <button className="cd-drawer__close" onClick={onClose} aria-label="Close case workspace">×</button>
        </header>

        {isFixture ? <div className="cd-demo-banner" role="status">DEMO DATA — synthetic fixture, not a live closing.</div> : null}

        {/* Persistent Next Required Action */}
        <div className="cd-next-action" data-testid="cd-next-action">
          <strong>Next Required Action: {c.health.nextRequiredAction ?? 'None pending'}</strong>
          <small>
            Responsible: {c.health.responsibleParty ?? 'Unassigned'} · SLA: {date(c.health.slaDeadline) ?? 'No SLA'}
          </small>
        </div>

        {/* 1. Command summary */}
        <section className="cd-section">
          <h3>Command Summary</h3>
          <div className="cd-kv">
            <KV k="Universal Stage" v={c.universalStage.replace(/_/g, ' ')} />
            <KV k="Board Lane" v={boardColumnLabel(c.boardColumn)} />
            <KV k="Risk" v={c.riskLevel} />
            <KV k="On-time Close" v={c.health.onTimeCloseProbability === null ? null : `${Math.round(c.health.onTimeCloseProbability * 100)}%`} />
            <KV k="Days to Close" v={c.health.daysUntilClosing === null ? null : String(c.health.daysUntilClosing)} />
            <KV k="Data Completeness" v={`${c.health.dataCompletenessScore}%`} />
          </div>
        </section>

        {/* 2. Property & seller */}
        <section className="cd-section">
          <h3>Property &amp; Seller</h3>
          <div className="cd-kv">
            <KV k="Address" v={c.propertyAddress} />
            <KV k="Market" v={c.market} />
            <KV k="Seller" v={c.sellerName} />
            <KV k="Property ID" v={c.identity.propertyId} />
          </div>
        </section>

        {/* 3 + 4. Contract terms / signers & authority */}
        <section className="cd-section">
          <h3>Contract &amp; Authority</h3>
          <div className="cd-kv">
            <KV k="Contract Status" v={c.contractStatus} />
            <KV k="Contract ID" v={c.identity.contractId} />
            <KV k="Signed" v={date(c.dates.contractSignedDate)} />
            <KV k="Effective" v={date(c.dates.effectiveDate)} />
            <KV k="Signers Verified" v={bool(c.readiness.allSignersVerified)} />
            <KV k="Authority Verified" v={bool(c.readiness.authorityVerified)} />
          </div>
        </section>

        {/* 5. Buyer & assignment */}
        <section className="cd-section">
          <h3>Buyer &amp; Assignment</h3>
          <div className="cd-kv">
            <KV k="Disposition" v={c.dispositionStatus} />
            <KV k="Buyer ID" v={c.identity.buyerId} />
            <KV k="Assignment ID" v={c.identity.assignmentId} />
            <KV k="Buyer Secured" v={bool(c.readiness.buyerSecured)} />
            <KV k="Buyer Funds Verified" v={bool(c.readiness.buyerFundsVerified)} />
            <KV k="EMD Received" v={bool(c.readiness.emdReceived)} />
          </div>
        </section>

        {/* 6. Title & escrow */}
        <section className="cd-section">
          <h3>Title &amp; Escrow</h3>
          <div className="cd-kv">
            <KV k="Title Status" v={c.titleStatus} />
            <KV k="Escrow Status" v={c.escrowStatus} />
            <KV k="Escrow File #" v={c.identity.escrowFileNumber} />
            <KV k="Title Opened" v={date(c.dates.titleOpenedDate)} />
            <KV k="Commitment" v={date(c.dates.titleCommitmentDate)} />
            <KV k="Cure Deadline" v={date(c.dates.cureDeadline)} />
          </div>
        </section>

        {/* 7. Milestones */}
        <section className="cd-section">
          <h3>Closing Milestones ({c.milestones.length})</h3>
          <ul className="cd-timeline">
            {c.milestones.length === 0 ? <li className="cd-absent">No milestones recorded.</li> : null}
            {c.milestones.map((m) => (
              <li key={m.eventId}>
                <span className="dot" aria-hidden />
                <span>
                  <strong>{milestoneLabel(m.type)}</strong>
                  <br />
                  <small style={{ color: 'var(--nx-text-faint,#67768c)' }}>
                    {date(m.occurredAt) ?? 'date unknown'} · {m.sourceSystem}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* 8. Issues & curative */}
        <section className="cd-section">
          <h3>Issues &amp; Curative ({issues.length})</h3>
          {issues.length === 0 ? <p className="cd-absent">No open issues.</p> : null}
          {issues.map((i) => (
            <div className="cd-issue" data-sev={i.severity} key={i.issueId}>
              <div className="cd-issue__title">{i.title}</div>
              <div className="cd-issue__meta">
                {i.category} · {i.severity} · {i.status} · owner {i.owner ?? '—'} · due {date(i.dueAt) ?? 'no SLA'}
              </div>
            </div>
          ))}
        </section>

        {/* 9 + 10 + 11. Tasks / Documents / Communications */}
        <section className="cd-section">
          <h3>Tasks · Documents · Communications</h3>
          <p className="cd-absent">
            Tasks ({c.tasks.length}), documents ({c.documents.length}) and the communications timeline are not yet
            projected from Podio/message events into Supabase. See AUDIT.md for the integration plan.
          </p>
        </section>

        {/* 12. Financials & expected revenue */}
        <section className="cd-section">
          <h3>Financials &amp; Expected Revenue</h3>
          <div className="cd-kv">
            <KV k="Seller Contract" v={money(c.financials.sellerContractPrice)} />
            <KV k="Buyer Price" v={money(c.financials.buyerPrice)} />
            <KV k="Assignment Fee" v={money(c.financials.assignmentFee)} />
            <KV k="Buyer EMD" v={money(c.financials.buyerEmd)} />
            <KV k="Title Fees" v={money(c.financials.titleFees)} />
            <KV k="Expected Gross" v={money(c.financials.expectedGrossRevenue)} />
            <KV k="Confirmed Gross" v={money(c.financials.confirmedGrossRevenue)} />
            <KV k="Revenue Status" v={c.financials.revenueStatus} />
          </div>
        </section>

        {/* 14. Closing health explanation */}
        <section className="cd-section">
          <h3>Closing Health — Why {c.health.score}/100</h3>
          {c.health.factors.length === 0 ? (
            <p className="cd-absent">Not enough persisted facts to score this case.</p>
          ) : (
            c.health.factors.map((f, idx) => (
              <div className="cd-factor" key={`${f.rule}-${idx}`}>
                <span>{f.label}</span>
                <span className={`cd-factor__delta ${f.delta < 0 ? 'neg' : 'pos'}`}>{f.delta > 0 ? `+${f.delta}` : f.delta}</span>
                <span className="cd-factor__evidence">{f.evidence}</span>
              </div>
            ))
          )}
        </section>

        {/* AI Closing Copilot (read-only, fact-citing) */}
        <section className="cd-section">
          <h3>Closing Copilot — Read Only</h3>
          <div className="cd-copilot">
            {copilot.insights.map((insight, idx) => (
              <div className="cd-insight" key={`${insight.kind}-${idx}`}>
                <div className="cd-insight__headline">{insight.headline}</div>
                <div className="cd-insight__detail">{insight.detail}</div>
                {insight.citedFacts.length > 0 ? (
                  <div className="cd-insight__facts">cited: {insight.citedFacts.join(' · ')}</div>
                ) : null}
              </div>
            ))}
            {copilot.proposedActions.map((action, idx) => (
              <div className="cd-proposed" key={`${action.kind}-${idx}`}>
                <span className="cd-proposed__badge">Proposed · requires approval</span>
                <div className="cd-insight__headline">{action.label}</div>
                <div className="cd-insight__detail">{action.rationale}</div>
                <div className="cd-insight__facts">cited: {action.citedFacts.join(' · ')}</div>
                <button type="button" disabled title="Read-only foundation — execution is disabled.">
                  Execution disabled
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* 13. Audit trail / provenance */}
        <section className="cd-section">
          <h3>Audit &amp; Provenance</h3>
          <p className="cd-issue__meta">Fully backed by live data: {c.provenance.fullyBacked ? 'yes' : 'no'}</p>
          {c.provenance.degraded.map((d, i) => (
            <p className="cd-issue__meta" key={i}>⚠ {d}</p>
          ))}
        </section>
      </div>
    </div>
  )
}
