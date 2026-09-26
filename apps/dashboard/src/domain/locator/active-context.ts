/**
 * IS THE OPERATOR IN UNIVERSAL MODE, OR AIMED AT SOMETHING? (§3)
 *
 * Two legitimate operating states, and until now the product could not tell you
 * which one it was in:
 *
 *   UNIVERSAL  the app shows its whole domain — every thread, the market, all
 *              campaigns, the entity universe.
 *   CONTEXT    the app is deliberately scoped to one property/seller/thread.
 *
 * The old answer lived in `sessionStorage` and was invisible, sticky and
 * unclearable: `clearPropertyLocator` had no caller anywhere outside its own
 * unit test, so one selection silently re-scoped Buyer Match, Calendar, Email
 * and Entity Graph for the rest of the session.
 *
 * The answer now lives in the URL. A contextual action writes the parameter; the
 * absence of the parameter IS universal mode. That makes the state visible,
 * reloadable, shareable, and — the part that was actually missing — escapable,
 * because clearing it is just removing a query parameter.
 *
 * This module is the single reader/writer of that contract. Nothing else should
 * be parsing context parameters by hand, which is how they drifted apart in the
 * first place (§27).
 */
import { pushRoutePath } from '../../app/router'
import { clearPropertyLocator, readPropertyLocator } from './property-locator'
import { setUniversalEntityContextSnapshot } from '../entity-graph/universal-entity-context-store'
import { EMPTY_UNIVERSAL_ENTITY_CONTEXT, parseEntityGraphDeepLink } from '../entity-graph/universal-entity-context'

/** Every parameter that scopes a surface to one entity. */
export const CONTEXT_PARAMS = ['property_id', 'opp', 'opportunity_id', 'thread', 'thread_key', 'owner_id', 'master_owner_id'] as const

export type ContextKind = 'property' | 'opportunity' | 'thread' | 'owner'

export interface ActiveContext {
  kind: ContextKind
  id: string
  /** Short human identity for the chip — an address where we have one. */
  label: string
  /** Longer identity for the title attribute / screen readers. */
  detail: string
}

const clean = (value: string | null | undefined): string | null => {
  const text = String(value ?? '').trim()
  return text.length > 0 ? text : null
}

/** "1115 Nw 64th St, Miami, Fl 33150" -> "1115 Nw 64th St" */
export const shortAddress = (address: string): string => {
  const head = address.split(',')[0]?.trim()
  return head && head.length > 0 ? head : address
}

/**
 * The context the CURRENT URL declares, or null for universal mode.
 *
 * The locator is consulted only to put a human name on a context the URL has
 * already declared — never to create one. That distinction is the whole fix: it
 * can label, it cannot scope.
 */
export function readActiveContext(search?: string): ActiveContext | null {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(search ?? (typeof window !== 'undefined' ? window.location.search : ''))
  } catch {
    return null
  }

  const locator = readPropertyLocator()

  const propertyId = clean(params.get('property_id'))
  if (propertyId) {
    const address = locator?.propertyId === propertyId ? clean(locator.address) : null
    return {
      kind: 'property',
      id: propertyId,
      label: address ? shortAddress(address) : `Property ${propertyId}`,
      detail: address ?? `Property ${propertyId}`,
    }
  }

  const opportunityId = clean(params.get('opp')) ?? clean(params.get('opportunity_id'))
  if (opportunityId) {
    const address = locator?.opportunityId === opportunityId ? clean(locator.address) : null
    return {
      kind: 'opportunity',
      id: opportunityId,
      label: address ? shortAddress(address) : 'Opportunity',
      detail: address ?? `Opportunity ${opportunityId}`,
    }
  }

  const threadKey = clean(params.get('thread')) ?? clean(params.get('thread_key'))
  if (threadKey) {
    const address = locator?.threadKey === threadKey ? clean(locator.address) : null
    return {
      kind: 'thread',
      id: threadKey,
      label: address ? shortAddress(address) : 'Conversation',
      detail: address ?? 'Conversation',
    }
  }

  const ownerId = clean(params.get('owner_id')) ?? clean(params.get('master_owner_id'))
  if (ownerId) {
    return { kind: 'owner', id: ownerId, label: 'Owner', detail: `Owner ${ownerId}` }
  }

  return null
}

