import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { LCButton, LCChip, LCLink, LCPopover, LCSegmented, LCTooltip, LC_DUR, cx, lcEase, useLcReducedMotion } from '../../../shared/lc'
import type { EvidenceComp } from '../../../domain/comp-intelligence/comps-evidence-api'
import {
  describeFilters, filterCount, fmtMoney, fmtPct, matchesPreset, PRESETS, type CompFilters, type ExplainContext, type PresetId,
} from '../../../domain/comp-intelligence/comps-workstation-model'
import { CompRow } from './CompRow'
import type { Lens, Tier, Workstation } from './derive-workstation'
import type { FocusStore } from './focus-store'

interface Props {
  m: Workstation
  ctx: ExplainContext
  store: FocusStore
  filters: CompFilters
  onFilters: (f: CompFilters) => void
  filtersOpen: boolean
  onFiltersOpen: (open: boolean) => void
  filterPanel: ReactNode
  onLens: (l: Lens) => void
  onOpen: (c: EvidenceComp) => void
  onInclude: (c: EvidenceComp) => void
  onExclude: (c: EvidenceComp) => void
  onReset: () => void
  onStart: () => void
  changes: number
}

const CANDIDATE_PAGE = 30

export function EvidenceMode({ m, ctx, store, filters, onFilters, filtersOpen, onFiltersOpen, filterPanel, onLens, onOpen, onInclude, onExclude, onReset, onStart, changes }: Props) {
  const reduced = useLcReducedMotion()
  const list = useRef<HTMLDivElement | null>(null)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({ set: true, removed: true, candidates: true, excluded: false })
  const [page, setPage] = useState(CANDIDATE_PAGE)
  const [confirmReset, setConfirmReset] = useState(false)
  const preset = matchesPreset(filters)

  const totalWeight = m.lensComps.reduce((s, c) => s + (c.engine?.weight ?? 0), 0)
  const shares = new Map(m.lensComps.map((c) => [c.key, totalWeight > 0 ? (c.engine?.weight ?? 0) / totalWeight : null]))
  const maxShare = Math.max(0, ...[...shares.values()].map((v) => v ?? 0))
  const firstKey = m.lensComps[0]?.key ?? m.candidates[0]?.key ?? null
  const tabKey = activeKey ?? firstKey

  const onKeyNav = useCallback((e: KeyboardEvent<HTMLDivElement>, c: EvidenceComp) => {
    const k = e.key
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault()
      const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-comp-row]') ?? [])]
      const i = rows.indexOf(e.currentTarget)
      const next = rows[k === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)]
      if (next) { next.focus(); setActiveKey(next.dataset.key ?? null); next.scrollIntoView({ block: 'nearest' }) }
    } else if (k === 'Enter' || k === ' ') {
      e.preventDefault()
      onOpen(c)
    } else if ((k === 'i' || k === 'I') && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      onInclude(c)
    } else if ((k === 'x' || k === 'X') && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      onExclude(c)
    }
  }, [onExclude, onInclude, onOpen])

  const row = (c: EvidenceComp, tier: Tier, rank: number | null) => (
    <CompRow key={c.key} c={c} tier={tier} rank={rank} weightShare={shares.get(c.key) ?? null} maxShare={maxShare} kind={m.kind} metric={m.metric}
      ctx={ctx} store={store} onOpen={onOpen} onInclude={onInclude} onExclude={onExclude} tabStop={tabKey === c.key} onKeyNav={onKeyNav} />
  )

  const lensReplay = m.lensReplay.result
  const sysReplay = m.systemReplay.result
  const delta = m.operatorReplay?.result && sysReplay ? (m.operatorReplay.result.mid - sysReplay.mid) / sysReplay.mid : null

  return (
    <div className="ciw-evidence" ref={list}>
      <header className="ciw-sets">
        <div className="ciw-sets__counts lc-num">
          <SetCount label="System" value={m.systemKeys.size} hint="Comps the acquisition engine priced this subject from (stored run)" />
          <SetCount label="Operator" value={m.operatorKeys ? m.operatorKeys.size : null} hint="Your set in this session — never written back" />
          <SetCount label="Universe" value={m.universeCount} hint={`Admissible sales in the search: engine pool + recorded deeds, ${m.w.query.radiusMiles} mi · ${m.w.query.months} mo`} />
          <SetCount label="Excluded" value={m.excludedCount} hint="Sales the engine’s rules or the deed record rule out" tone="quiet" />
        </div>
        {m.operatorKeys ? (
          <div className="ciw-sets__lens">
            <LCSegmented
              label="Set shown"
              size="sm"
              value={m.lens}
              onChange={onLens}
              options={[{ value: 'system', label: `System ${m.systemKeys.size}` }, { value: 'operator', label: `Operator ${m.operatorKeys.size}` }]}
            />
            <span className="ciw-sets__delta lc-num">
              {delta !== null ? <>central <b>{fmtMoney(m.operatorReplay?.result?.mid ?? null)}</b> <em className={cx(delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : null)}>{fmtPct(delta, 1, true)}</em> vs system</> : m.operatorReplay?.result ? <>central <b>{fmtMoney(m.operatorReplay.result.mid)}</b></> : 'no priced comps in your set'}
              <span className="ciw-sets__changes"> · {changes} change{changes === 1 ? '' : 's'}</span>
            </span>
            <AnimatePresence mode="wait" initial={false}>
              {confirmReset ? (
                <motion.span key="confirm" className="ciw-inline-confirm" initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : LC_DUR.select, ease: lcEase('enter') }}>
                  <span>Discard your set{m.systemKeys.size ? ' and return to the engine’s' : ''}?</span>
                  <LCButton variant="secondary" size="sm" onClick={() => { setConfirmReset(false); onReset() }}>Reset</LCButton>
                  <LCButton variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>Keep</LCButton>
                </motion.span>
              ) : (
                <motion.span key="reset" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : LC_DUR.fast }}>
                  <LCButton variant="ghost" size="sm" icon="refresh-cw" onClick={() => setConfirmReset(true)}>{m.systemKeys.size ? 'Reset to system set' : 'Clear set'}</LCButton>
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        ) : (
          <p className="ciw-sets__hint">
            {m.systemKeys.size
              ? <>Showing the engine’s set. Include or exclude any sale to build your own — the system set stays as priced.</>
              : <>The engine has no priced set for this subject. Build an operator set from the admissible sales below{m.candidates.length ? '' : ' once any are found'}.</>}
          </p>
        )}
      </header>

      <div className="ciw-filterbar" role="group" aria-label="Universe filters">
        <div className="ciw-filterbar__presets" role="radiogroup" aria-label="Presets">
          {(Object.keys(PRESETS) as PresetId[]).map((id) => (
            <LCTooltip key={id} content={describeFilters(PRESETS[id].filters, m.kind).join(' · ') || 'Everything in the loaded search'}>
              <button type="button" role="radio" aria-checked={preset === id} data-preset={id} className={cx('ciw-preset', preset === id && 'is-on')} onClick={() => onFilters(PRESETS[id].filters)}>
                {PRESETS[id].label}
              </button>
            </LCTooltip>
          ))}
        </div>
        <LCPopover
          open={filtersOpen}
          onOpenChange={onFiltersOpen}
          label="Universe filters"
          side="bottom"
          align="end"
          material="frosted"
          width={360}
          trigger={
            <LCButton variant="quiet" size="sm" icon="filter" aria-label={`Filters, ${filterCount(filters)} active`}>
              Filters{filterCount(filters) ? <span className="ciw-filterbar__n">{filterCount(filters)}</span> : null}
            </LCButton>
          }
        >
          {filterPanel}
        </LCPopover>
        <span className="ciw-filterbar__count lc-num">{m.candidates.length.toLocaleString('en-US')} of {Math.max(0, m.universeCount - m.lensKeys.size).toLocaleString('en-US')} candidates shown</span>
      </div>
      {filterCount(filters) ? (
        <div className="ciw-chips">
          {describeFilters(filters, m.kind).map((d) => <LCChip key={d} value={d} tone="neutral" />)}
          <LCLink onClick={() => onFilters(PRESETS.broad.filters)}>Clear</LCLink>
        </div>
      ) : null}

      <div role="list" aria-label="Comparable evidence" className="ciw-sections">
        <Section id="set" title={m.lens === 'operator' ? 'Your set' : 'System set'} count={m.lensComps.length} open={open.set} onToggle={() => setOpen((o) => ({ ...o, set: !o.set }))}
          aside={lensReplay ? <span className="lc-num">central {fmtMoney(lensReplay.mid)} · {fmtMoney(lensReplay.low)}–{fmtMoney(lensReplay.high)}</span> : null}>
          {m.lensComps.length ? (
            <AnimatePresence initial={false}>
              {m.lensComps.map((c, i) => (
                <motion.div key={c.key} layout={!reduced} initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }} transition={{ duration: reduced ? LC_DUR.fast : LC_DUR.surface, ease: lcEase('standard') }}>
                  {row(c, m.added.has(c.key) ? 'added' : 'set', i + 1)}
                </motion.div>
              ))}
            </AnimatePresence>
          ) : (
            <div className="ciw-empty-inline">
              {m.lens === 'operator' ? 'Your set is empty — include candidates to price it.' : m.candidates.length ? (
                <>No engine set to show. <LCLink onClick={onStart}>Start an operator set from the {Math.min(6, m.candidates.length)} highest-weighted candidates</LCLink></>
              ) : 'No engine set and no admissible sales in this search.'}
            </div>
          )}
        </Section>

        {m.removed.length ? (
          <Section id="removed" title="Removed from the system set" count={m.removed.length} open={open.removed} onToggle={() => setOpen((o) => ({ ...o, removed: !o.removed }))} tone="quiet">
            {m.removed.map((c) => row(c, 'removed', null))}
          </Section>
        ) : null}

        <Section id="candidates" title="Candidates" count={m.candidates.length} open={open.candidates} onToggle={() => setOpen((o) => ({ ...o, candidates: !o.candidates }))}
          aside={<span>admissible by the engine’s rules · heaviest first</span>}>
          {m.candidates.length ? (
            <>
              {m.candidates.slice(0, page).map((c) => row(c, 'candidate', null))}
              {m.candidates.length > page ? (
                <div className="ciw-more"><LCButton variant="ghost" size="sm" onClick={() => setPage((p) => p + CANDIDATE_PAGE)}>Show {Math.min(CANDIDATE_PAGE, m.candidates.length - page)} more of {m.candidates.length - page}</LCButton></div>
              ) : null}
            </>
          ) : <div className="ciw-empty-inline">{filterCount(filters) ? 'No admissible sale passes these filters.' : 'No other admissible sale in this search.'}</div>}
        </Section>

        <Section id="excluded" title="Excluded" count={m.excluded.length} open={open.excluded} onToggle={() => setOpen((o) => ({ ...o, excluded: !o.excluded }))} tone="quiet"
          aside={<span>each with the rule that rules it out</span>}>
          {m.excluded.slice(0, 80).map((c) => row(c, 'excluded', null))}
          {m.excluded.length > 80 ? <div className="ciw-empty-inline">{m.excluded.length - 80} more excluded sales — narrow the search or filters to review them.</div> : null}
        </Section>
      </div>
    </div>
  )
}

