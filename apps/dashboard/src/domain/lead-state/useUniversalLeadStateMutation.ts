import { useCallback, useRef, useState } from 'react'
import {
  patchLeadStateFromView,
  type LeadStateSourceView,
  type UniversalLeadStateMeta,
  type UniversalLeadStateMutationResult,
  type UniversalLeadStatePatch,
} from './persistUniversalLeadState'

export interface UseUniversalLeadStateMutationOptions {
  onSuccess?: (result: UniversalLeadStateMutationResult, patch: UniversalLeadStatePatch) => void
  onError?: (message: string) => void
}

export function useUniversalLeadStateMutation(
  sourceView: LeadStateSourceView,
  options: UseUniversalLeadStateMutationOptions = {},
) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSeq = useRef(0)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const patch = useCallback(async (
    threadKey: string,
    patchPayload: UniversalLeadStatePatch,
    meta: UniversalLeadStateMeta = {},
  ): Promise<UniversalLeadStateMutationResult> => {
    const key = String(threadKey ?? '').trim()
    if (!key) {
      const failure: UniversalLeadStateMutationResult = {
        ok: false,
        threadKey: '',
        errorMessage: 'Missing thread key',
        mutationPayload: null,
        writeTarget: 'none',
      }
      optionsRef.current.onError?.(failure.errorMessage!)
      return failure
    }

    const requestId = ++requestSeq.current
    setPending(true)
    setError(null)

    try {
      const result = await patchLeadStateFromView(sourceView, key, patchPayload, meta)
      if (requestId !== requestSeq.current) return result

      if (!result.ok) {
        const message = result.errorMessage || 'lead_state_patch_failed'
        setError(message)
        optionsRef.current.onError?.(message)
      } else {
        optionsRef.current.onSuccess?.(result, patchPayload)
      }
      return result
    } finally {
      if (requestId === requestSeq.current) setPending(false)
    }
  }, [sourceView])

  const clearError = useCallback(() => setError(null), [])

  return { patch, pending, error, clearError }
}