/**
 * DEAL INTELLIGENCE — the mobile decision surface.
 *
 *   Decision  what the engine concluded, how sure, what could break it
 *   Evidence  comps · seller facts (with provenance) · debt · history · demand
 *   Model     scenario lab · sensitivity · method & lineage
 *
 * Read-only against /api/cockpit/deal-intelligence/decision. The only write
 * reachable from here is the existing canonical "re-run decision engine"
 * (passed in by the host, behind a confirm); there is no offer button, no
 * stage move, and a scenario is never persisted.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { pushRoutePath } from '../../../../app/router'
import { writeMapFocusSet } from '../../../../domain/map/map-focus-set'
import type { DealDecision } from '../../../../domain/deal-intelligence/deal-decision-api'
import { fetchDealDecision } from '../../../../domain/deal-intelligence/deal-decision-api'
import { cls, DdLink } from './dd-primitives'
import { DecisionHero, DecisionSummary, OfferIntelligence, RiskList, StrategyStack, ValuationSpectrum } from './DecisionLayer'
import { BuyerDemand, CompEvidence, DebtAndLiens, HistoryTimeline, SellerFacts, ValuationTrend } from './EvidenceLayer'
import { Methodology, ScenarioLab, Sensitivity } from './ModelLayer'
import './deal-decision.css'

type Layer = 'decision' | 'evidence' | 'model'
const LAYERS: Array<{ key: Layer; label: string }> = [
  { key: 'decision', label: 'Decision' },
  { key: 'evidence', label: 'Evidence' },
  { key: 'model', label: 'Model' },
]

export interface DealDecisionSurfaceProps {
  propertyId?: string | null
  threadKey?: string | null
  /** Bumped by the host after a canonical engine run completes. */
  refreshKey?: number
  onOpenConversation?: (() => void) | null
  onRunEngine?: (() => void) | null
  engineBusy?: boolean
  /** The resolved subject, so a host with no dossier can still name it. */
  onSubject?: (subject: DealDecision['subject']) => void
}

