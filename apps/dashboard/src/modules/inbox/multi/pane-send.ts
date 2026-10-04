/** What a pane's send hands the shared composer send path — its OWN thread and context. */
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import type { ThreadContext } from '../../../lib/data/inboxData'
import type { SmsTemplate } from '../../../lib/data/templateData'

export interface PaneSendTarget {
  thread: InboxWorkflowThread
  threadContext: ThreadContext | null
}

export function paneSendArgs(target: PaneSendTarget, text: string, template: SmsTemplate | null, clientSendId: string) {
  return { thread: target.thread, text, template, threadContext: target.threadContext, clientSendId }
}
