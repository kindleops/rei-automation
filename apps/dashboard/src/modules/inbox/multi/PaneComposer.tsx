/**
 * The composer of a secondary Inbox pane — the SAME Composer component and the
 * SAME send path as Inbox 1 (composer-send.ts → sendInboxMessageNow /
 * queueReplyFromInbox / scheduleReplyFromInbox), bound to THIS pane's thread
 * and THIS thread's own context. Nothing is routed through Inbox 1; sender,
 * queue and routing are decided by the server exactly as for Inbox 1.
 */
import { useEffect, useState } from 'react'
import { Composer } from '../components/Composer'
import { InboxSchedulePanel } from '../InboxSchedulePanel'
import { buildThreadContextFromThread, getThreadContext, type ThreadContext } from '../../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import type { SmsTemplate } from '../../../lib/data/templateData'
import { queueComposerTemplate, scheduleComposerMessage, sendComposerMessage, type ComposerSendDeps } from '../composer-send'
import { paneSendArgs, type PaneSendTarget } from './pane-send'

export function PaneComposer({ thread, onSent, deps }: {
  thread: InboxWorkflowThread
  /** a send / queue / schedule landed — re-read this conversation */
  onSent: () => void
  deps?: Partial<ComposerSendDeps>
}) {
  const threadKey = String(thread.threadKey ?? thread.id)
  const [ctx, setCtx] = useState<{ key: string; context: ThreadContext | null }>(() => ({ key: threadKey, context: buildThreadContextFromThread(thread) }))
  if (ctx.key !== threadKey) setCtx({ key: threadKey, context: buildThreadContextFromThread(thread) })
  const [draft, setDraft] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [schedule, setSchedule] = useState<{ text: string; template: SmsTemplate | null } | null>(null)

  // This conversation's own context (seller / property), from the canonical loader.
  useEffect(() => {
    const controller = new AbortController()
    getThreadContext(thread, controller.signal).then(
      (context) => { if (!controller.signal.aborted) setCtx({ key: threadKey, context }) },
      () => { /* keep the context built from the row */ },
    )
    return () => controller.abort()
    // the conversation is the key; the row object refreshes with the list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey])

  const suppressed = thread.isSuppressed === true
  const target: PaneSendTarget = { thread, threadContext: ctx.key === threadKey ? ctx.context : null }

  const send = async (text: string, template: SmsTemplate | null = null) => {
    if (!text.trim() || isSending || suppressed) return
    setIsSending(true)
    try {
      const result = await sendComposerMessage({ ...paneSendArgs(target, text, template, crypto.randomUUID()), deps })
      if (result.ok) { setDraft(''); onSent() }
    } finally {
      setIsSending(false)
    }
  }

  return (
    <>
      <Composer
        draftText={draft}
        onSend={(text) => { void send(text) }}
        onOpenSchedule={(current) => setSchedule({ text: current, template: null })}
        thread={thread}
        threadContext={target.threadContext}
        onSendTemplate={(payload) => { void send(payload.text, payload.template ?? null) }}
        onQueueTemplate={(payload) => {
          void queueComposerTemplate({ thread, text: payload.text, template: payload.template, threadContext: target.threadContext, deps })
            .then((ok) => { if (ok) { setDraft(''); onSent() } })
        }}
        onScheduleTemplate={(payload) => setSchedule({ text: payload.text, template: payload.template ?? null })}
        isSending={isSending}
        disabled={suppressed}
        disabledReason="Messaging disabled for suppressed thread"
        layoutMode="medium"
      />
      <InboxSchedulePanel
        open={schedule !== null}
        onClose={() => setSchedule(null)}
        thread={thread}
        onSchedule={(time) => {
          const payload = schedule ?? { text: draft, template: null }
          setSchedule(null)
          if (!payload.text.trim()) return
          void scheduleComposerMessage({ thread, text: payload.text, template: payload.template, threadContext: target.threadContext, at: time.iso, label: time.label, deps })
            .then((ok) => { if (ok) { setDraft(''); onSent() } })
        }}
      />
    </>
  )
}
