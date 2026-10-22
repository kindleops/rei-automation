/**
 * WORKFORCE record refs → the canonical object refs of the shell
 * (modules/desktop/objects). That is the split-screen contract (§8):
 *   property    → Deal Intelligence
 *   thread      → Inbox
 *   opportunity → Pipeline
 * Missions, assignments and employees live inside Workforce; a runtime job
 * has no app of its own, so it is shown and never opened.
 */
import { dealObject, propertyObject, sellerObject, type ObjectRef } from '../../desktop/objects'
import type { WfRef } from '../api/wf-types'

export const WF_SOURCE = 'workforce'

export function refToObject(r: WfRef): ObjectRef | null {
  switch (r.type) {
    case 'property':
      return propertyObject({ propertyId: r.id, threadKey: r.thread_key ?? null, opportunityId: r.opportunity_id ?? null, label: r.label, source: WF_SOURCE })
    case 'thread':
      return sellerObject({ threadKey: r.id, propertyId: r.property_id ?? null, propertyLabel: null, label: r.label, source: WF_SOURCE })
    case 'opportunity':
      return dealObject({ opportunityId: r.id, propertyId: r.property_id ?? null, threadKey: r.thread_key ?? null, label: r.label, source: WF_SOURCE })
    default:
      return null
  }
}

export const REF_NOUN: Record<WfRef['type'], string> = {
  property: 'Property', thread: 'Conversation', opportunity: 'Deal', job: 'Runtime job',
  assignment: 'Assignment', mission: 'Mission', employee: 'Employee', market: 'Market',
}

/** What the chip says: the label, else a short id. Never a phone number (thread keys are not shown). */
export function refText(r: WfRef): string {
  if (r.label) return r.label
  if (r.type === 'thread') return 'Seller conversation'
  if (r.type === 'opportunity') return 'Pipeline deal'
  const id = r.id.replace(/^(wfm|wfa|mjob|emp)_/, '')
  return id.length > 14 ? `${id.slice(0, 8)}…` : id
}

/** Merge refs of one subject into one chip group, property first, without duplicates. */
export function dedupeRefs(refs: ReadonlyArray<WfRef>): WfRef[] {
  const seen = new Set<string>()
  const order: Record<string, number> = { property: 0, opportunity: 1, thread: 2, mission: 3, assignment: 4, employee: 5, job: 6, market: 7 }
  return [...refs].filter((r) => { const k = `${r.type}:${r.id}`; if (seen.has(k)) return false; seen.add(k); return true }).sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9))
}
