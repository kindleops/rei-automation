import { useMemo } from 'react'
import { callBackend } from '../../lib/api/backendClient'
import { useHomeSource } from '../../views/home/desktop/board/home-sources'
import { SOURCES, type SourceDef } from '../../views/home/desktop/board/board-data'
import type { HomeLoad } from '../../views/home/home-signals'
import { useStoryStore } from '../notifications/plane/story-store'
import { useGoals } from '../../views/analytics/goals/goals-store'
import type { EventsResponse, PlatformEvent } from '../desktop/feed/feed-model'
import type { Story } from '../notifications/plane/story-model'
import type { BriefFacts, Load } from './brief-model'

/**
 * BRIEF SOURCES — every input is a read the owning app already makes:
 *
 *   signals    GET /api/cockpit/signals                (Home's shared source)
 *   stories    the shell's one Notification Center story store (no request)
 *   movement   GET /api/cockpit/platform/events, stage / deal types, 24 h
 *   campaigns  Campaign Command's campaign list        (Home's shared source)
 *   inbox      the inbox new_replies bucket            (Home's shared source)
 *   closings   Closing Desk live cases                 (Home's shared source)
 *   goals      the goals store + /analytics/goals/progress
 *
 * Reads go through Home's shared source cache, so the Brief widget, the Brief
 * plane and every other widget reading the same thing make ONE request.
 */

const MOVEMENT_TYPES = ['stage.advanced', 'stage.regressed', 'deal.opened']

export const movementSource: SourceDef<PlatformEvent[]> = {
  key: 'brief-movement-24h',
  load: async (signal) => {
    const q = new URLSearchParams({ since: new Date(Date.now() - 86_400_000).toISOString(), types: MOVEMENT_TYPES.join(','), sources: 'pipeline', limit: '80' })
    const res = await callBackend<EventsResponse>(`/api/cockpit/platform/events?${q.toString()}`, { signal, timeoutMs: 45_000 })
    if (!res.ok || !res.data?.ok) throw new Error('Pipeline movement could not be read')
    if (res.data.degraded?.includes('pipeline')) throw new Error('The pipeline ledger did not answer')
    return res.data.events
  },
  apps: ['/pipeline'],
  everyMs: 120_000,
}

const asLoad = <T,>(l: HomeLoad<T>): Load<T> => (l.status === 'ready' ? { status: 'ready', data: l.data, at: l.at } : l.status === 'unavailable' ? { status: 'unavailable', reason: l.reason } : { status: 'loading' })

function useSource<T>(def: SourceDef<T>, active: boolean): Load<T> {
  const { load } = useHomeSource<T>(def.key, def.load, { everyMs: def.everyMs, active, apps: def.apps })
  return asLoad(load)
}

/** Everything the Brief composes, as loads (nothing is fetched while `active` is false). */
export function useBriefFacts(active: boolean, now: number): BriefFacts {
  const signals = useSource(SOURCES.signals, active)
  const inbox = useSource(SOURCES.inbox, active)
  const campaignBook = useSource(SOURCES.campaigns, active)
  const closings = useSource(SOURCES.closings, active)
  const movement = useSource(movementSource, active)
  const st = useStoryStore()
  const g = useGoals(active)

  const stories = useMemo<Load<Story[]>>(() => (
    st.status === 'ready' ? { status: 'ready', data: [...st.stories.values()] } : st.status === 'error' ? { status: 'unavailable', reason: st.error ?? 'Notification Center did not answer' } : { status: 'loading' }
  ), [st.status, st.stories, st.error])

  const campaigns = useMemo(() => (campaignBook.status === 'ready' ? { status: 'ready' as const, data: campaignBook.data.summary } : campaignBook), [campaignBook])

  const activeGoals = g.goals.filter((x) => x.status === 'active').length
  const goals = useMemo<BriefFacts['goals']>(() => {
    if (!g.ready) return { status: 'loading' }
    if (!activeGoals) return { status: 'ready', data: { goals: [], progress: {}, catalogue: g.catalogue } }
    if (g.progress.status === 'error' && !Object.keys(g.progress.byId).length) return { status: 'unavailable', reason: g.progress.error ?? 'Goal progress did not load' }
    if (!Object.keys(g.progress.byId).length) return { status: 'loading' }
    return { status: 'ready', data: { goals: g.goals, progress: g.progress.byId, catalogue: g.catalogue } }
  }, [g.ready, g.goals, g.progress, g.catalogue, activeGoals])

  return { now, signals, stories, movement, campaigns, inbox, closings, goals }
}
