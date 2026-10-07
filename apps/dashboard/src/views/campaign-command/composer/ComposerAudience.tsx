import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { LCButton, LCChip, LCCombobox, LCPopover, LCSegmented, LCSkeleton, LCTooltip, cx, lcTransition, LC_SPRING, useLcReducedMotion, type LCComboOption } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import type { CampaignFieldCatalog, CampaignFieldDefinition } from '../campaignWizardAdapter'
import { loadFieldOptionValues, type FieldOptionValues } from '../field-option-values'
import { FilterEffectsPanel } from '../FilterEffectsPanel'
import type { ComposerAudience as Audience } from './composer-types'
import {
  buildIsPartial, buildSegments, clauseId, eligibleOf, fmt, hasValue, heldWords, n0, sendableBlocker, serializeClauses, universeSegments,
  type ComposerSource, type FilterClause, type Segment,
} from './composer-model'
import { dragLooksAcceptable, resolveDrop, type DropResolution } from './composer-intake'
import { RollingCount } from './ComposerParts'
import type { ComposerOfferReady } from './composer-api'
import { ComposerFunnel } from './ComposerFunnel'
import { clauseValueText } from './composer-format'

/* ── filter groups (catalog categories → the brief's groups; real fields only) ── */

const GROUP_OF_CATEGORY: Record<string, string> = {
  'Location & Market': 'Market',
  'Asset Type & Structure': 'Property',
  'Condition & Repair': 'Property',
  'Land, Lot & Zoning': 'Property',
  'Tax & Assessment': 'Property',
  'Value, Equity & Debt': 'Equity & debt',
  'Distress & Motivation': 'Behavior',
  'Owner Relationship': 'Ownership',
  Demographics: 'Owner & prospect',
  'Matching & Eligibility': 'Owner & prospect',
  Profile: 'Owner & prospect',
  Scores: 'Scores',
  'Portfolio Financials': 'Ownership',
  'Portfolio Distress': 'Ownership',
  Quality: 'Relationships',
  Rules: 'Activity',
  Routing: 'Relationships',
}
const groupOf = (f: CampaignFieldDefinition) => GROUP_OF_CATEGORY[f.category] ?? f.category

/* ── the filter command ──────────────────────────────────────────────────── */

