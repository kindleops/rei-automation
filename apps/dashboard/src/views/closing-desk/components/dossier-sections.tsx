import { useState } from 'react'
import type { ClosingCase, ClosingIdentity } from '../../../domain/closing-desk/closing-desk.types'
import { boardColumnLabel } from '../../../domain/closing-desk/closing-board'
import { orderIssues } from '../../../domain/closing-desk/closing-issues'
import {
  CLOSING_MILESTONE_CATALOG,
  milestoneLabel,
  nextExpectedMilestone,
} from '../../../domain/closing-desk/closing-milestones'
import type { CopilotReadout } from '../../../domain/closing-desk/closing-copilot'
import { ClosingHealthBadge } from './ClosingHealthBadge'
import { DossierFactGrid } from './DossierFactGrid'
import {
  formatBool,
  formatClosingDate,
  formatDataSource,
  formatDatePresent,
  formatDaysToClose,
  formatIssueCategory,
  formatIssueSeverity,
  formatIssueStatus,
  formatTimestamp,
  humanizeEnum,
  partyRoleLabel,
  displayEntityName,
  humanizeOperatorText,
} from '../closing-desk-present'
import { money, primaryBlocker, stageLabel } from '../closing-desk-utils'

type MilestoneState = 'completed' | 'current' | 'blocked' | 'upcoming' | 'overdue'

function riskHealthNote(c: ClosingCase): string | null {
  const band = c.health.band
  const risk = c.riskLevel
  const lowRisk = risk === 'low' || risk === 'unknown'
  const highBand = band === 'at_risk' || band === 'critical'
  if (lowRisk && highBand) {
    return 'Health score reflects active blockers despite a low portfolio risk label — review issues and milestones.'
  }
  const highRisk = risk === 'high' || risk === 'severe'
  const goodBand = band === 'on_track' || band === 'watch'
  if (highRisk && goodBand) {
    return 'Risk label is elevated while health remains stable — monitor SLA deadlines and title readiness.'
  }
  return null
}

function buyerPartyName(c: ClosingCase): string | null {
  const buyer = c.parties.find((p) => p.role === 'selected_buyer')
  return buyer?.name ?? null
}

function titleContact(c: ClosingCase): string | null {
  const contact = c.parties.find((p) => p.role === 'title_contact')
  return contact?.name ?? (c.identity.titleCompanyId ? 'Title company on file' : null)
}

function buildTimeline(c: ClosingCase): { type: string; label: string; state: MilestoneState; date: string | null; source: string }[] {
  const achieved = new Set(c.milestones.map((m) => m.type))
  const next = nextExpectedMilestone([...achieved])
  const blockingTypes = new Set(
    c.issues
      .filter((i) => i.status !== 'resolved' && i.status !== 'waived')
      .flatMap((i) => i.blockingMilestones),
  )
  const now = Date.now()

  const items: { type: string; label: string; state: MilestoneState; date: string | null; source: string }[] = []

  for (const m of c.milestones) {
    items.push({
      type: m.type,
      label: milestoneLabel(m.type),
      state: 'completed',
      date: m.occurredAt,
      source: formatDataSource(m.sourceSystem),
    })
  }

  if (next) {
    let state: MilestoneState = 'current'
    if (blockingTypes.has(next.type)) state = 'blocked'
    else if (c.health.daysUntilClosing !== null && c.health.daysUntilClosing < 0) state = 'overdue'
    items.push({
      type: next.type,
      label: next.label,
      state,
      date: null,
      source: 'Expected',
    })
  }

  const nextOrder = next?.order ?? Number.MAX_SAFE_INTEGER
  for (const def of CLOSING_MILESTONE_CATALOG) {
    if (def.type === 'closing_cancelled' || achieved.has(def.type) || def.order <= nextOrder) continue
    if (items.some((i) => i.type === def.type)) continue
    items.push({
      type: def.type,
      label: def.label,
      state: 'upcoming',
      date: null,
      source: 'Planned',
    })
    if (items.filter((i) => i.state === 'upcoming').length >= 4) break
  }

  void now
  return items.sort((a, b) => {
    const orderA = CLOSING_MILESTONE_CATALOG.find((d) => d.type === a.type)?.order ?? 0
    const orderB = CLOSING_MILESTONE_CATALOG.find((d) => d.type === b.type)?.order ?? 0
    return orderA - orderB
  })
}

