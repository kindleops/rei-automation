import { useState } from 'react'
import { Icon } from '../../../shared/icons'

/**
 * Campaign Creator — BUILD, mobile.
 *
 * Answers two questions: what is this campaign, and who should it reach?
 *
 * What it replaced, measured at 390x844: a NAME band, a TARGETING band of five
 * rows each reading only "—", and then roughly 40% of the screen as empty black.
 * A second name field lived in a collapsed "Campaign setup" panel above, bound
 * to the same value, alongside two native OS <select> menus. Nothing on the
 * screen said what any category controlled, what was missing, or how to move on.
 *
 * Now:
 *   CAMPAIGN   the one name field, plus message and touch as direct choices
 *   AUDIENCE   five cards that say what each filter group narrows, with the
 *              filters actually applied shown inside the card they belong to
 *   NOTES      only when something is genuinely unresolved
 *
 * Forward motion is the builder footer's job, not this screen's.
 *
 * Counts here are applied-filter counts and matching sellers, never catalog
 * size: "5 available" told the operator how many fields exist, which reads as
 * progress and is not.
 */

export interface BuildCategory {
  key: string
  label: string
  applied: number
}

export interface BuildAppliedFilter {
  id: string
  domain: string
  fieldLabel: string
  operatorLabel: string
  valueLabel: string
  unsupported: boolean
  pending: boolean
}

export type BuildChoice = { value: string; label: string; short?: string }

/**
 * What each group narrows, written from the real field groups in
 * CAMPAIGN_DOMAIN_DEFINITIONS — never a guess at what a category might hold.
 */
