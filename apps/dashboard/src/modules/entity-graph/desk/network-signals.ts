/**
 * Signals for a relationship-network property (the inspector / hover card),
 * through the SAME vocabulary as the grid (property-signals.ts).
 */
import type { NetworkProperty } from '../console/entity-network-api'
import type { PropertyRecords } from '../../../domain/entity-graph/entity-graph-intel-api'
import { signalFor, type PropertySignal } from '../mobile/property-signals'

const RANK = { distress: 0, opportunity: 1, risk: 2, neutral: 3 } as const

export function networkPropertySignals(p: NetworkProperty, rec: PropertyRecords | null = null): PropertySignal[] {
  const raw = [...p.tags]
  if (p.taxDelinquent) raw.push('Tax Delinquent')
  if (p.activeLien) raw.push('Active Lien')
  if (p.outOfStateOwner) raw.push('Out Of State Owner')
  if (p.corporateOwner) raw.push('Corporate Owner')
  if (p.equityRule === 'free_and_clear') raw.push('Free And Clear')
  for (const l of rec?.liens ?? []) if (l.distress) raw.push(l.label)
  if (rec?.foreclosures?.length) raw.push('Foreclosure')
  if ((rec?.mortgages ?? []).some((m) => m.open && m.privateLender)) raw.push('Private Lender')
  const seen = new Map<string, PropertySignal>()
  for (const t of raw) {
    const s = signalFor(t)
    if (s && !seen.has(s.label.toLowerCase())) seen.set(s.label.toLowerCase(), s)
  }
  return [...seen.values()].sort((a, b) => RANK[a.tone] - RANK[b.tone])
}
