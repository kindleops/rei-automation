/**
 * A pane conversation's own header: who and where, and a real desktop Close
 * (× · Esc). The conversation's built-in back control lives in the phone hero,
 * which the desk hides, so a pane needs its own.
 */
import { LCIconButton } from '../../../shared/lc'

export function PaneConversationHeader({ paneLabel, title, subtitle, onClose }: {
  paneLabel: string
  title: string
  subtitle?: string | null
  onClose: () => void
}) {
  return (
    <header className="ixm-conv-head">
      <div className="ixm-conv-head__id">
        <span className="ixm-conv-head__title">{title}</span>
        {subtitle ? <span className="ixm-conv-head__sub">{subtitle}</span> : null}
      </div>
      <LCIconButton
        icon="x"
        label={`Close conversation · ${paneLabel} · Esc`}
        size="sm"
        variant="plain"
        onClick={onClose}
        aria-keyshortcuts="Escape"
      />
    </header>
  )
}
