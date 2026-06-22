import type { ViewLayoutMode } from '../../../domain/inbox/view-layout'
import type { PipelineCardDesign } from '../../../domain/pipeline/pipeline-card-design.types'
import type { PipelineOpportunity } from '../../../domain/pipeline/pipeline-opportunity.types'
import { resolveTemperature } from '../../../domain/pipeline/pipeline-display-helpers'
import {
  resolveBadgeSlots,
  resolveFieldValue,
  resolveMetricSlots,
  resolvePreviewField,
} from '../../../domain/pipeline/pipeline-field-resolver'
import { normalizeCardDesign } from '../../../domain/pipeline/pipeline-card-presets'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface PipelineConfigurableCardProps {
  opp: PipelineOpportunity
  design: PipelineCardDesign
  layoutMode: ViewLayoutMode
  selected?: boolean
  dragging?: boolean
  mutableView?: boolean
  onClick?: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  onReplyAction?: () => void
}

function layoutTier(mode: ViewLayoutMode): '25' | '50' | '75' | '100' {
  if (mode === 'compact') return '25'
  if (mode === 'medium') return '50'
  if (mode === 'expanded') return '75'
  return '100'
}

export function PipelineConfigurableCard({
  opp,
  design,
  layoutMode,
  selected,
  dragging,
  mutableView,
  onClick,
  onMouseEnter,
  onMouseLeave,
  onDragStart,
  onDragEnd,
  onReplyAction,
}: PipelineConfigurableCardProps) {
  const tier = layoutTier(layoutMode)
  const resolved = normalizeCardDesign(design)
  const slots = resolved.slots
  const density = resolved.density

  const eyebrow = slots.eyebrow?.disabled ? null : resolveFieldValue(opp, slots.eyebrow?.fieldKey ?? 'property_type_market')
  const title = resolveFieldValue(opp, slots.title?.fieldKey ?? 'seller_display_name')
  const subtitle = resolveFieldValue(opp, slots.subtitle?.fieldKey ?? 'property_address_full')
  const preview = slots.preview?.disabled
    ? null
    : resolvePreviewField(opp, slots.preview?.fieldKey ?? 'latest_message_preview')
  const footer = slots.footer?.disabled ? null : resolveFieldValue(opp, slots.footer?.fieldKey ?? 'last_activity_at')

  const badgeKeys = [slots.badge_1, slots.badge_2, slots.badge_3]
    .filter((s) => s && !s.disabled)
    .map((s) => s!.fieldKey)
  const badges = resolveBadgeSlots(opp, badgeKeys)

  const metricKeys = [slots.metric_1, slots.metric_2, slots.metric_3]
    .filter((s) => s && !s.disabled)
    .map((s) => s!.fieldKey)
  let metrics = resolveMetricSlots(opp, metricKeys)
  if (tier === '75' && metrics.length > 2) metrics = metrics.slice(0, 2)
  if (tier === '50' && metrics.length > 1) metrics = metrics.slice(0, 1)
  if (tier === '25') metrics = []

  const tempTone = resolveTemperature(opp)
  const accentTone = slots.accent?.fieldKey === 'pipeline_stage' ? 'stage' : tempTone

  const showEyebrow = tier !== '25' && eyebrow && !eyebrow.empty
  const showSubtitle = tier !== '25' && subtitle
  const showPreview = !slots.preview?.disabled && preview && tier !== '25'
  const previewText = preview?.display ?? ''
  const previewOneLine = tier === '50' || resolved.previewLines === 1 || density === 'compact'

  const badgeLimit = tier === '25' ? 1 : tier === '50' ? 2 : 3
  const visibleBadges = badges.slice(0, badgeLimit)

  return (
    <article
      className={cls(
        'plv-card',
        'plv-card--configurable',
        density === 'compact' && 'plv-card--compact',
        density === 'expanded' && 'plv-card--expanded',
        `plv-card--tier-${tier}`,
        selected && 'is-selected',
        dragging && 'is-dragging',
      )}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.() } }}
      role="button"
      tabIndex={0}
      draggable={mutableView}
      onDragStart={mutableView ? onDragStart : undefined}
      onDragEnd={mutableView ? onDragEnd : undefined}
    >
      <div className={cls('plv-card__accent', `is-${accentTone}`)} />
      <div className="plv-card__body">
        {showEyebrow && (
          <div className="plv-card__eyebrow" title={eyebrow?.tooltip}>{eyebrow?.display}</div>
        )}
        <div className="plv-card__seller" title={title?.tooltip}>{title?.display}</div>
        {showSubtitle && (
          <div className={cls('plv-card__address', tier === '50' && 'plv-card__address--compact')} title={subtitle?.tooltip}>
            {subtitle?.display}
          </div>
        )}
        {visibleBadges.length > 0 && (
          <div className="plv-card__chips-row">
            {visibleBadges.map((badge) => (
              badge.actionable ? (
                <button
                  key={badge.key}
                  type="button"
                  className={cls('plv-chip', badge.tone && `is-${badge.tone}`)}
                  title={badge.tooltip}
                  onClick={(e) => { e.stopPropagation(); onReplyAction?.() }}
                >
                  {badge.display}
                </button>
              ) : (
                <span
                  key={badge.key}
                  className={cls('plv-chip', badge.tone && `is-${badge.tone}`, badge.key === 'pipeline_stage' && 'is-stage')}
                  title={badge.tooltip}
                >
                  {badge.display}
                </span>
              )
            ))}
          </div>
        )}
        {showPreview && previewText && (
          <div
            className={cls('plv-card__snippet', previewOneLine && 'plv-card__snippet--one-line')}
            title={preview?.tooltip}
          >
            {previewText}
          </div>
        )}
        {tier === '25' && (
          <div className="plv-card__snippet plv-card__snippet--one-line">
            {previewText || footer?.display || '—'}
          </div>
        )}
        {metrics.length > 0 && (
          <div className="plv-card__metrics-row">
            {metrics.map((m) => (
              <div key={m.key} className="plv-card__metric" title={m.tooltip}>
                <span className="plv-card__meta-label">{m.label}</span>
                <span className={cls('plv-card__meta-val', m.tone && `is-${m.tone}`)}>{m.display}</span>
              </div>
            ))}
          </div>
        )}
        {footer && tier !== '25' && (
          <div className="plv-card__footer">
            <span className="plv-card__age" title={footer.tooltip}>{footer.display}</span>
          </div>
        )}
        {tier === '25' && isFollowUpIndicator(opp) && (
          <span className="plv-card__due-dot" aria-label="Follow-up due" />
        )}
      </div>
    </article>
  )
}

function isFollowUpIndicator(opp: PipelineOpportunity): boolean {
  const iso = opp.next_action_due || opp.next_follow_up_at
  if (!iso) return false
  return new Date(iso).getTime() <= Date.now()
}