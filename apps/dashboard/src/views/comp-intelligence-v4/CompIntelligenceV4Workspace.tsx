/**
 * Comp Intelligence V4 — workspace root.
 *
 * Full-height two-pane institutional workspace:
 *   LEFT  (52–56%) — persistent spatial evidence map
 *   RIGHT (44–48%) — sticky subject header · decision ribbon · market summary ·
 *                    search controls · evidence list · dossier drawer
 *
 * Consumes the read-only canonical projection. No valuation is computed here.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import './styles/comp-v4.css'
import { useCompV4Projection } from './hooks/useCompV4Projection'
import { filterByTier, tierCounts, useCompV4Search } from './hooks/useCompV4Search'
import { tierLabel } from './adapters/labels'
import { EvidenceMapPane } from './components/EvidenceMapPane'
import { SubjectStickyHeader } from './components/SubjectStickyHeader'
import { QualifiedMarketSummary } from './components/QualifiedMarketSummary'
import { SearchControlBar } from './components/SearchControlBar'
import { AcquisitionRibbon } from './components/AcquisitionRibbon'
import { CompEvidenceList } from './components/CompEvidenceList'
import { CompDossierDrawer } from './components/CompDossierDrawer'

export interface CompV4Identity {
  propertyId?: string | null
  opportunityId?: string | null
  threadKey?: string | null
  masterOwnerId?: string | null
}

export interface CompIntelligenceV4WorkspaceProps {
  /** Canonical selection context from the host (Inbox, Map, Queue, …). */
  dealContext?: CompV4Identity | null
  /** Direct override (used by the dev harness route). */
  identity?: CompV4Identity | null
  paneWidth?: '25' | '50' | '75' | '100'
  paused?: boolean
}

function useThemeMode(): { isLight: boolean } {
  const read = () =>
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-nexus-theme') === 'light'
  const [isLight, setIsLight] = useState<boolean>(read())
  useEffect(() => {
    if (typeof document === 'undefined') return
    const obs = new MutationObserver(() => setIsLight(read()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-nexus-theme'] })
    return () => obs.disconnect()
  }, [])
  return { isLight }
}

export default function CompIntelligenceV4Workspace(props: CompIntelligenceV4WorkspaceProps) {
  const { paneWidth = '100', paused = false } = props
  const identity = props.identity ?? props.dealContext ?? null
  const propertyId = identity?.propertyId ?? null

  const search = useCompV4Search()
  const { isLight } = useThemeMode()

  const { status, model, error } = useCompV4Projection({
    propertyId: paused ? null : propertyId,
    opportunityId: identity?.opportunityId,
    threadKey: identity?.threadKey,
    masterOwnerId: identity?.masterOwnerId,
    radiusMiles: search.radiusMiles,
    monthsBack: search.monthsBack,
  })

  // Universal context: reset stale selection + tier when the subject changes.
  const lastPropertyRef = useRef<string | null>(propertyId)
  const autoTierRef = useRef<string | null>(null)
  useEffect(() => {
    if (lastPropertyRef.current !== propertyId) {
      lastPropertyRef.current = propertyId
      autoTierRef.current = null
      search.select(null)
      search.closeDossier()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId])

  // Smart default tier: lead with Qualified when canonical qualified comps exist,
  // otherwise fall back to All so the operator still sees the evidence. Runs once
  // per subject and never overrides a manual tier change.
  const hasQualified = model?.summary.hasQualified ?? false
  useEffect(() => {
    if (!model || autoTierRef.current === propertyId) return
    autoTierRef.current = propertyId
    search.setTier(hasQualified ? 'qualified' : 'all')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, propertyId, hasQualified])

  const evidence = model?.evidence ?? []
  const visibleEvidence = useMemo(
    () => filterByTier(evidence, search.tier),
    [evidence, search.tier],
  )
  const selectedEvidence = useMemo(
    () => evidence.find((e) => e.id === search.selectedId) ?? null,
    [evidence, search.selectedId],
  )
  const showExcluded = search.tier === 'excluded' || search.tier === 'all'

  const widthClass = `is-width-${paneWidth}`
  const busy = status === 'refreshing' || status === 'loading'

  if (!propertyId) {
    return (
      <div className={`civ4-root ${widthClass}`}>
        <div className="civ4-blank">
          <span className="civ4-blank__title">No property selected</span>
          <span className="civ4-blank__hint">Select a property to open Comp Intelligence.</span>
        </div>
      </div>
    )
  }

  if (status === 'loading' && !model) {
    return (
      <div className={`civ4-root ${widthClass}`}>
        <CompShellSkeleton />
      </div>
    )
  }

  if (!model) {
    return (
      <div className={`civ4-root ${widthClass}`}>
        <div className="civ4-blank">
          <span className="civ4-blank__title">Comp intelligence unavailable</span>
          <span className="civ4-blank__hint">{error ?? 'No projection returned for this property.'}</span>
        </div>
      </div>
    )
  }

  const counts = tierCounts(evidence)

  return (
    <div className={`civ4-root ${widthClass}`} data-busy={busy ? 'true' : 'false'}>
      <SearchControlBar
        radiusMiles={search.radiusMiles}
        monthsBack={search.monthsBack}
        tier={search.tier}
        mapStyle={search.mapStyle}
        counts={counts}
        busy={busy}
        onRadius={search.setRadius}
        onMonthsBack={search.setMonthsBack}
        onTier={search.setTier}
        onMapStyle={search.setMapStyle}
      />

      <div className="civ4-panes">
        <div className="civ4-pane civ4-pane--map">
          <EvidenceMapPane
            subject={model.subject}
            evidence={evidence}
            radiusMiles={search.radiusMiles}
            mapStyle={search.mapStyle}
            isLightTheme={isLight}
            selectedId={search.selectedId}
            hoveredId={search.hoveredId}
            showExcluded={showExcluded}
            onSelect={search.select}
            onHover={search.setHovered}
            onOpenDossier={search.openDossier}
          />
        </div>

        <div className="civ4-pane civ4-pane--intel">
          <SubjectStickyHeader
            subject={model.subject}
            radiusMiles={search.radiusMiles}
            monthsBack={search.monthsBack}
            qualifiedCount={model.summary.qualified}
            onOpenDossier={() => undefined}
          />
          <div className="civ4-intel__scroll">
            <AcquisitionRibbon decision={model.decision} onViewUnderwriting={() => undefined} />
            <QualifiedMarketSummary summary={model.summary} />
            <CompEvidenceList
              evidence={visibleEvidence}
              subject={model.subject}
              tierLabel={tierLabel(search.tier)}
              totalDiscovered={model.summary.discovered}
              selectedId={search.selectedId}
              hoveredId={search.hoveredId}
              onHover={search.setHovered}
              onSelect={search.select}
              onOpenDossier={search.openDossier}
            />
          </div>
        </div>
      </div>

      <CompDossierDrawer
        open={search.dossierOpen}
        subject={model.subject}
        evidence={selectedEvidence}
        onClose={search.closeDossier}
      />
    </div>
  )
}

function CompShellSkeleton() {
  return (
    <div className="civ4-skeleton">
      <div className="civ4-skeleton__controls" />
      <div className="civ4-skeleton__panes">
        <div className="civ4-skeleton__map" />
        <div className="civ4-skeleton__intel">
          <div className="civ4-skeleton__subject" />
          <div className="civ4-skeleton__row" />
          <div className="civ4-skeleton__card" />
          <div className="civ4-skeleton__card" />
        </div>
      </div>
    </div>
  )
}
