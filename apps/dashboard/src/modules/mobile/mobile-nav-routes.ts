/**
 * Mobile icon vocabulary.
 *
 * This file also carried MOBILE_MORE_ROUTES, MOBILE_TAB_ROUTES and resolveMobileNavTab
 * — a third, silently dead navigation list with ZERO consumers that had drifted badly
 * from the surfaces actually rendered: it called Entity Graph "Property Lists", routed
 * Deal Intelligence at `/inbox`, omitted Buyer Match, Properties and Comp Intelligence,
 * and hard-coded a four-tab model the product no longer uses.
 *
 * Dead navigation lists are not harmless: they read like truth to the next person
 * editing mobile navigation. They are gone; domain/app-registry is the one registry.
 */

export type NavIconName =
  | 'radar'
  | 'inbox'
  | 'alert'
  | 'stats'
  | 'map'
  | 'users'
  | 'file-text'
  | 'settings'
  | 'bell'
  | 'star'
  | 'grid'
  | 'target'
  | 'send'
  | 'mail'