function FieldValueEditor({ field, initial, onApply, onCancel }: {
  field: CampaignFieldDefinition
  initial: FilterClause | null
  onApply: (clause: FilterClause) => void
  onCancel: () => void
}) {
  const ops = field.operators.map((o) => o.key)
  const isNumber = field.type === 'number'
  const isBool = field.type === 'boolean'
  const [op, setOp] = useState<string>(initial?.operator ?? (isBool ? 'is_true' : isNumber ? 'between' : ops[0] ?? 'is_any_of'))
  const [values, setValues] = useState<string[]>(() => (Array.isArray(initial?.value) ? (initial!.value as unknown[]).map(String) : initial?.value != null && initial.value !== '' ? [String(initial.value)] : []))
  const [range, setRange] = useState<[string, string]>(() => (Array.isArray(initial?.value) && initial?.operator === 'between' ? [String(initial.value[0] ?? ''), String(initial.value[1] ?? '')] : ['', '']))
  const [options, setOptions] = useState<{ key: string; result: FieldOptionValues } | null>(null)
  const wantsOptions = !isNumber && !isBool && field.supports_options
  useEffect(() => {
    if (!wantsOptions) return
    let dead = false
    loadFieldOptionValues(field.key, '')
      .then((result) => { if (!dead) setOptions({ key: field.key, result }) })
      .catch((error: unknown) => { if (!dead) setOptions({ key: field.key, result: { options: [], state: 'unavailable', message: `Values couldn’t load. ${error instanceof Error ? error.message : ''}`.trim(), source: null } }) })
    return () => { dead = true }
  }, [field.key, wantsOptions])
  const optionResult = options?.key === field.key ? options.result : null
  const optionRows = optionResult ? optionResult.options : null
  // Both numbers, named: properties in the audience · queue-eligible.
  const comboOptions = useMemo<LCComboOption[]>(() => (optionRows ?? []).filter((o) => !values.includes(o.value)).map((o) => ({
    value: o.value,
    label: o.label,
    meta: typeof o.count === 'number' ? `${fmt(o.count)}${typeof o.eligibleCount === 'number' ? ` · ${fmt(o.eligibleCount)} eligible` : ''}` : undefined,
  })), [optionRows, values])

  const apply = () => {
    let value: unknown = values
    let operator = op
    if (isBool) value = ''
    else if (isNumber) {
      const [lo, hi] = range
      if (lo && hi) { operator = 'between'; value = [lo, hi] } else if (lo) { operator = 'gte'; value = lo } else if (hi) { operator = 'lte'; value = hi } else return
    }
    const clause: FilterClause = { id: initial?.id ?? clauseId(), domain: field.domain, category: field.category, fieldKey: field.key, label: field.label, operator, value }
    if (!hasValue(clause)) return
    onApply(clause)
  }

  return (
    <div className="ccz-fx">
      <div className="ccz-fx__head">
        <span className="ccz-kicker">{groupOf(field)}</span>
        <strong>{field.label}</strong>
      </div>
      {isBool ? (
        <LCSegmented label={field.label} size="sm" value={op as 'is_true' | 'is_false'} onChange={setOp} options={[{ value: 'is_true', label: 'Yes' }, { value: 'is_false', label: 'No' }]} />
      ) : isNumber ? (
        <div className="ccz-fx__range">
          <label><span>Min</span><input inputMode="decimal" value={range[0]} onChange={(e) => setRange([e.target.value, range[1]])} /></label>
          <label><span>Max</span><input inputMode="decimal" value={range[1]} onChange={(e) => setRange([range[0], e.target.value])} /></label>
        </div>
      ) : (
        <>
          {ops.includes('is_not_any_of') ? (
            <LCSegmented label="Match" size="sm" value={op === 'is_not_any_of' ? 'is_not_any_of' : 'is_any_of'} onChange={setOp} options={[{ value: 'is_any_of', label: 'Include' }, { value: 'is_not_any_of', label: 'Exclude' }]} />
          ) : null}
          <div className="ccz-fx__values">
            {values.map((v) => <LCChip key={v} value={optionRows?.find((o) => o.value === v)?.label ?? v} onRemove={() => setValues(values.filter((x) => x !== v))} />)}
          </div>
          {wantsOptions ? (
            optionRows === null ? <LCSkeleton shape="lines" count={1} /> : optionRows.length === 0 ? (
              // An empty list says why (not counted yet / no values / failed) and still takes a typed value.
              <>
                <p className="ccz-note is-attn" role="status">{optionResult?.message}</p>
                <input className="ccz-fx__free" placeholder="Type an exact value, Enter to add" onKeyDown={(e) => { if (e.key === 'Enter' && e.currentTarget.value.trim()) { setValues([...values, e.currentTarget.value.trim()]); e.currentTarget.value = '' } }} />
              </>
            ) : (
              <LCCombobox label={`Add ${field.label}`} placeholder={`Find ${field.label.toLowerCase()}… (properties · eligible)`} options={comboOptions} value={null} clearable={false} onChange={(v) => setValues([...values, v])} emptyText="No value matches" />
            )
          ) : (
            <input className="ccz-fx__free" placeholder="Type a value, Enter to add" onKeyDown={(e) => { if (e.key === 'Enter' && e.currentTarget.value.trim()) { setValues([...values, e.currentTarget.value.trim()]); e.currentTarget.value = '' } }} />
          )}
        </>
      )}
      <div className="ccz-fx__foot">
        <LCButton variant="quiet" size="sm" onClick={onCancel}>Cancel</LCButton>
        <LCButton variant="primary" size="sm" onClick={apply}>{initial ? 'Update' : 'Apply'}</LCButton>
      </div>
    </div>
  )
}