export function DealDecisionSurface({ propertyId, threadKey, refreshKey = 0, onOpenConversation, onRunEngine, engineBusy, onSubject }: DealDecisionSurfaceProps) {
  const [data, setData] = useState<DealDecision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [layer, setLayer] = useState<Layer>('decision')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const subjectKey = `${propertyId ?? ''}|${threadKey ?? ''}`

  const load = useCallback((signal?: AbortSignal) => {
    if (!propertyId && !threadKey) { setLoading(false); setError('no_subject'); return }
    setLoading(true)
    setError(null)
    fetchDealDecision({ propertyId, threadKey }, signal)
      .then((d) => { if (!signal?.aborted) { setData(d); onSubject?.(d.subject) } })
      .catch((e: Error) => { if (!signal?.aborted) setError(e.message || 'deal_decision_failed') })
      .finally(() => { if (!signal?.aborted) setLoading(false) })
  // eslint-disable-next-line react-hooks/exhaustive-deps -- onSubject is a notifier, not an input
  }, [propertyId, threadKey])

  useEffect(() => {
    const ctrl = new AbortController()
    load(ctrl.signal)
    return () => ctrl.abort()
  }, [load, refreshKey])

  // A different subject starts clean — never paint one property's numbers under another's header.
  useEffect(() => { setData(null); setLayer('decision') }, [subjectKey])

  const pick = (l: Layer) => {
    setLayer(l)
    const top = rootRef.current
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  if (!data) {
    return (
      <div className="ddx" ref={rootRef}>
        {loading ? (
          <div className="ddx-boot" aria-busy="true">
            <div className="ddx-boot__hero" />
            <div className="ddx-boot__rail" />
            <div className="ddx-boot__line" />
            <div className="ddx-boot__line is-short" />
          </div>
        ) : (
          <div className="ddx-fail">
            <Icon name="alert-circle" />
            <p>{error === 'property_not_found' ? 'No property record to underwrite.' : error === 'no_subject' ? 'This conversation isn’t linked to a property yet.' : 'Couldn’t load the underwriting.'}</p>
            {error !== 'no_subject' && error !== 'property_not_found' ? <button type="button" className="ddx-btn" onClick={() => load()}>Retry</button> : null}
          </div>
        )}
      </div>
    )
  }

  const d = data
  const pid = d.subject.propertyId
  const openComps = () => pushRoutePath(`/comp-intelligence?property_id=${encodeURIComponent(pid)}`)
  const openBuyers = () => pushRoutePath(`/buyer-match?property_id=${encodeURIComponent(pid)}`)
  const openGraph = () => pushRoutePath(`/entity-graph/property/${encodeURIComponent(pid)}`)
  const openPipeline = () => d.pipeline && pushRoutePath(`/pipeline?opp=${encodeURIComponent(d.pipeline.opportunityId)}`)
  const openMap = () => {
    if (d.subject.lat !== null && d.subject.lng !== null) {
      writeMapFocusSet({ label: d.subject.address ?? 'This property', tone: 'property', points: [{ lat: d.subject.lat, lng: d.subject.lng, id: pid, label: d.subject.address }] })
    }
    pushRoutePath('/map')
  }
  const layerIndex = LAYERS.findIndex((l) => l.key === layer)

  return (
    <div className={cls('ddx', loading && 'is-refreshing')} ref={rootRef}>
      {d.subject.isCanary ? <div className="ddx-canary"><Icon name="flag" /> Test property — not a real deal</div> : null}
      <DecisionHero d={d} />
      <ValuationSpectrum d={d} />

      <nav className="ddx-layers" role="tablist" aria-label="Deal intelligence layers" style={{ ['--i' as string]: layerIndex }}>
        <span className="ddx-layers__glide" aria-hidden="true" />
        {LAYERS.map((l) => (
          <button key={l.key} type="button" role="tab" aria-selected={layer === l.key} className={cls('ddx-layers__tab', layer === l.key && 'is-on')} onClick={() => pick(l.key)}>
            {l.label}
            {l.key === 'decision' && d.risks.some((r) => r.severity === 'critical') ? <i className="ddx-layers__dot" /> : null}
          </button>
        ))}
      </nav>

      <div className="ddx-layer" key={layer}>
        {layer === 'decision' ? (
          <>
            <DecisionSummary d={d} onRunEngine={onRunEngine} engineBusy={engineBusy} />
            <RiskList d={d} />
            <OfferIntelligence d={d} />
            <StrategyStack d={d} />
            <div className="ddx-links">
              <DdLink icon="message" label="Conversation" onClick={() => onOpenConversation?.()} disabled={!onOpenConversation} />
              <DdLink icon="layers" label="Pipeline" sub={d.pipeline?.stageLabel ?? 'no deal'} onClick={openPipeline} disabled={!d.pipeline} />
              <DdLink icon="stats" label="Comps" onClick={openComps} />
              <DdLink icon="users" label="Buyer Match" onClick={openBuyers} />
              <DdLink icon="radar" label="Entity Graph" onClick={openGraph} />
              <DdLink icon="map" label="Map" onClick={openMap} />
            </div>
          </>
        ) : null}
        {layer === 'evidence' ? (
          <>
            <CompEvidence d={d} onOpenComps={openComps} />
            <SellerFacts d={d} />
            <DebtAndLiens d={d} />
            <HistoryTimeline d={d} />
            <ValuationTrend d={d} />
            <BuyerDemand d={d} onOpenBuyers={openBuyers} />
          </>
        ) : null}
        {layer === 'model' ? (
          <>
            <ScenarioLab key={d.lineage.computedAt ?? 'none'} d={d} />
            <Sensitivity d={d} />
            <Methodology d={d} onRunEngine={onRunEngine} engineBusy={engineBusy} />
          </>
        ) : null}
      </div>
    </div>
  )
}
