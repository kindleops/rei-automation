export const POLL_INTERVAL_DEGRADED_MS = 60_000
export const POLL_INTERVAL_SELECTED_MS = 30_000

export type InboxRealtimePollStatus = 'connected' | 'connecting' | 'error' | 'disconnected' | 'disabled' | string

export type InboxConnectionPollState = 'live' | 'offline' | 'reconnecting' | 'degraded_polling' | string

export function shouldRunDegradedPoll(status: InboxRealtimePollStatus): boolean {
  return status === 'error' || status === 'disconnected' || status === 'disabled'
}

export function shouldRunSelectedThreadPoll(connectionState: InboxConnectionPollState): boolean {
  return connectionState === 'offline' || connectionState === 'degraded_polling'
}

export interface IntervalScheduler {
  stop: () => void
}

export function createIntervalScheduler(input: {
  intervalMs: number
  shouldRun: () => boolean
  onTick: () => void
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void
}): IntervalScheduler {
  const setIntervalFn = input.setIntervalFn ?? setInterval
  const clearIntervalFn = input.clearIntervalFn ?? clearInterval
  const timer = setIntervalFn(() => {
    if (!input.shouldRun()) return
    input.onTick()
  }, input.intervalMs)
  return {
    stop: () => clearIntervalFn(timer),
  }
}

export function createDegradedPollScheduler(input: {
  getRealtimeStatus: () => InboxRealtimePollStatus
  isCancelled: () => boolean
  isDocumentHidden: () => boolean
  onTick: () => void
  intervalMs?: number
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void
}): IntervalScheduler {
  return createIntervalScheduler({
    intervalMs: input.intervalMs ?? POLL_INTERVAL_DEGRADED_MS,
    setIntervalFn: input.setIntervalFn,
    clearIntervalFn: input.clearIntervalFn,
    shouldRun: () => !input.isCancelled()
      && !input.isDocumentHidden()
      && shouldRunDegradedPoll(input.getRealtimeStatus()),
    onTick: input.onTick,
  })
}

export function createSelectedThreadPollScheduler(input: {
  getConnectionState: () => InboxConnectionPollState
  isDocumentHidden: () => boolean
  isPollInFlight: () => boolean
  onTick: () => void
  intervalMs?: number
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void
}): IntervalScheduler | null {
  if (!shouldRunSelectedThreadPoll(input.getConnectionState())) return null
  return createIntervalScheduler({
    intervalMs: input.intervalMs ?? POLL_INTERVAL_SELECTED_MS,
    setIntervalFn: input.setIntervalFn,
    clearIntervalFn: input.clearIntervalFn,
    shouldRun: () => shouldRunSelectedThreadPoll(input.getConnectionState())
      && !input.isDocumentHidden()
      && !input.isPollInFlight(),
    onTick: input.onTick,
  })
}