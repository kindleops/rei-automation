/**
 * Comp Intelligence V4 — search / filter / selection state.
 *
 * Owns the operator's control state (radius, lookback, evidence tier, map style,
 * selected comp). Checkpoint 1 wires radius + lookback + tier + map style + map
 * fit live; the full advanced-filter matrix lands in Checkpoint 4.
 */

import { useCallback, useState } from 'react'
import type { EvidenceState, V4Evidence } from '../state/types'

export type EvidenceTierFilter =
  | 'qualified'
  | 'candidate'
  | 'review'
  | 'demand_only'
  | 'excluded'
  | 'all'
export type MapStyleMode = 'street' | 'satellite' | 'hybrid'

export type DossierTarget = { kind: 'subject' } | { kind: 'comp'; id: string }

export const RADIUS_OPTIONS = [0.25, 0.5, 1, 1.5, 3, 5] as const
export const LOOKBACK_OPTIONS = [3, 6, 12, 18, 24, 36] as const

export interface CompV4SearchState {
  radiusMiles: number
  monthsBack: number
  tier: EvidenceTierFilter
  mapStyle: MapStyleMode
  selectedId: string | null
  hoveredId: string | null
  dossierOpen: boolean
  setRadius: (miles: number) => void
  setMonthsBack: (months: number) => void
  setTier: (tier: EvidenceTierFilter) => void
  setMapStyle: (style: MapStyleMode) => void
  select: (id: string | null) => void
  setHovered: (id: string | null) => void
  openDossier: (id: string) => void
  closeDossier: () => void
}

export function useCompV4Search(initial?: Partial<CompV4SearchState>): CompV4SearchState {
  const [radiusMiles, setRadius] = useState(initial?.radiusMiles ?? 1)
  const [monthsBack, setMonthsBack] = useState(initial?.monthsBack ?? 6)
  const [tier, setTier] = useState<EvidenceTierFilter>(initial?.tier ?? 'qualified')
  const [mapStyle, setMapStyle] = useState<MapStyleMode>(initial?.mapStyle ?? 'street')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [dossierOpen, setDossierOpen] = useState(false)

  const openDossier = useCallback((id: string) => {
    setSelectedId(id)
    setDossierOpen(true)
  }, [])

  const closeDossier = useCallback(() => setDossierOpen(false), [])

  const select = useCallback((id: string | null) => setSelectedId(id), [])

  return {
    radiusMiles,
    monthsBack,
    tier,
    mapStyle,
    selectedId,
    hoveredId,
    dossierOpen,
    setRadius,
    setMonthsBack,
    setTier,
    setMapStyle,
    select,
    setHovered: setHoveredId,
    openDossier,
    closeDossier,
  }
}

/** Visible evidence for the active tier filter. Markers always show all states. */
export function filterByTier(evidence: V4Evidence[], tier: EvidenceTierFilter): V4Evidence[] {
  if (tier === 'all') return evidence
  const want = tier as EvidenceState
  return evidence.filter((e) => e.state === want)
}

/** Count helper keyed by tier (for control chips). */
export function tierCounts(evidence: V4Evidence[]): Record<EvidenceTierFilter, number> {
  const c: Record<EvidenceTierFilter, number> = {
    qualified: 0,
    candidate: 0,
    review: 0,
    demand_only: 0,
    excluded: 0,
    all: evidence.length,
  }
  for (const e of evidence) c[e.state as EvidenceState] += 1
  return c
}
