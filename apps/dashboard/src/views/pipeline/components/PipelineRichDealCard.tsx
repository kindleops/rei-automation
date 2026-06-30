import { useMemo } from 'react'
import type { PipelineOpportunity } from '../../../domain/pipeline/pipeline-opportunity.types'
import {
  displayAos,
  displayCurrency,
  isFollowUpDue,
  resolvePipelineStage,
  resolvePropertyType,
  resolveTemperature,
  resolveUniversalStatus,
  stageLabel,
} from '../../../domain/pipeline/pipeline-display-helpers'
import { resolveReplyAttentionState } from '../../../domain/pipeline/pipeline-field-resolver'
import { InboxStreetViewThumb } from '../../../modules/inbox/components/InboxStreetViewThumb'
import { formatRelativeTime } from '../../../shared/formatters'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

function readMetaNumber(meta: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const n = Number(meta[key])
    if (Number.isFinite(n) && Math.abs(n) > 0.0001) return n
  }
  return null
}

function resolvePropertyMedia(opp: PipelineOpportunity) {
  const meta = (opp.metadata ?? {}) as Record<string, unknown>
  return {
    address: opp.property_address_full,
    lat: readMetaNumber(meta, ['property_latitude', 'latitude', 'lat']),
    lng: readMetaNumber(meta, ['property_longitude', 'longitude', 'lng']),
    cachedImage: String(meta.streetview_image ?? meta.streetviewImage ?? '').trim() || null,
  }
}

function equityPctLabel(opp: PipelineOpportunity): string | null {
  const value = opp.estimated_value
  const equity = opp.equity_amount
  if (value == null || equity == null || value <= 0) return null
  return `${Math.round((equity / value) * 100)}%`
}

interface PipelineRichDealCardProps {
  opp: PipelineOpportunity
  tier?: '25' | '50' | '75' | '100'
  selected?: boolean
  dragging?: boolean
  mutableView?: boolean
  onClick?: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  onReplyAction?: () => void
}

export function PipelineRichDealCard({
  opp,
  tier = '75',
  selected,
  dragging,
  mutableView,
  onClick,
  onMouseEnter,
  onMouseLeave,
  onPointerDown,
  onDragStart,
  onDragEnd,
  onReplyAction,
}: PipelineRichDealCardProps) {
  const media = useMemo(() => resolvePropertyMedia(opp), [opp])
  const engineRunId = opp.acquisition_engine_run_id
  const temp = resolveTemperature(opp)
  const attention = resolveReplyAttentionState(opp)
  const due = isFollowUpDue(opp)
  const equityPct = equityPctLabel(opp)
  const showMedia = tier !== '25'
  const showKpis = tier === '75' || tier === '100'
  const showPreview = tier !== '25'
  const thumbSize = tier === '100' ? 'row' : 'header'

  const kpis = [
    { label: 'Value', value: displayCurrency(opp.estimated_value, { engineRunId }), tone: 'blue' },
    equityPct ? { label: 'Equity', value: equityPct, tone: 'green' } : null,
    opp.asking_price != null ? { label: 'Ask', value: displayCurrency(opp.asking_price, { engineRunId }), tone: 'gold' } : null,
    opp.aos != null ? { label: 'AOS', value: displayAos(opp), tone: 'cyan' } : null,
  ].filter(Boolean) as Array<{ label: string; value: string; tone: string }>

  return (
    <article
      className={cls(
        'plv-card',
        'plv-rich-card',
        `plv-rich-card--tier-${tier}`,
        selected && 'is-selected',
        dragging && 'is-dragging',
      )}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.() } }}
      role="button"
      tabIndex={0}
      draggable={mutableView}
      onDragStart={mutableView ? onDragStart : undefined}
      onDragEnd={mutableView ? onDragEnd : undefined}
    >
      <div className={cls('plv-card__accent', temp !== 'unknown' ? `is-${temp}` : 'is-stage')} />

      {showMedia && (
        <div className="plv-rich-card__media">
          <InboxStreetViewThumb
            address={media.address}
            lat={media.lat}
            lng={media.lng}
            cachedImageUrl={media.cachedImage}
            size={thumbSize}
            className="plv-rich-card__streetview"
          />
          <span className="plv-rich-card__maps-attr" aria-hidden>Google</span>
        </div>
      )}

      <div className="plv-rich-card__body">
        <div className="plv-rich-card__eyebrow">
          <span>{resolvePropertyType(opp)}</span>
          <span>·</span>
          <span>{opp.market || 'Market'}</span>
        </div>

        <div className="plv-rich-card__title-row">
          <strong className="plv-rich-card__seller">{opp.seller_display_name || 'Unknown seller'}</strong>
          {opp.last_contact_at && tier !== '25' && (
            <span className="plv-rich-card__age">{formatRelativeTime(opp.last_contact_at)}</span>
          )}
        </div>

        <p className="plv-rich-card__address">{opp.property_address_full || 'Address unavailable'}</p>

        <div className="plv-rich-card__chips">
          <span className="plv-chip is-stage">{stageLabel(resolvePipelineStage(opp))}</span>
          <span className="plv-chip">{stageLabel(resolveUniversalStatus(opp))}</span>
          {temp !== 'unknown' && <span className={cls('plv-chip', `is-${temp}`)}>{stageLabel(temp)}</span>}
          {attention && (
            <button
              type="button"
              className="plv-chip is-unread"
              onClick={(e) => { e.stopPropagation(); onReplyAction?.() }}
            >
              {attention}
            </button>
          )}
          {due && <span className="plv-chip is-due">Due</span>}
        </div>

        {showPreview && opp.latest_message_preview && (
          <p className={cls('plv-rich-card__snippet', tier === '50' && 'is-one-line')}>
            {opp.latest_message_preview}
          </p>
        )}

        {showKpis && kpis.length > 0 && (
          <div className="plv-rich-card__kpis">
            {kpis.slice(0, tier === '75' ? 3 : 4).map((kpi) => (
              <div key={kpi.label} className="plv-rich-card__kpi">
                <em>{kpi.label}</em>
                <strong className={cls(`is-${kpi.tone}`)}>{kpi.value}</strong>
              </div>
            ))}
          </div>
        )}

        {opp.next_action && tier !== '25' && (
          <div className="plv-rich-card__next">
            <span>Next</span>
            <strong>{opp.next_action}</strong>
          </div>
        )}
      </div>
    </article>
  )
}