export function FilterCommand({ catalog, filters, onChange, editing, setEditing, request, onRequestDone }: {
  catalog: CampaignFieldCatalog | null
  filters: FilterClause[]
  onChange: (next: FilterClause[]) => void
  editing: string | null
  setEditing: (id: string | null) => void
  request: string | null
  onRequestDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const [field, setField] = useState<CampaignFieldDefinition | null>(null)
  const fieldOptions = useMemo<LCComboOption[]>(() => (catalog?.fields ?? [])
    .filter((f) => f.filterable && f.supported_in_preview !== false && f.key !== 'properties.drawn_area')
    .map((f) => ({
      value: f.key,
      label: f.label,
      group: groupOf(f),
      sub: f.campaign_applicable === false ? (f.campaign_inapplicable_message || 'Not targetable for campaigns') : undefined,
      disabled: f.campaign_applicable === false,
      keywords: [f.category, f.domain, f.key],
    })), [catalog])
  const editingClause = filters.find((f) => f.id === editing) ?? null
  const editingField = editingClause ? catalog?.fields.find((f) => f.key === editingClause.fieldKey) ?? null : null
  const requested = request ? catalog?.fields.find((f) => f.key === request) ?? null : null
  const close = () => { setOpen(false); setField(null); setEditing(null); onRequestDone() }
  const upsert = (clause: FilterClause) => {
    const exists = filters.some((f) => f.id === clause.id)
    onChange(exists ? filters.map((f) => (f.id === clause.id ? clause : f)) : [...filters, clause])
    close()
  }
  const activeField = editingField ?? field ?? requested
  return (
    <LCPopover
      open={open || Boolean(editing) || Boolean(requested)}
      onOpenChange={(o) => { if (!o) close(); else setOpen(true) }}
      width={360}
      label="Filter command"
      trigger={<button type="button" className="ccz-addfilter" disabled={!catalog}><Icon name="filter" size={13} /> <span>Add filter</span></button>}
    >
      {activeField ? (
        <FieldValueEditor key={activeField.key + (editingClause?.id ?? '')} field={activeField} initial={editingClause} onApply={upsert} onCancel={close} />
      ) : (
        <div className="ccz-fx">
          <LCCombobox
            label="Filter by"
            placeholder="Search fields — equity, ZIP, tax delinquent…"
            options={fieldOptions}
            value={null}
            autoFocus
            clearable={false}
            onChange={(key) => setField(catalog?.fields.find((f) => f.key === key) ?? null)}
            emptyText="No backend-supported field matches"
          />
        </div>
      )}
    </LCPopover>
  )
}

/* ── distribution bar ────────────────────────────────────────────────────── */

export function SegmentBar({ segments, total, label }: { segments: Segment[]; total: number; label: string }) {
  const reduced = useLcReducedMotion()
  if (!segments.length || total <= 0) return null
  return (
    <div className="ccz-seg" role="img" aria-label={`${label}: ${segments.map((s) => `${s.label} ${fmt(s.count)}`).join(', ')}`}>
      <div className="ccz-seg__bar">
        {segments.map((s) => (
          <LCTooltip key={s.key} content={`${s.label} · ${fmt(s.count)} — ${s.explain}`}>
            <motion.span
              className={cx('ccz-seg__part', `is-${s.tone}`)}
              initial={false}
              animate={{ flexGrow: Math.max(s.count / total, 0.004) }}
              transition={lcTransition(reduced, LC_SPRING.layout)}
            />
          </LCTooltip>
        ))}
      </div>
      <ul className="ccz-seg__legend">
        {segments.map((s) => (
          <li key={s.key}><i className={cx('ccz-dot', `is-${s.tone}`)} aria-hidden="true" /><span>{s.label}</span><b>{fmt(s.count)}</b></li>
        ))}
      </ul>
    </div>
  )
}

/* ── footprint: ZIP mosaic (lightweight, not a second Map) ───────────────── */

function Footprint({ audience }: { audience: Audience }) {
  const zips = audience.distributions.zips
  const markets = audience.distributions.markets
  if (!zips.length && !markets.length) return null
  const max = Math.max(...zips.map((z) => z.count), 1)
  const scanned = zips.reduce((s, z) => s + z.count, 0)
  return (
    <div className="ccz-foot">
      <div className="ccz-foot__head">
        <span className="ccz-kicker">Footprint</span>
        <span className="ccz-muted">{markets.slice(0, 3).map((m) => m.label).join(' · ')}{markets.length > 3 ? ` +${markets.length - 3}` : ''} · {zips.length} ZIPs in the first {fmt(audience.zones.scanned)} read</span>
      </div>
      <div className="ccz-foot__grid" role="list" aria-label="ZIP footprint">
        {zips.slice(0, 48).map((z) => (
          <LCTooltip key={z.value} content={`${z.value} · ${fmt(z.count)} (${Math.round((z.count / Math.max(scanned, 1)) * 100)}%)`}>
            <span role="listitem" className="ccz-foot__cell" style={{ ['--w' as string]: String(0.18 + 0.82 * (z.count / max)) }}>
              <em>{z.value}</em>
            </span>
          </LCTooltip>
        ))}
      </div>
    </div>
  )
}

/* ── the audience plane ──────────────────────────────────────────────────── */

export type QuickSource = { key: string; label: string; detail: string; icon: 'globe' | 'target' | 'refresh-cw' | 'map' | 'users' | 'file-text'; run: () => void; disabled?: string | null }

export function AudiencePlane({
  audience, offerReady = null, loading, error, filters, source, catalog, quick, markets, onMarket, onFilters, onDrop, onRetry, editing, setEditing, fieldRequest, onFieldRequestDone,
}: {
  audience: Audience | null
  offerReady?: { data: ComposerOfferReady | null; error: string | null } | null
  loading: boolean
  error: string | null
  filters: FilterClause[]
  source: ComposerSource | null
  catalog: CampaignFieldCatalog | null
  quick: QuickSource[]
  markets: LCComboOption[] | null
  onMarket: (market: string) => void
  onFilters: (next: FilterClause[]) => void
  onDrop: (resolution: DropResolution) => void
  onRetry: () => void
  editing: string | null
  setEditing: (id: string | null) => void
  fieldRequest: string | null
  onFieldRequestDone: () => void
}) {
  const reduced = useLcReducedMotion()
  const [drag, setDrag] = useState<'idle' | 'over' | 'absorb'>('idle')
  // the freshness label's "N hours old" is relative to when this surface opened
  const [openedAt] = useState(() => Date.now())
  const labelOf = (key: string) => catalog?.fields.find((f) => f.key === key)?.label ?? key.split('.').pop()!.replace(/_/g, ' ')
  // The same serialized clauses the audience read counted (audienceSpec).
  const filterSpec = useMemo(() => serializeClauses(filters), [filters])
  const eligible = eligibleOf(audience)
  const blocker = sendableBlocker(audience)
  const universe = universeSegments(audience)
  const build = buildSegments(audience)
  const partial = buildIsPartial(audience)
  const blank = filters.length === 0

  const onDragOver = (e: DragEvent) => {
    if (!dragLooksAcceptable([...e.dataTransfer.types])) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (drag !== 'over') setDrag('over')
  }
  const onDropEvent = (e: DragEvent) => {
    e.preventDefault()
    const res = resolveDrop((t) => e.dataTransfer.getData(t), [...e.dataTransfer.types])
    setDrag('absorb')
    window.setTimeout(() => setDrag('idle'), reduced ? 0 : 520)
    onDrop(res)
  }

  return (
    <div
      className={cx('ccz-aud', drag === 'over' && 'is-dragover', drag === 'absorb' && 'is-absorbing', blank && 'is-blank')}
      onDragOver={onDragOver}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag('idle') }}
      onDrop={onDropEvent}
    >
      {blank ? (
        <div className="ccz-invite">
          <div className="ccz-invite__well" aria-hidden="true"><span /><span /><span /></div>
          <h3>Choose or drop an audience</h3>
          <p className="ccz-muted">A market, a ZIP or county, a draft from the Map or Entity Graph, or properties dragged in from any app.</p>
          <div className="ccz-invite__market">
            {markets ? (
              <LCCombobox label="Market" placeholder="Market — Dallas, Minneapolis…" icon="globe" options={markets} value={null} clearable={false} onChange={onMarket} emptyText="No market" />
            ) : <LCSkeleton shape="lines" count={1} />}
          </div>
          <div className="ccz-invite__grid">
            {quick.map((q) => (
              <button key={q.key} type="button" className="ccz-quick" onClick={q.run} disabled={Boolean(q.disabled)} aria-describedby={q.disabled ? `${q.key}-why` : undefined}>
                <Icon name={q.icon} size={15} />
                <span><strong>{q.label}</strong><em id={q.disabled ? `${q.key}-why` : undefined}>{q.disabled || q.detail}</em></span>
              </button>
            ))}
          </div>
          <div className="ccz-invite__filter">
            <FilterCommand catalog={catalog} filters={filters} onChange={onFilters} editing={editing} setEditing={setEditing} request={fieldRequest} onRequestDone={onFieldRequestDone} />
            <span className="ccz-dim">or build from any backend-supported field</span>
          </div>
        </div>
      ) : (
        <>
          <div className="ccz-aud__hero">
            <div className="ccz-aud__count">
              <span className="ccz-kicker">Eligible</span>
              <div className={cx('ccz-big', loading && 'is-settling')} aria-live="polite">
                {eligible === null ? (loading ? <LCSkeleton shape="lines" count={1} /> : '—') : <RollingCount value={eligible} />}
              </div>
              <span className="ccz-muted">
                {audience ? <>of <b>{fmt(audience.matched)}</b> matched · <b>{fmt(audience.eligible_in_audience)}</b> queue-ready in the graph</> : loading ? 'Counting…' : ''}
              </span>
              {blocker ? (
                <p className="ccz-note is-attn" role="status"><Icon name="alert-circle" size={13} /> <span>{blocker.text}</span></p>
              ) : null}
            </div>
            {source ? (
              <div className="ccz-src">
                <span className="ccz-kicker">Source</span>
                <strong>{source.label}</strong>
                {source.detail ? <em>{source.detail}</em> : null}
              </div>
            ) : null}
          </div>

          <div className="ccz-chips">
            {filters.map((f) => (
              <LCChip key={f.id} field={f.label} value={clauseValueText(f)} onEdit={f.fieldKey === 'properties.drawn_area' || f.fieldKey === 'properties.property_id' ? undefined : () => setEditing(f.id)} onRemove={() => onFilters(filters.filter((x) => x.id !== f.id))} />
            ))}
            <FilterCommand catalog={catalog} filters={filters} onChange={onFilters} editing={editing} setEditing={setEditing} request={fieldRequest} onRequestDone={onFieldRequestDone} />
          </div>

          {error ? (
            <div className="ccz-err" role="alert">
              <Icon name="alert-circle" size={14} />
              <span>Audience couldn’t be counted — {error}</span>
              <LCButton size="sm" variant="quiet" onClick={onRetry}>Try again</LCButton>
            </div>
          ) : null}

          {audience ? (
            <AnimatePresence initial={false}>
              <motion.div key="dist" className="ccz-aud__dist" initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={lcTransition(reduced, { duration: 0.26 })}>
                <ComposerFunnel audience={audience} labelOf={labelOf} nowMs={openedAt} />
                <OfferReadyLine state={offerReady} />
                <div className="ccz-aud__block">
                  <div className="ccz-aud__label"><span className="ccz-kicker">Universe</span><span className="ccz-muted">{fmt(audience.matched)} matched properties</span></div>
                  <SegmentBar segments={universe} total={n0(audience.matched)} label="Matched universe" />
                </div>
                {audience.build.ok ? (
                  <div className="ccz-aud__block">
                    <div className="ccz-aud__label">
                      <span className="ccz-kicker">Build</span>
                      <span className="ccz-muted">
                        {audience.build.whole_cohort
                          ? <>Whole cohort · {fmt(audience.build.rows_read)} rows → {fmt(audience.build.recipients)} recipients{partial ? ` · Build reads at most ${fmt(audience.build.build_limit ?? audience.build.simulated_limit)}` : ''}{audience.build.timings_ms ? ` · counted in ${(audience.build.timings_ms.total / 1000).toFixed(1)}s` : ''}</>
                          : <>Sample · first {fmt(audience.build.rows_read)} rows → {fmt(audience.build.recipients)} recipients · counting the whole cohort…</>}
                      </span>
                    </div>
                    <SegmentBar segments={build} total={n0(audience.build.rows_read)} label="Simulated build" />
                    {audience.build.held ? (
                      <ul className="ccz-why">
                        {Object.entries(audience.build.held_by_reason ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => <li key={k}><span>{heldWords(k)}</span><b>{fmt(v)}</b></li>)}
                      </ul>
                    ) : null}
                  </div>
                ) : (
                  <div className="ccz-err"><Icon name="alert" size={14} /><span>Build simulation failed — {audience.build.error}</span></div>
                )}
                {audience.zones.unresolved > 0 ? (
                  <p className="ccz-note is-attn"><Icon name="clock" size={13} /> Timezone unavailable for {fmt(audience.zones.unresolved)} of {fmt(audience.zones.scanned)} read — held, never defaulted to a zone.</p>
                ) : null}
                {audience.inapplicable_filters.length || audience.dropped_filter_count ? (
                  <p className="ccz-note is-attn"><Icon name="filter" size={13} /> {audience.inapplicable_filters.length + audience.dropped_filter_count} filter(s) can’t narrow this audience and were not applied — listed by name below.</p>
                ) : null}
                <FilterEffectsPanel filters={filterSpec} format={fmt} className="ccz-aud__why" />
                <Footprint audience={audience} />
              </motion.div>
            </AnimatePresence>
          ) : loading ? <LCSkeleton shape="block" height={180} /> : null}
          <div className="ccz-dropline" aria-hidden={drag === 'idle'}>
            <Icon name="drag" size={13} /> Drop properties or a campaign here to fold them in
          </div>
        </>
      )}
      <div className="ccz-drophalo" aria-hidden="true" />
    </div>
  )
}

