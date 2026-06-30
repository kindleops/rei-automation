import { useCallback, useEffect, useRef, useState } from 'react'
import type { InboxThread } from '../../../domain/inbox/inbox-model-types'
import {
  getThreadContext,
  getThreadMessagesForThread,
  type ThreadContext,
  type ThreadMessage,
} from '../../../lib/data/inboxData'

type ConversationCacheEntry = {
  messages: ThreadMessage[]
  threadContext: ThreadContext
}

type ConversationSnapshot = {
  key: string
  messages: ThreadMessage[]
  threadContext: ThreadContext | null
  loading: boolean
  error: string | null
}

const conversationCache = new Map<string, ConversationCacheEntry>()

const buildSnapshot = (
  cacheKey: string,
  enabled: boolean,
): ConversationSnapshot => {
  const cached = conversationCache.get(cacheKey)
  return {
    key: cacheKey,
    messages: cached?.messages ?? [],
    threadContext: cached?.threadContext ?? null,
    loading: Boolean(enabled && cacheKey && !cached),
    error: null,
  }
}

export const useSellerMapCardConversation = ({
  enabled,
  thread,
  cacheKey,
}: {
  enabled: boolean
  thread: InboxThread
  cacheKey: string
}) => {
  const abortRef = useRef<AbortController | null>(null)
  const fetchGenerationRef = useRef(0)
  const [snapshot, setSnapshot] = useState<ConversationSnapshot>(() => buildSnapshot(cacheKey, enabled))

  if (snapshot.key !== cacheKey) {
    setSnapshot(buildSnapshot(cacheKey, enabled))
  }

  useEffect(() => {
    if (!enabled || !cacheKey || conversationCache.has(cacheKey)) return undefined

    const generation = ++fetchGenerationRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    Promise.all([
      getThreadMessagesForThread(thread, { signal: controller.signal }),
      getThreadContext(thread, controller.signal),
    ])
      .then(([loadedMessages, loadedContext]) => {
        if (generation !== fetchGenerationRef.current || controller.signal.aborted) return
        conversationCache.set(cacheKey, {
          messages: loadedMessages,
          threadContext: loadedContext,
        })
        setSnapshot({
          key: cacheKey,
          messages: loadedMessages,
          threadContext: loadedContext,
          loading: false,
          error: null,
        })
      })
      .catch((err) => {
        if (generation !== fetchGenerationRef.current || controller.signal.aborted) return
        setSnapshot((current) => ({
          ...current,
          key: cacheKey,
          loading: false,
          error: err instanceof Error ? err.message : 'Could not load conversation',
        }))
      })

    return () => {
      controller.abort()
    }
  }, [cacheKey, enabled, thread])

  const appendMessage = useCallback((message: ThreadMessage) => {
    setSnapshot((current) => {
      const nextMessages = [...current.messages, message]
      const cached = conversationCache.get(cacheKey)
      if (cached) {
        conversationCache.set(cacheKey, { ...cached, messages: nextMessages })
      }
      return { ...current, messages: nextMessages }
    })
  }, [cacheKey])

  const refresh = useCallback(async () => {
    if (!enabled || !cacheKey) return

    conversationCache.delete(cacheKey)
    const generation = ++fetchGenerationRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setSnapshot((current) => ({
      ...current,
      key: cacheKey,
      loading: true,
      error: null,
    }))

    try {
      const [loadedMessages, loadedContext] = await Promise.all([
        getThreadMessagesForThread(thread, { signal: controller.signal }),
        getThreadContext(thread, controller.signal),
      ])
      if (generation !== fetchGenerationRef.current || controller.signal.aborted) return

      conversationCache.set(cacheKey, {
        messages: loadedMessages,
        threadContext: loadedContext,
      })
      setSnapshot({
        key: cacheKey,
        messages: loadedMessages,
        threadContext: loadedContext,
        loading: false,
        error: null,
      })
    } catch (err) {
      if (generation !== fetchGenerationRef.current || controller.signal.aborted) return
      setSnapshot((current) => ({
        ...current,
        key: cacheKey,
        loading: false,
        error: err instanceof Error ? err.message : 'Could not load conversation',
      }))
    }
  }, [cacheKey, enabled, thread])

  return {
    messages: snapshot.messages,
    threadContext: snapshot.threadContext,
    loading: snapshot.loading,
    error: snapshot.error,
    refresh,
    appendMessage,
  }
}