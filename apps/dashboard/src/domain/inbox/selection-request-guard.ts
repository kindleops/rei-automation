/**
 * Deal Desk selection request guard — request-generation protection.
 *
 * Audit background (docs/audits/DEAL_DESK_FRONTEND_RUNTIME_AUDIT.md §C.1):
 *   "Stale response overwrites? — Guarded for list & messages, unguarded for
 *   participants… the participants effect has no cancellation token on the response
 *   commit" and "Request-cancellation failures? — Partially: an `AbortController` is
 *   passed to the 4 primary fetches, but the participants fetch, the valuation-snapshot
 *   fetch and the read-mark PATCH are all uncancelled."
 *
 * Every selection-triggered request is issued a token bound to
 * `(selectionKey, selectionVersion)` plus a per-resource generation counter. A response
 * may only commit state if `accept(token)` returns true, which proves it still belongs to
 * the current selection *and* is not superseded by a newer request for the same resource.
 *
 * Superseding a request also aborts it, so the network work is cancelled rather than
 * merely discarded.
 *
 * Pure apart from `AbortController`, which is available in every browser and in Node 18+,
 * so this is testable under `node --test`.
 */

export interface SelectionIdentity {
  selectionKey: string
  selectionVersion: number
}

export interface SelectionRequestToken {
  resource: string
  selectionKey: string
  selectionVersion: number
  /** Per-resource monotonic counter. Only the newest generation may commit. */
  generation: number
}

export interface SelectionRequestGuardStats {
  issued: number
  accepted: number
  /** Responses that arrived for a superseded selection or generation. */
  rejectedStale: number
  /** Requests aborted because a newer request for the same resource started. */
  aborted: number
  byResource: Record<string, { issued: number; accepted: number; rejectedStale: number }>
}

export interface SelectionRequestGuard {
  /**
   * Start a request for `resource` under `identity`. Aborts any still-in-flight request
   * for the same resource, then returns a token and the signal the fetch must use.
   */
  begin(resource: string, identity: SelectionIdentity): { token: SelectionRequestToken; signal: AbortSignal }
  /** True iff a response carrying this token may still commit state. */
  isCurrent(token: SelectionRequestToken): boolean
  /** Record the outcome and return whether the caller may commit. */
  accept(token: SelectionRequestToken): boolean
  /** Abort every in-flight request (selection cleared / component unmounted). */
  abortAll(): void
  /** Abort in-flight requests for one resource without issuing a new one. */
  abortResource(resource: string): void
  stats(): SelectionRequestGuardStats
  resetStats(): void
}

interface ResourceSlot {
  generation: number
  controller: AbortController | null
  identity: SelectionIdentity | null
}

const emptyResourceStat = () => ({ issued: 0, accepted: 0, rejectedStale: 0 })

export function createSelectionRequestGuard(): SelectionRequestGuard {
  const slots = new Map<string, ResourceSlot>()
  const stats: SelectionRequestGuardStats = {
    issued: 0,
    accepted: 0,
    rejectedStale: 0,
    aborted: 0,
    byResource: {},
  }

  const slotFor = (resource: string): ResourceSlot => {
    let slot = slots.get(resource)
    if (!slot) {
      slot = { generation: 0, controller: null, identity: null }
      slots.set(resource, slot)
    }
    return slot
  }

  const resourceStat = (resource: string) => {
    if (!stats.byResource[resource]) stats.byResource[resource] = emptyResourceStat()
    return stats.byResource[resource]
  }

  const abortSlot = (slot: ResourceSlot) => {
    if (slot.controller && !slot.controller.signal.aborted) {
      slot.controller.abort()
      stats.aborted += 1
    }
    slot.controller = null
  }

  return {
    begin(resource, identity) {
      const slot = slotFor(resource)
      abortSlot(slot)
      slot.generation += 1
      slot.identity = { ...identity }
      const controller = new AbortController()
      slot.controller = controller
      stats.issued += 1
      resourceStat(resource).issued += 1
      return {
        token: {
          resource,
          selectionKey: identity.selectionKey,
          selectionVersion: identity.selectionVersion,
          generation: slot.generation,
        },
        signal: controller.signal,
      }
    },

    isCurrent(token) {
      const slot = slots.get(token.resource)
      if (!slot) return false
      if (slot.generation !== token.generation) return false
      if (!slot.identity) return false
      return (
        slot.identity.selectionKey === token.selectionKey &&
        slot.identity.selectionVersion === token.selectionVersion
      )
    },

    accept(token) {
      const slot = slots.get(token.resource)
      const current =
        Boolean(slot) &&
        slot!.generation === token.generation &&
        Boolean(slot!.identity) &&
        slot!.identity!.selectionKey === token.selectionKey &&
        slot!.identity!.selectionVersion === token.selectionVersion
      if (current) {
        stats.accepted += 1
        resourceStat(token.resource).accepted += 1
        return true
      }
      stats.rejectedStale += 1
      resourceStat(token.resource).rejectedStale += 1
      return false
    },

    abortAll() {
      for (const slot of slots.values()) {
        abortSlot(slot)
        // Invalidate every outstanding token so no late response can commit.
        slot.generation += 1
        slot.identity = null
      }
    },

    abortResource(resource) {
      const slot = slots.get(resource)
      if (!slot) return
      abortSlot(slot)
      slot.generation += 1
      slot.identity = null
    },

    stats() {
      return {
        issued: stats.issued,
        accepted: stats.accepted,
        rejectedStale: stats.rejectedStale,
        aborted: stats.aborted,
        byResource: Object.fromEntries(
          Object.entries(stats.byResource).map(([key, value]) => [key, { ...value }]),
        ),
      }
    },

    resetStats() {
      stats.issued = 0
      stats.accepted = 0
      stats.rejectedStale = 0
      stats.aborted = 0
      stats.byResource = {}
    },
  }
}

/** Canonical resource names, so a typo cannot silently create a second guard slot. */
export const DEAL_DESK_RESOURCES = {
  conversation: 'conversation',
  messages: 'messages',
  hydration: 'hydration',
  dossier: 'dossier',
  threadContext: 'thread_context',
  property: 'property',
  prospect: 'prospect',
  participants: 'participants',
  intelligence: 'intelligence',
  propertyMedia: 'property_media',
} as const

export type DealDeskResourceName = (typeof DEAL_DESK_RESOURCES)[keyof typeof DEAL_DESK_RESOURCES]
