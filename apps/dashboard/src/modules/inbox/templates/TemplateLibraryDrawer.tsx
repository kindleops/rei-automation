import type { InboxThread } from '../inbox.adapter'
import type { ThreadContext } from '../../../lib/data/inboxData'
import { TemplatePicker } from './TemplatePicker'

export const TemplateLibraryDrawer = ({
  open,
  thread,
  threadContext,
  onClose,
  onInsert,
  onReplace,
  onSendNow,
  onQueue,
  onSchedule,
}: {
  open: boolean
  thread: InboxThread | null
  threadContext: ThreadContext | null
  onClose: () => void
  onInsert: (text: string) => void
  onReplace: (text: string) => void
  onSendNow: (text: string) => void
  onQueue: (text: string) => void
  onSchedule: (text: string) => void
}) => {
  if (!open) return null

  return (
    <aside className="nx-template-drawer" aria-label="SMS template library">
      <header className="nx-template-drawer__header">
        <div>
          <span>SMS Templates</span>
          <h2>Template Library</h2>
        </div>
        <button 
          type="button" 
          className="nx-inbox__conv-btn nx-inbox__conv-btn--ghost" 
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }}
        >
          Close
        </button>
      </header>
      <TemplatePicker
        thread={thread}
        threadContext={threadContext}
        onInsert={onInsert}
        onReplace={onReplace}
        onSendNow={onSendNow}
        onQueue={onQueue}
        onSchedule={onSchedule}
      />
    </aside>
  )
}
