import { useMemo, useState } from 'react'
import type { ClosingCase } from '../../../domain/closing-desk/closing-desk.types'
import { boardColumnLabel } from '../../../domain/closing-desk/closing-board'
import { milestoneLabel } from '../../../domain/closing-desk/closing-milestones'
import { orderIssues } from '../../../domain/closing-desk/closing-issues'
import { buildCopilotReadout } from '../../../domain/closing-desk/closing-copilot'
import { ClosingHealthBadge } from './ClosingHealthBadge'
import { ClosingReadinessRing } from './ClosingReadinessRing'
import { daysRemaining, formatDate, money, primaryBlocker, stageLabel } from '../closing-desk-utils'

const TABS = [
  'Overview',
  'Contract',
  'Parties & Authority',
  'Buyer / Assignment',
  'Title & Escrow',
  'Milestones',
  'Issues / Curative',
  'Tasks & SLA',
  'Documents',
  'Communications',
  'Financials',
  'Audit Trail',
] as const

type Tab = (typeof TABS)[number]

const bool = (v: boolean | null) => (v === null ? null : v ? 'Yes' : 'No')

function Val({ children }: { children: string | null }) {
  if (children === null || children === '') return <span className="cd-absent">Not projected</span>
  return <>{children}</>
}

function KV({ k, v, kind = 'fact' }: { k: string; v: string | null; kind?: 'fact' | 'derived' | 'missing' }) {
  return (
    <div className={`cd-kv-item cd-kv-item--${kind}`}>
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
  const [tab, setTab] = useState<Tab>('Overview')
  const copilot = useMemo(() => buildCopilotReadout(c), [c])
  const issues = useMemo(() => orderIssues(c.issues), [c.issues])
  const isFixture = c.provenance.fields.identity === 'fixture'
  const blocker = primaryBlocker(c)
  const days = c.health.daysUntilClosing ?? daysRemaining(c.dates.scheduledClosingDate)
  const milestonePct = c.milestones.length > 0 ? Math.min(100, Math.round((c.milestones.length / 8) * 100)) : 0

  return (
    <div className="cd-dossier-overlay" role="dialog" aria-modal="true" aria-label={`Closing case ${c.displayName}`} onClick={onClose}>
      <div className="cd-dossier" onClick={(e) => e.stopPropagation()} data-testid="cd-dossier">
        <header className="cd-dossier__command">
          <div className="cd-dossier__identity">
            <p className="cd-dossier__eyebrow">TRANSACTION DOSSIER</p>
            <h2>{c.displayName}</h2>
            <div className="cd-dossier__chips">
              <span>{c.market ?? '—'}</span>
              <span>{stageLabel(c.universalStage)}</span>
              <span>{boardColumnLabel(c.boardColumn)}</span>
            </div>
          </div>
          <div className="cd-dossier__vitals">
            <ClosingReadinessRing score={c.health.score} band={c.health.band} size={64} />
            <div className="cd-dossier__countdown">
              <strong>{days ?? '—'}</strong>
              <span>days to close</span>
            </div>
            <div className="cd-dossier__revenue">
              <strong>{money(c.financials.expectedGrossRevenue) ?? '—'}</strong>
              <span>expected revenue</span>
            </div>
          </div>
          <button className="cd-dossier__close" onClick={onClose} aria-label="Close dossier">×</button>
        </header>

        {isFixture ? <div className="cd-env cd-env--demo cd-env--compact" role="status"><span className="cd-env__pill">Synthetic fixture</span></div> : null}

        <div className="cd-dossier__next" data-testid="cd-next-action">
          <strong>Next required action</strong>
          <p>{c.health.nextRequiredAction ?? 'None pending'}</p>
          <small>{c.health.responsibleParty ?? 'Unassigned'} · SLA {formatDate(c.health.slaDeadline) ?? 'none'}</small>
        </div>

        {blocker ? (
          <div className="cd-dossier__blocker" data-sev={blocker.severity}>
            <span>Primary blocker</span>
            <strong>{blocker.title}</strong>
            <small>{blocker.owner ?? 'Unassigned'}</small>
          </div>
        ) : null}

        <div className="cd-dossier__viz-row">
          <div className="cd-viz-card">
            <span className="cd-viz-card__label">Milestone track</span>
            <div className="cd-progress"><div className="cd-progress__fill" style={{ width: `${milestonePct}%` }} /></div>
            <span className="cd-viz-card__meta">{c.milestones.length} recorded · {milestonePct}% coverage</span>
          </div>
          <div className="cd-viz-card">
            <span className="cd-viz-card__label">Data completeness</span>
            <div className="cd-progress"><div className="cd-progress__fill is-accent" style={{ width: `${c.health.dataCompletenessScore}%` }} /></div>
            <span className="cd-viz-card__meta">{c.health.dataCompletenessScore}% fields projected</span>
          </div>
          <div className="cd-viz-card">
            <span className="cd-viz-card__label">On-time probability</span>
            <strong className="cd-viz-card__value">
              {c.health.onTimeCloseProbability === null ? '—' : `${Math.round(c.health.onTimeCloseProbability * 100)}%`}
            </strong>
          </div>
        </div>

        <nav className="cd-dossier__tabs" role="tablist" aria-label="Dossier sections">
          {TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>

        <div className="cd-dossier__body">
          {tab === 'Overview' && (
            <section className="cd-dossier-section">
              <div className="cd-kv-grid">
                <KV k="Health band" v={c.health.band} kind="derived" />
                <KV k="Risk level" v={c.riskLevel} kind="derived" />
                <KV k="Closing status" v={c.closingStatus} />
                <KV k="Escrow" v={c.escrowStatus} />
                <KV k="Scheduled close" v={formatDate(c.dates.scheduledClosingDate)} />
                <KV k="Seller" v={c.sellerName} />
              </div>
              <ClosingHealthBadge health={c.health} />
            </section>
          )}

          {tab === 'Contract' && (
            <section className="cd-dossier-section">
              <div className="cd-kv-grid">
                <KV k="Contract status" v={c.contractStatus} />
                <KV k="Contract ID" v={c.identity.contractId} />
                <KV k="Signed" v={formatDate(c.dates.contractSignedDate)} />
                <KV k="Effective" v={formatDate(c.dates.effectiveDate)} />
                <KV k="Signers verified" v={bool(c.readiness.allSignersVerified)} />
                <KV k="Authority verified" v={bool(c.readiness.authorityVerified)} />
              </div>
            </section>
          )}

          {tab === 'Parties & Authority' && (
            <section className="cd-dossier-section">
              <div className="cd-kv-grid">
                <KV k="Property ID" v={c.identity.propertyId} />
                <KV k="Master owner" v={c.identity.masterOwnerId} />
                <KV k="Opportunity" v={c.identity.opportunityId} />
                <KV k="Offer" v={c.identity.offerId} />
              </div>
              {c.parties.map((p) => (
                <div className="cd-party" key={`${p.role}-${p.name}`}>
                  <strong>{p.role}</strong> {p.name} · verified {bool(p.verified) ?? '—'}
                </div>
              ))}
            </section>
          )}

          {tab === 'Buyer / Assignment' && (
            <section className="cd-dossier-section">
              <div className="cd-kv-grid">
                <KV k="Disposition" v={c.dispositionStatus} />
                <KV k="Buyer ID" v={c.identity.buyerId} />
                <KV k="Assignment ID" v={c.identity.assignmentId} />
                <KV k="Buyer secured" v={bool(c.readiness.buyerSecured)} />
                <KV k="Funds verified" v={bool(c.readiness.buyerFundsVerified)} />
                <KV k="EMD received" v={bool(c.readiness.emdReceived)} />
              </div>
            </section>
          )}

          {tab === 'Title & Escrow' && (
            <section className="cd-dossier-section">
              <div className="cd-kv-grid">
                <KV k="Title status" v={c.titleStatus} />
                <KV k="Escrow status" v={c.escrowStatus} />
                <KV k="Escrow file" v={c.identity.escrowFileNumber} />
                <KV k="Title opened" v={formatDate(c.dates.titleOpenedDate)} />
                <KV k="Commitment" v={formatDate(c.dates.titleCommitmentDate)} />
                <KV k="Cure deadline" v={formatDate(c.dates.cureDeadline)} />
              </div>
            </section>
          )}

          {tab === 'Milestones' && (
            <section className="cd-dossier-section">
              <h3>Closing Milestones ({c.milestones.length})</h3>
              <ul className="cd-milestone-track">
                {c.milestones.length === 0 ? <li className="cd-absent">No milestones recorded.</li> : null}
                {c.milestones.map((m) => (
                  <li key={m.eventId}>
                    <span className="cd-milestone-track__dot" aria-hidden />
                    <div>
                      <strong>{milestoneLabel(m.type)}</strong>
                      <small>{formatDate(m.occurredAt) ?? '—'} · {m.sourceSystem}</small>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {tab === 'Issues / Curative' && (
            <section className="cd-dossier-section">
              <h3>Issues &amp; Curative ({issues.length})</h3>
              {issues.length === 0 ? <p className="cd-absent">No open issues.</p> : null}
              {issues.map((i) => (
                <div className="cd-issue" data-sev={i.severity} key={i.issueId}>
                  <div className="cd-issue__title">{i.title}</div>
                  <div className="cd-issue__meta">{i.category} · {i.severity} · {i.status} · {i.owner ?? '—'}</div>
                </div>
              ))}
            </section>
          )}

          {tab === 'Tasks & SLA' && (
            <section className="cd-dossier-section">
              <p className="cd-absent">Tasks ({c.tasks.length}) not yet projected from Podio into Supabase.</p>
              <KV k="SLA deadline" v={formatDate(c.health.slaDeadline)} kind="derived" />
            </section>
          )}

          {tab === 'Documents' && (
            <section className="cd-dossier-section">
              <p className="cd-absent">Documents ({c.documents.length}) not yet projected.</p>
            </section>
          )}

          {tab === 'Communications' && (
            <section className="cd-dossier-section">
              <p className="cd-absent">Communications timeline not yet mirrored from message events.</p>
            </section>
          )}

          {tab === 'Financials' && (
            <section className="cd-dossier-section">
              <div className="cd-kv-grid">
                <KV k="Seller contract" v={money(c.financials.sellerContractPrice)} />
                <KV k="Buyer price" v={money(c.financials.buyerPrice)} />
                <KV k="Assignment fee" v={money(c.financials.assignmentFee)} />
                <KV k="Expected gross" v={money(c.financials.expectedGrossRevenue)} />
                <KV k="Confirmed gross" v={money(c.financials.confirmedGrossRevenue)} />
                <KV k="Revenue status" v={c.financials.revenueStatus} />
              </div>
              <div className="cd-revenue-compare">
                <div><span>Expected</span><strong>{money(c.financials.expectedGrossRevenue) ?? '—'}</strong></div>
                <div><span>Confirmed</span><strong>{money(c.financials.confirmedGrossRevenue) ?? '—'}</strong></div>
              </div>
            </section>
          )}

          {tab === 'Audit Trail' && (
            <section className="cd-dossier-section">
              <KV k="Fully backed" v={c.provenance.fullyBacked ? 'Yes' : 'No'} kind="derived" />
              {c.provenance.degraded.map((d, i) => <p className="cd-diag-line" key={i}>{d}</p>)}
            </section>
          )}

          <section className="cd-dossier-section cd-dossier-copilot">
            <h3>Closing Copilot — Read Only</h3>
            <p className="cd-copilot-note">Summarizes and recommends — cannot execute actions.</p>
            <div className="cd-copilot">
              {copilot.insights.map((insight, idx) => (
                <div className="cd-insight" key={`${insight.kind}-${idx}`}>
                  <div className="cd-insight__headline">{insight.headline}</div>
                  <div className="cd-insight__detail">{insight.detail}</div>
                </div>
              ))}
              {copilot.proposedActions.map((action, idx) => (
                <div className="cd-proposed" key={`${action.kind}-${idx}`}>
                  <span className="cd-proposed__badge">Proposed · requires approval</span>
                  <div className="cd-insight__headline">{action.label}</div>
                  <button type="button" disabled>Execution disabled</button>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}