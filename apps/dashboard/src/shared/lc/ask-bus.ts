/**
 * ConfirmAction / prompt bus — lets any action handler (including plain .ts
 * modules) ask the operator through LCConfirm / LCDialog instead of the
 * browser's confirm() and prompt().
 *
 *   if (!(await lcConfirm({ title, effects, confirmLabel, nativeText }))) return
 *   const name = await lcPrompt({ title, label, initialValue, nativeText })
 *
 * One LCAskHost renders the requests. Where no host is mounted (mobile shell,
 * tests) the request falls back to the browser dialog with the same
 * `nativeText`, so nothing is ever auto-confirmed and nothing changes where
 * the host is absent.
 */
import type { LCEffect } from './Dialog'

export interface LCConfirmRequest {
  title: string
  effects: LCEffect[]
  confirmLabel: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
  /** the exact text for the browser fallback when no host is mounted */
  nativeText: string
}

export interface LCPromptRequest {
  title: string
  /** field label, e.g. "Name" */
  label: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  /** the exact prompt text for the browser fallback */
  nativeText: string
}

export type LCAskEntry =
  | { id: number; kind: 'confirm'; req: LCConfirmRequest; resolve: (ok: boolean) => void }
  | { id: number; kind: 'prompt'; req: LCPromptRequest; resolve: (value: string | null) => void }

type Listener = () => void

let queue: LCAskEntry[] = []
let hosts = 0
let seq = 0
const listeners = new Set<Listener>()
const emit = () => { for (const fn of listeners) fn() }

export function subscribeAsk(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function getAskQueue(): LCAskEntry[] {
  return queue
}

/** A host registers while mounted; returns its unregister. */
export function registerAskHost(): () => void {
  hosts++
  return () => {
    hosts = Math.max(0, hosts - 1)
    if (hosts === 0) {
      // A host going away must not leave a caller waiting forever, and must
      // never be read as consent: pending asks resolve as cancelled.
      const pending = queue
      queue = []
      for (const entry of pending) {
        if (entry.kind === 'confirm') entry.resolve(false)
        else entry.resolve(null)
      }
      emit()
    }
  }
}

export function hasAskHost(): boolean {
  return hosts > 0
}

/** Settle the entry with `id` and remove it from the queue. */
export function settleAsk(id: number, value: boolean | string | null): void {
  const entry = queue.find((e) => e.id === id)
  if (!entry) return
  queue = queue.filter((e) => e.id !== id)
  emit()
  if (entry.kind === 'confirm') entry.resolve(value === true)
  else entry.resolve(typeof value === 'string' ? value : null)
}

export function lcConfirm(req: LCConfirmRequest): Promise<boolean> {
  if (!hasAskHost()) {
    return Promise.resolve(typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(req.nativeText) : false)
  }
  return new Promise<boolean>((resolve) => {
    queue = [...queue, { id: ++seq, kind: 'confirm', req, resolve }]
    emit()
  })
}

export function lcPrompt(req: LCPromptRequest): Promise<string | null> {
  if (!hasAskHost()) {
    return Promise.resolve(typeof window !== 'undefined' && typeof window.prompt === 'function' ? window.prompt(req.nativeText, req.initialValue) : null)
  }
  return new Promise<string | null>((resolve) => {
    queue = [...queue, { id: ++seq, kind: 'prompt', req, resolve }]
    emit()
  })
}
