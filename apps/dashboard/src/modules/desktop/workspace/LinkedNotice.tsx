import { LCIconButton } from '../../../shared/lc'
import './workspace.css'

/**
 * The quiet answer a following app gives when the linked property has no
 * object of its kind — "No pipeline item for this property". Not an error,
 * not an empty state that replaces the app: one line, dismissible, and the
 * app below keeps working. Nothing is created to fill the gap.
 */
export function LinkedNotice({ text, subject, onDismiss }: { text: string; subject?: string | null; onDismiss?: () => void }) {
  return (
    <div className="ws-linked-note" role="status" aria-live="polite">
      <span className="ws-linked-note__dot" aria-hidden="true" />
      <span className="ws-linked-note__text">
        {text}
        {subject ? <span className="ws-linked-note__subject"> · {subject}</span> : null}
      </span>
      {onDismiss ? <LCIconButton icon="x" label="Dismiss" size="sm" onClick={onDismiss} /> : null}
    </div>
  )
}
