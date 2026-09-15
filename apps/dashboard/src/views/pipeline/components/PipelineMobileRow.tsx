import { Icon } from '../../../shared/icons'
import type { PipelineOpportunity } from '../../../domain/pipeline/pipeline-opportunity.types'
import {
  resolveTemperature,
  resolvePropertyType,
} from '../../../domain/pipeline/pipeline-display-helpers'
import {
  resolveOpportunityAutomation,
  resolveOpportunityDisposition,
  resolveOpportunityNextAction,
  resolveOpportunityOfferState,
} from '../../../domain/pipeline/pipeline-card-state'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s && s !== 'null' ? s : null
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

/** "Sep 22" / "today" / "overdue" — the scheduled time, not a duration. */
function dueWhen(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const now = Date.now()
  const diffDays = Math.floor((d.getTime() - now) / 86_400_000)
  if (diffDays < -1) return 'overdue'
  if (diffDays < 0) return 'due today'
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'tomorrow'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
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
  const stageAge = age((opp as unknown as Record<string, unknown>).stage_entered_at ?? opp.last_contact_at)
  const propType = text(resolvePropertyType(opp))

  /**
   * The four facts §7 asks for that this row did not carry: disposition,
   * the latest thing the seller said, what happens next (with its time), and
   * whether automation is doing anything. All read from the canonical
   * opportunity row.
   */
  const row = opp as unknown as Record<string, unknown>
  const disposition = resolveOpportunityDisposition(row)
  const nextActionState = resolveOpportunityNextAction(row)
  const automation = resolveOpportunityAutomation(row)
  const offerState = resolveOpportunityOfferState(row)
  const preview = text(row.latest_message_preview)
  const dueLabel = nextActionState?.dueAt ? dueWhen(nextActionState.dueAt) : null

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
          {disposition ? (
            <span className="plm-row__state">
              <span className={cls('plm-chip', `is-${disposition.tone}`)}>{disposition.label}</span>
              {offerState ? <span className="plm-chip is-offer">{offerState.label}</span> : null}
            </span>
          ) : null}
          {preview ? <span className="plm-row__preview">{preview}</span> : null}
          <span className="plm-row__meta">
            {propType ? <span>{propType}</span> : null}
            {nextActionState ? (
              <span className={cls('plm-row__next', nextActionState.derived && 'is-derived')}>
                {nextActionState.label}
                {dueLabel ? <span className="plm-row__due"> · {dueLabel}</span> : null}
              </span>
            ) : null}
            {automation && automation.tone !== 'idle' ? (
              <span className={cls('plm-row__auto', `is-${automation.tone}`)}>{automation.label}</span>
            ) : null}
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
