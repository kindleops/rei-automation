import { memo, type ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import { LCButton, LCIconButton, LCLive, LCMenu, LCSearch, LCSegmented, LCTabs, LCTooltip, cx, type LCMenuEntry } from '../../../shared/lc'
import type { DeskBrief } from '../../../domain/calendar/calendar-timeline-api'
import type { DateCommand, Mode, OwnerKey } from './temporal-model'
import { clock, fullDay, monthTitle, relative, weekday, zoneAbbr, monthDay, addDays, weekStart } from './temporal-time'

/**
 * THE TOP COMMAND STRIP (§117–121) — one glass strip, not five cards:
 * the date in strong type with NOW beside it, the system's posture, and one
 * summary line (day · system · you · attention · next) where every number is
 * a drill (§128–130). Below it, the controls: mode lens, owner, search,
 * filters, zoom and Create.
 */

export interface StripCounts { label?: string | null; day: number; system: number; you: number; external: number; attention: number; basis: Record<string, string> }

export interface StripProps {
  day: string
  preview: string | null
  today: string
  now: number
  tz: string
  mode: Mode
  posture: { headline: string; tone: 'clear' | 'system' | 'you' | 'attention' }
  counts: StripCounts | null
  next: DeskBrief | null
  live: { live: boolean; updatedAt: number | null; refreshing: boolean; stale: boolean }
  degraded: string[]
  owner: OwnerKey
  query: string
  command: DateCommand | null
  filterButton: ReactNode
  createItems: LCMenuEntry[]
  briefShown: boolean
  onMode: (m: Mode) => void
  onOwner: (o: OwnerKey) => void
  onQuery: (q: string) => void
  onSubmitQuery: () => void
  onDrill: (k: 'day' | 'system' | 'you' | 'attention' | 'next') => void
  onBrief: () => void
}

const MODES: Array<{ id: Mode; label: string }> = [
  { id: 'today', label: 'Today' }, { id: 'timeline', label: 'Timeline' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }, { id: 'attention', label: 'Attention' }, { id: 'appointments', label: 'Appointments' },
]

function Seg({ k, label, value, basis, tone, onDrill, children }: { k: 'day' | 'system' | 'you' | 'attention'; label: string; value: number | null; basis?: string; tone?: string; onDrill: (k: 'day' | 'system' | 'you' | 'attention') => void; children?: ReactNode }) {
  return (
    <LCTooltip content={basis} side="bottom">
      <button type="button" className={cx('tcc-sum__seg', tone && `is-${tone}`)} onClick={() => onDrill(k)} aria-label={`${label}: ${value ?? 'loading'}`}>
        <span className="tcc-sum__label">{label}</span>
        <b className="tcc-sum__value">{value === null ? <i className="tcc-skel-num" /> : value.toLocaleString('en-US')}</b>
        {children}
      </button>
    </LCTooltip>
  )
}

export const TemporalStrip = memo(function TemporalStrip(p: StripProps) {
  const shown = p.preview ?? p.day
  const isToday = shown === p.today
  const title = p.mode === 'month' ? monthTitle(shown) : p.mode === 'week' ? `Week of ${monthDay(weekStart(shown))} – ${monthDay(addDays(weekStart(shown), 6))}` : p.mode === 'timeline' ? `Timeline · ${monthDay(addDays(p.today, -1))} – ${monthDay(addDays(p.today, 7))}` : p.mode === 'attention' ? 'Attention · what needs time' : p.mode === 'appointments' ? 'Appointments · booked calls' : fullDay(shown).replace(/, \d{4}$/, '')
  const dayWord = isToday ? 'Today' : `${weekday(shown)} ${Number(shown.slice(8, 10))}`
  const c = p.counts
  return (
    <header className={cx('tcc-strip', p.preview && 'is-previewing')}>
      <div className="tcc-strip__top">
        <div className="tcc-date">
          <h1 className="tcc-date__title" aria-live="polite">{title}</h1>
          <p className="tcc-date__meta">
            <LCLive live={p.live.live} updatedAt={p.live.updatedAt} stale={p.live.stale} label={p.live.refreshing ? 'Refreshing' : p.live.live ? 'Live' : 'Polling'} />
            <span className="tcc-date__now"><b>{clock(p.now, p.tz)}</b> {zoneAbbr(p.tz)}</span>
            <span className={cx('tcc-date__posture', `is-${p.posture.tone}`)}>{p.posture.headline}</span>
            {!isToday && p.mode !== 'month' && p.mode !== 'week' ? <span className="tcc-date__rel">{shown < p.today ? 'Past day' : 'Ahead'}</span> : null}
            {p.degraded.length ? <LCTooltip content={`Not loaded: ${p.degraded.join(', ')}. Everything else is current.`}><span className="tcc-date__degraded"><Icon name="alert" size={11} />{p.degraded.length === 1 ? `${p.degraded[0]} unavailable` : `${p.degraded.length} sources unavailable`}</span></LCTooltip> : null}
          </p>
        </div>
        <div className="tcc-sum" role="group" aria-label="Temporal summary">
          <Seg k="day" label={c?.label ?? dayWord} value={c ? c.day : null} basis={c?.basis.day} onDrill={p.onDrill} />
          <Seg k="system" label="System" value={c ? c.system : null} basis={c?.basis.system} tone={p.owner === 'system' ? 'on' : undefined} onDrill={p.onDrill} />
          <Seg k="you" label="You" value={c ? c.you : null} basis={c?.basis.you} tone={p.owner === 'you' ? 'on' : c && c.you ? 'you' : undefined} onDrill={p.onDrill} />
          <Seg k="attention" label="Attention" value={c ? c.attention : null} basis={c?.basis.attention} tone={c && c.attention ? 'attn' : undefined} onDrill={p.onDrill} />
          <LCTooltip content={c?.basis.next} side="bottom">
            <button type="button" className="tcc-sum__seg is-next" onClick={() => p.onDrill('next')} disabled={!p.next} aria-label={p.next ? `Next system action ${clock(p.next.at, p.tz)}: ${p.next.title}` : 'No next system action'}>
              <span className="tcc-sum__label">Next</span>
              <b className="tcc-sum__value">{p.next ? clock(p.next.at, p.tz) : '—'}</b>
              <em className="tcc-sum__what">{p.next ? `${p.next.type === 'campaign_window' ? 'Window opens' : p.next.title} · ${String(p.next.subtitle || '').split(' · ').slice(0, 2).join(' · ') || relative(Date.parse(p.next.at), p.now)}` : 'Nothing else scheduled'}</em>
            </button>
          </LCTooltip>
        </div>
      </div>
      <div className="tcc-strip__bar">
        <LCTabs items={MODES.map((m) => ({ id: m.id, label: m.label, count: m.id === 'attention' && c?.attention ? c.attention : null, tone: m.id === 'attention' && c?.attention ? 'attn' as const : undefined }))} value={p.mode} onChange={(v) => p.onMode(v as Mode)} label="Calendar mode" className="tcc-modes" />
        <LCSegmented size="sm" label="Owner" value={p.owner} onChange={(v) => p.onOwner(v as OwnerKey)} className="tcc-owner-seg"
          options={[{ value: 'all', label: 'All' }, { value: 'system', label: 'System' }, { value: 'you', label: 'You' }, { value: 'external', label: 'External' }]} />
        <span className="tcc-strip__spacer" />
        <div className={cx('tcc-search', p.query && 'has-query')}>
          <LCSearch value={p.query} onChange={p.onQuery} onSubmit={p.onSubmitQuery} label="Search events or jump to a date" placeholder="Search events, sellers, campaigns — or “Oct 15”" />
          {p.command ? <button type="button" className="tcc-search__cmd" onClick={p.onSubmitQuery}><Icon name="calendar" size={11} />Go to {p.command.label}<kbd className="lc-kbd">↵</kbd></button> : null}
        </div>
        {p.filterButton}
        <LCIconButton icon="briefing" label={p.briefShown ? 'Hide the brief — canvas full width' : 'Show the temporal brief'} size="sm" selected={p.briefShown} onClick={p.onBrief} />
        <LCMenu label="Create" title="Created in the app that owns it" items={p.createItems} width={300}
          trigger={<LCButton variant="secondary" size="sm" icon="spark" trailingIcon="chevron-down" className="tcc-create">Create</LCButton>} />
      </div>
    </header>
  )
})
