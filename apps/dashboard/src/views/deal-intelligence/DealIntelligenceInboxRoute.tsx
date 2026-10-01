import { lazy, Suspense, useContext, useEffect, useState } from 'react'
import { openInboxDealIntelligence, openInboxThread } from '../../modules/mobile/mobile-inbox-bridge'
import { getUniversalEntityContextSnapshot, subscribeUniversalEntityContext } from '../../domain/entity-graph/universal-entity-context-store'
import { PaneRouteContext } from '../../app/router'
import { MobileSellerCommandCenter } from '../../modules/deal-intelligence/mobile/MobileSellerCommandCenter'
import { useBreakpoint } from '../../modules/mobile/useBreakpoint'

/**
 * The desktop decision room is its own chunk: a phone never downloads it, and
 * the phone path below is byte-for-byte the behaviour it had.
 */
const DealIntelligenceDesktop = lazy(() =>
  import('./desktop/DealIntelligenceDesktop').then((m) => ({ default: m.DealIntelligenceDesktop })),
)

/**
 * THE ROUTE HAS TO CARRY THE SUBJECT.
 *
 * This called `openInboxDealIntelligence()` with no arguments. The bridge
 * accepts an identity and deliberately does not overwrite an established one
 * when given nothing — so a direct arrival at /deal-intelligence opened the Deal
 * Intelligence pane on whatever thread the Inbox happened to be holding.
 *
 * Measured 2026-09-14: /deal-intelligence?property_id=278442634
 * (3016 Bellefontaine Ave, Kansas City) opened on Bertha A Daniels,
 * 1115 Nw 64th St, Miami — an unrelated seller, with the requested property_id
 * silently discarded.
 *
 * Two sources, in order of explicitness:
 *   1. the URL, which survives a reload and a shared link
 *   2. the universal entity context, for an in-app hop that only published the
 *      snapshot
 * If neither has anything the call stays argument-free, which preserves the
 * bridge's "do not erase an established identity" contract.
 */
function identityFromUrl(search?: string): {
  threadKey?: string
  propertyId?: string
  prospectId?: string
  masterOwnerId?: string
} {
  if (typeof window === 'undefined') return {}
  const params = new URLSearchParams(search ?? window.location.search)
  const read = (...keys: string[]) => {
    for (const key of keys) {
      const value = params.get(key)
      if (value && value.trim()) return value.trim()
    }
    return undefined
  }
  return {
    threadKey: read('thread_key', 'threadKey'),
    // Notifications link `?property=` (notification-destination.ts); it was dropped here.
    propertyId: read('property_id', 'propertyId', 'property'),
    prospectId: read('prospect_id', 'prospectId'),
    masterOwnerId: read('master_owner_id', 'masterOwnerId'),
  }
}

/**
 * In a desktop SPLIT PANE, Deal Intelligence is a companion instead of a
 * redirect: it follows whichever seller is selected (the universal entity
 * context every surface publishes), so Inbox | Deal Intelligence side by side
 * reads the thread on the left. Redirecting from a pane would take over the
 * main window, which is exactly what a split must never do.
 */
export function DealIntelligenceInboxRoute() {
  const pane = useContext(PaneRouteContext)
  const { isModernDesktop } = useBreakpoint()
  // DESKTOP: the acquisition decision room, in the main pane or any side pane.
  // It reads its own pane's location (?property_id= / ?property= / ?thread_key=)
  // and follows linked context; it never redirects into the Inbox.
  if (isModernDesktop) {
    return (
      <Suspense fallback={<div className="dr-route-fallback" aria-busy="true" />}>
        <DealIntelligenceDesktop />
      </Suspense>
    )
  }
  if (pane) return <DealIntelligenceCompanion search={pane.location.includes('?') ? pane.location.slice(pane.location.indexOf('?')) : ''} />
  return <DealIntelligenceRedirect />
}

function DealIntelligenceCompanion({ search }: { search: string }) {
  const [ctx, setCtx] = useState(getUniversalEntityContextSnapshot)
  useEffect(() => subscribeUniversalEntityContext(() => setCtx(getUniversalEntityContextSnapshot())), [])
  const fromPane = identityFromUrl(search)
  const identity = {
    threadKey: ctx?.threadKey ?? fromPane.threadKey,
    propertyId: ctx?.propertyId ?? (ctx?.entityType === 'property' && ctx?.entityId ? ctx.entityId : fromPane.propertyId),
    prospectId: ctx?.prospectId ?? fromPane.prospectId,
    masterOwnerId: ctx?.masterOwnerId ?? fromPane.masterOwnerId,
  }
  const key = [identity.threadKey, identity.propertyId, identity.prospectId, identity.masterOwnerId].map((v) => v ?? '').join('|')
  if (!identity.threadKey && !identity.propertyId && !identity.prospectId && !identity.masterOwnerId) {
    return (
      <div className="nx-route-redirect-shell nx-di-companion-empty" role="status">
        <p><strong>Deal Intelligence follows your selection</strong></p>
        <p>Select a seller or property in any pane and its decision, evidence and economics appear here.</p>
      </div>
    )
  }
  return (
    <MobileSellerCommandCenter
      key={key}
      threadKey={identity.threadKey ?? undefined}
      propertyId={identity.propertyId ?? undefined}
      prospectId={identity.prospectId ?? undefined}
      masterOwnerId={identity.masterOwnerId ?? undefined}
      onOpenConversation={identity.threadKey ? () => openInboxThread({ threadKey: identity.threadKey as string }) : null}
    />
  )
}

/** Redirect into the Deal Desk inbox workspace — do not mount InboxPage here (state would be lost on /inbox navigation). */
function DealIntelligenceRedirect() {
  useEffect(() => {
    const fromUrl = identityFromUrl()
    const hasUrlIdentity = Boolean(
      fromUrl.threadKey || fromUrl.propertyId || fromUrl.prospectId || fromUrl.masterOwnerId,
    )
    if (hasUrlIdentity) {
      openInboxDealIntelligence(fromUrl)
      return
    }

    const context = getUniversalEntityContextSnapshot()
    const fromContext = {
      threadKey: context?.threadKey ?? undefined,
      propertyId: context?.propertyId
        ?? (context?.entityType === 'property' ? context?.entityId ?? undefined : undefined),
      prospectId: context?.prospectId ?? undefined,
      masterOwnerId: context?.masterOwnerId ?? undefined,
    }
    const hasContextIdentity = Boolean(
      fromContext.threadKey || fromContext.propertyId || fromContext.prospectId || fromContext.masterOwnerId,
    )
    openInboxDealIntelligence(hasContextIdentity ? fromContext : undefined)
  }, [])

  return (
    <div className="nx-route-redirect-shell" aria-busy="true" aria-live="polite">
      <p>Opening Deal Intelligence…</p>
    </div>
  )
}
