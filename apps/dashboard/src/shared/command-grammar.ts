import { useCallback, useEffect, useRef, useState } from 'react'

// ── Command Grammar Engine ─────────────────────────────────────────────────
// Vim-inspired multi-key command sequences for NEXUS.
// Handles two-key combos (e.g. `g h`, `m l`) with a 500ms timeout window.
// Ignores sequences when the user is typing in an input field.

export type CommandBinding = {
  keys: string  // Display format, e.g. 'g h'
  seq: string[] // Actual key sequence, e.g. ['g', 'h']
  label: string
  category: string
  action: () => void
}

export type GrammarState = {
  pending: string | null
  lastExecuted: string | null
}

const SEQUENCE_TIMEOUT = 500

export const useCommandGrammar = (bindings: CommandBinding[]) => {
  const [state, setState] = useState<GrammarState>({
    pending: null,
    lastExecuted: null,
  })

  const pendingKeyRef = useRef<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bindingsRef = useRef(bindings)

  useEffect(() => {
    bindingsRef.current = bindings
  }, [bindings])

  const clearPending = useCallback(() => {
    pendingKeyRef.current = null
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    setState((prev) => ({ ...prev, pending: null }))
  }, [])

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    const activeBindings = bindingsRef.current

    // Skip when user is in an input field
    const target = event.target
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return
    }

    // Skip modifier combos — those are handled by the app shell
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return
    }

    const key = event.key.toLowerCase()

    // If there's a pending first key, try to match a two-key sequence
    if (pendingKeyRef.current) {
      const firstKey = pendingKeyRef.current
      clearPending()

      const match = activeBindings.find(
        (b) => b.seq.length === 2 && b.seq[0] === firstKey && b.seq[1] === key,
      )

      if (match) {
        event.preventDefault()
        match.action()
        setState({ pending: null, lastExecuted: match.keys })
        return
      }
    }

    // Check if this key is the first key of any two-key binding
    const isFirstKey = activeBindings.some((b) => b.seq.length === 2 && b.seq[0] === key)

    // Check if this key is a single-key binding
    const singleMatch = activeBindings.find((b) => b.seq.length === 1 && b.seq[0] === key)

    if (isFirstKey) {
      event.preventDefault()
      pendingKeyRef.current = key
      setState((prev) => ({ ...prev, pending: key }))

      timeoutRef.current = setTimeout(() => {
        // Timeout expired — if there's a single-key fallback, execute it
        if (singleMatch) {
          singleMatch.action()
          setState({ pending: null, lastExecuted: singleMatch.keys })
        } else {
          clearPending()
        }
      }, SEQUENCE_TIMEOUT)
      return
    }

    if (singleMatch) {
      event.preventDefault()
      singleMatch.action()
      setState({ pending: null, lastExecuted: singleMatch.keys })
    }
  }, [clearPending])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      onKeyDown(event)
    }

    window.addEventListener('keydown', handler, true)
    return () => {
      window.removeEventListener('keydown', handler, true)
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [onKeyDown])

  return state
}
