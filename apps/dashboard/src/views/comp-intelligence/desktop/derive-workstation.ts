import type { CompsWorkspace, EngineRules, EngineRun, EvidenceComp } from '../../../domain/comp-intelligence/comps-evidence-api'
import { outlierBand, parityWithStored, replaySet, type Parity, type ReplayOfSet } from '../../../domain/comp-intelligence/comps-valuation-replay'
import {
  weightAgedMaterially,
  assetKind, evidenceDepth, passesFilters, unitMetricFor, type AssetKind, type CompFilters, type EvidenceDepth, type UnitMetric,
} from '../../../domain/comp-intelligence/comps-workstation-model'
import type { OperatorState } from './use-operator-set'

export type Lens = 'system' | 'operator'
export type Tier = 'set' | 'added' | 'removed' | 'candidate' | 'excluded'

export interface Workstation {
  w: CompsWorkspace
  /** the payload's own clock — every age is measured from when the evidence was read */
  now: number
  kind: AssetKind
  metric: UnitMetric
  rules: EngineRules | null
  run: EngineRun | null
  byKey: Map<string, EvidenceComp>
  systemKeys: Set<string>
  operatorKeys: Set<string> | null
  lens: Lens
  lensKeys: Set<string>
  /** the set being shown, heaviest engine weight first */
  lensComps: EvidenceComp[]
  /** operator lens: system comps the operator took out */
  removed: EvidenceComp[]
  added: Set<string>
  /** admissible sales in the search, outside the shown set, passing the filters */
  candidates: EvidenceComp[]
  /** ruled-out sales in the search, passing the filters */
  excluded: EvidenceComp[]
  /** admissible sales in the search before filters (the universe) */
  universeCount: number
  excludedCount: number
  tiers: Map<string, Tier>
  systemReplay: ReplayOfSet
  operatorReplay: ReplayOfSet | null
  lensReplay: ReplayOfSet
  parity: Parity
  band: { low: number; high: number; median: number; allowed: number } | null
  depth: EvidenceDepth
  /** the stored valuation is comp evidence (not the record-estimate fallback) */
  comparableValuation: boolean
  /** days since the engine priced this subject */
  runAgeDays: number | null
  drift: { aged: number; rejected: number }
}

const byWeight = (a: EvidenceComp, b: EvidenceComp) =>
  (b.engine?.weight ?? -1) - (a.engine?.weight ?? -1) || (a.distanceMiles ?? 99) - (b.distanceMiles ?? 99)

export function deriveWorkstation(w: CompsWorkspace, operator: OperatorState | null, operatorKeys: Set<string> | null, lensWanted: Lens, filters: CompFilters): Workstation {
  const now = Date.parse(w.generatedAt) || 0
  const kind = assetKind(w.subject.family)
  const metric = unitMetricFor(kind)
  const byKey = new Map<string, EvidenceComp>()
  for (const c of w.comps) byKey.set(c.key, c)
  // an operator's added comp stays priceable after it leaves the loaded search
  for (const [k, snap] of Object.entries(operator?.snapshots ?? {})) if (!byKey.has(k)) byKey.set(k, { ...snap, outsideSearch: true })

  const systemKeys = new Set(w.comps.filter((c) => c.state === 'system').map((c) => c.key))
  const lens: Lens = operatorKeys && lensWanted === 'operator' ? 'operator' : 'system'
  const lensKeys = lens === 'operator' && operatorKeys ? operatorKeys : systemKeys
  const pick = (keys: Iterable<string>) => [...keys].map((k) => byKey.get(k)).filter((c): c is EvidenceComp => Boolean(c))
  const lensComps = pick(lensKeys).sort(byWeight)
  const removed = lens === 'operator' ? pick([...systemKeys].filter((k) => !lensKeys.has(k))).sort(byWeight) : []
  const added = new Set(lens === 'operator' ? [...lensKeys].filter((k) => !systemKeys.has(k)) : [])

  const admissible = w.comps.filter((c) => c.state !== 'excluded')
  const candidates = admissible.filter((c) => !lensKeys.has(c.key) && !(lens === 'operator' && systemKeys.has(c.key)) && passesFilters(c, filters, w.subject, now)).sort(byWeight)
  const excluded = w.comps.filter((c) => c.state === 'excluded' && passesFilters(c, filters, w.subject, now))
    .sort((a, b) => (a.distanceMiles ?? 99) - (b.distanceMiles ?? 99))

  const tiers = new Map<string, Tier>()
  for (const c of candidates) tiers.set(c.key, 'candidate')
  for (const c of excluded) tiers.set(c.key, 'excluded')
  for (const c of removed) tiers.set(c.key, 'removed')
  for (const c of lensComps) tiers.set(c.key, added.has(c.key) ? 'added' : 'set')

  const systemReplay = replaySet(pick(systemKeys))
  const operatorReplay = operatorKeys ? replaySet(pick(operatorKeys)) : null
  const lensReplay = lens === 'operator' && operatorReplay ? operatorReplay : systemReplay
  const run = w.engineRun ?? null
  const computedAt = run?.computedAt ? Date.parse(run.computedAt) : NaN
  const system = pick(systemKeys)

  return {
    w,
    now,
    kind,
    metric,
    rules: w.engineRules ?? null,
    run,
    byKey,
    systemKeys,
    operatorKeys,
    lens,
    lensKeys,
    lensComps,
    removed,
    added,
    candidates,
    excluded,
    universeCount: admissible.length,
    excludedCount: w.comps.length - admissible.length,
    tiers,
    systemReplay,
    operatorReplay,
    lensReplay,
    parity: parityWithStored(w.conclusion, systemReplay.result),
    band: outlierBand(run),
    depth: evidenceDepth(lensComps, metric, now),
    comparableValuation: Boolean(w.conclusion?.valueMid && (!w.conclusion.method || w.conclusion.method === 'weighted_adjusted_comp_value') && systemKeys.size),
    runAgeDays: Number.isFinite(computedAt) && now ? Math.max(0, Math.floor((now - computedAt) / 86_400_000)) : null,
    drift: {
      aged: system.filter((c) => c.today?.eligible && weightAgedMaterially(c.engine?.weight, c.today.weight)).length,
      rejected: system.filter((c) => c.today && !c.today.eligible).length,
    },
  }
}
