import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LiveActivitySpeed } from './commandMapLiveActivity'
import type { LiveActivityEvent } from './live-activity-engine'
import { sortLiveActivityEvents } from './live-activity-engine'

export const LIVE_ACTIVITY_DECK_STORAGE_KEY = 'nexus.commandMap.liveActivityDeck'

export const SPEED_TO_INTERVAL_MS: Record<LiveActivitySpeed, number> = {
  paused: 0,
  slow: 9000,
  normal: 6000,
  fast: 3500,
}

const FLIP_DURATION_MS = 380

type DeckPersistedState = {
  activeEventId: string | null
  acknowledgedIds: string[]
  pinnedIds: string[]
  manualPaused: boolean
}

const loadDeckState = (): DeckPersistedState => {
  const defaults: DeckPersistedState = {
    activeEventId: null,
    acknowledgedIds: [],
    pinnedIds: [],
    manualPaused: false,
  }
  if (typeof window === 'undefined') return defaults
  try {
    const raw = window.localStorage.getItem(LIVE_ACTIVITY_DECK_STORAGE_KEY)
    if (!raw) return defaults
    return { ...defaults, ...(JSON.parse(raw) as Partial<DeckPersistedState>) }
  } catch {
    return defaults
  }
}

const persistDeckState = (state: DeckPersistedState): void => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(LIVE_ACTIVITY_DECK_STORAGE_KEY, JSON.stringify(state))
}

export const applyDeckRanking = (
  events: LiveActivityEvent[],
  acknowledgedIds: Set<string>,
  pinnedIds: Set<string>,
): LiveActivityEvent[] => {
  const ranked = events.map((event) => {
    let score = event.rankScore
    if (pinnedIds.has(event.id)) score += 200
    if (acknowledgedIds.has(event.id)) score -= 260
    if (event.type === 'opt_out' && acknowledgedIds.has(event.id)) score -= 400
    if (event.isUnread) score += 30
    return { ...event, rankScore: score }
  })
  return sortLiveActivityEvents(ranked)
}

export type LiveActivityRecencyGroup = 'now' | 'lastHour' | 'today' | 'earlier'

export const groupEventsByRecency = (events: LiveActivityEvent[]): Record<LiveActivityRecencyGroup, LiveActivityEvent[]> => {
  const buckets: Record<LiveActivityRecencyGroup, LiveActivityEvent[]> = {
    now: [],
    lastHour: [],
    today: [],
    earlier: [],
  }
  const now = Date.now()
  for (const event of events) {
    const ageMs = now - new Date(event.occurredAt).getTime()
    if (ageMs < 5 * 60000) buckets.now.push(event)
    else if (ageMs < 60 * 60000) buckets.lastHour.push(event)
    else if (ageMs < 24 * 60 * 60000) buckets.today.push(event)
    else buckets.earlier.push(event)
  }
  return buckets
}

type UseLiveActivityDeckArgs = {
  queue: LiveActivityEvent[]
  speed: LiveActivitySpeed
  autoAdvance: boolean
  pauseOnHover: boolean
  isHovered: boolean
  isInteractionPaused: boolean
  reducedMotion: boolean
}

