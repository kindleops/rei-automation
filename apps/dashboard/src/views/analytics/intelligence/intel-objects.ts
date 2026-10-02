import { dealObject, propertyObject, sellerObject, type ObjectRef } from '../../../modules/desktop/objects'
import type { MoneyDeal } from './intel-model'

/** A Lab deal row as its canonical deal (opportunity id + property / seller). */
export const moneyDealObject = (d: Pick<MoneyDeal, 'id' | 'propertyId' | 'threadKey' | 'stage' | 'address'>): ObjectRef =>
  dealObject({ opportunityId: d.id, propertyId: d.propertyId, threadKey: d.threadKey, stage: d.stage, label: d.address, source: 'analytics' })

/** A records-drawer row: its deal when it has one, else its seller's thread. */
export function recordRowObject(r: Readonly<Record<string, unknown>>): ObjectRef | null {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  if (r.oppId) return dealObject({ opportunityId: String(r.oppId), threadKey: r.thread ? String(r.thread) : null, label: str(r.address), source: 'analytics' })
  return r.thread ? sellerObject({ threadKey: String(r.thread), label: str(r.seller), source: 'analytics' }) : null
}

/** A cohort hand-off place (canonical coordinates from the Lab read). */
export const handoffPointObject = (p: { id?: string; lat: number; lng: number; label?: string | null }, i: number): ObjectRef =>
  propertyObject({ propertyId: p.id ?? `point-${i}`, label: p.label ?? null, source: 'analytics', lat: p.lat, lng: p.lng })
