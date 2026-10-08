/**
 * ONE SIGNAL SYSTEM (owner, 2026-10-08: "signals / seller tags / recorded
 * signals are duplicated and bland").
 *
 * Three sources described the same facts three ways — vendor property flags
 * ("Tax Delinquent; Vacant Home"), vendor seller tags (the same list, again)
 * and recorded-document signals (probate, lis pendens…). They are merged into
 * one deduplicated list of badges with a meaning:
 *
 *   distress     pressure to sell, on record or flagged (tax delinquent, vacant,
 *                pre-foreclosure, lis pendens, probate, liens, auction…)
 *   opportunity  a seller profile worth a call (high equity, free & clear,
 *                tired landlord, senior / long-term / absentee owner…)
 *   risk         makes a deal harder (low equity, adjustable loan, private
 *                lender, landlocked, just bought)
 *   neutral      context (corporate owner, cash buyer, bought at trustee sale)
 *
 * Property FACTS are not signals and never become badges: "Apartment Building
 * 5+ Units", "Commercial", "Strip Malls", "Storage Units", "Off Market",
 * "Corner Lot" (they belong in the property type / facts).
 */
import type { EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'

export type SignalTone = 'distress' | 'opportunity' | 'risk' | 'neutral'
export type PropertySignal = { key: string; label: string; tone: SignalTone }

const T: Record<string, [string, SignalTone]> = {
  'tax delinquent': ['Tax delinquent', 'distress'],
  'tax lien': ['Tax lien', 'distress'],
  preforeclosure: ['Pre-foreclosure', 'distress'],
  'pre-foreclosure': ['Pre-foreclosure', 'distress'],
  foreclosure: ['Foreclosure', 'distress'],
  'notice of default': ['Notice of default', 'distress'],
  'lis pendens': ['Lis pendens', 'distress'],
  'upcoming auction': ['Auction scheduled', 'distress'],
  'bank owned': ['Bank owned', 'distress'],
  probate: ['Probate', 'distress'],
  'death record': ['Death record', 'distress'],
  'vacant home': ['Vacant', 'distress'],
  'zombie property': ['Zombie property', 'distress'],
  'active lien': ['Active lien', 'distress'],
  'hoa lien': ['HOA lien', 'distress'],
  judgment: ['Judgment', 'distress'],
  "mechanic's lien": ["Mechanic's lien", 'distress'],
  'code violation': ['Code violation', 'distress'],
  'high equity': ['High equity', 'opportunity'],
  'free and clear': ['Free & clear', 'opportunity'],
  'tired landlord': ['Tired landlord', 'opportunity'],
  'senior owner': ['Senior owner', 'opportunity'],
  'empty nester': ['Empty nester', 'opportunity'],
  'long term owner': ['Long-term owner', 'opportunity'],
  'absentee owner': ['Absentee owner', 'opportunity'],
  'out of state owner': ['Out-of-state owner', 'opportunity'],
  'likely to move': ['Likely to move', 'opportunity'],
  'heavily dated': ['Heavily dated', 'opportunity'],
  'no updates': ['No updates', 'opportunity'],
  'low equity': ['Low equity', 'risk'],
  'adjustable loan': ['Adjustable loan', 'risk'],
  'private lender': ['Private lender', 'risk'],
  landlocked: ['Landlocked', 'risk'],
  'new owner': ['New owner', 'risk'],
  'recently sold': ['Recently sold', 'risk'],
  'corporate owner': ['Corporate owner', 'neutral'],
  'cash buyer': ['Bought with cash', 'neutral'],
  'mid-term owner': ['Mid-term owner', 'neutral'],
  'bought at trustee sale': ['Bought at trustee sale', 'neutral'],
}

/** Property facts, not signals: never a badge. */
export const NOT_SIGNALS = new Set(['apartment building 5+ units', 'commercial', 'strip malls', 'storage units', 'off market', 'corner lot'])

const RANK: Record<SignalTone, number> = { distress: 0, opportunity: 1, risk: 2, neutral: 3 }

const tokens = (text: unknown): string[] => String(text ?? '').split(/[;|,]/).map((s) => s.trim()).filter(Boolean)

export function signalFor(raw: string): PropertySignal | null {
  const k = raw.trim().toLowerCase()
  if (!k || NOT_SIGNALS.has(k)) return null
  const hit = T[k]
  if (hit) return { key: k, label: hit[0], tone: hit[1] }
  // an unrecognised vendor token stays visible, neutral and humanised — never a raw code
  return { key: k, label: raw.trim().replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), tone: 'neutral' }
}

/** Every signal on a row, deduplicated, distress first. Pure — tested. */
export function propertySignals(r: EntitySearchResult): PropertySignal[] {
  const d = r.details ?? {}
  const raw: string[] = [
    ...tokens(d.flags),
    ...tokens((d.row ?? {}).property_flags_text),
    ...tokens((d.row ?? {}).seller_tags_text),
    ...(d.records?.signals ?? []).map((s) => s.label),
  ]
  if (d.taxDelinquent) raw.push('Tax Delinquent')
  if (d.absentee) raw.push('Out Of State Owner')
  const seen = new Map<string, PropertySignal>()
  for (const t of raw) {
    const s = signalFor(t)
    if (!s) continue
    // "Foreclosure" from the records and "Preforeclosure" from the vendor are
    // different facts; identical labels are one badge
    const key = s.label.toLowerCase()
    if (!seen.has(key)) seen.set(key, s)
  }
  return [...seen.values()].sort((a, b) => RANK[a.tone] - RANK[b.tone])
}

/** The vendor's acquisition bucket (APARTMENT_BUILDINGS) as words — a property fact. */
export function humanBucket(code: unknown): string | null {
  const c = String(code ?? '').trim()
  if (!c) return null
  return c.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (x) => x.toUpperCase())
}
