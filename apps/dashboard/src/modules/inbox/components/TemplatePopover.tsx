import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { ThreadContext } from '../../../lib/data/inboxData'
import type { SmsTemplate } from '../../../lib/data/templateData'
import type { InboxThread } from '../inbox.adapter'
import { TemplatePicker } from '../templates/TemplatePicker'

export interface TemplateActionPayload {
  text: string
  template: SmsTemplate | null
}

interface TemplatePopoverProps {
  open: boolean
  onClose: () => void
  thread: InboxThread | null
  threadContext: ThreadContext | null
  onInsert: (text: string) => void
  onReplace: (text: string) => void
  onSendNow: (payload: TemplateActionPayload) => void
  onQueue: (payload: TemplateActionPayload) => void
  onSchedule: (payload: TemplateActionPayload) => void
}

export const TemplatePopover = ({
  open,
  onClose,
  thread,
  threadContext,
  onInsert,
  onReplace,
  onSendNow,
  onQueue,
  onSchedule,
}: TemplatePopoverProps) => {
  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="nx-template-modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="nx-template-modal nx-liquid-panel"
        role="dialog"
        aria-label="Template Library"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="nx-tpl-header">
          <div>
            <div className="nx-tpl-header__title">Template Library</div>
            <div className="nx-tpl-header__sub">Live templates from Supabase</div>
          </div>
          <button type="button" className="nx-tpl-close" onClick={onClose} aria-label="Close template library">
            <Icon name="close" />
          </button>
        </header>

        <TemplatePicker
          thread={thread}
          threadContext={threadContext}
          onInsert={(text) => {
            onInsert(text)
            onClose()
          }}
          onReplace={(text) => {
            onReplace(text)
            onClose()
          }}
          onSendNow={(text, template) => {
            onSendNow({ text, template })
            onClose()
          }}
          onQueue={(text, template) => {
            onQueue({ text, template })
            onClose()
          }}
          onSchedule={(text, template) => {
            onSchedule({ text, template })
            onClose()
          }}
        />
      </div>
    </div>,
    document.body,
  )
}
