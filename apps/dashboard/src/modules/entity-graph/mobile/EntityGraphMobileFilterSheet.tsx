import { useEffect, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { MobileSheet } from '../../mobile/MobileSheet'
import type { EntityGraphFilters } from '../../../domain/entity-graph/entity-graph.types'
import { EMPTY_ENTITY_GRAPH_FILTERS } from '../../../domain/entity-graph/entity-graph.types'
import {
  ASSET_TYPES,
  activeFilterEntries,
  type EntityScope,
  type FilterKey,
} from './entity-graph-mobile-format'
import type {
  EntityGraphFieldFilter,
  EntityGraphFilterCatalog,
} from '../../../domain/entity-graph/entity-graph-field-filters'
import {
  completeFieldFilters,
  fetchEntityGraphFilterCatalog,
} from '../../../domain/entity-graph/entity-graph-field-filters'
import { EntityGraphFieldFilterBuilder } from '../EntityGraphFieldFilterBuilder'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  inputMode,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  placeholder?: string
  inputMode?: 'numeric' | 'text'
}) {
  return (
    <label className="egm-field">
      <span>{label}</span>
      <input
        type={type}
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

function Toggle({
  label,
  hint,
  on,
  onChange,
}: {
  label: string
  hint?: string
  on: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button type="button" className={cls('egm-toggle', on && 'is-on')} onClick={() => onChange(!on)}>
      <span className="egm-toggle__box"><Icon name="check" /></span>
      <span>
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
    </button>
  )
}

type Props = {
  open: boolean
  scope: EntityScope
  filters: EntityGraphFilters
  /** Count for the *applied* filters, so the header can say what is live now. */
  appliedTotal: number | null
  scopeTotal: number | null
  fieldFilters: EntityGraphFieldFilter[]
  onClose: () => void
  onApply: (filters: EntityGraphFilters, fieldFilters: EntityGraphFieldFilter[]) => void
}

/**
 * Full-height filter sheet with a draft buffer: nothing re-queries until Apply,
 * so the operator is never fighting a list that reshuffles mid-edit. Reset
 * clears the draft in place; Apply commits; dismissing discards.
 */
export function EntityGraphMobileFilterSheet({
  open,
  scope,
  filters,
  fieldFilters,
  appliedTotal,
  scopeTotal,
  onClose,
  onApply,
}: Props) {
  const [draft, setDraft] = useState<EntityGraphFilters>(filters)
  const [fieldDraft, setFieldDraft] = useState<EntityGraphFieldFilter[]>(fieldFilters)
  const [wasOpen, setWasOpen] = useState(open)
  const [catalog, setCatalog] = useState<EntityGraphFilterCatalog | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)

  /**
   * The mobile sheet gets the SAME catalog as the desktop drawer -- it offered
   * 9 inputs where the catalog has 101 fields, which is the "too few filter
   * fields" defect on the surface an operator actually carries.
   */
  useEffect(() => {
    if (!open) return undefined
    const controller = new AbortController()
    setCatalogLoading(true)
    setCatalogError(null)
    fetchEntityGraphFilterCatalog(scope, controller.signal)
      .then((next) => setCatalog(next))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setCatalog(null)
        setCatalogError(error instanceof Error ? error.message : 'filter_catalog_unavailable')
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false)
      })
    return () => controller.abort()
  }, [open, scope])

  // Re-seed the draft on the closed → open transition. Done during render
  // rather than in an effect so the sheet's first paint already shows the
  // committed filters instead of a stale draft for one frame.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setDraft(filters)
      setFieldDraft(fieldFilters)
    }
  }

  const patch = (key: FilterKey, value: string | boolean) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const chips = activeFilterEntries(draft, scope)
  const completeFieldDraft = completeFieldFilters(fieldDraft)
  const totalDraftFilters = chips.length + completeFieldDraft.length

  return (
    <MobileSheet
      open={open}
      title="Filters"
      subtitle={`Applies to ${scope.replace(/_/g, ' ')}`}
      height="full"
      className="egm-sheet"
      onClose={onClose}
    >
      <div className="egm-filters">
        <div className="egm-cohorthead">
          <div className="egm-cohorthead__count">
            <strong>{appliedTotal === null ? '—' : appliedTotal.toLocaleString()}</strong>
            <span>
              {scopeTotal !== null && appliedTotal !== null && appliedTotal !== scopeTotal
                ? `of ${scopeTotal.toLocaleString()} in cohort`
                : 'in cohort'}
            </span>
          </div>
          {/* The count reflects the *applied* filters, not the draft. Saying so
              stops the operator reading it as a live preview of their edits. */}
          <p>Count updates when you apply. Only filters the browse adapter can execute are offered.</p>
        </div>

        <section className="egm-filters__section">
          <EntityGraphFieldFilterBuilder
            catalog={catalog}
            loading={catalogLoading}
            error={catalogError}
            filters={fieldDraft}
            onChange={setFieldDraft}
          />
        </section>

        {chips.length > 0 ? (
          <div className="egm-filters__chips">
            {chips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                className="egm-chip"
                onClick={() => patch(chip.key, chip.key === 'reachable' ? false : '')}
              >
                {chip.label} <em>{chip.value}</em>
                <span className="egm-chip__x" aria-hidden>×</span>
                <span className="nx-sr-only">Remove {chip.label} filter</span>
              </button>
            ))}
          </div>
        ) : null}

        {scope === 'properties' ? (
          <>
            <section className="egm-fsection">
              <h4>Geography</h4>
              <div className="egm-fgrid">
                <Field label="Market" value={draft.market} onChange={(v) => patch('market', v)} placeholder="Miami, FL" />
                <Field label="City" value={draft.city} onChange={(v) => patch('city', v)} placeholder="Cincinnati" />
                <Field label="State" value={draft.state} onChange={(v) => patch('state', v)} placeholder="OH" />
                <Field label="ZIP" value={draft.zip} onChange={(v) => patch('zip', v)} placeholder="45232" inputMode="numeric" />
              </div>
            </section>

            <section className="egm-fsection">
              <h4>Property</h4>
              <div className="egm-fgrid">
                <label className="egm-field">
                  <span>Asset type</span>
                  <select value={draft.assetType} onChange={(e) => patch('assetType', e.target.value)}>
                    <option value="">Any type</option>
                    {ASSET_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                  </select>
                </label>
                <Field label="Units min" value={draft.unitsMin} onChange={(v) => patch('unitsMin', v)} type="number" inputMode="numeric" />
                <Field label="Units max" value={draft.unitsMax} onChange={(v) => patch('unitsMax', v)} type="number" inputMode="numeric" />
                {/* Named for its author (§24). This bounds
                    `properties.final_acquisition_score`, a Podio-era screening
                    output the current Decision Engine never reads — a legitimate
                    corpus selector, and not this system's verdict on a deal. */}
                <Field label="Legacy screening min" value={draft.scoreMin} onChange={(v) => patch('scoreMin', v)} type="number" inputMode="numeric" />
                <Field label="Legacy screening max" value={draft.scoreMax} onChange={(v) => patch('scoreMax', v)} type="number" inputMode="numeric" />
              </div>
            </section>
          </>
        ) : null}

        {scope === 'master_owners' ? (
          <>
            <section className="egm-fsection">
              <h4>Geography</h4>
              <div className="egm-fgrid is-single">
                <Field label="Primary market" value={draft.market} onChange={(v) => patch('market', v)} placeholder="Miami, FL" />
              </div>
            </section>
            <section className="egm-fsection">
              <h4>Owner</h4>
              <div className="egm-fgrid">
                <Field label="Owner type" value={draft.ownerType} onChange={(v) => patch('ownerType', v)} placeholder="LLC" />
                <Field label="Priority tier" value={draft.priorityTier} onChange={(v) => patch('priorityTier', v)} placeholder="TIER_1" />
                <Field label="Coverage min %" value={draft.coverageMin} onChange={(v) => patch('coverageMin', v)} type="number" inputMode="numeric" />
              </div>
            </section>
          </>
        ) : null}

        {scope === 'people' ? (
          <section className="egm-fsection">
            <h4>People</h4>
            <div className="egm-fgrid is-single">
              <Field label="Language" value={draft.language} onChange={(v) => patch('language', v)} placeholder="Spanish" />
              <Toggle
                label="Reachable only"
                hint="Has a scored phone or email"
                on={draft.reachable}
                onChange={(next) => patch('reachable', next)}
              />
            </div>
          </section>
        ) : null}

        {scope === 'contact_methods' ? (
          <section className="egm-fsection">
            <h4>Contact quality</h4>
            <div className="egm-fgrid is-single">
              <label className="egm-field">
                <span>Status</span>
                <select value={draft.contactStatus} onChange={(e) => patch('contactStatus', e.target.value)}>
                  <option value="">Any status</option>
                  <option value="eligible">Eligible</option>
                  <option value="wrong">Wrong number / failed</option>
                </select>
              </label>
              <Toggle
                label="Reachable only"
                hint="Contact score above zero"
                on={draft.reachable}
                onChange={(next) => patch('reachable', next)}
              />
            </div>
          </section>
        ) : null}

        {scope === 'organizations' ? (
          <section className="egm-fsection">
            <h4>Ownership entity</h4>
            <div className="egm-fgrid is-single">
              <Field label="Entity type" value={draft.entityType} onChange={(v) => patch('entityType', v)} placeholder="LLC" />
            </div>
            <p className="egm-chain__empty" style={{ marginTop: 10 }}>
              Geography and contact filters are not applied to ownership entities by the
              browse adapter, so they are not offered here.
            </p>
          </section>
        ) : null}

        <div className="egm-filters__footer">
          <button
            type="button"
            className="egm-btn is-ghost"
            onClick={() => {
              setDraft({ ...EMPTY_ENTITY_GRAPH_FILTERS })
              setFieldDraft([])
            }}
          >
            Reset
          </button>
          <button
            type="button"
            className="egm-btn is-primary"
            onClick={() => onApply(draft, completeFieldDraft)}
          >
            {totalDraftFilters > 0
              ? `Apply ${totalDraftFilters} filter${totalDraftFilters === 1 ? '' : 's'}`
              : 'Apply'}
          </button>
        </div>
      </div>
    </MobileSheet>
  )
}
