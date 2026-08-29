import type { ReactNode } from 'react'
import { Icon } from '../../../shared/icons'

/**
 * Full-screen dismissible sheet.
 *
 * Built for a targeting category; LAUNCH reuses the same chrome for its
 * schedule / pacing / limit controls, so `note` and `ariaLabel` override the
 * targeting-specific copy. Omitting them keeps BUILD's behaviour identical.
 *
 * The field catalog lives here rather than on the BUILD screen — dumping every
 * approved field onto the build surface is what made targeting unreadable.
 *
 * The BODY is supplied by CreateCampaignModal, which already knows how to
 * render categories, field pickers and the filter editor. This component owns
 * only the sheet chrome, so no editing semantics change.
 */
export function CampaignCategorySheet({
  title,
  subtitle,
  appliedCount,
  note,
  ariaLabel,
  onClose,
  children,
}: {
  title: string
  subtitle?: string | null
  appliedCount?: number
  note?: string
  ariaLabel?: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="ccs" role="dialog" aria-modal="true" aria-label={ariaLabel ?? `${title} targeting`}>
      <header className="ccs__bar">
        <button type="button" className="ccs__close" onClick={onClose} aria-label="Done">
          <Icon name="chevron-down" size={18} />
        </button>
        <span className="ccs__title">{title}</span>
        <span className="ccs__count">
          {note ?? ((appliedCount ?? 0) > 0 ? `${appliedCount} applied` : 'none applied')}
        </span>
      </header>
      {subtitle && <p className="ccs__sub">{subtitle}</p>}
      <div className="ccs__body">{children}</div>
      <div className="ccs__foot">
        <button type="button" className="ccs__done" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}