function SourceDetails({ identity, isFixture }: { identity: ClosingIdentity; isFixture: boolean }) {
  const [open, setOpen] = useState(false)
  const entries: { label: string; value: string | null }[] = [
    { label: 'Closing Case', value: identity.closingCaseId },
    { label: 'Property', value: identity.propertyId },
    { label: 'Master Owner', value: identity.masterOwnerId },
    { label: 'Prospect', value: identity.prospectId },
    { label: 'Opportunity', value: identity.opportunityId },
    { label: 'Offer', value: identity.offerId },
    { label: 'Contract', value: identity.contractId },
    { label: 'Buyer', value: identity.buyerId },
    { label: 'Assignment', value: identity.assignmentId },
    { label: 'Title Company', value: identity.titleCompanyId },
    { label: 'Escrow File', value: identity.escrowFileNumber },
  ]

  return (
    <div className="cd-source-details" data-testid="cd-source-details">
      <button type="button" className="cd-source-details__toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? 'Hide source identifiers' : 'Source identifiers & provenance'}
      </button>
      {open ? (
        <dl className="cd-source-details__list">
          {isFixture ? (
            <p className="cd-source-details__note">Synthetic fixture — identifiers are demo-only and not live records.</p>
          ) : null}
          {entries.map((e) =>
            e.value ? (
              <div key={e.label} className="cd-source-details__row">
                <dt>{e.label}</dt>
                <dd>
                  <code title={e.value}>{e.value}</code>
                </dd>
              </div>
            ) : null,
          )}
        </dl>
      ) : null}
    </div>
  )
}