export function useLiveActivityDeck({
  queue,
  speed,
  autoAdvance,
  pauseOnHover,
  isHovered,
  isInteractionPaused,
  reducedMotion,
}: UseLiveActivityDeckArgs) {
  const persisted = useRef(loadDeckState())
  const [acknowledgedIds, setAcknowledgedIds] = useState<Set<string>>(() => new Set(persisted.current.acknowledgedIds))
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => new Set(persisted.current.pinnedIds))
  const [manualPaused, setManualPaused] = useState(persisted.current.manualPaused)
  const [activeEventId, setActiveEventId] = useState<string | null>(persisted.current.activeEventId)
  const [isFlipped, setIsFlipped] = useState(false)
  const [incomingEventId, setIncomingEventId] = useState<string | null>(null)
  const [isFlipping, setIsFlipping] = useState(false)
  const flipTimerRef = useRef<number | null>(null)
  const prevTopIdRef = useRef<string | null>(null)

  const rankedQueue = useMemo(
    () => applyDeckRanking(queue, acknowledgedIds, pinnedIds),
    [acknowledgedIds, pinnedIds, queue],
  )

  const activeIndex = useMemo(() => {
    if (rankedQueue.length === 0) return 0
    if (activeEventId) {
      const found = rankedQueue.findIndex((event) => event.id === activeEventId)
      if (found >= 0) return found
    }
    return 0
  }, [activeEventId, rankedQueue])

  const activeEvent = rankedQueue[activeIndex] ?? null
  const incomingEvent = useMemo(() => {
    if (!incomingEventId) return null
    return rankedQueue.find((event) => event.id === incomingEventId) ?? null
  }, [incomingEventId, rankedQueue])

  const nextEvent = incomingEvent
    ?? (rankedQueue.length > 1 ? rankedQueue[(activeIndex + 1) % rankedQueue.length] : null)

  useEffect(() => {
    persistDeckState({
      activeEventId: activeEvent?.id ?? null,
      acknowledgedIds: [...acknowledgedIds],
      pinnedIds: [...pinnedIds],
      manualPaused,
    })
  }, [acknowledgedIds, activeEvent?.id, manualPaused, pinnedIds])

  useEffect(() => {
    if (activeEvent?.id) setActiveEventId(activeEvent.id)
  }, [activeEvent?.id])

  const resolveFlipTarget = useCallback((index: number): LiveActivityEvent | null => {
    if (rankedQueue.length === 0) return null
    const normalized = ((index % rankedQueue.length) + rankedQueue.length) % rankedQueue.length
    return rankedQueue[normalized] ?? null
  }, [rankedQueue])

  const flipToIndex = useCallback((index: number, options?: { interrupt?: boolean }) => {
    const target = resolveFlipTarget(index)
    if (!target || target.id === activeEvent?.id) return

    if (reducedMotion || options?.interrupt === false) {
      setActiveEventId(target.id)
      setIncomingEventId(null)
      setIsFlipped(false)
      return
    }

    if (isFlipping) return

    setIsFlipping(true)
    setIncomingEventId(target.id)
    setIsFlipped(true)
    if (flipTimerRef.current) window.clearTimeout(flipTimerRef.current)
    flipTimerRef.current = window.setTimeout(() => {
      setActiveEventId(target.id)
      setIncomingEventId(null)
      setIsFlipped(false)
      setIsFlipping(false)
    }, FLIP_DURATION_MS)
  }, [activeEvent?.id, isFlipping, reducedMotion, resolveFlipTarget])

  const goNext = useCallback(() => {
    if (rankedQueue.length <= 1) return
    flipToIndex(activeIndex + 1)
  }, [activeIndex, flipToIndex, rankedQueue.length])

  const goPrevious = useCallback(() => {
    if (rankedQueue.length <= 1) return
    flipToIndex(activeIndex - 1)
  }, [activeIndex, flipToIndex, rankedQueue.length])

  const acknowledgeActive = useCallback(() => {
    if (!activeEvent) return
    setAcknowledgedIds((current) => new Set([...current, activeEvent.id]))
    goNext()
  }, [activeEvent, goNext])

  const togglePinActive = useCallback(() => {
    if (!activeEvent) return
    setPinnedIds((current) => {
      const next = new Set(current)
      if (next.has(activeEvent.id)) next.delete(activeEvent.id)
      else next.add(activeEvent.id)
      return next
    })
  }, [activeEvent])

  const toggleManualPause = useCallback(() => {
    setManualPaused((current) => !current)
  }, [])

  // High-priority interrupt
  useEffect(() => {
    const top = rankedQueue[0]
    if (!top || !activeEvent) return
    if (top.id === prevTopIdRef.current) return
    prevTopIdRef.current = top.id

    const shouldInterrupt = top.rankScore > activeEvent.rankScore + 120 && top.id !== activeEvent.id
    if (shouldInterrupt) {
      flipToIndex(0, { interrupt: true })
    }
  }, [activeEvent, flipToIndex, rankedQueue])

  // Scope change: if active event fell out of queue, flip to top
  useEffect(() => {
    if (!activeEventId || rankedQueue.length === 0) return
    const stillQualified = rankedQueue.some((event) => event.id === activeEventId)
    if (!stillQualified) {
      flipToIndex(0, { interrupt: false })
    }
  }, [activeEventId, flipToIndex, rankedQueue])

  // Autoplay
  useEffect(() => {
    const intervalMs = SPEED_TO_INTERVAL_MS[speed]
    const paused = manualPaused
      || !autoAdvance
      || intervalMs === 0
      || rankedQueue.length <= 1
      || isFlipping
      || isInteractionPaused
      || (pauseOnHover && isHovered)

    if (paused) return

    const timer = window.setInterval(() => {
      goNext()
    }, intervalMs)

    return () => window.clearInterval(timer)
  }, [
    autoAdvance,
    goNext,
    isFlipping,
    isHovered,
    isInteractionPaused,
    manualPaused,
    pauseOnHover,
    rankedQueue.length,
    speed,
  ])

  useEffect(() => () => {
    if (flipTimerRef.current) window.clearTimeout(flipTimerRef.current)
  }, [])

  return {
    rankedQueue,
    activeEvent,
    nextEvent,
    activeIndex,
    queueCount: rankedQueue.length,
    isFlipped,
    isFlipping,
    flipDurationMs: FLIP_DURATION_MS,
    manualPaused,
    isPinned: activeEvent ? pinnedIds.has(activeEvent.id) : false,
    goNext,
    goPrevious,
    acknowledgeActive,
    togglePinActive,
    toggleManualPause,
    flipToIndex,
  }
}