import { useCallback, useEffect, useMemo, useState } from 'react'
import { replaceRoutePath, useRouteLocation } from '../../../app/router'
import { PROPERTY_LOCATOR_EVENT, readPropertyLocator, setPropertyLocator, type PropertyLocator } from '../../../domain/locator/property-locator'
import { useWorkspaceLink } from '../../../modules/desktop/workspace/instance-context'
import {
  buildDiPath, EMPTY_SUBJECT, fetchKey, hasSubject, modeFromSearch, sameSubject, searchOf, subjectFromLocator, subjectFromSearch, type DiSubject,
} from './di-subject'
import type { DiMode } from './di-types'

type Source = 'prop' | 'url' | 'locator' | 'select' | 'none'
interface Active { subject: DiSubject; source: Source }

/**
 * The subject Deal Intelligence is showing, and where it came from.
 *
 *   explicit prop  → always wins (a host embedding the surface)
 *   location       → the PANE's own path + query (useRouteLocation), so a side
 *                    pane never reads another app's URL; a change while
 *                    mounted moves the subject in place
 *   locator        → live linked context, ONLY while the pane follows
 *                    (useWorkspaceLink().follows); a pinned pane ignores it
 *
 * Whichever of location / locator changed most recently wins. When the
 * subject came from the locator or an in-app selection, the location is
 * rewritten (replace, not push) so a reload or a shared link returns here.
 */
export function useDecisionSubject(explicit?: DiSubject | null) {
  const location = useRouteLocation()
  const search = searchOf(location)
  const urlSubject = useMemo(() => subjectFromSearch(search), [search])
  const urlMode = useMemo(() => modeFromSearch(search), [search])
  const { follows, pinned, pinLabel } = useWorkspaceLink()

  const [active, setActive] = useState<Active>(() => {
    if (hasSubject(urlSubject)) return { subject: urlSubject, source: 'url' }
    if (follows) {
      const fromLocator = subjectFromLocator(readPropertyLocator())
      if (hasSubject(fromLocator)) return { subject: fromLocator, source: 'locator' }
    }
    return { subject: EMPTY_SUBJECT, source: 'none' }
  })

  // The location moved (shell retargeted this pane, back/forward, a link):
  // adopt it — derived during render, not in an effect.
  const [seenSearch, setSeenSearch] = useState(search)
  if (seenSearch !== search) {
    setSeenSearch(search)
    if (hasSubject(urlSubject) && fetchKey(urlSubject) !== fetchKey(active.subject)) setActive({ subject: urlSubject, source: 'url' })
  }

  // Live linked context — a selection elsewhere in the workspace.
  useEffect(() => {
    if (!follows) return
    const onLocator = (e: Event) => {
      const detail = (e as CustomEvent<PropertyLocator | null>).detail
      const next = subjectFromLocator(detail ?? null)
      if (!hasSubject(next)) return
      setActive((cur) => (sameSubject(cur.subject, next) ? cur : { subject: next, source: 'locator' }))
    }
    window.addEventListener(PROPERTY_LOCATOR_EVENT, onLocator)
    return () => window.removeEventListener(PROPERTY_LOCATOR_EVENT, onLocator)
  }, [follows])

  // Re-linking a pane is a meaningful selection: catch up with the workspace.
  const [seenFollows, setSeenFollows] = useState(follows)
  if (seenFollows !== follows) {
    setSeenFollows(follows)
    if (follows) {
      const fromLocator = subjectFromLocator(readPropertyLocator())
      if (hasSubject(fromLocator) && !sameSubject(active.subject, fromLocator)) setActive({ subject: fromLocator, source: 'locator' })
    }
  }

  const subject = explicit && hasSubject(explicit) ? explicit : active.subject
  const source: Source = explicit && hasSubject(explicit) ? 'prop' : active.source

  // Mode: the URL is the record of it; changes go back to the URL.
  const [mode, setModeState] = useState<DiMode>(urlMode ?? 'decision')
  const [seenMode, setSeenMode] = useState(urlMode)
  if (seenMode !== urlMode) {
    setSeenMode(urlMode)
    if (urlMode && urlMode !== mode) setModeState(urlMode)
  }

  // Keep the location truthful when the subject did not come from it.
  useEffect(() => {
    if (source === 'prop' || source === 'none') return
    const want = buildDiPath(subject, mode)
    const current = `/deal-intelligence${search}`
    if (fetchKey(subjectFromSearch(search)) !== fetchKey(subject) || (modeFromSearch(search) ?? 'decision') !== mode) {
      if (want !== current) replaceRoutePath(want)
    }
  }, [subject, mode, search, source])

  const setMode = useCallback((m: DiMode) => setModeState(m), [])

  /** An in-app subject choice: show it here and tell linked panes. */
  const select = useCallback((next: DiSubject & { address?: string | null }) => {
    if (!hasSubject(next)) return
    setActive({ subject: next, source: 'select' })
    setPropertyLocator({
      propertyId: next.propertyId,
      threadKey: next.threadKey,
      opportunityId: next.opportunityId,
      prospectId: next.prospectId,
      masterOwnerId: next.masterOwnerId,
      address: next.address ?? null,
    })
  }, [])

  return { subject, source, mode, setMode, select, follows, pinned, pinLabel }
}
