/**
 * CONTEXT-PRESERVING NAVIGATION.
 *
 * The operator requirement: look at a seller thread for Property A, tap any
 * destination, arrive at THAT property. The product should feel like one operating
 * system, not a set of unrelated websites that each start from scratch.
 *
 * Two pieces already existed and this file joins them into one primitive:
 *
 *   domain/locator/property-locator  — WHAT the operator is looking at, published at
 *                                      selection time and persisted in sessionStorage
 *                                      because no in-memory value survives the unmount
 *                                      a route change causes.
 *   domain/app-registry              — WHICH identifier each destination can actually
 *                                      consume.
 *
 * Previously only PinnedAppDock resolved a focused destination, via a hand-written
 * switch. Every other entry point — the workspace launcher, the mobile app sheet, the
 * command palette — pushed a bare path and dropped the context on the floor. Anything
 * that navigates should go through `navigateToApp` so there is exactly one answer.
 *
 * Honesty rule: a focused URL is only produced when the target surface really reads
 * that identifier. The registry's `context` field is the contract, and it is empty for
 * surfaces that do not read one — the old dock appended `?property_id=` to /queue,
 * which QueuePage never parsed, so the URL looked focused and did nothing.
 */
import { pushRoutePath } from '../../app/router'
import { readPropertyLocator, type PropertyLocator } from '../locator/property-locator'
import { canonicalizeRoutePath, getApp, getAppByRoute, type AppId, type NexusApp } from './app-registry'

/** Side effects a destination needs that a path push cannot express. */
export interface ContextualNavigationEffects {
  /**
   * Deal Intelligence is a panel inside the inbox workspace, not a route, so it is
   * opened by event with an explicit identity. Without the identity it resolved to the
   * FIRST thread in the list, i.e. somebody else's deal.
   */
  openDealIntelligence: (identity?: {
    threadKey?: string | null
    propertyId?: string | null
    prospectId?: string | null
    masterOwnerId?: string | null
  }) => void
  openNotifications: () => void
  openSettings: () => void
  /**
   * Tapping Inbox while the Deal Intelligence panel is open used to push /inbox onto
   * /inbox — a no-op — stranding the operator in the panel. The caller supplies the
   * escape hatch because only it knows whether the panel is open.
   */
  closeInboxDealIntelligence?: () => void
  isInboxRoute?: (path: string) => boolean
}

export interface ResolvedDestination {
  /** The path to push, already canonicalised. Null when the app is action-only. */
  path: string | null
  /** True when the locator actually narrowed the destination. */
  focused: boolean
  /** Which identifier carried the context, for telemetry and for explaining the jump. */
  focusedBy: 'property_id' | 'opportunity_id' | 'thread_key' | null
}

/**
 * Where should this app go, given what the operator is currently looking at?
 *
 * Returns the plain path whenever the locator cannot narrow it, which is the
 * pre-existing behaviour — this can only ever add precision.
 */
export function resolveAppDestination(
  app: NexusApp,
  locator: PropertyLocator | null = readPropertyLocator(),
): ResolvedDestination {
  if (app.action) return { path: null, focused: false, focusedBy: null }

  const plain = { path: app.route, focused: false, focusedBy: null } as const
  if (!locator) return { ...plain }

  const { context } = app

  if (context.propertyId === 'path:/entity-graph/property' && locator.propertyId) {
    return {
      path: `/entity-graph/property/${encodeURIComponent(locator.propertyId)}`,
      focused: true,
      focusedBy: 'property_id',
    }
  }

  if (context.propertyId === 'query:property_id' && locator.propertyId) {
    return {
      path: `${app.route}?property_id=${encodeURIComponent(locator.propertyId)}`,
      focused: true,
      focusedBy: 'property_id',
    }
  }

  if (context.opportunityId === 'query:opp' && locator.opportunityId) {
    return {
      path: `${app.route}?opp=${encodeURIComponent(locator.opportunityId)}`,
      focused: true,
      focusedBy: 'opportunity_id',
    }
  }

  if (context.threadKey === 'query:thread' && locator.threadKey) {
    return {
      path: `${app.route}?thread=${encodeURIComponent(locator.threadKey)}`,
      focused: true,
      focusedBy: 'thread_key',
    }
  }

  /**
   * `locator` support means the destination seeds itself from the locator on mount
   * (InboxPage does this for /inbox, /conversation, /map, /pipeline, /calendar and
   * /comp-intelligence). The path is deliberately unchanged — the focus happens
   * inside the view, so a query parameter here would be decoration.
   */
  const seedsFromLocator = context.propertyId === 'locator' || context.threadKey === 'locator'
  if (seedsFromLocator) {
    const by = locator.propertyId ? 'property_id' : locator.threadKey ? 'thread_key' : null
    return { path: app.route, focused: Boolean(by), focusedBy: by }
  }

  return { ...plain }
}

/**
 * THE navigation entry point. Every launcher, dock and palette should call this
 * rather than pushRoutePath, so context preservation is a property of the platform
 * instead of something each surface remembers to do.
 */
export function navigateToApp(
  app: NexusApp,
  effects: ContextualNavigationEffects,
  locator: PropertyLocator | null = readPropertyLocator(),
): ResolvedDestination {
  if (app.action === 'deal_intelligence') {
    effects.openDealIntelligence(
      locator
        ? {
          threadKey: locator.threadKey,
          propertyId: locator.propertyId,
          prospectId: locator.prospectId,
          masterOwnerId: locator.masterOwnerId,
        }
        : undefined,
    )
    return { path: null, focused: Boolean(locator), focusedBy: locator?.threadKey ? 'thread_key' : null }
  }

  if (app.action === 'notifications') {
    effects.openNotifications()
    return { path: null, focused: false, focusedBy: null }
  }

  if (app.action === 'settings') {
    effects.openSettings()
    return { path: null, focused: false, focusedBy: null }
  }

  if (
    app.id === 'inbox'
    && effects.closeInboxDealIntelligence
    && effects.isInboxRoute?.(typeof window !== 'undefined' ? window.location.pathname : '')
  ) {
    effects.closeInboxDealIntelligence()
    return { path: null, focused: false, focusedBy: null }
  }

  const destination = resolveAppDestination(app, locator)
  if (destination.path) pushRoutePath(destination.path)
  return destination
}

/** Convenience for callers that only hold an id or a raw path (command palette results). */
export function navigateToAppId(
  id: AppId,
  effects: ContextualNavigationEffects,
  locator?: PropertyLocator | null,
): ResolvedDestination | null {
  const app = getApp(id)
  return app ? navigateToApp(app, effects, locator) : null
}

export function navigateToPath(
  rawPath: string,
  effects: ContextualNavigationEffects,
  locator?: PropertyLocator | null,
): ResolvedDestination {
  const canonical = canonicalizeRoutePath(rawPath)
  const app = getAppByRoute(canonical)
  if (app) return navigateToApp(app, effects, locator)
  // Deep links (/entity-graph/property/:id) are already focused; push them verbatim.
  pushRoutePath(canonical)
  return { path: canonical, focused: false, focusedBy: null }
}
