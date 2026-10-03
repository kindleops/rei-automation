import { useMemo, useState } from 'react'
import { useRouteLocation } from '../../../app/router'
import { Icon } from '../../../shared/icons'
import { LCButton, LCDialog, LCEmpty, LCError, LCIconButton, LCMenu, LCSegmented, LCSelect, LCSkeleton, LCStatus, LCTooltip, cx, lcConfirm, lcToast } from '../../../shared/lc'
import { sound } from '../../../shared/sound'
import type { FilterOptions } from '../../../domain/analytics/analytics-lab-api'
import { useIntel, paths } from '../intelligence/intel-data'
import { serverContext } from '../intelligence/intel-state'
import { useLab } from '../intelligence/intel-context'
import { openPath } from '../../home/desktop/board/widget-runtime'
import { GoalBar, GoalFacts, GoalLine, GoalReadout } from './GoalParts'
import {
  analyticsPathFor, attentionRank, catalogueEntry, COMPARATOR_WORD, duplicateOf, formatValue, goalState, goalTerms, goalTitle, newGoalId, PERIOD_WORD, PERIODS,
  type CatalogueEntry, type Comparator, type Goal, type GoalProgress, type PeriodKind,
} from './goals-model'
import { archiveGoal, refreshProgress, saveGoal, useGoals } from './goals-store'
import './goals.css'

/**
 * ANALYTICS · GOALS LENS — operator-set targets on canonical Lab metrics.
 *
 *   one plane: the goals, behind-pace first, each with period-to-date vs
 *   target, the linear pace tick, the running-total line and (for counts that
 *   add up by day) a run-rate projection labelled as modeled
 *
 * Every number is the Lab engine's evaluation of the goal's period-to-date
 * (GET /goals/progress): the same definition, exclusions and sample gates the
 * rest of Analytics shows. A Lab status that is not ok (no data, too few
 * records, unavailable, not measurable for a market) is shown verbatim and
 * gets no verdict. Who may set targets is an open owner decision: today a goal
 * belongs to the signed-in operator only.
 */

export function GoalsLens() {
  const s = useGoals(true)
  const { ctx } = useLab()
  const location = useRouteLocation()
  const [draft, setDraft] = useState<Draft | null>(() => draftFromLocation(location, s.catalogue))
  // a deck command arriving while the lens is already open ("new goal …")
  const [seen, setSeen] = useState(location)
  if (seen !== location) {
    setSeen(location)
    const d = draftFromLocation(location, s.catalogue)
    if (d) setDraft(d)
  }

  const active = useMemo(() => s.goals.filter((g) => g.status === 'active'), [s.goals])
  const ordered = useMemo(() => active.slice().sort((a, b) => attentionRank(s.progress.byId[a.goal_id]) - attentionRank(s.progress.byId[b.goal_id]) || a.metric_id.localeCompare(b.metric_id)), [active, s.progress.byId])
  const behind = ordered.filter((g) => attentionRank(s.progress.byId[g.goal_id]) === 0).length
  const loading = s.progress.status === 'loading' && !Object.keys(s.progress.byId).length

  return (
    <section className="gl lc-plane is-solid is-d2" aria-label="Goals">
      <header className="ix-plane__head gl__head">
        <div>
          <span className="ix-eyebrow">Goals</span>
          <h2>{active.length ? (behind ? `${behind} of ${active.length} goal${active.length === 1 ? '' : 's'} need attention` : `${active.length} goal${active.length === 1 ? '' : 's'}, none behind`) : 'Targets on the metrics Analytics measures'}</h2>
          <p>Progress is the period-to-date value of the same Analytics definition — nothing is stored or estimated. Projections are run-rate arithmetic, shown only for counts that add up day by day.</p>
        </div>
        <div className="ix-plane__acts">
          <LCTooltip content={s.note ?? 'Goals are saved to the server for your sign-in.'}>
            <span className={cx('gl-persist', s.persistence === 'local' && 'is-local')}>
              <Icon name={s.persistence === 'local' ? 'database' : 'check'} size={11} />
              {s.persistence === 'booting' ? 'Opening…' : s.persistence === 'local' ? 'On this device' : 'Saved to server'}
            </span>
          </LCTooltip>
          {active.length ? <LCIconButton icon="refresh-cw" label="Re-read progress" size="sm" onClick={() => void refreshProgress(true)} /> : null}
          <LCButton variant="primary" size="sm" icon="plus" onClick={() => { sound.panel.open(); setDraft(blankDraft(s.catalogue)) }}>New goal</LCButton>
        </div>
      </header>

      {s.progress.status === 'error' && !Object.keys(s.progress.byId).length ? (
        <LCError compact what="Goal progress didn’t load — no figure is shown rather than a guess" detail={s.progress.error ?? undefined} onRetry={() => void refreshProgress(true)} />
      ) : null}

      {!active.length ? (
        <LCEmpty
          icon="target"
          title="No goals yet"
          body="Set a target on a metric Analytics already measures — sellers reached, replies, interested sellers, opportunities, offers, contracts — for a week, month or quarter, in one market or all."
          action={{ label: 'New goal', onClick: () => setDraft(blankDraft(s.catalogue)) }}
        />
      ) : (
        <ul className="gl-grid">
          {ordered.map((g) => (
            <GoalCard key={g.goal_id} goal={g} p={s.progress.byId[g.goal_id]} loading={loading} catalogue={s.catalogue} onEdit={() => setDraft(draftOf(g))} />
          ))}
        </ul>
      )}

      {draft ? <GoalComposer draft={draft} catalogue={s.catalogue} goals={s.goals} labCtx={ctx} onClose={() => setDraft(null)} /> : null}
    </section>
  )
}

