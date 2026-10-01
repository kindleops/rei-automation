import { memo } from 'react'
import { Icon } from '../../../shared/icons'
import { LCTooltip, cx } from '../../../shared/lc'
import type { DeskCampaign, DeskEvent } from '../../../domain/calendar/calendar-timeline-api'
import { LANE_ICON, laneOf, timeText, type BriefLine, type BriefModel } from './temporal-model'
import { addDays, clock, clockShort, dayKey, longDay, monthDay, relative, zoneAbbr } from './temporal-time'

/**
 * THE TEMPORAL BRIEF (§60–65, §187) — right now · next · forecast · end of
 * day · tomorrow, as one vertical plane. Every line is a deterministic count
 * with its basis on hover; a line is a control only when it has somewhere to
 * go. No cards inside cards.
 */

export interface BriefProps {
  model: BriefModel
  campaigns: DeskCampaign[]
  day: string
  today: string
  tz: string
  now: number
  onOpen: (e: DeskEvent) => void
  onOpenId: (id: string) => void
  onAttention: () => void
  onCampaign: (c: DeskCampaign) => void
  onDay: (day: string) => void
}

const SITUATION: Record<DeskCampaign['situation'], { word: (c: DeskCampaign, tz: string) => string; tone: string }> = {
  sending: { word: (c, tz) => `Sending · until ${c.window_today ? clockShort(c.window_today.closes_at, c.tz || tz) : '—'} ${zoneAbbr(c.tz)}`, tone: 'exec' },
  window_ahead: { word: (c, tz) => `Opens ${c.window_today ? clockShort(c.window_today.opens_at, c.tz || tz) : '—'} ${zoneAbbr(c.tz)}`, tone: 'exec' },
  window_closed: { word: () => 'Window closed for today', tone: 'neutral' },
  scheduled: { word: (c, tz) => (c.scheduled_for ? `Starts ${monthDay(dayKey(c.scheduled_for, tz))} ${clock(c.scheduled_for, tz)}` : 'Scheduled'), tone: 'exec' },
  missed: { word: (c, tz) => (c.scheduled_for ? `Missed start · ${monthDay(dayKey(c.scheduled_for, tz))} ${clock(c.scheduled_for, tz)}` : 'Missed start'), tone: 'attn' },
  exhausted: { word: () => 'Active · no one left to text', tone: 'neutral' },
  no_timezone: { word: () => 'No market zone set — no window', tone: 'attn' },
}

function Line({ line, onGo }: { line: BriefLine; onGo?: () => void }) {
  const body = (
    <>
      <span className="tcc-dot" data-tone={line.tone || 'neutral'} aria-hidden="true" />
      <span className="tcc-brief__text">{line.text}</span>
      {onGo ? <Icon name="chevron-right" size={12} className="tcc-brief__go" /> : null}
    </>
  )
  return (
    <LCTooltip content={line.basis} side="left">
      {onGo ? <button type="button" className="tcc-brief__line is-go" onClick={onGo}>{body}</button> : <div className="tcc-brief__line" tabIndex={0}>{body}</div>}
    </LCTooltip>
  )
}

export const TemporalBrief = memo(function TemporalBrief({ model, campaigns, day, today, tz, now, onOpen, onOpenId, onAttention, onCampaign, onDay }: BriefProps) {
  const isToday = day === today
  const go = (l: BriefLine) => {
    if (l.key === 'overdue' || l.key === 'missed' || l.key === 'deadlines') return onAttention
    if (l.ids && l.ids.length === 1) return () => onOpenId(l.ids![0])
    return undefined
  }
  const live = campaigns.filter((c) => c.situation !== 'missed')
  return (
    <aside className="tcc-brief" aria-label="Temporal brief">
      <header className="tcc-brief__head" data-posture={model.posture}>
        <span className="lc-eyebrow">{isToday ? 'Today · brief' : `${longDay(day)} · brief`}</span>
        <h2>{model.headline}</h2>
        {model.posture === 'system' && isToday ? <p>No operator action is required right now. The windows and follow-ups below run on their own.</p> : null}
        {model.posture === 'clear' ? <p>No system actions are scheduled{isToday ? ' for the rest of today' : ' on this day'}.</p> : null}
      </header>

      {isToday && model.rightNow.length ? (
        <section className="tcc-brief__sec">
          <h3 className="lc-eyebrow">Right now</h3>
          {model.rightNow.map((l) => <Line key={l.key} line={l} onGo={go(l)} />)}
        </section>
      ) : null}

      <section className="tcc-brief__sec">
        <h3 className="lc-eyebrow">Next</h3>
        {model.next.length ? (
          <ol className="tcc-brief__next">
            {model.next.map((e) => {
              const t = timeText(e, tz)
              return (
                <li key={e.id}>
                  <button type="button" className="tcc-brief__nextrow" onClick={() => onOpen(e)}>
                    <span className="tcc-brief__when"><b>{clock(e.start, tz)}</b><em>{relative(Date.parse(e.start), now)}</em></span>
                    <span className="tcc-brief__what"><Icon name={LANE_ICON[laneOf(e)]} size={12} /><b>{e.type === 'campaign_window' ? `Window opens · ${String(e.subtitle || '').split(' · ')[1] || e.subtitle}` : e.title}</b>
                      <em>{e.type === 'campaign_window' ? t.main + (t.alt ? ` · ${t.alt}` : '') : e.subtitle || e.place || e.reason || ''}</em></span>
                  </button>
                </li>
              )
            })}
          </ol>
        ) : <p className="tcc-brief__calm">{isToday ? 'Nothing else is scheduled today.' : 'Nothing timed on this day.'}</p>}
      </section>

      <section className="tcc-brief__sec">
        <h3 className="lc-eyebrow">Attention forecast</h3>
        {model.forecast.length ? model.forecast.map((l) => <Line key={l.key} line={l} onGo={go(l)} />) : <p className="tcc-brief__calm">Nothing will become a problem on its own — no overdue items, no missed starts.</p>}
      </section>

      {live.length ? (
        <section className="tcc-brief__sec">
          <h3 className="lc-eyebrow">Campaigns</h3>
          <ul className="tcc-brief__camps">
            {campaigns.map((c) => {
              const s = SITUATION[c.situation]
              return (
                <li key={c.id}>
                  <button type="button" className="tcc-brief__camp" onClick={() => onCampaign(c)}>
                    <span className="tcc-dot" data-tone={s.tone} aria-hidden="true" />
                    <span className="tcc-brief__campname"><b>{c.name}</b><em>{s.word(c, tz)}</em></span>
                    {c.counts.eligible ? <span className="tcc-brief__campn"><b>{Number(c.counts.sent ?? 0).toLocaleString('en-US')}</b>/{Number(c.counts.eligible).toLocaleString('en-US')}</span> : null}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {isToday && model.endOfDay.length ? (
        <section className="tcc-brief__sec">
          <h3 className="lc-eyebrow">End of day</h3>
          {model.endOfDay.map((l) => <Line key={l.key} line={l} onGo={go(l)} />)}
        </section>
      ) : null}

      <section className={cx('tcc-brief__sec', 'is-tomorrow')}>
        <button type="button" className="tcc-brief__tomorrow" onClick={() => onDay(addDays(day, 1))}>
          <span className="lc-eyebrow">{isToday ? 'Tomorrow' : 'Next day'}</span>
          <span>{model.tomorrow.length ? model.tomorrow.map((l) => l.text).join(' · ') : 'Nothing scheduled yet'}</span>
          <Icon name="chevron-right" size={12} />
        </button>
      </section>
    </aside>
  )
})