const OFFER_REASON_WORDS: Record<string, string> = {
  not_scored: 'not scored by the offer engine',
  score_predates_current_policy: 'score predates the 09-12 offer policy',
  score_stale: 'score older than 30 days',
  tier_not_offer_authoritative: 'engine tier is not an automatic offer',
  no_recommended_offer: 'no recommended offer',
  no_authorized_ceiling: 'no authorized max',
  backfill_row_not_monetary_authority: 'backfill score (ranking only)',
}

/** "2,348 sendable · 2,311 offer-ready · 37 review-only" — review-only sellers are still contacted; Autopilot never quotes them money. */
function OfferReadyLine({ state }: { state: { data: ComposerOfferReady | null; error: string | null } | null | undefined }) {
  if (!state) return <p className="ccz-dim ccz-offer-ready">Offer Ready — counting after the whole cohort…</p>
  if (state.error || !state.data) return <p className="ccz-dim ccz-offer-ready">Offer Ready not measured — {state.error || 'unavailable'}</p>
  const d = state.data
  const reasons = Object.entries(d.by_reason).filter(([k]) => k !== 'offer_ready').sort((a, b) => b[1] - a[1])
  return (
    <div className="ccz-aud__block ccz-offer-ready" aria-label="Offer Ready preflight">
      <div className="ccz-aud__label">
        <span className="ccz-kicker">Offer Ready</span>
        <span className="ccz-muted">{fmt(d.sendable)} sendable · {fmt(d.offer_ready)} offer-ready · {fmt(d.review_only)} review-only</span>
      </div>
      {reasons.length ? (
        <ul className="ccz-why">
          {reasons.map(([k, n]) => <li key={k}><span>{OFFER_REASON_WORDS[k] || k}</span><b>{fmt(n)}</b></li>)}
        </ul>
      ) : null}
      <p className="ccz-dim">Review-only sellers are still messaged; Autopilot converses but never quotes a number without a fresh authoritative engine offer.</p>
    </div>
  )
}
