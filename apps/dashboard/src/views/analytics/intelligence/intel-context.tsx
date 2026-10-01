/**
 * ANALYTICS 4.0 — what every section of the Lab shares: the one analytical
 * state, the registry (definitions), the period envelope, and the two ways to
 * go deeper — the contextual inspector (a definition, a bucket, an event, a
 * market, a campaign, a stage, the filters) and the exact records behind a
 * number.
 */
import { createContext, useContext } from 'react'
import type { DimensionDef, LabOverview, MetricDef, RecordCohort } from '../../../domain/analytics/analytics-lab-api'
import type { IntelActions, IntelContext } from './intel-state'
import type { IntelEvent, IntelRegistry, MoneyDeal } from './intel-model'

export type Subject =
  | { kind: 'metric'; id: string }
  | { kind: 'bucket'; metric: string; start: number; end: number }
  | { kind: 'event'; event: IntelEvent; group?: IntelEvent[] }
  | { kind: 'group'; dim: string; key: string; label: string; metric?: string }
  | { kind: 'stage'; code: string }
  | { kind: 'deal'; deal: MoneyDeal }
  | { kind: 'filters' }

export type RecordsRequest = { cohort: RecordCohort; title: string }

export type LabShared = {
  ctx: IntelContext
  act: IntelActions
  registry: IntelRegistry
  defs: Record<string, MetricDef>
  dims: Record<string, DimensionDef>
  overview: LabOverview | null
  /** current data is being replaced by a newer read (shown dimmed) */
  refreshing: boolean
  inspect: (s: Subject) => void
  records: (r: RecordsRequest) => void
}

export const LabContextReact = createContext<LabShared | null>(null)

export function useLab(): LabShared {
  const v = useContext(LabContextReact)
  if (!v) throw new Error('useLab outside the Intelligence Lab')
  return v
}
