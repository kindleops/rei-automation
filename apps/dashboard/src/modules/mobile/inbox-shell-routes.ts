/**
 * Routes that render InboxPage with the shared NexusTopBar command shell.
 *
 * This list decides whether `GlobalNotificationShell` also mounts
 * `PortableCommandShell`. NexusTopBar and PortableCommandShell each paint a
 * `.nx-mobile-command-dock`, so a route that renders InboxPage but is MISSING
 * from this set gets TWO fixed top docks at `top: 0; z-index: 150`, stacked
 * exactly on top of each other — and the lower one's controls become
 * permanently unclickable.
 *
 * `/analytics` was exactly that. ANALYTICS-MOBILE-LOCK-1 repointed the route to
 * `<InboxView initialWorkspaceView="metrics" routeMode="fullscreen" />` — which
 * makes it an inbox-shell route — without adding it here, so production served
 * two top docks and four dead controls underneath the live ones.
 *
 * This is the THIRD time a hardcoded route list has silently drifted from a
 * routing change: `resolveMobileAwareLayoutMode`'s compact list lost Calendar,
 * then Analytics, and now this set lost Analytics. When you change what a route
 * renders, grep for the route's path — the router is not the only place that
 * has an opinion about it.
 */
export const INBOX_COMMAND_SHELL_ROUTES = new Set([
  '/',
  '/inbox',
  '/conversation',
  '/map',
  '/pipeline',
  '/calendar',
  '/comp-intelligence',
  '/analytics',
])

export function routeHasInboxCommandShell(path: string): boolean {
  return INBOX_COMMAND_SHELL_ROUTES.has(path)
}
