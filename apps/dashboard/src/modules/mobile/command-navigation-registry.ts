/**
 * DERIVED VIEW of the canonical application registry.
 *
 * This file used to BE a registry — a hand-maintained list of 15 applications that
 * disagreed with app/routes.tsx (24 routes), CommandCenterApp.navItems (15) and two
 * dead lists. Properties and Comp Intelligence were missing from it entirely, which is
 * precisely why they were unreachable on a phone: this list is what the mobile
 * launcher and the dock render.
 *
 * It now derives from domain/app-registry. The `CommandNavRoute` shape is kept because
 * the dock's persisted operator settings key off `path`, and a rename would silently
 * reset every operator's pinned apps. Add applications in the canonical registry.
 */
import {
  NEXUS_APPS,
  isAppActive,
  type NexusApp,
} from '../../domain/app-registry/app-registry'
import type { IconName } from '../../shared/icons'

export type { NavIconName } from './mobile-nav-routes'

export type CommandNavAction = 'route' | 'settings' | 'notifications' | 'deal_intelligence'

export interface CommandNavRoute {
  path: string
  label: string
  description?: string
  icon: IconName
  workspaceKey?: string
  action?: CommandNavAction
}

/**
 * Deal Intelligence is stored as `__deal_intelligence__` in operator settings because
 * it is a panel inside the inbox workspace rather than a route. Preserved verbatim so
 * existing pinned docks keep resolving.
 */
export const DOCK_ID_BY_APP_ID: Partial<Record<NexusApp['id'], string>> = {
  'deal-intelligence': '__deal_intelligence__',
}

export const dockIdForApp = (app: NexusApp): string => DOCK_ID_BY_APP_ID[app.id] ?? app.route

const WORKSPACE_KEY_BY_APP_ID: Partial<Record<NexusApp['id'], string>> = {
  inbox: 'deal_desk',
  map: 'command_map',
  pipeline: 'pipeline',
  'deal-intelligence': 'deal_desk',
}

const toCommandNavRoute = (app: NexusApp): CommandNavRoute => ({
  path: dockIdForApp(app),
  label: app.label,
  description: app.description,
  icon: app.icon,
  workspaceKey: WORKSPACE_KEY_BY_APP_ID[app.id],
  action: app.action,
})

/** Every application, in canonical registry order. */
export const COMMAND_NAV_ROUTES: CommandNavRoute[] = NEXUS_APPS.map(toCommandNavRoute)

/** Reverse lookup so a CommandNavRoute can recover its canonical app. */
const APP_BY_DOCK_ID = new Map(NEXUS_APPS.map((app) => [dockIdForApp(app), app]))

export const appForCommandNavRoute = (item: CommandNavRoute): NexusApp | undefined =>
  APP_BY_DOCK_ID.get(item.path)

export function isCommandNavRouteActive(routePath: string, item: CommandNavRoute): boolean {
  const app = APP_BY_DOCK_ID.get(item.path)
  return app ? isAppActive(routePath, app) : false
}

export function resolveCommandNavLabel(path: string): string {
  return APP_BY_DOCK_ID.get(path)?.label ?? 'NEXUS'
}
