import { useCallback, useMemo, useState, type KeyboardEvent } from 'react'
import type { ClosingCase } from '../../../domain/closing-desk/closing-desk.types'
import { UniversalLeadStateControls } from '../../../domain/lead-state/UniversalLeadStateControls'
import { boardColumnLabel } from '../../../domain/closing-desk/closing-board'
import { buildCopilotReadout } from '../../../domain/closing-desk/closing-copilot'
import { orderIssues } from '../../../domain/closing-desk/closing-issues'
import { ClosingReadinessRing } from './ClosingReadinessRing'
import { daysRemaining, money, primaryBlocker, stageLabel } from '../closing-desk-utils'
import { formatClosingDate, formatDaysToClose, formatTimestamp, humanizeOperatorText } from '../closing-desk-present'
import {
  DossierAuditSection,
  DossierBuyerSection,
  DossierCommunicationsSection,
  DossierContractSection,
  DossierDocumentsSection,
  DossierFinancialsSection,
  DossierIssuesSection,
  DossierMilestonesSection,
  DossierOverviewSection,
  DossierPartiesSection,
  DossierTasksSection,
  DossierTitleSection,
} from './dossier-sections'

export const DOSSIER_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'contract', label: 'Contract' },
  { id: 'parties', label: 'Parties & Authority' },
  { id: 'buyer', label: 'Buyer / Assignment' },
  { id: 'title', label: 'Title & Escrow' },
  { id: 'milestones', label: 'Milestones' },
  { id: 'issues', label: 'Issues / Curative' },
  { id: 'tasks', label: 'Tasks & SLA' },
  { id: 'documents', label: 'Documents' },
  { id: 'communications', label: 'Communications' },
  { id: 'financials', label: 'Financials' },
  { id: 'audit', label: 'Audit Trail' },
] as const

export type DossierSectionId = (typeof DOSSIER_SECTIONS)[number]['id']

export interface ClosingCaseWorkspaceProps {
  closingCase: ClosingCase
  onClose: () => void
}

