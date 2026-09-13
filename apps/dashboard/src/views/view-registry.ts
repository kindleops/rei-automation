/**
 * DERIVED VIEW of the canonical application registry.
 *
 * This was a fourth hand-maintained list of applications with zero consumers. It had
 * already drifted — it knew nothing about Entity Graph or Properties, and it described
 * Comp Intelligence and Pipeline as if they had their own top-level folders when both
 * render through the inbox workspace.
 *
 * It is kept only as a folder map (the one fact it held that the canonical registry
 * does not) and now derives everything else. Add applications in domain/app-registry.
 */
import { NEXUS_APPS, type AppId } from '../domain/app-registry/app-registry'

export type CanonicalViewId = AppId

export const CANONICAL_VIEW_IDS: readonly CanonicalViewId[] = NEXUS_APPS.map((app) => app.id)

export interface CanonicalViewMeta {
  id: CanonicalViewId
  label: string
  route: string
  /** Where the surface's source lives. Several views render through views/inbox. */
  folder: string
}

/** Only the surfaces whose implementation does NOT live in its own same-named folder. */
const FOLDER_OVERRIDES: Partial<Record<AppId, string>> = {
  conversation: 'views/conversation',
  'deal-intelligence': 'views/deal-intelligence',
  'comp-intelligence': 'views/comp-intelligence',
  pipeline: 'views/pipeline',
  map: 'views/map',
  calendar: 'views/calendar',
  properties: 'views/deal-intelligence',
  'entity-graph': 'modules/entity-graph',
  analytics: 'views/analytics',
  notifications: 'modules/notifications',
  settings: 'modules/mobile',
}

export const CANONICAL_VIEWS: Record<CanonicalViewId, CanonicalViewMeta> = Object.fromEntries(
  NEXUS_APPS.map((app) => [
    app.id,
    {
      id: app.id,
      label: app.label,
      route: app.route,
      folder: FOLDER_OVERRIDES[app.id] ?? `views/${app.id}`,
    },
  ]),
) as Record<CanonicalViewId, CanonicalViewMeta>
