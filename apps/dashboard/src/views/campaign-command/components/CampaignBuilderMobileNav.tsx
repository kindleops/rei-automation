import { Icon } from '../../../shared/icons'
import { cls } from '../campaign-formatters'

export type CampaignBuilderPhase = 'build' | 'reach' | 'launch'

interface CampaignBuilderMobileNavProps {
  phase: CampaignBuilderPhase
  onPhaseChange: (phase: CampaignBuilderPhase) => void
  deliverableCount: number | null
  isPreviewLoading: boolean
  launchStatus: string
  onPreview: () => void
  onSaveDraft: () => void
  onSchedule: () => void
  onActivate?: () => void
  canSaveDraft: boolean
  canSchedule: boolean
  canActivate?: boolean
  isSaving: boolean
  isLaunching: boolean
}

export function CampaignBuilderMobileNav({
  phase,
  onPhaseChange,
  deliverableCount,
  isPreviewLoading,
  launchStatus,
  onPreview,
  onSaveDraft,
  onSchedule,
  onActivate,
  canSaveDraft,
  canSchedule,
  canActivate = false,
  isSaving,
  isLaunching,
}: CampaignBuilderMobileNavProps) {
  const reachLabel = isPreviewLoading
    ? '…'
    : deliverableCount != null
      ? deliverableCount >= 1000
        ? `${(deliverableCount / 1000).toFixed(1)}k`
        : String(deliverableCount)
      : '—'

  return (
    <div className="cmp-mobile-builder-chrome">
      <nav className="cmp-mobile-builder-nav" aria-label="Campaign builder phases">
        <button
          type="button"
          className={cls('cmp-mobile-builder-nav__item', phase === 'build' && 'is-active')}
          onClick={() => onPhaseChange('build')}
        >
          <Icon name="filter" size={14} />
          <span>Build</span>
        </button>
        <button
          type="button"
          className={cls('cmp-mobile-builder-nav__item', phase === 'reach' && 'is-active')}
          onClick={() => onPhaseChange('reach')}
        >
          <Icon name="activity" size={14} />
          <span>Reach</span>
          <em className="cmp-mobile-builder-nav__badge">{reachLabel}</em>
        </button>
        <button
          type="button"
          className={cls('cmp-mobile-builder-nav__item', phase === 'launch' && 'is-active')}
          onClick={() => onPhaseChange('launch')}
        >
          <Icon name="calendar" size={14} />
          <span>Launch</span>
          <em className={cls('cmp-mobile-builder-nav__status', `is-${launchStatus}`)} />
        </button>
      </nav>

      <div className="cmp-mobile-builder-actions">
        {phase === 'build' && (
          <>
            <button
              type="button"
              className="cmp-mobile-builder-actions__secondary"
              disabled={isPreviewLoading}
              onClick={onPreview}
            >
              {isPreviewLoading ? 'Updating…' : 'Preview'}
            </button>
            <button
              type="button"
              className="cmp-mobile-builder-actions__primary"
              disabled={isSaving || !canSaveDraft}
              onClick={onSaveDraft}
            >
              {isSaving ? 'Saving…' : 'Save draft'}
            </button>
          </>
        )}
        {phase === 'reach' && (
          <button
            type="button"
            className="cmp-mobile-builder-actions__primary cmp-mobile-builder-actions__full"
            disabled={isPreviewLoading}
            onClick={onPreview}
          >
            {isPreviewLoading ? 'Refreshing reach…' : 'Refresh reach'}
          </button>
        )}
        {phase === 'launch' && (
          <div className="cmp-mobile-builder-actions__launch-row">
            <button
              type="button"
              className="cmp-mobile-builder-actions__secondary"
              disabled={isSaving || !canSaveDraft}
              onClick={onSaveDraft}
            >
              Save Draft
            </button>
            <button
              type="button"
              className="cmp-mobile-builder-actions__secondary"
              disabled={isLaunching || !canSchedule}
              onClick={onSchedule}
            >
              Schedule
            </button>
            <button
              type="button"
              className="cmp-mobile-builder-actions__primary"
              disabled={isLaunching || !canActivate}
              onClick={onActivate}
            >
              {isLaunching ? 'Activating…' : 'Activate Now'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}