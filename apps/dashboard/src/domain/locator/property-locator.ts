/**
 * THE GLOBAL PROPERTY LOCATOR.
 *
 * Operator requirement: select a conversation in the Inbox, tap any destination
 * in the bottom dock, and land on THAT property — not a generic view.
 *
 * Why this is a new module rather than a reuse of universal-entity-context-store:
 * that store is the cross-view *selected entity* singleton, and it is WIPED on
 * every dock tap. pushRoutePath fires popstate, InboxPage clears the snapshot on
 * any non-/entity-graph route, and every route change unmounts the current view.
 * So the one piece of shared state that looks like it should carry the selection
 * is guaranteed to be empty exactly when the dock needs to read it.
 *
 * Two consequences shape this design:
 *
 *  1. It is published at SELECTION time, not at navigation time. By the time a
 *     dock tap is being handled the in-memory selection may already be gone, so
 *     waiting until navigation is too late.
 *
 *  2. It is persisted in sessionStorage, because no in-memory value survives the
 *     unmount. sessionStorage (not localStorage) keeps it scoped to the tab and
 *     lets a fresh tab start clean.
 *
 * It carries every identifier the destinations need, because they do not agree
 * on one: Pipeline wants an opportunity_id, Entity Graph wants a property_id,
 * Deal Intelligence resolves from a thread, and Queue filters on a property.
 * Recording all of them once at selection is far cheaper than making each
 * destination re-resolve an identity it was not given.
 */

export interface PropertyLocator {
  propertyId: string | null
  threadKey: string | null
  masterOwnerId: string | null
  prospectId: string | null
  opportunityId: string | null
  address: string | null
  /** ms epoch — lets a consumer ignore a stale locator if it ever needs to. */
  setAt: number
}

const STORAGE_KEY = 'nexus:property-locator:v1'

/** Broadcast so a mounted view can react without polling. */
export const PROPERTY_LOCATOR_EVENT = 'nexus:property-locator'

const EMPTY: PropertyLocator = {
  propertyId: null,
  threadKey: null,
  masterOwnerId: null,
  prospectId: null,
  opportunityId: null,
  address: null,
  setAt: 0,
}

const str = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

const hasStorage = () => {
  try {
    return typeof window !== 'undefined' && Boolean(window.sessionStorage)
  } catch {
    return false
  }
}

/**
 * Record the property the operator is looking at.
 *
 * Deliberately tolerant about which identifiers are present — a thread with no
 * linked property still yields a useful locator for Deal Intelligence, and a
 * property row with no thread still works for Map and Lists. A call carrying no
 * identifier at all is ignored rather than clearing a good locator, so a partial
 * row cannot silently erase a working one.
 */
export function setPropertyLocator(input: Partial<PropertyLocator>): PropertyLocator | null {
  const next: PropertyLocator = {
    propertyId: str(input.propertyId),
    threadKey: str(input.threadKey),
    masterOwnerId: str(input.masterOwnerId),
    prospectId: str(input.prospectId),
    opportunityId: str(input.opportunityId),
    address: str(input.address),
    setAt: Date.now(),
  }

  const hasAnyIdentity = Boolean(
    next.propertyId || next.threadKey || next.opportunityId || next.prospectId || next.masterOwnerId,
  )
  if (!hasAnyIdentity) return null

  if (hasStorage()) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* a full or blocked sessionStorage must never break selection */
    }
  }
  try {
    window.dispatchEvent(new CustomEvent(PROPERTY_LOCATOR_EVENT, { detail: next }))
  } catch {
    /* non-DOM environments */
  }
  return next
}

export function readPropertyLocator(): PropertyLocator | null {
  if (!hasStorage()) return null
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PropertyLocator>
    const locator: PropertyLocator = { ...EMPTY, ...parsed, setAt: Number(parsed?.setAt) || 0 }
    const hasAnyIdentity = Boolean(
      locator.propertyId || locator.threadKey || locator.opportunityId || locator.prospectId || locator.masterOwnerId,
    )
    return hasAnyIdentity ? locator : null
  } catch {
    return null
  }
}

export function clearPropertyLocator(): void {
  if (hasStorage()) {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }
  try {
    window.dispatchEvent(new CustomEvent(PROPERTY_LOCATOR_EVENT, { detail: null }))
  } catch {
    /* ignore */
  }
}

/**
 * Where should a dock destination actually go, given the current locator?
 *
 * Returns null when the destination cannot be focused — the caller then falls
 * back to its plain path, which is the existing behaviour. Nothing here invents
 * a route: every path and query parameter below is one the target view already
 * reads.
 *
 *   /pipeline        reads `opp`            (PipelineWorkspace OPP_PARAM)
 *   /entity-graph    has /property/:id      (registered route)
 *   /map, /inbox     focus from the inbox activeContext, which InboxPage seeds
 *                    from this locator on mount
 *   /queue           reads `property_id`
 *
 * Campaign Command is deliberately absent: it has no property-focus concept at
 * any layer and no endpoint answers "which campaign contains this property", so
 * pretending to focus it would be a lie. It keeps its plain path until that
 * endpoint exists.
 */
export function resolveDockDestination(path: string, locator: PropertyLocator | null): string | null {
  if (!locator) return null

  switch (path) {
    case '/pipeline':
      return locator.opportunityId ? `/pipeline?opp=${encodeURIComponent(locator.opportunityId)}` : null
    case '/entity-graph':
      return locator.propertyId ? `/entity-graph/property/${encodeURIComponent(locator.propertyId)}` : null
    case '/queue':
      return locator.propertyId ? `/queue?property_id=${encodeURIComponent(locator.propertyId)}` : null
    case '/map':
      // The map focuses off the inbox activeContext rather than a URL param, so
      // the locator alone is enough; the path is unchanged on purpose.
      return null
    default:
      return null
  }
}
