/**
 * A conversation open INSIDE a secondary Inbox pane (Multi-Inbox §8-§10).
 *
 * Reads the same canonical thread as every other pane (no copy of backend
 * state). Opening it here is an explicit open → the existing read rule applies
 * once (thread-read-policy 'open_conversation'); rendering, the list, filters
 * and layout never write read state.
 *
 * Replying stays in Inbox 1, whose composer owns the send path (queue, sender
 * routing, automation ownership): "Reply in Inbox 1" hands the thread over.
 * A second composer was not added on purpose — the send path is out of scope.
 */
import { useEffect, useRef, useState } from 'react'
import { ChatThread } from '../components/ChatThread'
import { getThreadMessagesForThread, type ThreadMessage } from '../../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { callBackend } from '../../../lib/api/backendClient'
import { applyThreadReadOnSelect } from '../thread-read-policy'
import { LCButton, LCError } from '../../../shared/lc'

export function PaneConversation({
  thread, paneLabel, onClose, onReplyInPrimary, onReadWritten,
}: {
  thread: InboxWorkflowThread
  paneLabel: string
  onClose: () => void
  onReplyInPrimary: (thread: InboxWorkflowThread) => void
  onReadWritten?: () => void
}) {
  const threadKey = String(thread.threadKey ?? thread.id)
  const [state, setState] = useState<{ key: string; messages: ThreadMessage[]; loading: boolean; error: string | null }>({ key: threadKey, messages: [], loading: true, error: null })
  const [attempt, setAttempt] = useState(0)
  if (state.key !== threadKey) setState({ key: threadKey, messages: [], loading: true, error: null })

  useEffect(() => {
    let cancelled = false
    getThreadMessagesForThread(thread).then(
      (messages) => { if (!cancelled) setState({ key: threadKey, messages, loading: false, error: null }) },
      (error: unknown) => { if (!cancelled) setState({ key: threadKey, messages: [], loading: false, error: error instanceof Error ? error.message : 'Messages did not load' }) },
    )
    return () => { cancelled = true }
    // the thread object identity changes with every list refresh; the key is the conversation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey, attempt])

  // One explicit open = one read write, per the existing rule.
  const readFor = useRef<string | null>(null)
  useEffect(() => {
    if (readFor.current === threadKey) return
    readFor.current = threadKey
    applyThreadReadOnSelect('open_conversation', thread, {
      patchRead: (writeKey) => callBackend('/api/cockpit/inbox/thread-state', {
        method: 'PATCH',
        body: JSON.stringify({ thread_key: writeKey, patch: { is_read: true } }),
      }),
      onWritten: () => onReadWritten?.(),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey])

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    const target = event.target as HTMLElement | null
    if (target?.closest('[aria-expanded="true"]')) return
    event.preventDefault()
    const tag = target?.tagName
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || target?.isContentEditable) { target?.blur(); return }
    onClose()
  }

  return (
    <section className="ixm-conversation" aria-label={`${paneLabel} · conversation`} onKeyDown={onKeyDown}>
      {state.error ? (
        <div className="ixm-conversation__error">
          <LCError what="This conversation didn't load" detail={state.error} onRetry={() => { setState({ key: threadKey, messages: [], loading: true, error: null }); setAttempt((n) => n + 1) }} />
          <LCButton variant="quiet" size="sm" icon="x" onClick={onClose}>Close</LCButton>
        </div>
      ) : (
        <ChatThread
          thread={thread}
          messages={state.messages}
          loading={state.loading}
          isSuppressed={thread.isSuppressed === true}
          deskMode
          onBack={onClose}
          closeAffordance="close"
        />
      )}
      <footer className="ixm-conversation__foot">
        <span className="ixm-conversation__note">Replies are written in Inbox 1, where the send path lives.</span>
        <LCButton variant="primary" size="sm" icon="message" onClick={() => onReplyInPrimary(thread)}>Reply in Inbox 1</LCButton>
      </footer>
    </section>
  )
}