export const CATEGORY_META: Record<string, { icon: 'home' | 'user' | 'briefcase' | 'phone' | 'shield'; blurb: string }> = {
  properties:    { icon: 'home',      blurb: 'Market, property type, equity, distress and condition' },
  prospects:     { icon: 'user',      blurb: 'Who the seller is and whether they qualify' },
  master_owners: { icon: 'briefcase', blurb: 'Owner profile, scores and portfolio signals' },
  phones:        { icon: 'phone',     blurb: 'Which numbers are good enough to text' },
  outreach:      { icon: 'shield',    blurb: 'Timing, compliance and contact history' },
}

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export function CampaignBuildMobile({
  name,
  onNameChange,
  scenario,
  scenarioOptions,
  onScenarioChange,
  stage,
  stageOptions,
  onStageChange,
  description,
  onDescriptionChange,
  categories,
  appliedFilters,
  candidateCount,
  previewStale,
  previewLoading,
  unappliedCount,
  readinessLine,
  onOpenCategory,
  onEditFilter,
  onRemoveFilter,
}: {
  name: string
  onNameChange: (value: string) => void
  scenario: string
  scenarioOptions: BuildChoice[]
  onScenarioChange: (value: string) => void
  stage: string
  stageOptions: BuildChoice[]
  onStageChange: (value: string) => void
  description: string
  onDescriptionChange: (value: string) => void
  categories: BuildCategory[]
  appliedFilters: BuildAppliedFilter[]
  candidateCount: number | null
  previewStale: boolean
  previewLoading: boolean
  unappliedCount: number
  readinessLine: string | null
  onOpenCategory: (key: string) => void
  onEditFilter: (id: string) => void
  onRemoveFilter: (id: string) => void
}) {
  const [noteOpen, setNoteOpen] = useState(Boolean(description))

  const categoryKeys = new Set(categories.map((c) => c.key))
  const otherFilters = appliedFilters.filter((f) => !categoryKeys.has(f.domain))
  const totalApplied = appliedFilters.length

  /*
   * One sentence about the audience, true at every stage of the build. With no
   * filters the preview counts the whole book, so saying "no audience" would
   * be false — every property qualifies until something narrows it.
   */
  const audienceLine = totalApplied === 0
    ? 'Every property in your book qualifies until you add a filter.'
    : previewLoading
      ? `${totalApplied} ${totalApplied === 1 ? 'filter' : 'filters'} · counting…`
      : candidateCount != null && !previewStale
        ? `${totalApplied} ${totalApplied === 1 ? 'filter' : 'filters'} · ${candidateCount.toLocaleString()} sellers match`
        : `${totalApplied} ${totalApplied === 1 ? 'filter' : 'filters'} · counted on Reach`

  return (
    <div className="cbb">
      {/* ── CAMPAIGN ─────────────────────────────────────────────────── */}
      <section className="cbb-id" aria-label="Campaign">
        <label className="cbb-id__name">
          <span className="cbb-eyebrow">Campaign name</span>
          <input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="e.g. Dallas high-equity first touch"
            aria-label="Campaign name"
            autoComplete="off"
            enterKeyHint="done"
          />
        </label>

        <div className="cbb-id__choice">
          <span className="cbb-eyebrow">Message</span>
          <div className="cbb-seg" role="radiogroup" aria-label="Message">
            {scenarioOptions.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={scenario === o.value}
                className={cls('cbb-seg__opt', scenario === o.value && 'is-on')}
                onClick={() => onScenarioChange(o.value)}
              >
                {o.short ?? o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="cbb-id__choice">
          <span className="cbb-eyebrow">Touch</span>
          <div className="cbb-seg" role="radiogroup" aria-label="Touch">
            {stageOptions.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={stage === o.value}
                className={cls('cbb-seg__opt', stage === o.value && 'is-on')}
                onClick={() => onStageChange(o.value)}
              >
                {o.short ?? o.label}
              </button>
            ))}
          </div>
        </div>

        {noteOpen ? (
          <label className="cbb-id__note">
            <span className="cbb-eyebrow">Note</span>
            <input
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              placeholder="Optional — who this is for, or why"
              aria-label="Campaign note"
              autoComplete="off"
            />
          </label>
        ) : (
          <button type="button" className="cbb-id__add-note" onClick={() => setNoteOpen(true)}>
            + Add a note
          </button>
        )}
      </section>

      {/* ── AUDIENCE ─────────────────────────────────────────────────── */}
      <section className="cbb-aud" aria-label="Audience">
        <header className="cbb-aud__head">
          <h3>Audience</h3>
          <p>{audienceLine}</p>
        </header>

        <div className="cbb-aud__list">
          {categories.map((c) => {
            const meta = CATEGORY_META[c.key]
            const filters = appliedFilters.filter((f) => f.domain === c.key)
            return (
              <div key={c.key} className={cls('cbb-cat', filters.length > 0 && 'is-set')}>
                <button type="button" className="cbb-cat__head" onClick={() => onOpenCategory(c.key)}>
                  <span className="cbb-cat__icon" aria-hidden="true">
                    <Icon name={meta?.icon ?? 'filter'} size={16} />
                  </span>
                  <span className="cbb-cat__text">
                    <strong>{c.label}</strong>
                    <em>{meta?.blurb ?? 'Refine who this campaign reaches'}</em>
                  </span>
                  <span className="cbb-cat__state">
                    {filters.length > 0 ? filters.length : 'Add'}
                  </span>
                  <Icon name="chevron-right" size={15} />
                </button>

                {filters.length > 0 && (
                  <ul className="cbb-cat__filters">
                    {filters.map((f) => (
                      <FilterChip key={f.id} filter={f} onEdit={onEditFilter} onRemove={onRemoveFilter} />
                    ))}
                  </ul>
                )}
              </div>
            )
          })}

          {otherFilters.length > 0 && (
            <div className="cbb-cat is-set">
              <div className="cbb-cat__head is-static">
                <span className="cbb-cat__icon" aria-hidden="true"><Icon name="filter" size={16} /></span>
                <span className="cbb-cat__text">
                  <strong>Other filters</strong>
                  <em>Applied outside the categories above</em>
                </span>
                <span className="cbb-cat__state">{otherFilters.length}</span>
              </div>
              <ul className="cbb-cat__filters">
                {otherFilters.map((f) => (
                  <FilterChip key={f.id} filter={f} onEdit={onEditFilter} onRemove={onRemoveFilter} />
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      {/* ── NOTES — only what is genuinely unresolved ─────────────────── */}
      {(unappliedCount > 0 || (previewStale && !previewLoading && totalApplied > 0) || readinessLine) && (
        <section className="cbb-notes" aria-label="Build notes">
          {unappliedCount > 0 && (
            <p className="cbb-note is-warn">
              <Icon name="alert-circle" size={14} />
              <span>{unappliedCount} {unappliedCount === 1 ? 'filter has' : 'filters have'} unsaved edits. Open {unappliedCount === 1 ? 'it' : 'them'} to apply.</span>
            </p>
          )}
          {previewStale && !previewLoading && totalApplied > 0 && (
            <p className="cbb-note">
              <Icon name="refresh-cw" size={14} />
              <span>The audience changed. It will be recounted on Reach.</span>
            </p>
          )}
          {readinessLine && (
            <p className="cbb-note">
              <Icon name="database" size={14} />
              <span>{readinessLine}</span>
            </p>
          )}
        </section>
      )}
    </div>
  )
}

function FilterChip({
  filter,
  onEdit,
  onRemove,
}: {
  filter: BuildAppliedFilter
  onEdit: (id: string) => void
  onRemove: (id: string) => void
}) {
  return (
    <li className={cls('cbb-chip', filter.pending && 'is-pending', filter.unsupported && 'is-unsupported')}>
      <button type="button" className="cbb-chip__main" onClick={() => onEdit(filter.id)}>
        <span className="cbb-chip__field">{filter.fieldLabel}</span>
        <span className="cbb-chip__op">{filter.operatorLabel.toLowerCase()}</span>
        <span className="cbb-chip__value">{filter.valueLabel}</span>
        {filter.pending && <span className="cbb-chip__flag">Not applied</span>}
        {filter.unsupported && !filter.pending && <span className="cbb-chip__flag">Not in count</span>}
      </button>
      <button
        type="button"
        className="cbb-chip__remove"
        onClick={() => onRemove(filter.id)}
        aria-label={`Remove ${filter.fieldLabel} filter`}
      >
        <Icon name="x" size={12} />
      </button>
    </li>
  )
}
