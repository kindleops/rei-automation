/**
 * THE COMPOSER'S SEND PATH — one implementation for every Inbox pane.
 *
 * Inbox 1's composer and the composers in Inboxes 2-4 call exactly these
 * functions, which call exactly the canonical client send APIs
 * (sendInboxMessageNow / queueReplyFromInbox / scheduleReplyFromInbox). The
 * thread passed in IS the send target: a pane sends to its own conversation,
 * with that conversation's own context — never to whatever another pane has
 * selected. Send, queue, routing and override semantics are unchanged from the
 * code this was lifted out of (InboxPage handleSend / handleQueueTemplate /
 * the schedule panel).
 */
import { lcConfirm, lcToast } from '../../shared/lc'
import {
  queueReplyFromInbox,
  scheduleReplyFromInbox,
  sendInboxMessageNow,
  type SendNowResult,
} from '../../lib/data/inboxData'
import type { InboxThread } from '../../domain/inbox/inbox-model-types'
import type { SmsTemplate } from '../../lib/data/templateData'
import type { ThreadContext } from '../../lib/data/inboxData'

export interface ComposerSendDeps {
  send: typeof sendInboxMessageNow
  queue: typeof queueReplyFromInbox
  schedule: typeof scheduleReplyFromInbox
  confirm: typeof lcConfirm
  toast: typeof lcToast
}

const DEFAULT_DEPS: ComposerSendDeps = {
  send: sendInboxMessageNow,
  queue: queueReplyFromInbox,
  schedule: scheduleReplyFromInbox,
  confirm: lcConfirm,
  toast: lcToast,
}

/**
 * Send now: the first attempt, the one explicit operator-override decision when
 * the server allows it, and the outcome toast. Returns the final result.
 */
export async function sendComposerMessage({
  thread, text, template = null, threadContext, clientSendId, deps = {},
}: {
  thread: InboxThread
  text: string
  template?: SmsTemplate | null
  threadContext: ThreadContext | null
  clientSendId: string
  deps?: Partial<ComposerSendDeps>
}): Promise<SendNowResult> {
  const d = { ...DEFAULT_DEPS, ...deps }
  let result = await d.send(thread, text, {
    selectedTemplate: template ?? null,
    threadContext,
    clientSendId,
    // The send-now response was lost: say so, and that we are checking --
    // the message may already be out, so this is not the moment to resend.
    onConfirmingSend: () => d.toast({
      title: 'Confirming Send…',
      detail: 'The connection dropped before the server answered. Checking whether the message went out — do not resend.',
      severity: 'info',
    }),
  })
  const overrideAllowed = !result.ok && result.operatorOverrideAllowed === true
  if (overrideAllowed) {
    // Same text and the same single explicit decision as the browser confirm
    // this replaces: the issue, then the question. Dismissing is "no"; nothing
    // is re-sent without the button.
    const [issue, question, confirmLabel] =
      result.backendReason === 'recent_delivery_failures'
        ? ['Recent delivery issue detected.', 'Retry anyway?', 'Retry anyway']
        : result.backendReason === 'content_blocked'
          ? ['Potential content issue detected.', 'Send anyway?', 'Send anyway']
          : ['This send was blocked, but operator override is allowed.', 'Retry anyway?', 'Retry anyway']
    const retry = await d.confirm({
      title: question,
      effects: [{ text: issue, kind: 'stops' }],
      confirmLabel,
      nativeText: `${issue} ${question}`,
    })
    if (retry) {
      result = await d.send(thread, text, {
        selectedTemplate: template ?? null,
        threadContext,
        clientSendId,
        operatorOverride: true,
      })
    }
  }
  d.toast({
    title: result.ok
      ? 'Message Sent'
      : result.outcomeUnknown
        ? 'Send Not Confirmed'
        : 'Send Failed',
    detail: result.ok
      ? (result.confirmedAfterTransportError
        ? 'Confirmed on the server after the connection dropped.'
        : result.deliveryStatus === 'delivered'
          ? 'Message delivered.'
          : 'Provider accepted the message.')
      : (result.errorMessage ?? 'Could not queue message for send'),
    severity: result.ok
      ? 'success'
      : result.outcomeUnknown
        ? 'warning'
        : 'critical',
  })
  return result
}

/** Queue for approval (the composer's template "Queue"). */
export async function queueComposerTemplate({
  thread, text, template, threadContext, deps = {},
}: {
  thread: InboxThread
  text: string
  template: SmsTemplate | null | undefined
  threadContext: ThreadContext | null
  deps?: Partial<ComposerSendDeps>
}): Promise<boolean> {
  const d = { ...DEFAULT_DEPS, ...deps }
  if (!text.trim()) return false
  const result = await d.queue(thread, text, { selectedTemplate: template, threadContext })
  d.toast({
    title: result.ok ? 'Reply Queued For Approval' : 'Queue Failed',
    detail: result.ok
      ? `Queue row ${result.queueId ?? 'created'} is waiting for approval`
      : (result.errorMessage ?? 'Could not queue reply'),
    severity: result.ok ? 'success' : 'critical',
  })
  return result.ok
}

/** Schedule (the schedule panel's chosen time). */
export async function scheduleComposerMessage({
  thread, text, template, threadContext, at, label, deps = {},
}: {
  thread: InboxThread
  text: string
  template: SmsTemplate | null | undefined
  threadContext: ThreadContext | null
  at: string
  label: string
  deps?: Partial<ComposerSendDeps>
}): Promise<boolean> {
  const d = { ...DEFAULT_DEPS, ...deps }
  const result = await d.schedule(thread, text, at, { selectedTemplate: template, threadContext })
  d.toast({
    title: result.ok ? 'Scheduled' : 'Schedule Failed',
    detail: result.ok ? `Sent set for ${label}` : (result.errorMessage ?? 'Could not schedule message'),
    severity: result.ok ? 'success' : 'critical',
  })
  return result.ok
}
