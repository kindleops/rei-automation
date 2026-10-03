import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { LCButton, LCSegmented, LCStatus, LCTooltip, cx, lcTransition, LC_SPRING, useLcReducedMotion } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import type { ComposerAudience, ComposerCoverage, ComposerFleet, ComposerSample, ComposerStrategy, ComposerTemplates, CoverageMarket, GovernedTemplate } from './composer-types'
import {
  checkSchedule, completionEstimate, fmt, n0, parseCap, snapVolume, unavailableWord,
  type CapacityPlan, type Composition, type ScheduleCheck, type ZoneWave,
} from './composer-model'
import { Kv } from './ComposerParts'
import { reasonWords, toLocalInput } from './composer-format'

/* ══ STRATEGY ════════════════════════════════════════════════════════════ */

function StrategySurface({ s, selected, onSelect, cohortLanguages }: { s: ComposerStrategy; selected: boolean; onSelect: () => void; cohortLanguages: string[] }) {
  const reduced = useLcReducedMotion()
  const english = s.languages.find((l) => l.language === 'English')
  const disabled = s.sendable === 0
  const covered = cohortLanguages.filter((l) => (s.languages.find((x) => x.language === l)?.sendable ?? 0) > 0).length
  return (
    <button type="button" role="radio" aria-checked={selected} className={cx('ccz-strat', selected && 'is-selected')} onClick={onSelect} disabled={disabled} title={disabled ? 'No sendable template' : undefined}>
      {selected ? <motion.span layoutId="ccz-strat-lens" className="ccz-strat__lens" transition={lcTransition(reduced, LC_SPRING.snappy)} /> : null}
      <span className="ccz-strat__top"><span className="ccz-kicker">{s.stage_code} · {s.touch}</span>{selected ? <Icon name="check" size={13} /> : null}</span>
      <strong>{s.label}</strong>
      <span className="ccz-strat__meta">
        <b>{fmt(s.sendable)}</b> sendable · {s.languages.length} languages
      </span>
      <span className="ccz-strat__meta">English {english ? `${english.sendable}/${english.templates}` : '0'}{cohortLanguages.length ? ` · cohort ${covered}/${cohortLanguages.length} covered` : ''}</span>
    </button>
  )
}

