/**
 * A conversation open INSIDE a secondary Inbox pane (Multi-Inbox §8-§10).
 *
 * Reads the same canonical thread as every other pane (no copy of backend
 * state). Opening it here is an explicit open → the existing read rule applies
 * once (thread-read-policy 'open_conversation'); rendering, the list, filters
 * and layout never write read state.
 *
 * Replies are written HERE, in this pane's own composer (PaneComposer): the
 * same Composer and the same send path as Inbox 1, bound to this thread.
 */
import { useEffect, useRef, useState } from 'react'
import { ChatThread } from '../components/ChatThread'
import { getThreadMessagesForThread, type ThreadMessage } from '../../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { callBackend } from '../../../lib/api/backendClient'
import { applyThreadReadOnSelect } from '../thread-read-policy'
import { LCButton, LCError } from '../../../shared/lc'
import { PaneComposer } from './PaneComposer'

export function PaneConversation({
  thread, paneLabel, onClose, onReadWritten, onSent,
}: {
  thread: InboxWorkflowThread
  paneLabel: string
  onClose: () => void
  onReadWritten?: () => void
  /** this pane sent / queued / scheduled — counts and lists re-read */
  onSent?: () => void
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
      <div className="ixm-conversation__composer">
        <PaneComposer thread={thread} onSent={() => { setAttempt((n) => n + 1); onSent?.() }} />
      </div>
    </section>
  )
}
