import { useCallback, useEffect, useRef, useState } from 'react'
import { replaceRoutePath, useRouteLocation } from '../../../app/router'
import { readPropertyLocator, setPropertyLocator, type PropertyLocator } from '../../../domain/locator/property-locator'
import { useWorkspaceLink } from '../../../modules/desktop/workspace/instance-context'
import { useLinkedProperty } from '../../../modules/desktop/workspace/linked-property'

export type SubjectSource = 'url' | 'locator' | 'host' | 'none'

const ROUTE = '/comp-intelligence'

function pidFromLocation(location: string): string | null {
  const q = location.indexOf('?')
  if (q < 0) return null
  const pid = new URLSearchParams(location.slice(q + 1)).get('property_id')
  return pid && pid.trim() ? pid.trim() : null
}

const pathOf = (location: string) => (location.indexOf('?') < 0 ? location : location.slice(0, location.indexOf('?')))

/**
 * The subject Comp Intelligence is valuing, and where it came from.
 *
 *   location  the PANE's own path + query (useRouteLocation) — a side pane
 *             never reads another app's URL; the shell retargets a linked
 *             pane by rewriting this path (app registry: query:property_id)
 *   locator   live linked context, ONLY while the pane follows
 *             (useWorkspaceLink().follows); a pinned pane keeps its subject
 *   host      the property the embedding surface hands over (classic Inbox
 *             multi-view passes its selected deal context)
 *
 * The most recent of location / locator wins. A hand-off this surface
 * emits itself (focusing linked apps on a comp's property) is ignored here,
 * so sending a comp to Deal Intelligence never re-aims Comps at that comp.
 */
export function useCompsSubject(hostPropertyId: string | null) {
  const location = useRouteLocation()
  const urlPid = pidFromLocation(location)
  const { follows, pinned, pinLabel } = useWorkspaceLink()
  const selfEmit = useRef<{ pid: string; at: number } | null>(null)

  const [active, setActive] = useState<{ pid: string | null; source: SubjectSource }>(() => {
    if (urlPid) return { pid: urlPid, source: 'url' }
    if (follows) {
      const loc = readPropertyLocator()
      if (loc?.propertyId) return { pid: loc.propertyId, source: 'locator' }
    }
    return { pid: null, source: 'none' }
  })

  // The pane's location moved (shell retarget, back/forward, a link): adopt it.
  const [seenUrl, setSeenUrl] = useState(urlPid)
  if (seenUrl !== urlPid) {
    setSeenUrl(urlPid)
    if (urlPid && urlPid !== active.pid) setActive({ pid: urlPid, source: 'url' })
  }

  // Re-linking a pane is a meaningful act: catch up with the workspace.
  const [seenFollows, setSeenFollows] = useState(follows)
  if (seenFollows !== follows) {
    setSeenFollows(follows)
    if (follows) {
      const loc = readPropertyLocator()
      if (loc?.propertyId && loc.propertyId !== active.pid) setActive({ pid: loc.propertyId, source: 'locator' })
    }
  }

  // Live linked context (the bus: debounced, latest wins, never this pane's
  // own selection; gated on `follows`). Comps is heavy — one read per settled click.
  const followLinked = useCallback((loc: PropertyLocator) => {
    const pid = loc.propertyId ?? null
    if (!pid) return
    const mine = selfEmit.current
    if (mine && mine.pid === pid && Date.now() - mine.at < 4000) return
    setActive((cur) => (cur.pid === pid ? cur : { pid, source: 'locator' }))
  }, [])
  useLinkedProperty(followLinked)

  const pid = active.pid ?? hostPropertyId ?? null
  const source: SubjectSource = active.pid ? active.source : hostPropertyId ? 'host' : 'none'

  // Keep the location truthful when the subject did not come from it, so a
  // reload or a shared link returns here — only on this app's own route
  // (embedded in another view, the location belongs to that view).
  useEffect(() => {
    if (!pid || source === 'url' || source === 'none') return
    if (pathOf(location) !== ROUTE || urlPid === pid) return
    replaceRoutePath(`${ROUTE}?property_id=${encodeURIComponent(pid)}`)
  }, [pid, source, location, urlPid])

  /** Explicit operator hand-off: aim linked apps at a property without re-aiming Comps. */
  const handOff = useCallback((propertyId: string, address: string | null) => {
    selfEmit.current = { pid: propertyId, at: Date.now() }
    setPropertyLocator({ propertyId, address })
  }, [])

  return { propertyId: pid, source, follows, pinned, pinLabel, handOff }
}
