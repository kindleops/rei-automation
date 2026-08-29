import { Icon } from '../../../shared/icons'

/**
 * Campaign Creator — BUILD, mobile 393pt.
 *
 * Answers one question: "what exactly am I targeting?"
 *
 * Targeting categories are native drill-in rows; their fields live in a
 * full-screen sheet, not on this screen. Applied filters are compact editable
 * rows carrying field · operator · value — no developer chips, no browser
 * selects.
 *
 * Counts here are ALWAYS applied-filter counts and matching candidates, never
 * catalog size: "5 available" told the operator how many fields exist, which
 * reads as progress and is not.
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

export function CampaignBuildMobile({
  name,
  onNameChange,
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
  const totalApplied = categories.reduce((sum, c) => sum + c.applied, 0) + appliedFilters
    .filter((f) => !categories.some((c) => c.key === f.domain)).length

  return (
    <div className="cbx">
      <section className="cdb__band">
        <div className="cdb__key">NAME</div>
        <input
          className="cbx__name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Name this campaign"
          aria-label="Campaign name"
        />
      </section>

      <section className="cdb__band">
        <div className="cdb__key">
          TARGETING
          <span className="cdb__count">
            {totalApplied} applied
            {candidateCount != null && ` · ${candidateCount.toLocaleString()} match`}
          </span>
        </div>
        <div className="cdb__rows">
          {categories.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`cdb__row cbx__cat${c.applied === 0 ? ' is-nil' : ''}`}
              onClick={() => onOpenCategory(c.key)}
            >
              <span className="cdb__row-label cbx__cat-label">{c.label}</span>
              <span className="cdb__row-value is-text">
                {c.applied > 0 ? `${c.applied} applied` : '—'}
              </span>
              <Icon name="chevron-right" size={14} />
            </button>
          ))}
        </div>
      </section>

      {appliedFilters.length > 0 && (
        <section className="cdb__band">
          <div className="cdb__key">APPLIED FILTERS</div>
          <div className="cdb__rows">
            {appliedFilters.map((f) => (
              <div key={f.id} className={`cdb__row cbx__filter${f.pending ? ' is-pending' : ''}`}>
                <button
                  type="button"
                  className="cbx__filter-main"
                  onClick={() => onEditFilter(f.id)}
                >
                  <span className="cbx__filter-field">{f.fieldLabel}</span>
                  <span className="cbx__filter-op">{f.operatorLabel}</span>
                  <span className="cbx__filter-value">{f.valueLabel}</span>
                  {f.unsupported && <span className="cbx__filter-note">not counted in preview</span>}
                  {f.pending && <span className="cbx__filter-note is-pending">not applied yet</span>}
                </button>
                <button
                  type="button"
                  className="cbx__filter-remove"
                  onClick={() => onRemoveFilter(f.id)}
                  aria-label={`Remove ${f.fieldLabel} filter`}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {(unappliedCount > 0 || previewStale || readinessLine) && (
        <section className="cdb__band is-last">
          <div className="cdb__key">STATUS</div>
          {unappliedCount > 0 && (
            <p className="cbx__flag">
              {unappliedCount} filter{unappliedCount === 1 ? '' : 's'} edited but not applied
            </p>
          )}
          {previewStale && !previewLoading && (
            <p className="cbx__flag">
              Targeting changed — reach count is stale. Open REACH to recount.
            </p>
          )}
          {readinessLine && <p className="cbx__flag is-quiet">{readinessLine}</p>}
        </section>
      )}
    </div>
  )
}