function GoalCard({ goal, p, loading, catalogue, onEdit }: { goal: Goal; p: GoalProgress | undefined; loading: boolean; catalogue: ReadonlyArray<CatalogueEntry>; onEdit: () => void }) {
  const entry = catalogueEntry(catalogue, goal.metric_id)
  const unit = entry?.unit
  const st = goalState(p)
  const archive = async () => {
    const ok = await lcConfirm({
      title: `Archive “${goalTitle(goal, catalogue)}”?`,
      effects: [{ text: 'The target stops being tracked on Analytics, Home and the Brief.', kind: 'stops' }, { text: 'No metric or record changes — a goal is only a target.', kind: 'keeps' }],
      confirmLabel: 'Archive goal', nativeText: `Archive the goal ${goalTitle(goal, catalogue)}?`,
    })
    if (!ok) return
    const r = await archiveGoal(goal.goal_id)
    if (!r.ok) lcToast({ title: 'Goal not archived', detail: r.message, severity: 'warning' })
  }
  return (
    <li className={cx('gl-card', `is-${st.tone}`)}>
      <div className="gl-card__top">
        <div className="gl-card__name">
          <strong>{goalTitle(goal, catalogue)}</strong>
          <small>{goalTerms(goal, catalogue)}</small>
        </div>
        <LCMenu
          label="Goal actions"
          trigger={<LCIconButton icon="more" label="Goal actions" size="sm" />}
          items={[
            { id: 'open', label: 'Open in Analytics', icon: 'arrow-up-right', hint: 'The same metric, market and period', onSelect: () => openPath(analyticsPathFor(goal, p)) },
            { id: 'edit', label: 'Edit target…', icon: 'target', onSelect: onEdit },
            { kind: 'separator', id: 's' },
            { id: 'archive', label: 'Archive goal…', icon: 'archive', onSelect: () => void archive() },
          ]}
        />
      </div>
      {loading ? <LCSkeleton shape="metric" count={1} label="Measuring" /> : (
        <>
          <GoalReadout p={p} catalogue={catalogue} metricId={goal.metric_id} />
          {p && p.status === 'ok' ? <GoalBar p={p} label={`${formatValue(p.current, unit)} of ${formatValue(p.target, unit)} ${PERIOD_WORD[goal.period_kind]}`} /> : null}
          <GoalLine p={p} />
          {p && p.status === 'ok' ? (
            <GoalFacts items={[
              ...(p.pace !== null ? [{ k: 'Pace by now', v: formatValue(p.pace, unit), title: 'The target spread evenly over the period, at this moment' }] : []),
              ...(p.additive ? [{ k: 'Run-rate', v: p.projection !== null ? formatValue(p.projection, unit) : 'too early', title: p.projection_basis ?? undefined, modeled: true }] : []),
              { k: 'Days left', v: String(p.period.days_left) },
              ...(p.n !== null && unit === 'rate' ? [{ k: 'Sample', v: p.n.toLocaleString('en-US'), title: p.min_sample ? `Minimum sample ${p.min_sample}` : undefined }] : []),
            ]} />
          ) : p ? <p className="gl-card__why">{st.detail ?? 'Analytics returned no value for this period.'}</p> : null}
          {entry?.caveat ? <p className="gl-card__caveat"><Icon name="alert-circle" size={11} />{entry.caveat}</p> : null}
        </>
      )}
    </li>
  )
}