export function StrategyBody({ templates, audience, composition, fleet, onStrategy, onInspect }: {
  templates: ComposerTemplates | null
  audience: ComposerAudience | null
  composition: Composition
  fleet: ComposerFleet | null
  onStrategy: (s: ComposerStrategy) => void
  onInspect: (sample: ComposerSample) => void
}) {
  const [sampleIdx, setSampleIdx] = useState(0)
  const [picked, setPicked] = useState<string | null>(null)
  const selected = templates?.strategies.find((s) => s.use_case === composition.template_use_case) ?? null
  const cohortLanguages = useMemo(() => (audience?.distributions.languages ?? []).map((l) => (l.value === 'unknown' ? 'English' : l.value)).filter((v, i, a) => a.indexOf(v) === i), [audience])
  const samples = audience?.samples ?? []
  const sample = samples.length ? samples[sampleIdx % samples.length] : null
  const governed = selected?.governed ?? []
  const pickedTemplate = governed.find((g) => g.template_id === picked && g.selectable) ?? null

  if (!templates) return <div className="ccz-skel-rows" aria-busy="true"><span /><span /><span /></div>
  return (
    <div className="ccz-strategy">
      <div className="ccz-strats" role="radiogroup" aria-label="Strategy">
        {templates.strategies.map((s) => (
          <StrategySurface key={s.use_case} s={s} selected={s.use_case === composition.template_use_case} onSelect={() => onStrategy(s)} cohortLanguages={cohortLanguages} />
        ))}
      </div>

      {selected ? (
        <div className="ccz-cover">
          <div className="ccz-sub"><span className="ccz-kicker">Coverage by language</span><span className="ccz-muted">{selected.label} · {selected.stage_code}</span></div>
          <table className="ccz-table">
            <thead><tr><th>Language</th><th>Sendable</th><th>Paused</th><th>Blocked</th><th>Cohort</th></tr></thead>
            <tbody>
              {selected.languages.slice(0, 4).map((l) => {
                const cohort = (audience?.distributions.languages ?? []).find((x) => (x.value === 'unknown' ? 'English' : x.value) === l.language)?.count ?? 0
                return (
                  <tr key={l.language} className={cx(l.sendable === 0 && 'is-gap')}>
                    <td>{l.language}</td>
                    <td className="num">{fmt(l.sendable)}<span className="ccz-dim">/{fmt(l.templates)}</span></td>
                    <td className={cx('num', l.paused > 0 && 'is-attn')}>{l.paused || '—'}</td>
                    <td className={cx('num', l.blocked > 0 && 'is-attn')}>{l.blocked || '—'}</td>
                    <td className="num">{cohort ? fmt(cohort) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {selected.languages.length > 4 ? <p className="ccz-muted">+{selected.languages.length - 4} more languages · {fmt(selected.languages.slice(4).reduce((s, l) => s + l.sendable, 0))} sendable</p> : null}
          {(audience?.distributions.languages ?? []).some((l) => l.value === 'unknown') ? <p className="ccz-muted">No stated language → English (the documented default).</p> : null}
        </div>
      ) : null}

      {governed.length ? (
        <div className="ccz-governed">
          <div className="ccz-sub"><span className="ccz-kicker">Governed templates</span><span className="ccz-muted">{governed.filter((g) => g.selectable).length} in rotation · {governed.filter((g) => !g.selectable).length} unavailable</span></div>
          <ul className="ccz-tpl" role="listbox" aria-label="Governed templates">
            {governed.map((g: GovernedTemplate) => (
              <li key={g.template_id} role="option" aria-selected={picked === g.template_id} aria-disabled={!g.selectable}>
                <button type="button" disabled={!g.selectable} onClick={() => setPicked(picked === g.template_id ? null : g.template_id)} className={cx('ccz-tpl__row', !g.selectable && 'is-off', picked === g.template_id && 'is-on')}>
                  <span className="ccz-mono">{g.template_id}</span>
                  <span>{g.language}</span>
                  <LCStatus label={g.selectable ? (g.rotation_status ?? 'ungoverned') : reasonWords(g.reason)} tone={g.selectable ? 'exec' : 'attn'} quiet />
                  <span className="ccz-dim">{g.performance ? `${g.performance.reply_rate ?? '—'}% reply · n=${fmt(g.performance.sample)}` : 'Performance not captured'}</span>
                </button>
              </li>
            ))}
          </ul>
          {pickedTemplate ? <p className="ccz-muted">{pickedTemplate.name} · cap {pickedTemplate.daily_cap ?? '—'}/day · rotation picks among sendable templates; a pick here is for inspection only.</p> : null}
        </div>
      ) : null}

      <div className="ccz-preview">
        <div className="ccz-sub">
          <span className="ccz-kicker">Rendered preview</span>
          {samples.length > 1 ? (
            <span className="ccz-cycle">
              <button type="button" aria-label="Previous sample" onClick={() => setSampleIdx((i) => (i + samples.length - 1) % samples.length)}><Icon name="chevron-left" size={13} /></button>
              <span className="ccz-mono">{(sampleIdx % samples.length) + 1}/{samples.length}</span>
              <button type="button" aria-label="Next sample" onClick={() => setSampleIdx((i) => (i + 1) % samples.length)}><Icon name="chevron-right" size={13} /></button>
            </span>
          ) : null}
        </div>
        {sample ? (
          <div className={cx('ccz-bubble', !sample.ok && 'is-failed')}>
            <div className="ccz-bubble__who">
              <span>{sample.recipient ?? 'Seller'} · {sample.place ?? sample.market ?? '—'}</span>
              {sample.property_id ? <LCButton size="sm" variant="ghost" icon="eye" onClick={() => onInspect(sample)}>Inspect</LCButton> : null}
            </div>
            {sample.ok ? <p className="ccz-bubble__text">{sample.text}</p> : <p className="ccz-bubble__fail"><Icon name="alert" size={13} /> Not rendered — {reasonWords(sample.reason)}. This seller is held at build.</p>}
            {sample.ok ? <span className="ccz-dim">Template {sample.template_id} · {sample.template_language ?? 'English'} · rotation may pick a sibling</span> : null}
          </div>
        ) : <p className="ccz-muted">{audience ? 'No ready target to render.' : 'Previews render from real targets once the audience is counted.'}</p>}
      </div>

      <div className="ccz-auto">
        <div className="ccz-sub"><span className="ccz-kicker">Automation</span><span className="ccz-muted">read-only here · never reset on save</span></div>
        <dl className="ccz-kvs">
          <Kv k="Auto send" v="Off at creation; transmission is governed by the queue processor" />
          <Kv k="Auto reply" v={fleet?.system.auto_reply_mode ?? 'not available'} />
          <Kv k="Follow-up" v={fleet?.system.followup_automation_mode ?? 'not available'} />
        </dl>
      </div>
    </div>
  )
}

/* ══ DELIVERY ════════════════════════════════════════════════════════════ */

const COVERAGE_TONE: Record<string, 'ok' | 'exec' | 'attn' | 'neutral'> = { LOCAL: 'ok', REGIONAL: 'exec', DEGRADED: 'attn', UNCOVERED: 'attn' }
const COVERAGE_WORD: Record<string, string> = { LOCAL: 'Local', REGIONAL: 'Regional', DEGRADED: 'Degraded', UNCOVERED: 'No route' }
const TIER_WORD: Record<string, string> = { exact_market_match: 'local', approved_state_fallback: 'regional (state)', approved_alias: 'approved alias', primary: 'local', preferred_fallback: 'regional', last_resort: 'fallback' }

function CoverageRows({ markets }: { markets: CoverageMarket[] }) {
  return (
    <ul className="ccz-cov" aria-label="Coverage by market">
      {markets.map((m) => {
        const local = m.coverage === 'LOCAL'
        const via = m.serving_pool && !local ? ` via ${m.serving_pool}` : ''
        const reasons = (m.unavailable ?? []).flatMap((u) => u.reasons.map((r) => `${u.pool} ${r.phone} ${unavailableWord(r.reason)}`))
        return (
          <li key={`${m.market_id ?? ''}:${m.market}`} className={cx('ccz-cov__row', `is-${m.coverage.toLowerCase()}`)}>
            <span className="ccz-cov__mkt"><b>{m.market}</b><em>{fmt(m.targets)} sellers</em></span>
            <LCStatus label={`${COVERAGE_WORD[m.coverage] ?? m.coverage}${via}`} tone={COVERAGE_TONE[m.coverage] ?? 'neutral'} quiet={local} />
            <span className="ccz-cov__cap">{m.coverage === 'UNCOVERED' ? '—' : <><b className="num">{fmt(m.daily_capacity)}</b><em>/day · {m.healthy_numbers} {m.healthy_numbers === 1 ? 'number' : 'numbers'}{m.serving_tier ? ` · ${TIER_WORD[m.serving_tier] ?? m.serving_tier}` : ''}</em></>}</span>
            {reasons.length ? (
              <LCTooltip content={reasons.join(' · ')}><span className="ccz-cov__why">{reasons.length} unavailable</span></LCTooltip>
            ) : <span className="ccz-cov__why" />}
          </li>
        )
      })}
    </ul>
  )
}

function CapacityInstrument({ plan, composition, onDailyCap }: { plan: CapacityPlan; composition: Composition; onDailyCap: (value: string, reason: string | null) => void }) {
  const reduced = useLcReducedMotion()
  const track = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const cap = parseCap(composition.daily_cap)
  const planned = dragging ?? (cap === null || Number.isNaN(cap) ? null : cap)
  const total = Math.max(plan.available_per_day, planned ?? 0, plan.window_per_day ?? 0, 1)
  const scale = total * 1.08
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`
  const fromPointer = (e: ReactPointerEvent) => {
    const r = track.current!.getBoundingClientRect()
    const v = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * scale
    return Math.round(v / 10) * 10
  }
  const over = planned !== null && planned > plan.available_per_day
  return (
    <div className="ccz-cap">
      <div className="ccz-cap__nums">
        <div><span className="ccz-kicker">Planned</span><b className="ccz-num">{planned === null ? '—' : fmt(planned)}</b><em>/day</em></div>
        <div><span className="ccz-kicker">Routable today</span><b className="ccz-num">{fmt(plan.available_per_day)}</b><em>/day</em></div>
        <div><span className="ccz-kicker">Modeled</span><b className="ccz-num">{fmt(plan.effective_per_day)}</b><em>/day · {plan.binding === 'daily_cap' ? 'daily cap binds' : plan.binding === 'sender_capacity' ? 'senders bind' : plan.binding === 'contact_window' ? 'window binds' : plan.binding === 'cap_zero' ? 'cap 0' : '—'}</em></div>
      </div>
      <div
        ref={track}
        className={cx('ccz-cap__track', over && 'is-over')}
        role="slider"
        tabIndex={0}
        aria-label="Planned daily volume"
        aria-valuemin={0}
        aria-valuemax={Math.round(scale)}
        aria-valuenow={planned ?? 0}
        aria-valuetext={`${fmt(planned)} per day, ${fmt(plan.available_per_day)} available`}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(fromPointer(e)) }}
        onPointerMove={(e) => { if (dragging !== null) setDragging(fromPointer(e)) }}
        onPointerUp={() => {
          if (dragging === null) return
          const snap = snapVolume(dragging, plan)
          setDragging(null)
          onDailyCap(String(snap.value), snap.reason)
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 100 : 10
          const base = planned ?? 0
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); const s = snapVolume(base + step, plan); onDailyCap(String(s.value), s.reason) }
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onDailyCap(String(Math.max(0, base - step)), null) }
        }}
      >
        <span className="ccz-cap__avail" style={{ width: pct(plan.available_per_day) }} />
        {plan.window_per_day ? <span className="ccz-cap__win" style={{ left: pct(plan.window_per_day) }} title="Contact window ceiling at this spacing" /> : null}
        {planned !== null ? (
          <motion.span className="ccz-cap__mark" initial={false} animate={{ left: pct(planned) }} transition={dragging !== null ? { duration: 0 } : lcTransition(reduced, LC_SPRING.morph)}>
            <i />
          </motion.span>
        ) : null}
      </div>
      <div className="ccz-cap__legend">
        <span><i className="ccz-dot is-exec" /> Healthy routed numbers {fmt(plan.available_per_day)} left today</span>
        {plan.unavailable_count ? <span><i className="ccz-dot is-hatch" /> Unavailable: {plan.unavailable_reason}</span> : null}
        {plan.window_per_day ? <span><i className="ccz-dot is-line" /> Window ceiling {fmt(plan.window_per_day)}/day at {composition.send_interval_seconds}s spacing</span> : null}
      </div>
    </div>
  )
}

export function DeliveryBody({ fleet, coverage, coverageError, coverageLoading, plan, composition, eligibleInAudience, snapNote, onPatch, onDailyCap }: {
  fleet: ComposerFleet | null
  coverage: ComposerCoverage | null
  coverageError: string | null
  coverageLoading: boolean
  plan: CapacityPlan
  composition: Composition
  eligibleInAudience: number | null
  snapNote: string | null
  onPatch: (patch: Partial<Composition>) => void
  onDailyCap: (value: string, reason: string | null) => void
}) {
  const [showV2, setShowV2] = useState(false)
  const field = (key: keyof Composition, label: string, hint: string, extra?: ReactNode) => (
    <label className="ccz-field">
      <span>{label}</span>
      <input inputMode="numeric" value={String(composition[key] ?? '')} onChange={(e) => onPatch({ [key]: e.target.value.replace(/[^\d]/g, '') } as Partial<Composition>)} aria-describedby={`${key}-hint`} />
      <em id={`${key}-hint`}>{hint}</em>
      {extra}
    </label>
  )
  if (!coverage) {
    return coverageError
      ? <div className="ccz-err"><Icon name="alert" size={14} /> Routing coverage didn’t load — {coverageError}</div>
      : <div className="ccz-skel-rows" aria-busy="true"><span /><span /><span /></div>
  }
  const v2 = coverage.v2_preview
  return (
    <div className={cx('ccz-delivery', coverageLoading && 'is-settling')}>
      <div className="ccz-engine">
        <span className="ccz-kicker">Dispatch engine</span>
        <strong>{coverage.engine === 'sender_routing_v2' ? 'Sender Routing 2.0' : 'Campaign router'}</strong>
        <span className="ccz-dim">{coverage.engine === 'sender_routing_v2' ? `graph ${coverage.graph_version ?? ''}` : 'what dispatches today · Routing 2.0 gated off'}</span>
        <span className="ccz-engine__tot"><b className="num">{fmt(coverage.totals.distinct_healthy_numbers)}</b> healthy · <b className="num">{fmt(coverage.totals.distinct_daily_capacity)}</b>/day left today</span>
      </div>
      {coverage.markets.length ? <CoverageRows markets={coverage.markets} /> : <p className="ccz-dim">Coverage appears once the audience has markets.</p>}
      {plan.uncovered_targets ? <p className="ccz-note is-attn" role="status"><Icon name="alert" size={13} /> {plan.uncovered_markets.join(', ')}: no route — {fmt(plan.uncovered_targets)} sellers won’t send until a number can carry them.</p> : null}

      <CapacityInstrument plan={plan} composition={composition} onDailyCap={onDailyCap} />
      {snapNote ? <p className="ccz-note is-attn" role="status"><Icon name="alert" size={13} /> {snapNote}</p> : null}
      {plan.over_capacity && !snapNote ? <p className="ccz-note is-attn">Planned volume exceeds what routed numbers can carry today — the router stops at capacity.</p> : null}

      <div className="ccz-fields">
        {field('daily_cap', 'Daily cap', '0 sends nothing')}
        {field('total_cap', 'Campaign size', 'Targets built', eligibleInAudience ? (
          <button type="button" className="ccz-linkbtn" onClick={() => onPatch({ total_cap: String(eligibleInAudience) })}>All {fmt(eligibleInAudience)}</button>
        ) : null)}
        {field('send_interval_seconds', 'Spacing (s)', 'Between sends')}
        {field('per_sender_cap', 'Per-number cap', fleet?.system.per_number_cap ? `Blank = system ${fleet.system.per_number_cap}` : 'Blank = system cap')}
      </div>

      {v2 ? (
        <div className="ccz-v2">
          <button type="button" className="ccz-v2__toggle" onClick={() => setShowV2((x) => !x)} aria-expanded={showV2}>
            <Icon name={showV2 ? 'chevron-down' : 'chevron-right'} size={12} /> Routing 2.0 (not enabled) — preview
          </button>
          {showV2 ? (
            <div className="ccz-v2__body">
              <p className="ccz-dim">{v2.label}{v2.seed_backfill_simulated ? ' · proposed graph, seed backfill simulated' : ''}. {fmt(v2.totals.distinct_healthy_numbers)} healthy · {fmt(v2.totals.distinct_daily_capacity)}/day.</p>
              <CoverageRows markets={v2.markets} />
            </div>
          ) : null}
        </div>
      ) : null}
      <p className="ccz-dim">Coverage and capacity come from the routing engine that dispatches now: canonical sender eligibility, the operator blocklist and actual sends today. A number serving several markets is counted once.</p>
    </div>
  )
}

/* ══ SCHEDULE ════════════════════════════════════════════════════════════ */

const HORIZON_H = 48
const hourLabel = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric' })
const dayLabel = (t: number) => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

function TemporalRail({ waves, from, now, startAt, check, onMove }: { waves: ZoneWave[]; from: number; now: number; startAt: number; check: ScheduleCheck; onMove: (t: number) => void }) {
  const reduced = useLcReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const to = from + HORIZON_H * 3600_000
  const x = (t: number) => `${((t - from) / (to - from)) * 100}%`
  const at = drag ?? startAt
  const pick = (e: ReactPointerEvent) => {
    const r = (overlay.current ?? ref.current)!.getBoundingClientRect()
    const t = from + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (to - from)
    return Math.round(t / 900_000) * 900_000
  }
  const ticks = Array.from({ length: HORIZON_H / 12 }, (_, i) => from + i * 12 * 3600_000)
  return (
    <div className="ccz-rail">
      <div className="ccz-rail__ticks" aria-hidden="true">
        {ticks.map((t) => <span key={t} style={{ left: x(t) }}>{new Date(t).getHours() === 0 ? dayLabel(t) : hourLabel(t)}</span>)}
      </div>
      <div
        ref={ref}
        className="ccz-rail__lanes"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag(pick(e)) }}
        onPointerMove={(e) => { if (drag !== null) setDrag(pick(e)) }}
        onPointerUp={() => { if (drag !== null) { onMove(drag); setDrag(null) } }}
      >
        {waves.length ? waves.map((w) => (
          <div key={w.zone} className="ccz-lane">
            <span className="ccz-lane__name"><b>{w.short}</b><em>{fmt(w.count)}</em></span>
            <div className="ccz-lane__track">
              {w.windows.map((win) => (
                <span key={win.start} className={cx('ccz-lane__win', win.end > at && 'is-live')} style={{ left: x(win.start), width: `calc(${x(win.end)} - ${x(win.start)})` }} title={`${w.short} texting hours ${hourLabel(win.start)}–${hourLabel(win.end)} your time`} />
              ))}
            </div>
          </div>
        )) : <div className="ccz-lane is-empty"><span className="ccz-dim">Recipient zones appear once the audience is counted.</span></div>}
        <div className="ccz-rail__overlay" ref={overlay}>
        <span className="ccz-rail__now" style={{ left: x(now) }}><em>now</em></span>
        <motion.span
          className={cx('ccz-rail__launch', check.state !== 'ok' && 'is-warn')}
          initial={false}
          animate={{ left: x(at) }}
          transition={drag !== null ? { duration: 0 } : lcTransition(reduced, LC_SPRING.morph)}
          role="slider"
          tabIndex={0}
          aria-label="Launch time"
          aria-valuetext={new Date(at).toLocaleString()}
          aria-valuemin={from}
          aria-valuemax={to}
          aria-valuenow={at}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') { e.preventDefault(); onMove(at + (e.shiftKey ? 3600_000 : 900_000)) }
            if (e.key === 'ArrowLeft') { e.preventDefault(); onMove(at - (e.shiftKey ? 3600_000 : 900_000)) }
          }}
        >
          <i /><em>{new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</em>
        </motion.span>
        </div>
      </div>
    </div>
  )
}

export function ScheduleBody({ composition, waves, audience, plan, eligible, held, now, onStart }: {
  composition: Composition
  waves: ZoneWave[]
  audience: ComposerAudience | null
  plan: CapacityPlan
  eligible: number | null
  held: number | null
  now: number
  onStart: (start: Composition['start']) => void
}) {
  const from = Math.floor(now / 3600_000) * 3600_000
  const startAt = composition.start.mode === 'at' ? Date.parse(composition.start.at ?? '') || now : now
  const check = checkSchedule(composition.start, waves, now)
  const perDay = plan.effective_per_day
  const est = completionEstimate(eligible, held, perDay)
  const days = useMemo(() => {
    if (!eligible || !perDay || perDay <= 0) return []
    const out: number[] = []
    let left = eligible
    while (left > 0 && out.length < 14) { out.push(Math.min(perDay, left)); left -= perDay }
    return out
  }, [eligible, perDay])
  const move = (t: number) => {
    if (t <= now + 5 * 60_000) onStart({ mode: 'now', at: null })
    else onStart({ mode: 'at', at: new Date(t).toISOString() })
  }
  return (
    <div className="ccz-schedule">
      <div className="ccz-sched__ctl">
        <LCSegmented label="Start" size="sm" value={composition.start.mode} onChange={(m) => onStart(m === 'now' ? { mode: 'now', at: null } : { mode: 'at', at: composition.start.at ?? new Date(from + 2 * 3600_000).toISOString() })} options={[{ value: 'now', label: 'On launch' }, { value: 'at', label: 'Scheduled' }]} />
        {composition.start.mode === 'at' ? (
          <input type="datetime-local" className="ccz-dt" value={toLocalInput(composition.start.at)} onChange={(e) => { const d = new Date(e.target.value); if (!Number.isNaN(d.getTime())) onStart({ mode: 'at', at: d.toISOString() }) }} aria-label="Scheduled start (your time)" />
        ) : null}
        <span className="ccz-dim">Windows {composition.contact_window_start}–{composition.contact_window_end} in each recipient’s own zone</span>
      </div>

      <TemporalRail waves={waves} from={from} now={now} startAt={startAt} check={check} onMove={move} />

      {check.state === 'missed' || check.state === 'invalid' ? (
        <div className="ccz-missed" role="alert">
          <Icon name="clock" size={15} />
          <div><strong>{check.state === 'missed' ? 'Missed start' : 'Invalid start'}</strong><span>{check.text}</span></div>
          <LCButton size="sm" variant="secondary" onClick={() => onStart({ mode: 'now', at: null })}>Start now</LCButton>
          <LCButton size="sm" variant="quiet" onClick={() => onStart({ mode: 'at', at: new Date(from + 2 * 3600_000).toISOString() })}>Reschedule</LCButton>
        </div>
      ) : (
        <p className={cx('ccz-note', check.state === 'warn' && 'is-attn')}>
          <Icon name={check.state === 'warn' ? 'alert' : 'check'} size={13} /> {check.text}
          {check.state === 'warn' && check.nextOpenAt ? ` · first window ${new Date(check.nextOpenAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}
        </p>
      )}
      {audience && audience.zones.unresolved > 0 ? (
        <p className="ccz-note is-attn"><Icon name="alert-circle" size={13} /> Timezone unavailable for {fmt(audience.zones.unresolved)} — held, not scheduled on any zone.</p>
      ) : null}

      <div className="ccz-proj">
        <div className="ccz-sub"><span className="ccz-kicker">Projected sends</span><span className="ccz-muted">{perDay ? `${fmt(perDay)}/day modeled` : 'Set a daily cap'}</span></div>
        {days.length ? (
          <div className="ccz-proj__bars" role="img" aria-label={`Projected ${days.length} days of sends`}>
            {days.map((d, i) => (
              <LCTooltip key={i} content={`Day ${i + 1} · ${fmt(d)}`}>
                <span className="ccz-proj__bar" style={{ ['--h' as string]: String(d / Math.max(perDay ?? 1, 1)) }}><em>{i + 1}</em></span>
              </LCTooltip>
            ))}
            {est && est.low > 14 ? <span className="ccz-dim">+{est.low - 14} days</span> : null}
          </div>
        ) : <p className="ccz-dim">The curve appears once eligible and pace are known.</p>}
        <dl className="ccz-kvs">
          <Kv k="Est. completion" v={est ? (est.low === est.high ? `${est.low} ${est.low === 1 ? 'day' : 'days'}` : `${est.low}–${est.high} days`) : '—'} />
          <Kv k="Uncertainty" v={held ? `${fmt(held)} held may clear review; sender availability assumed to hold` : 'Sender availability assumed to hold'} />
          <Kv k="Zones" v={waves.length ? waves.map((w) => w.short).join(' → ') : '—'} />
          <Kv k="Routed" v={plan.uncovered_targets ? `${fmt(plan.covered_targets)} sellers with a route · ${fmt(plan.uncovered_targets)} unrouted excluded from the estimate` : plan.covered_targets ? `${fmt(plan.covered_targets)} sellers, all routed` : '—'} />
        </dl>
        <p className="ccz-dim">Modeled from the daily cap, sendable capacity and the window at {composition.send_interval_seconds}s spacing. The feeder paces the real send.</p>
      </div>
      {n0(eligible) === 0 && audience ? <p className="ccz-dim">Nothing to schedule — zero eligible.</p> : null}
    </div>
  )
}
