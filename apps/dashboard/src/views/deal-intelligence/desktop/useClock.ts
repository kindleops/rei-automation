import { useSyncExternalStore } from 'react'

/**
 * One shared clock for relative times ("3h ago"), so render stays pure:
 * components read a snapshot instead of calling Date.now() while rendering.
 * Ticks every 30 s while anything is subscribed; stops when nothing is.
 */
let now = Date.now()
let timer: number | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (timer === null && typeof window !== 'undefined') {
    now = Date.now()
    timer = window.setInterval(() => {
      now = Date.now()
      listeners.forEach((l) => l())
    }, 30_000)
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size && timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }
}

const snapshot = () => now

export function useClock(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