/* ── composer ─────────────────────────────────────────────────────────── */

interface Draft { goal_id: string; metric_id: string; market: string | null; market_label: string | null; period_kind: PeriodKind; comparator: Comparator; target: string; label: string; editing: boolean; timezone: string }

const tzNow = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago' } catch { return 'America/Chicago' } }

function blankDraft(cat: ReadonlyArray<CatalogueEntry>, metric = 'sellers_reached'): Draft {
  const e = catalogueEntry(cat, metric) ?? catalogueEntry(cat, 'sellers_reached')!
  return { goal_id: newGoalId(), metric_id: e.id, market: null, market_label: null, period_kind: 'month', comparator: e.default_comparator, target: '', label: '', editing: false, timezone: tzNow() }
}
function draftOf(g: Goal): Draft {
  const rate = g.target_value <= 1 && /rate$/.test(g.metric_id)
  return { goal_id: g.goal_id, metric_id: g.metric_id, market: g.market, market_label: g.market_label, period_kind: g.period_kind, comparator: g.comparator, target: rate ? String(+(g.target_value * 100).toFixed(2)) : String(g.target_value), label: g.label ?? '', editing: true, timezone: g.timezone }
}
/** `/analytics?lens=goals&goal=new&metric=…&period=…` (the Command Deck) → a composer draft. */
function draftFromLocation(location: string, cat: ReadonlyArray<CatalogueEntry>): Draft | null {
  const q = new URLSearchParams(location.includes('?') ? location.slice(location.indexOf('?') + 1) : '')
  if (q.get('goal') !== 'new') return null
  const d = blankDraft(cat, q.get('metric') || 'sellers_reached')
  const period = q.get('period')
  return period === 'week' || period === 'month' || period === 'quarter' ? { ...d, period_kind: period } : d
}

