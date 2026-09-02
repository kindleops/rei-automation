import { Icon } from '../../../shared/icons'
import type { PipelineOpportunity } from '../../../domain/pipeline/pipeline-opportunity.types'
import {
  resolveTemperature,
  resolvePropertyType,
} from '../../../domain/pipeline/pipeline-display-helpers'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s && s !== 'null' ? s : null
}

/** `schedule_follow_up` -> `Schedule follow up`. Raw enums were reaching the UI. */
const humanize = (v: unknown): string | null => {
  const s = text(v)
  if (!s) return null
  if (!/[_-]/.test(s) && /[a-z]/.test(s)) return s
  const words = s.replace(/[_-]+/g, ' ').toLowerCase().trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Compact age: the operator's staleness trigger, shown once. */
function age(value: unknown): { label: string; stale: boolean } | null {
  const s = text(value)
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days < 1) return { label: 'today', stale: false }
  if (days < 7) return { label: `${days}d`, stale: false }
  if (days < 30) return { label: `${days}d`, stale: days >= 14 }
  const months = Math.floor(days / 30)
  return { label: `${months}mo`, stale: true }
}

const TEMP_TONE: Record<string, string> = {
  hot: 'hot', warm: 'warm', cold: 'cold', unscored: 'none',
}

/**
 * A pipeline row, not a card.
 *
 * The previous mobile card was ~370px tall and printed the same age three times
 * ("STAGE AGE", "5d", "5d ago"). This is one scannable line-set: who, where,
 * what's next, how stale — at roughly a quarter the height, so a stage of 242
 * is actually traversable on a phone.
 */
export function PipelineMobileRow({
  opp,
  selected,
  onOpen,
  onMessage,
  onWorkflow,
}: {
  opp: PipelineOpportunity
  selected?: boolean
  onOpen: () => void
  onMessage?: () => void
  onWorkflow?: () => void
}) {
  const seller = text(opp.seller_display_name) ?? text((opp as unknown as Record<string, unknown>).owner_name as string)
  const address = text(opp.property_address_full) ?? text((opp as unknown as Record<string, unknown>).address as string)
  const temp = String(resolveTemperature(opp) ?? '').toLowerCase()
  const tone = TEMP_TONE[temp] ?? 'none'
  const nextAction = humanize((opp as unknown as Record<string, unknown>).next_action)
  const stageAge = age((opp as unknown as Record<string, unknown>).stage_entered_at ?? opp.last_contact_at)
  const propType = text(resolvePropertyType(opp))

  return (
    <article className={cls('plm-row', selected && 'is-selected', stageAge?.stale && 'is-stale')}>
      <button type="button" className="plm-row__main" onClick={onOpen}>
        <span className={cls('plm-row__temp', `is-${tone}`)} aria-hidden="true" />
        <span className="plm-row__body">
          <span className="plm-row__line1">
            <strong className="plm-row__seller">{seller ?? address ?? 'Unidentified lead'}</strong>
            {stageAge ? (
              <span className={cls('plm-row__age', stageAge.stale && 'is-stale')}>{stageAge.label}</span>
            ) : null}
          </span>
          {address && seller ? <span className="plm-row__addr">{address}</span> : null}
          <span className="plm-row__meta">
            {propType ? <span>{propType}</span> : null}
            {nextAction ? <span className="plm-row__next">{nextAction}</span> : null}
          </span>
        </span>
      </button>
      {onWorkflow || onMessage ? (
        <div className="plm-row__gutter">
          {onWorkflow ? (
            <button type="button" className="plm-row__act" onClick={onWorkflow}
              aria-label={`Change workflow state for ${seller ?? address ?? 'lead'}`}>
              <Icon name="layers" />
            </button>
          ) : null}
          {onMessage ? (
            <button type="button" className="plm-row__act" onClick={onMessage}
              aria-label={`Open conversation with ${seller ?? address ?? 'lead'}`}>
              <Icon name="message" />
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}