export function ClosingCaseWorkspace({ closingCase: c, onClose }: ClosingCaseWorkspaceProps) {
  const [section, setSection] = useState<DossierSectionId>('overview')
  const [explainHealthOpen, setExplainHealthOpen] = useState(false)
  const [whyActionOpen, setWhyActionOpen] = useState(false)

  const copilot = useMemo(() => buildCopilotReadout(c), [c])
  const isFixture = c.provenance.fields.identity === 'fixture'
  const blocker = primaryBlocker(c)
  const days = c.health.daysUntilClosing ?? daysRemaining(c.dates.scheduledClosingDate)
  const milestonePct = c.milestones.length > 0 ? Math.min(100, Math.round((c.milestones.length / 8) * 100)) : 0
  const primaryThreadKey = c.identity.primaryThreadKey
  const leadStateThread = useMemo(() => {
    if (!primaryThreadKey) return null
    return {
      threadKey: primaryThreadKey,
      thread_key: primaryThreadKey,
      id: primaryThreadKey,
      lifecycle_stage: c.universalStage,
      next_action: c.health.nextRequiredAction,
    }
  }, [c.health.nextRequiredAction, c.universalStage, primaryThreadKey])

  const primaryInsight = copilot.insights.find((i) => i.kind === 'blocker') ?? copilot.insights.find((i) => i.kind === 'summary')
  const primaryRec = copilot.proposedActions[0]
  const riskInsight = copilot.insights.find((i) => i.kind === 'risk')

  const onNavKeyDown = useCallback(
    (e: KeyboardEvent, idx: number) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault()
        const next = DOSSIER_SECTIONS[(idx + 1) % DOSSIER_SECTIONS.length]
        setSection(next.id)
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault()
        const prev = DOSSIER_SECTIONS[(idx - 1 + DOSSIER_SECTIONS.length) % DOSSIER_SECTIONS.length]
        setSection(prev.id)
      }
    },
    [],
  )

  const sectionPanel = (() => {
    switch (section) {
      case 'overview':
        return <DossierOverviewSection c={c} copilot={copilot} />
      case 'contract':
        return <DossierContractSection c={c} />
      case 'parties':
        return <DossierPartiesSection c={c} />
      case 'buyer':
        return <DossierBuyerSection c={c} />
      case 'title':
        return <DossierTitleSection c={c} />
      case 'milestones':
        return <DossierMilestonesSection c={c} />
      case 'issues':
        return <DossierIssuesSection c={c} />
      case 'tasks':
        return <DossierTasksSection c={c} />
      case 'documents':
        return <DossierDocumentsSection c={c} />
      case 'communications':
        return <DossierCommunicationsSection />
      case 'financials':
        return <DossierFinancialsSection c={c} />
      case 'audit':
        return <DossierAuditSection c={c} isFixture={isFixture} />
      default:
        return null
    }
  })()

  const activeLabel = DOSSIER_SECTIONS.find((s) => s.id === section)?.label ?? 'Overview'

  return (
    <div
      className="cd-dossier-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Closing case ${c.displayName}`}
      onClick={onClose}
    >
      <div className="cd-dossier" onClick={(e) => e.stopPropagation()} data-testid="cd-dossier">
        <header className="cd-dossier__command cd-dossier__command--sticky">
          <div className="cd-dossier__identity">
            <p className="cd-dossier__eyebrow">TRANSACTION DOSSIER</p>
            <h2 title={c.displayName}>{c.displayName}</h2>
            {c.propertyAddress && c.propertyAddress !== c.displayName ? (
              <p className="cd-dossier__subaddress" title={c.propertyAddress}>{c.propertyAddress}</p>
            ) : null}
            <div className="cd-dossier__chips">
              <span>{c.market ?? 'Market unknown'}</span>
              <span>{stageLabel(c.universalStage)}</span>
              <span>{boardColumnLabel(c.boardColumn)}</span>
              {isFixture ? <span className="cd-dossier__fixture-chip" data-testid="cd-dossier-fixture">Synthetic Fixture</span> : null}
            </div>
          </div>
          <div className="cd-dossier__vitals">
            <ClosingReadinessRing score={c.health.score} band={c.health.band} size={64} />
            <div className="cd-dossier__countdown">
              <strong>{formatDaysToClose(days)}</strong>
              <span>days to close</span>
              <small title={c.dates.scheduledClosingDate ?? undefined}>{formatClosingDate(c.dates.scheduledClosingDate)}</small>
            </div>
            <div className="cd-dossier__revenue">
              <strong>{money(c.financials.expectedGrossRevenue) ?? '—'}</strong>
              <span>expected revenue</span>
              <small className="cd-dossier__revenue-note">
                {c.financials.confirmedGrossRevenue !== null
                  ? `Confirmed ${money(c.financials.confirmedGrossRevenue)}`
                  : 'Not yet confirmed'}
              </small>
            </div>
          </div>
          <button className="cd-dossier__close" onClick={onClose} aria-label="Close dossier">×</button>
        </header>

        <div className="cd-dossier__copilot-compact" data-testid="cd-copilot-compact">
          <div className="cd-dossier__copilot-head">
            <span className="cd-dossier__copilot-label">Copilot</span>
            <span className="cd-dossier__copilot-badge">Read only</span>
          </div>
          {primaryInsight ? (
            <p className="cd-dossier__copilot-rec">
              <strong>{humanizeOperatorText(primaryRec?.label ?? primaryInsight.headline)}</strong>
              <span>{blocker ? blocker.title : humanizeOperatorText(primaryInsight.detail)}</span>
            </p>
          ) : null}
          <div className="cd-dossier__copilot-actions">
            <button type="button" className="cd-btn cd-btn--ghost" onClick={() => setExplainHealthOpen((v) => !v)} aria-expanded={explainHealthOpen}>
              Explain health
            </button>
            {primaryRec ? (
              <button type="button" className="cd-btn cd-btn--ghost" onClick={() => setWhyActionOpen((v) => !v)} aria-expanded={whyActionOpen}>
                Why this action?
              </button>
            ) : null}
          </div>
          {explainHealthOpen ? (
            <div className="cd-dossier__copilot-expand" data-testid="cd-explain-health">
              <p>{humanizeOperatorText(copilot.insights.find((i) => i.kind === 'summary')?.detail ?? 'Health derived from readiness, milestones, and issues.')}</p>
              <ul>{c.health.factors.slice(0, 5).map((f) => <li key={f.rule}>{f.label}: {humanizeOperatorText(f.evidence)}</li>)}</ul>
              {riskInsight ? <p>{humanizeOperatorText(riskInsight.detail)}</p> : null}
            </div>
          ) : null}
          {whyActionOpen && primaryRec ? (
            <div className="cd-dossier__copilot-expand" data-testid="cd-why-action">
              <p>{humanizeOperatorText(primaryRec.rationale)}</p>
              <ul>{primaryRec.citedFacts.map((f) => <li key={f}>{humanizeOperatorText(f)}</li>)}</ul>
            </div>
          ) : null}
        </div>

        <div className="cd-dossier__next" data-testid="cd-next-action">
          <strong className="cd-dossier__next-label">Next required action</strong>
          <p>{c.health.nextRequiredAction ?? 'None pending'}</p>
          <small>{c.health.responsibleParty ?? 'Unassigned'} · SLA {formatTimestamp(c.health.slaDeadline) ?? 'none'}</small>
        </div>

        {leadStateThread ? (
          <div className="cd-dossier__lead-state" data-testid="cd-lead-state">
            <UniversalLeadStateControls
              thread={leadStateThread}
              sourceView="closing_desk"
              compact
            />
          </div>
        ) : null}

        {blocker ? (
          <div className="cd-dossier__blocker" data-sev={blocker.severity} data-testid="cd-primary-blocker">
            <span className="cd-dossier__blocker-label">Primary blocker</span>
            <strong className="cd-dossier__blocker-title">{blocker.title}</strong>
            <small className="cd-dossier__blocker-owner">{blocker.owner ?? 'Unassigned'}</small>
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

        <div className="cd-dossier__layout">
          <nav className="cd-dossier__nav" aria-label="Dossier sections">
            <div className="cd-dossier__nav-mobile">
              <label className="cd-dossier__nav-select-label" htmlFor="cd-dossier-section-select">Section</label>
              <select
                id="cd-dossier-section-select"
                className="cd-dossier__nav-select"
                value={section}
                onChange={(e) => setSection(e.target.value as DossierSectionId)}
                data-testid="cd-dossier-section-select"
              >
                {DOSSIER_SECTIONS.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </div>
            <div className="cd-dossier__nav-rail" role="tablist" aria-label="Dossier sections">
              {DOSSIER_SECTIONS.map((s, idx) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  id={`cd-tab-${s.id}`}
                  aria-selected={section === s.id}
                  aria-controls={`cd-panel-${s.id}`}
                  className={section === s.id ? 'is-active' : ''}
                  onClick={() => setSection(s.id)}
                  onKeyDown={(e) => onNavKeyDown(e, idx)}
                  data-testid={`cd-dossier-tab-${s.id}`}
                >
                  {s.label}
                  {s.id === 'issues' && orderIssues(c.issues).length > 0 ? (
                    <span className="cd-dossier__nav-badge">{orderIssues(c.issues).length}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </nav>

          <div
            className="cd-dossier__body"
            role="tabpanel"
            id={`cd-panel-${section}`}
            aria-labelledby={`cd-tab-${section}`}
            data-testid="cd-dossier-panel"
          >
            <h2 className="cd-dossier__panel-title">{activeLabel}</h2>
            {sectionPanel}
          </div>
        </div>
      </div>
    </div>
  )
}