function GoalComposer({ draft, catalogue, goals, labCtx, onClose }: { draft: Draft; catalogue: ReadonlyArray<CatalogueEntry>; goals: ReadonlyArray<Goal>; labCtx: ReturnType<typeof useLab>['ctx']; onClose: () => void }) {
  const [d, setD] = useState(draft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const entry = catalogueEntry(catalogue, d.metric_id)
  const rate = entry?.unit === 'rate'
  // the markets present in the last 90 days of activity, from the Lab's own options read
  const optCtx = serverContext(labCtx, { range: { preset: '90d' }, compare: { mode: 'none' }, filters: [], segment: [] })
  const markets = useIntel<FilterOptions>(paths.options(optCtx, 'market'), 10 * 60_000)
  const marketOptions = [{ value: '__all', label: 'All markets' }, ...(markets.data?.values ?? []).filter((v) => !v.test).map((v) => ({ value: v.value, label: v.label, hint: `${v.n.toLocaleString('en-US')} in 90 days` }))]
  if (d.market && !marketOptions.some((o) => o.value === d.market)) marketOptions.push({ value: d.market, label: d.market_label || d.market, hint: 'saved market' })

  const num = Number(d.target)
  const target = rate ? num / 100 : num
  const valid = d.target.trim() !== '' && Number.isFinite(num) && num >= 0 && (rate ? num <= 100 : Number.isInteger(num))
  const dup = duplicateOf(goals, { goal_id: d.goal_id, metric_id: d.metric_id, market: d.market, period_kind: d.period_kind })

  const save = async () => {
    if (!valid || dup || busy) return
    setBusy(true)
    setError(null)
    const r = await saveGoal({ goal_id: d.goal_id, metric_id: d.metric_id, label: d.label.trim() || null, market: d.market, market_label: d.market_label, period_kind: d.period_kind, comparator: d.comparator, target_value: target, timezone: d.timezone })
    setBusy(false)
    if (!r.ok) { setError(r.message); return }
    sound.outcome.success('subtle')
    lcToast({ title: d.editing ? 'Goal updated' : 'Goal set', detail: r.where === 'device' ? 'Saved on this device until server storage is enabled.' : undefined, severity: 'success' })
    onClose()
  }

  const metricOptions = catalogue.map((c) => ({ value: c.id, label: c.label, hint: c.unit === 'rate' ? 'rate' : c.additive ? 'count · projected' : 'count', group: c.unit === 'rate' ? 'Rates' : 'Counts' }))

  return (
    <LCDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      title={d.editing ? 'Edit goal' : 'New goal'}
      description="A target on a metric Analytics measures. Its progress is always the live Analytics value for the period."
      width={520}
      footer={
        <div className="gl-compose__foot">
          <LCButton variant="quiet" onClick={onClose}>Cancel</LCButton>
          <LCButton variant="primary" onClick={() => void save()} disabled={!valid || Boolean(dup)} loading={busy}>{d.editing ? 'Save goal' : 'Set goal'}</LCButton>
        </div>
      }
    >
      <div className="gl-compose">
        <label className="gl-field">
          <span>Metric</span>
          <LCSelect label="Metric" value={d.metric_id} options={metricOptions} disabled={d.editing} onChange={(id) => { const e = catalogueEntry(catalogue, id); setD({ ...d, metric_id: id, comparator: e?.default_comparator ?? d.comparator, target: '' }) }} menuWidth={320} />
        </label>
        {entry?.description ? <p className="gl-compose__def">{entry.description}</p> : null}
        <div className="gl-compose__row">
          <label className="gl-field">
            <span>Period</span>
            <LCSegmented<PeriodKind> label="Period" size="sm" value={d.period_kind} options={PERIODS} onChange={(v) => setD({ ...d, period_kind: v })} />
          </label>
          <label className="gl-field">
            <span>Market</span>
            <LCSelect label="Market" value={d.market ?? '__all'} options={marketOptions} onChange={(v) => setD({ ...d, market: v === '__all' ? null : v, market_label: v === '__all' ? null : marketOptions.find((o) => o.value === v)?.label ?? null })} menuWidth={280} />
          </label>
        </div>
        <div className="gl-compose__row">
          <label className="gl-field">
            <span>Target</span>
            <LCSegmented<Comparator> label="Comparator" size="sm" value={d.comparator} options={[{ value: 'at_least', label: COMPARATOR_WORD.at_least }, { value: 'at_most', label: COMPARATOR_WORD.at_most }]} onChange={(v) => setD({ ...d, comparator: v })} />
          </label>
          <label className="gl-field gl-field--num">
            <span>{rate ? 'Share (%)' : 'Value'}</span>
            <span className="gl-num">
              <input inputMode="decimal" value={d.target} placeholder={rate ? 'e.g. 8' : 'e.g. 600'} aria-label="Target value" onChange={(ev) => setD({ ...d, target: ev.target.value.replace(/[^0-9.]/g, '') })} onKeyDown={(ev) => { if (ev.key === 'Enter') void save() }} />
              {rate ? <i>%</i> : null}
            </span>
          </label>
        </div>
        <label className="gl-field">
          <span>Name <em>optional</em></span>
          <input className="gl-text" value={d.label} maxLength={120} placeholder={entry?.label ?? 'Goal name'} onChange={(ev) => setD({ ...d, label: ev.target.value })} />
        </label>
        {entry?.caveat ? <p className="gl-compose__note"><Icon name="alert-circle" size={12} />{entry.caveat}</p> : null}
        {entry && !entry.additive ? <p className="gl-compose__note"><Icon name="stats" size={12} />{entry.unit === 'rate' ? 'A rate goal is judged on its period-to-date value; it is never projected.' : 'This count does not add up day by day (one seller counts once per period), so it gets no pace or projection.'}</p> : null}
        {dup ? <p className="gl-compose__err"><LCStatus label="Already set" tone="attn" quiet />There is already an active goal for {entry?.label ?? d.metric_id}, {d.market_label || 'all markets'}, {PERIOD_WORD[d.period_kind]}.</p> : null}
        {error ? <p className="gl-compose__err">{error}</p> : null}
        <p className="gl-compose__who"><Icon name="user" size={11} />Only you can see and change your goals. Team-wide targets are not available yet.</p>
      </div>
    </LCDialog>
  )
}