function SetCount({ label, value, hint, tone }: { label: string; value: number | null; hint: string; tone?: 'quiet' }) {
  return (
    <LCTooltip content={hint}>
      <span className={cx('ciw-setcount', tone === 'quiet' && 'is-quiet')} tabIndex={0}>
        <span className="lc-eyebrow">{label}</span>
        <b>{value === null ? '—' : value.toLocaleString('en-US')}</b>
      </span>
    </LCTooltip>
  )
}

function Section({ id, title, count, open, onToggle, aside, tone, children }: { id: string; title: string; count: number; open: boolean; onToggle: () => void; aside?: ReactNode; tone?: 'quiet'; children: ReactNode }) {
  return (
    <section className={cx('ciw-sec', tone === 'quiet' && 'is-quiet', open && 'is-open')} data-section={id}>
      <button type="button" className="ciw-sec__head" aria-expanded={open} onClick={onToggle}>
        <span className="ciw-sec__title">{title}</span>
        <span className="ciw-sec__count lc-num">{count.toLocaleString('en-US')}</span>
        {aside ? <span className="ciw-sec__aside">{aside}</span> : null}
        <span className="ciw-sec__chev" aria-hidden="true" />
      </button>
      {open ? <div className="ciw-sec__body">{children}</div> : null}
    </section>
  )
}
