import type { LCToastMessage } from './toast-bus'

/**
 * Pure: put a raised toast on the stack. A toast whose `key` matches one on
 * screen replaces it IN PLACE (same slot, that toast's id kept so its timer and
 * exit animation stay coherent); otherwise it goes on top. Capped at `max`.
 */
export function upsertToast(prev: LCToastMessage[], toast: LCToastMessage, max: number): { toasts: LCToastMessage[]; replacedId: string | null } {
  if (toast.key) {
    const i = prev.findIndex((t) => t.key === toast.key)
    if (i >= 0) {
      const kept = prev[i].id
      const next = [...prev]
      next[i] = { ...toast, id: kept }
      return { toasts: next, replacedId: kept }
    }
  }
  return { toasts: [toast, ...prev].slice(0, max), replacedId: null }
}