/**
 * What the operator currently has selected, wherever it came from.
 *
 * The URL context first; then an Entity Graph path deep link; then a property
 * the operator selected (the locator) that apps like Map, Comps and Inbox seed
 * from without putting it in the URL. Every one of these makes the app "about"
 * one property, so every one must be visible and clearable from the global bar.
 */
export function readSelectedContext(search?: string, pathname?: string): ActiveContext | null {
  const fromUrl = readActiveContext(search)
  if (fromUrl) return fromUrl
  const path = pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '')
  const deep = path ? parseEntityGraphDeepLink(path) : null
  if (deep?.entityId) {
    const locator = readPropertyLocator()
    const address = locator && (locator.propertyId === deep.propertyId || locator.propertyId === deep.entityId) ? clean(locator.address) : null
    return { kind: 'property', id: String(deep.propertyId ?? deep.entityId), label: address ? shortAddress(address) : 'Selected', detail: address ?? 'Selected record' }
  }
  const locator = readPropertyLocator()
  if (locator && (locator.propertyId || locator.threadKey)) {
    const address = clean(locator.address)
    return {
      kind: locator.propertyId ? 'property' : 'thread',
      id: String(locator.propertyId ?? locator.threadKey),
      label: address ? shortAddress(address) : 'Selected',
      detail: address ?? 'Selected property',
    }
  }
  return null
}

/**
 * Drop the context and stay where you are.
 *
 * §3 is explicit that clearing must NOT bounce the operator back to the Inbox:
 * they asked this application to stop being about one property, not to be
 * replaced by a different application. So the path is preserved and only the
 * scoping parameters are stripped.
 *
 * The locator is released too. Leaving it would keep the stale identity
 * available to the next contextual action, which is how a cleared property came
 * back a screen later.
 */
export function clearActiveContext(): void {
  clearPropertyLocator()
  // The cross-app entity snapshot is released too, or Comps / Entity Graph /
  // Deal Intelligence re-open the cleared property on their next render.
  try { setUniversalEntityContextSnapshot(EMPTY_UNIVERSAL_ENTITY_CONTEXT) } catch { /* no store */ }
  try { window.dispatchEvent(new CustomEvent('nexus:selection-cleared')) } catch { /* non-DOM */ }

  if (typeof window === 'undefined') return
  // An Entity Graph record deep link IS the context: return to the graph itself.
  if (parseEntityGraphDeepLink(window.location.pathname)?.entityId) {
    pushRoutePath('/entity-graph')
    return
  }
  const url = new URL(window.location.href)
  let removed = false
  for (const param of CONTEXT_PARAMS) {
    if (url.searchParams.has(param)) {
      url.searchParams.delete(param)
      removed = true
    }
  }
  if (!removed) return

  const query = url.searchParams.toString()
  pushRoutePath(`${url.pathname}${query ? `?${query}` : ''}`)
}

/** Add a context parameter to a path — the one place a contextual link is built. */
export function withContext(path: string, context: Partial<Record<'property_id' | 'opp' | 'thread', string | null>>): string {
  const [base, existing] = path.split('?')
  const params = new URLSearchParams(existing ?? '')
  for (const [key, value] of Object.entries(context)) {
    const text = clean(value)
    if (text) params.set(key, text)
  }
  const query = params.toString()
  return query ? `${base}?${query}` : base
}

const labelCache = new Map<string, string | null>()

/**
 * The address for a property context that arrived without one (a map pin tap
 * publishes only the id). One read, cached; null when unknown.
 */
export async function resolvePropertyAddress(propertyId: string): Promise<string | null> {
  if (labelCache.has(propertyId)) return labelCache.get(propertyId) ?? null
  try {
    const { getSupabaseClient } = await import('../../lib/supabaseClient')
    const { data } = await getSupabaseClient()
      .from('properties')
      .select('property_address_full, property_address')
      .eq('property_id', propertyId)
      .maybeSingle()
    const row = (data ?? {}) as { property_address_full?: string | null; property_address?: string | null }
    const address = clean(row.property_address_full) ?? clean(row.property_address) ?? null
    labelCache.set(propertyId, address)
    return address
  } catch {
    return null
  }
}
