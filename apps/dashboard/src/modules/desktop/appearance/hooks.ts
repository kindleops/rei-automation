import { useEffect, useRef, useState } from 'react'

export const cx = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/**
 * While `active`, Esc belongs to this layer first (capture phase on window):
 * the colour editor and inline edits close before the panel behind them.
 * Layers stack — the most recently opened one handles Esc.
 */
const stack: Array<{ id: number; fn: () => void }> = []
let seq = 0
let installed = false
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !stack.length) return
  e.stopPropagation()
  e.preventDefault()
  stack[stack.length - 1].fn()
}

export function useEscapeLayer(active: boolean, onEscape: () => void) {
  const handler = useRef(onEscape)
  useEffect(() => { handler.current = onEscape })
  useEffect(() => {
    if (!active) return
    const entry = { id: ++seq, fn: () => handler.current() }
    stack.push(entry)
    if (!installed) { window.addEventListener('keydown', onKey, true); installed = true }
    return () => {
      const i = stack.findIndex((s) => s.id === entry.id)
      if (i >= 0) stack.splice(i, 1)
      if (!stack.length && installed) { window.removeEventListener('keydown', onKey, true); installed = false }
    }
  }, [active])
}

/** A short-lived confirmation word ("Copied", "Saved") — swaps in place, then back. */
export function useFlash(ms = 1400): [string | null, (word: string) => void] {
  const [word, setWord] = useState<string | null>(null)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return [word, (next: string) => {
    window.clearTimeout(timer.current)
    setWord(next)
    timer.current = window.setTimeout(() => setWord(null), ms)
  }]
}