export function DossierOverviewSection({ c, copilot }: { c: ClosingCase; copilot: CopilotReadout }) {
  const blocker = primaryBlocker(c)
  const achieved = c.milestones.length
  const note = riskHealthNote(c)
  const summaryInsight = copilot.insights.find((i) => i.kind === 'summary')
  const primaryRec = copilot.proposedActions[0]

  return (
    <section className="cd-dossier-section" aria-labelledby="cd-section-overview">
      <h3 id="cd-section-overview">Closing readiness</h3>
      <DossierFactGrid
        columns={2}
        items={[
          { label: 'Readiness score', value: `${c.health.score}/100`, raw: String(c.health.score), kind: 'derived' },
          { label: 'Health band', value: humanizeEnum(c.health.band), raw: c.health.band, kind: 'derived' },
          { label: 'Days to close', value: formatDaysToClose(c.health.daysUntilClosing ?? null), raw: c.dates.scheduledClosingDate },
          { label: 'Scheduled close', value: formatClosingDate(c.dates.scheduledClosingDate), raw: c.dates.scheduledClosingDate ?? undefined },
          { label: 'Risk level', value: humanizeEnum(c.riskLevel), raw: c.riskLevel, kind: 'derived' },
          { label: 'Closing status', value: humanizeEnum(c.closingStatus), raw: c.closingStatus },
          { label: 'Next required action', value: c.health.nextRequiredAction ?? 'None pending', kind: 'derived' },
          { label: 'Responsible party', value: c.health.responsibleParty, emptyLabel: 'Unassigned', kind: 'derived' },
          { label: 'Primary blocker', value: blocker?.title ?? 'None', kind: 'derived' },
          { label: 'Milestone progress', value: `${achieved} recorded`, kind: 'derived' },
          { label: 'Expected revenue', value: money(c.financials.expectedGrossRevenue), kind: 'derived' },
          { label: 'Confirmed revenue', value: money(c.financials.confirmedGrossRevenue) ?? 'Not confirmed', emptyLabel: 'Not confirmed' },
        ]}
      />
      {note ? <p className="cd-dossier-note">{note}</p> : null}
      <ClosingHealthBadge health={c.health} />

      <h3 className="cd-dossier-section__sub">Key parties</h3>
      <div className="cd-party-grid">
        {c.parties.length === 0 ? <p className="cd-absent">No parties projected.</p> : null}
        {c.parties.slice(0, 4).map((p) => (
          <div className="cd-party-card" key={`${p.role}-${p.name}`}>
            <span className="cd-party-card__role">{partyRoleLabel(p.role)}</span>
            <strong className="cd-party-card__name">{displayEntityName(p.name)}</strong>
            <span className="cd-party-card__meta">
              {formatBool(p.verified) ?? 'Verification unknown'}
            </span>
          </div>
        ))}
      </div>

      <h3 className="cd-dossier-section__sub">Recent activity</h3>
      <p className="cd-dossier-activity">
        {c.lastActivityAt ? formatTimestamp(c.lastActivityAt) : 'No activity timestamp projected'}
        {c.lastActivityAt ? <span className="cd-dossier-activity__raw" title={c.lastActivityAt}> · last touch</span> : null}
      </p>

      <div className="cd-dossier-copilot-full" data-testid="cd-copilot-full">
        <h3 className="cd-dossier-section__sub">Closing Copilot — full analysis</h3>
        <p className="cd-copilot-note">Read-only reasoning — cannot execute actions.</p>
        {summaryInsight ? (
          <div className="cd-insight">
            <div className="cd-insight__headline">{humanizeOperatorText(summaryInsight.headline)}</div>
            <div className="cd-insight__detail">{humanizeOperatorText(summaryInsight.detail)}</div>
          </div>
        ) : null}
        {copilot.insights.filter((i) => i.kind !== 'summary').map((insight, idx) => (
          <div className="cd-insight" key={`${insight.kind}-${idx}`}>
            <div className="cd-insight__headline">{humanizeOperatorText(insight.headline)}</div>
            <div className="cd-insight__detail">{humanizeOperatorText(insight.detail)}</div>
          </div>
        ))}
        {primaryRec ? (
          <div className="cd-proposed">
            <span className="cd-proposed__badge">Primary recommendation · requires approval</span>
            <div className="cd-insight__headline">{humanizeOperatorText(primaryRec.label)}</div>
            <p className="cd-insight__detail">{humanizeOperatorText(primaryRec.rationale)}</p>
            <button type="button" disabled>Execution disabled</button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

export function DossierContractSection({ c }: { c: ClosingCase }) {
  const hasContractDoc = c.documents.some((d) => /contract/i.test(d.kind) || /contract/i.test(d.label))
  return (
    <section className="cd-dossier-section" aria-labelledby="cd-section-contract">
      <h3 id="cd-section-contract">Contract execution</h3>
      <DossierFactGrid
        items={[
          { label: 'Contract status', value: humanizeEnum(c.contractStatus), raw: c.contractStatus },
          { label: 'Seller contract price', value: money(c.financials.sellerContractPrice) },
          { label: 'Effective date', value: formatDatePresent(c.dates.effectiveDate), raw: c.dates.effectiveDate ?? undefined },
          { label: 'Signed date', value: formatDatePresent(c.dates.contractSignedDate), raw: c.dates.contractSignedDate ?? undefined },
          { label: 'Inspection deadline', value: formatDatePresent(c.dates.inspectionDeadline), raw: c.dates.inspectionDeadline ?? undefined, emptyLabel: 'Not scheduled' },
          { label: 'EMD due', value: formatDatePresent(c.dates.emdDueDate), raw: c.dates.emdDueDate ?? undefined, emptyLabel: 'Not scheduled' },
          { label: 'Signers verified', value: formatBool(c.readiness.allSignersVerified), raw: String(c.readiness.allSignersVerified) },
          { label: 'Authority verified', value: formatBool(c.readiness.authorityVerified), raw: String(c.readiness.authorityVerified) },
          { label: 'Contract complete', value: formatBool(c.readiness.contractComplete), raw: String(c.readiness.contractComplete) },
          { label: 'Contract document', value: hasContractDoc ? 'On file' : 'Not projected', emptyLabel: 'Not projected' },
          { label: 'Source', value: formatDataSource(c.provenance.fields.contract_status ?? 'absent'), kind: 'derived' },
        ]}
      />
    </section>
  )
}

export function DossierPartiesSection({ c }: { c: ClosingCase }) {
  return (
    <section className="cd-dossier-section" aria-labelledby="cd-section-parties">
      <h3 id="cd-section-parties">Parties &amp; authority</h3>
      {c.parties.length === 0 ? <p className="cd-absent">No parties projected for this case.</p> : null}
      <div className="cd-party-grid">
        {c.parties.map((p) => (
          <article className="cd-party-card cd-party-card--full" key={`${p.role}-${p.name}`}>
            <header className="cd-party-card__head">
              <span className="cd-party-card__role">{partyRoleLabel(p.role)}</span>
              <span className="cd-party-card__verify" data-verified={String(p.verified)}>
                {formatBool(p.verified) ?? 'Unknown'}
              </span>
            </header>
            <strong className="cd-party-card__name">{displayEntityName(p.name)}</strong>
            <DossierFactGrid
              columns={1}
              items={[
                { label: 'Authority type', value: p.authorityType ? humanizeEnum(p.authorityType) : null, raw: p.authorityType ?? undefined },
                { label: 'Verification', value: formatBool(p.verified), raw: String(p.verified) },
                { label: 'Source', value: formatDataSource(p.source), kind: 'derived' },
              ]}
            />
          </article>
        ))}
      </div>
      <DossierFactGrid
        columns={2}
        items={[
          { label: 'Ownership verified', value: formatBool(c.readiness.ownershipVerified), raw: String(c.readiness.ownershipVerified) },
          { label: 'All signers verified', value: formatBool(c.readiness.allSignersVerified), raw: String(c.readiness.allSignersVerified) },
          { label: 'Authority verified', value: formatBool(c.readiness.authorityVerified), raw: String(c.readiness.authorityVerified) },
          { label: 'Seller ready', value: formatBool(c.readiness.sellerReady), raw: String(c.readiness.sellerReady) },
        ]}
      />
    </section>
  )
}

export function DossierBuyerSection({ c }: { c: ClosingCase }) {
  const spread =
    c.financials.buyerPrice !== null && c.financials.sellerContractPrice !== null
      ? c.financials.buyerPrice - c.financials.sellerContractPrice
      : null
  return (
    <section className="cd-dossier-section" aria-labelledby="cd-section-buyer">
      <h3 id="cd-section-buyer">Buyer &amp; assignment</h3>
      <DossierFactGrid
        items={[
          { label: 'Selected buyer', value: displayEntityName(buyerPartyName(c), 'No buyer selected') },
          { label: 'Assignment status', value: humanizeEnum(c.dispositionStatus), raw: c.dispositionStatus },
          { label: 'Buyer price', value: money(c.financials.buyerPrice) },
          { label: 'Expected spread', value: money(spread) },
          { label: 'Assignment fee', value: money(c.financials.assignmentFee) },
          { label: 'Buyer EMD', value: money(c.financials.buyerEmd) },
          { label: 'EMD received', value: formatBool(c.readiness.emdReceived), raw: String(c.readiness.emdReceived) },
          { label: 'Proof of funds', value: formatBool(c.readiness.buyerFundsVerified), raw: String(c.readiness.buyerFundsVerified) },
          { label: 'Buyer secured', value: formatBool(c.readiness.buyerSecured), raw: String(c.readiness.buyerSecured) },
          { label: 'Inspection deadline', value: formatDatePresent(c.dates.inspectionDeadline), emptyLabel: 'Not scheduled', raw: c.dates.inspectionDeadline ?? undefined },
          { label: 'Assignment document', value: c.dispositionStatus === 'assignment_signed' ? 'Signed' : 'Pending', raw: c.dispositionStatus },
        ]}
      />
    </section>
  )
}

export function DossierTitleSection({ c }: { c: ClosingCase }) {
  const openIssues = c.issues.filter((i) => i.status !== 'resolved' && i.status !== 'waived').length
  return (
    <section className="cd-dossier-section" aria-labelledby="cd-section-title">
      <h3 id="cd-section-title">Title &amp; escrow</h3>
      <DossierFactGrid
        items={[
          { label: 'Title company / contact', value: displayEntityName(titleContact(c)) },
          { label: 'Escrow number', value: c.identity.escrowFileNumber ? `File ${c.identity.escrowFileNumber}` : null, raw: c.identity.escrowFileNumber ?? undefined },
          { label: 'Title status', value: humanizeEnum(c.titleStatus), raw: c.titleStatus },
          { label: 'Escrow status', value: humanizeEnum(c.escrowStatus), raw: c.escrowStatus },
          { label: 'Title opened', value: formatDatePresent(c.dates.titleOpenedDate), raw: c.dates.titleOpenedDate ?? undefined },
          { label: 'Commitment status', value: c.readiness.titleCommitmentReceived === true ? 'Received' : c.readiness.titleCommitmentReceived === false ? 'Outstanding' : null, raw: String(c.readiness.titleCommitmentReceived) },
          { label: 'Payoff status', value: c.readiness.payoffReceived === true ? 'Received' : c.readiness.payoffReceived === false ? 'Outstanding' : null, raw: String(c.readiness.payoffReceived) },
          { label: 'Open curative issues', value: String(openIssues), kind: 'derived' },
          { label: 'Cure deadline', value: formatDatePresent(c.dates.cureDeadline), emptyLabel: 'Not scheduled', raw: c.dates.cureDeadline ?? undefined },
          { label: 'Clear to close', value: formatBool(c.readiness.clearToClose), raw: String(c.readiness.clearToClose) },
        ]}
      />
    </section>
  )
}

export function DossierMilestonesSection({ c }: { c: ClosingCase }) {
  const timeline = buildTimeline(c)
  return (
    <section className="cd-dossier-section" aria-labelledby="cd-section-milestones">
      <h3 id="cd-section-milestones">Milestone timeline</h3>
      {timeline.length === 0 ? <p className="cd-absent">No milestones recorded.</p> : null}
      <ol className="cd-milestone-timeline" data-testid="cd-milestone-timeline">
        {timeline.map((item) => (
          <li key={item.type} className={`cd-milestone-timeline__item is-${item.state}`} data-state={item.state}>
            <span className="cd-milestone-timeline__marker" aria-hidden />
            <div className="cd-milestone-timeline__body">
              <div className="cd-milestone-timeline__head">
                <strong>{item.label}</strong>
                <span className="cd-milestone-timeline__state">{humanizeEnum(item.state)}</span>
              </div>
              <small>
                {item.date ? formatDatePresent(item.date) : 'Date pending'} · {item.source}
              </small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function DossierIssuesSection({ c }: { c: ClosingCase }) {
  const issues = orderIssues(c.issues)
  return (
    <section className="cd-dossier-section" aria-labelledby="cd-section-issues">
      <h3 id="cd-section-issues">Issues &amp; curative ({issues.length})</h3>
      {issues.length === 0 ? <p className="cd-absent">No open issues.</p> : null}
      {issues.map((i) => (
        <article className="cd-issue-card" data-sev={i.severity} key={i.issueId} data-testid="cd-issue-card">
          <header className="cd-issue-card__head">
            <h4>{i.title}</h4>
            <span className="cd-issue-card__severity">{formatIssueSeverity(i.severity)}</span>
          </header>
          <DossierFactGrid
            columns={2}
            items={[
              { label: 'Category', value: formatIssueCategory(i.category), raw: i.category },
              { label: 'Status', value: formatIssueStatus(i.status), raw: i.status },
              { label: 'Owner', value: i.owner, emptyLabel: 'Unassigned' },
              { label: 'SLA / due', value: formatDatePresent(i.dueAt) ?? (i.slaHours ? `${i.slaHours}h SLA` : null), raw: i.dueAt ?? undefined },
              {
                label: 'Blocked milestone',
                value: i.blockingMilestones.length ? i.blockingMilestones.map(milestoneLabel).join(', ') : 'None',
                raw: i.blockingMilestones.join(', '),
              },
            ]}
          />
          {i.resolutionRequirements.length > 0 ? (
            <div className="cd-issue-card__reqs">
              <span className="cd-issue-card__label">Resolution requirements</span>
              <ul>{i.resolutionRequirements.map((r) => <li key={r}>{r}</li>)}</ul>
            </div>
          ) : null}
          {i.evidence.length > 0 ? (
            <div className="cd-issue-card__evidence">
              <span className="cd-issue-card__label">Supporting evidence</span>
              <ul>{i.evidence.map((e) => <li key={e.documentId}>{e.label}</li>)}</ul>
            </div>
          ) : null}
          {i.resolutionNote || i.resolvedAt ? (
            <p className="cd-issue-card__history">
              {i.resolvedAt ? `Resolved ${formatTimestamp(i.resolvedAt)}` : 'In progress'}
              {i.resolutionNote ? ` — ${i.resolutionNote}` : ''}
            </p>
          ) : null}
        </article>
      ))}
    </section>
  )
}

export function DossierTasksSection({ c }: { c: ClosingCase }) {
  return (
    <section className="cd-dossier-section" aria-labelledby="cd-section-tasks">
      <h3 id="cd-section-tasks">Tasks &amp; SLA</h3>
      {c.tasks.length === 0 ? (
        <p className="cd-absent">Tasks not yet projected from Podio into Supabase. SLA fields below reflect health engine output only.</p>
      ) : null}
      <DossierFactGrid
        items={[
          { label: 'Open tasks', value: String(c.tasks.length), kind: 'derived' },
          { label: 'SLA deadline', value: formatDatePresent(c.health.slaDeadline), raw: c.health.slaDeadline ?? undefined, kind: 'derived' },
          { label: 'Responsible party', value: c.health.responsibleParty, emptyLabel: 'Unassigned', kind: 'derived' },
        ]}
      />
    </section>
  )
}

export function DossierDocumentsSection({ c }: { c: ClosingCase }) {
  return (
    <section className="cd-dossier-section" aria-labelledby="cd-section-documents">
      <h3 id="cd-section-documents">Documents</h3>
      {c.documents.length === 0 ? (
        <p className="cd-absent">Documents ({c.documents.length}) not yet projected from closing mirror.</p>
      ) : (
        <ul className="cd-doc-list">
          {c.documents.map((d) => (
            <li key={d.documentId}>
              <strong>{d.label}</strong>
              <span>{humanizeEnum(d.kind) ?? d.kind}</span>
              <small>{d.receivedAt ? formatTimestamp(d.receivedAt) : 'Not received'}</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function DossierCommunicationsSection() {
  return (
    <section className="cd-dossier-section" aria-labelledby="cd-section-comms">
      <h3 id="cd-section-comms">Communications</h3>
      <p className="cd-absent">Communications timeline not yet mirrored from message events. No outbound messages can be sent from Closing Desk.</p>
    </section>
  )
}

export function DossierFinancialsSection({ c }: { c: ClosingCase }) {
  return (
    <section className="cd-dossier-section" aria-labelledby="cd-section-financials">
      <h3 id="cd-section-financials">Financials</h3>
      <DossierFactGrid
        items={[
          { label: 'Seller contract', value: money(c.financials.sellerContractPrice) },
          { label: 'Buyer price', value: money(c.financials.buyerPrice) },
          { label: 'Assignment fee', value: money(c.financials.assignmentFee) },
          { label: 'Expected gross', value: money(c.financials.expectedGrossRevenue), kind: 'derived' },
          { label: 'Confirmed gross', value: money(c.financials.confirmedGrossRevenue), emptyLabel: 'Not confirmed' },
          { label: 'Net revenue', value: money(c.financials.netRevenue) },
          { label: 'Revenue status', value: humanizeEnum(c.financials.revenueStatus), raw: c.financials.revenueStatus },
          { label: 'Funding source', value: c.financials.fundingSource },
        ]}
      />
      <div className="cd-revenue-compare" aria-label="Expected versus confirmed revenue">
        <div className="cd-revenue-compare__col">
          <span>Expected (projected)</span>
          <strong>{money(c.financials.expectedGrossRevenue) ?? '—'}</strong>
        </div>
        <div className="cd-revenue-compare__col is-confirmed">
          <span>Confirmed (booked)</span>
          <strong>{money(c.financials.confirmedGrossRevenue) ?? 'Not confirmed'}</strong>
        </div>
      </div>
    </section>
  )
}

export function DossierAuditSection({ c, isFixture }: { c: ClosingCase; isFixture: boolean }) {
  return (
    <section className="cd-dossier-section" aria-labelledby="cd-section-audit">
      <h3 id="cd-section-audit">Audit trail</h3>
      <DossierFactGrid
        items={[
          { label: 'Fully backed', value: c.provenance.fullyBacked ? 'Yes' : 'No', kind: 'derived' },
          { label: 'Last activity', value: formatTimestamp(c.lastActivityAt), raw: c.lastActivityAt ?? undefined },
          { label: 'Lane', value: boardColumnLabel(c.boardColumn), raw: c.boardColumn },
          { label: 'Stage', value: stageLabel(c.universalStage), raw: c.universalStage },
        ]}
      />
      {c.provenance.degraded.map((d, i) => (
        <p className="cd-diag-line" key={i}>{d}</p>
      ))}
      <SourceDetails identity={c.identity} isFixture={isFixture} />
    </section>
  )
}