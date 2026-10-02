import { useSyncExternalStore } from 'react'
import { Icon } from '../../../../../shared/icons'
import { LCButton, LCStatus } from '../../../../../shared/lc'
import { ObjectMenu, campaignObject, dealObject, handleObjectClick, objectAttrs, workflowObject } from '../../../../../modules/desktop/objects'
import { openInboxDealIntelligence } from '../../../../../modules/mobile/mobile-inbox-bridge'
import { CAMPAIGN_SUBJECT_EVENT, readCampaignSubject } from '../../../../campaign-command/desktop/war-room-links'
import type { CampaignSummary } from '../../../../campaign-command/campaigns.types'
import { relativeTime, type HomeLoad } from '../../../home-signals'
import { money, moneyModel } from '../../command/home-command-model'
import { SOURCES } from '../board-data'
import { cx, fmt, openPath, pct, useNow, useWidgetSource } from '../widget-runtime'
import { WEmpty, WFacts, WFigure, WState } from '../widget-ui'
import type { PinnedSubject, WidgetRenderProps } from '../widget-registry'

const ready = <T,>(l: HomeLoad<T>): T | null => (l.status === 'ready' ? l.data : null)

/* ── Pipeline ───────────────────────────────────────────────────────── */

const STAGE_HUE = ['#5ac8fa', '#38bdf8', '#34d399', '#818cf8', '#a78bfa', '#c084fc', '#22d3ee', '#fbbf24', '#f59e0b', '#94a3b8']

export function PipelineWidget({ size }: WidgetRenderProps) {
  const { load, reload } = useWidgetSource(SOURCES.pipelineOverview)
  const rich = size === 'large' || size === 'feature' || size === 'wide' || size === 'tall'
  return (
    <WState load={load} what="the pipeline" onRetry={reload} shape={size === 'compact' ? 'metric' : 'chart'}>
      {(o) => {
        const t = o.totals
        const m = moneyModel(o)
        const stages = o.stages.filter((s) => s.index >= 1 && s.index <= 9)
        const max = Math.max(1, ...stages.map((s) => s.count))
        const head = (
          <div className="hb-row">
            <WFigure value={fmt(t.opportunities)} label="live deals" onClick={() => openPath('/pipeline')} size={size === 'compact' ? 'md' : 'lg'} />
            {size !== 'compact' ? <WFigure value={m?.value ? money(m.value) : '—'} label="est. value" sub={m ? `${m.valued} of ${m.opportunities} valued` : null} /> : null}
            <WFigure value={fmt(t.movedToday)} label="moved today" tone={t.movedToday ? 'ok' : null} />
          </div>
        )
        if (size === 'compact') return head
        return (
          <div className={cx('hb-pipe', `is-${size}`)}>
            {head}
            {size !== 'small' ? (
              <div className="hb-flow" role="list" aria-label="Deals by stage, S1 to S9">
                {stages.map((s, i) => (
                  <button key={s.code} type="button" role="listitem" className="hb-flow__s" onClick={() => openPath('/pipeline')} title={`${s.label}: ${s.count} deals${s.attention ? ` · ${s.attention} need attention` : ''}`}>
                    <i style={{ height: `${Math.max(4, (s.count / max) * 100)}%`, background: STAGE_HUE[i % STAGE_HUE.length] }} aria-hidden="true" />
                    <span>{s.short}</span>
                    <b>{s.count}</b>
                  </button>
                ))}
              </div>
            ) : null}
            <WFacts items={[
              { label: 'Need attention', value: fmt(t.attention), tone: t.attention ? 'attn' as const : null },
              { label: 'Stalled', value: fmt(t.stalled), tone: t.stalled ? 'attn' as const : null },
              { label: 'Offers out', value: fmt(t.offersOut) },
              { label: 'Machine-handled', value: fmt(t.automated), tone: 'exec' as const },
            ].slice(0, size === 'small' ? 2 : 4)} />
            {rich ? (
              <div className={cx('hb-pipe__lists', (size === 'wide' || size === 'feature') && 'is-cols')}>
                <section aria-label="Deals that need attention">
                  <p className="hb-eyebrow">Needs attention</p>
                  {o.attentionTop.length ? (
                    <ul className="hb-list">
                      {o.attentionTop.slice(0, 4).map((c) => {
                        const ref = dealObject({ opportunityId: c.id, propertyId: c.propertyId, threadKey: c.threadKey, masterOwnerId: c.masterOwnerId, stage: c.stage, label: c.address || c.seller, source: 'home' })
                        return (
                          <li key={c.id}>
                            <ObjectMenu object={ref}>
                              <button type="button" className="hb-list__row" {...objectAttrs(ref)} onClick={(e) => handleObjectClick(e, ref, () => openInboxDealIntelligence({ propertyId: c.propertyId, threadKey: c.threadKey, masterOwnerId: c.masterOwnerId }))}>
                                <span className={cx('hb-dot', c.hot ? 'is-attn' : 'is-exec')} aria-hidden="true" />
                                <span className="hb-list__main"><strong>{c.address || c.seller || 'Deal'}</strong><small>{[c.stageLabel, c.lane.label].filter(Boolean).join(' · ')}</small></span>
                                <em>{c.money.value ? money(c.money.value) : relativeTime(c.lastActivityAt)}</em>
                              </button>
                            </ObjectMenu>
                          </li>
                        )
                      })}
                    </ul>
                  ) : <WEmpty>No deal needs attention.</WEmpty>}
                </section>
                {size !== 'tall' || o.movement.length ? (
                  <section aria-label="Movement">
                    <p className="hb-eyebrow">Movement</p>
                    {o.movement.length ? (
                      <ul className="hb-list is-quiet">
                        {o.movement.slice(0, 4).map((mv) => (
                          <li key={mv.id}><span className="hb-list__row is-static"><span className={cx('hb-dot', mv.kind === 'advance' ? 'is-ok' : mv.kind === 'regress' || mv.kind === 'exit' ? 'is-attn' : '')} aria-hidden="true" /><span className="hb-list__main"><strong>{mv.title}</strong><small>{mv.address || mv.seller || ''}</small></span><em>{relativeTime(mv.at)}</em></span></li>
                        ))}
                      </ul>
                    ) : <WEmpty icon="clock">No movement yet today.</WEmpty>}
                  </section>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      }}
    </WState>
  )
}

/* ── Campaign ───────────────────────────────────────────────────────── */

/** The campaign Campaign Command has open (linked context) — follows its subject event, never polls. */
const subscribeLinked = (l: () => void) => {
  window.addEventListener(CAMPAIGN_SUBJECT_EVENT, l)
  window.addEventListener('focus', l)
  return () => { window.removeEventListener(CAMPAIGN_SUBJECT_EVENT, l); window.removeEventListener('focus', l) }
}
const readLinked = () => { const s = readCampaignSubject(); return s?.campaignId ? `${s.campaignId}\u0000${s.name ?? ''}` : '' }

function campaignFor(list: CampaignSummary[], subject: PinnedSubject | null) {
  return subject ? list.find((c) => c.id === subject.id) ?? null : null
}

export function CampaignWidget({ size, context }: WidgetRenderProps) {
  const book = useWidgetSource(SOURCES.campaigns)
  const queue = useWidgetSource(context.mode === 'global' ? SOURCES.queue : null)
  const messaging = useWidgetSource(context.mode === 'global' && size !== 'compact' ? SOURCES.messaging : null)
  const linkedRaw = useSyncExternalStore(context.mode === 'linked' ? subscribeLinked : noopSub, readLinked, () => '')
  const linked: PinnedSubject | null = linkedRaw ? { kind: 'campaign', id: linkedRaw.split('\u0000')[0], label: linkedRaw.split('\u0000')[1] || 'Campaign' } : null
  const subject = context.mode === 'pinned' ? context.subject : context.mode === 'linked' ? linked : null
  const newCampaign = <LCButton variant="secondary" size="sm" icon="bolt" onClick={() => openPath('/campaign-command?compose=1')}>New campaign</LCButton>

  return (
    <WState load={book.load} what="campaigns" onRetry={book.reload} shape={size === 'compact' ? 'metric' : 'lines'}>
      {(b) => {
        if (context.mode !== 'global') {
          const c = campaignFor(b.list, subject)
          if (!subject) return <WEmpty icon="clock">Open a campaign in Campaign Command and this follows it.</WEmpty>
          if (!c) return <WEmpty icon="clock">{subject.label} is not in the current campaign list{b.truncated ? ' (the list is capped)' : ''}.</WEmpty>
          const ref = campaignObject({ campaignId: c.id, label: c.campaign_name, source: 'home' })
          const health = c.reply_count && c.delivered_count ? c.reply_count / c.delivered_count : null
          return (
            <div className={cx('hb-camp', `is-${size}`)}>
              <ObjectMenu object={ref}>
                <button type="button" className="hb-camp__name" {...objectAttrs(ref)} onClick={(e) => handleObjectClick(e, ref)}>
                  <strong>{c.campaign_name}</strong>
                  <LCStatus label={c.status.replace(/_/g, ' ')} tone={c.status === 'active' || c.status === 'live_limited' ? 'exec' : c.status === 'failed' ? 'crit' : 'neutral'} quiet />
                </button>
              </ObjectMenu>
              <div className="hb-row">
                <WFigure value={fmt(c.sent_count)} label="sent" />
                {size !== 'compact' ? <WFigure value={fmt(c.delivered_count)} label="delivered" tone="ok" /> : null}
                <WFigure value={fmt(c.reply_count)} label="replies" tone="exec" />
              </div>
              {size !== 'compact' ? (
                <WFacts items={[
                  { label: 'Ready', value: `${fmt(c.ready_targets)} / ${fmt(c.total_targets)}` },
                  { label: 'Failed', value: fmt(c.failed_count), tone: c.failed_count ? 'crit' : null },
                  { label: 'Reply rate', value: pct(health), title: 'Replies ÷ delivered' },
                  { label: 'Market', value: c.market_label || '—' },
                ].slice(0, size === 'small' ? 2 : 4)} />
              ) : null}
            </div>
          )
        }
        const sm = b.summary
        const q = ready(queue.load)
        const msg = ready(messaging.load)
        return (
          <div className={cx('hb-camp', `is-${size}`)}>
            <div className="hb-row">
              <WFigure value={fmt(sm.live)} label="active" tone={sm.live ? 'exec' : null} onClick={() => openPath('/campaign-command')} size={size === 'compact' ? 'md' : 'lg'} />
              {size !== 'compact' ? <WFigure value={fmt(q?.sentToday)} label="sent today" /> : null}
              <WFigure value={fmt(sm.attention.length)} label="blocked" tone={sm.attention.length ? 'attn' : null} />
            </div>
            {size !== 'compact' ? (
              <WFacts items={[
                { label: 'Delivered today', value: fmt(q?.deliveredToday), tone: 'ok' },
                { label: 'Replies today', value: fmt(msg?.replies), tone: 'exec' },
                { label: 'Ready targets', value: fmt(sm.readyTargets), title: 'Capacity: targets ready to send across running campaigns' },
                { label: 'Paused', value: fmt(sm.paused) },
              ].slice(0, size === 'small' ? 2 : 4)} />
            ) : null}
            {(size === 'large' || size === 'tall' || size === 'feature' || size === 'wide') ? (
              <ul className="hb-list">
                {[...sm.attention, ...sm.highlighted.filter((h) => !sm.attention.some((a) => a.id === h.id))].slice(0, 4).map((c) => {
                  const ref = campaignObject({ campaignId: c.id, label: c.name, source: 'home' })
                  return (
                    <li key={c.id}>
                      <ObjectMenu object={ref}>
                        <button type="button" className="hb-list__row" {...objectAttrs(ref)} onClick={(e) => handleObjectClick(e, ref)}>
                          <span className={cx('hb-dot', c.issue ? 'is-attn' : 'is-exec')} aria-hidden="true" />
                          <span className="hb-list__main"><strong>{c.name}</strong><small>{c.issue ?? [c.market, `${fmt(c.sent)} sent`].filter(Boolean).join(' · ')}</small></span>
                          <em>{fmt(c.replies)} replies</em>
                        </button>
                      </ObjectMenu>
                    </li>
                  )
                })}
              </ul>
            ) : null}
            {size !== 'compact' ? <div className="hb-foot">{newCampaign}</div> : null}
          </div>
        )
      }}
    </WState>
  )
}

const noopSub = () => () => {}

/* ── Calendar ───────────────────────────────────────────────────────── */

export function CalendarWidget({ size }: WidgetRenderProps) {
  const { load, reload } = useWidgetSource(SOURCES.calendar)
  const now = useNow()
  return (
    <WState load={load} what="the calendar" onRetry={reload} shape={size === 'compact' ? 'metric' : 'lines'}>
      {(cal) => {
        const today = cal.days[0]
        const upcoming = cal.days.flatMap((d) => d.agenda).filter((a) => a.allDay || Date.parse(a.at) >= now - 15 * 60_000)
        const next = upcoming[0] ?? null
        const head = (
          <div className="hb-row">
            <WFigure value={fmt(today?.agenda.length ?? 0)} label="today" onClick={() => openPath('/calendar')} />
            <WFigure value={fmt(cal.overdue)} label="overdue" tone={cal.overdue ? 'crit' : null} />
            {size !== 'compact' ? <WFigure value={fmt(today?.scheduledSends ?? 0)} label="send windows today" tone="exec" /> : null}
          </div>
        )
        if (size === 'compact') return head
        if (size === 'wide' || size === 'feature') {
          return (
            <div className="hb-cal is-strip">
              {head}
              <ol className="hb-week">
                {cal.days.map((d) => (
                  <li key={d.key} className={cx(d.key === today?.key && 'is-today')}>
                    <span>{d.date.toLocaleDateString([], { weekday: 'short' })}</span>
                    <b>{d.agenda.length}</b>
                    <small>{d.scheduledSends ? `${d.scheduledSends} sends` : ''}</small>
                  </li>
                ))}
              </ol>
            </div>
          )
        }
        return (
          <div className="hb-cal">
            {head}
            {next ? <p className="hb-next"><Icon name="clock" size={12} /> Next: <b>{next.title}</b> {next.allDay ? 'today' : new Date(next.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p> : <WEmpty>Nothing else scheduled this week.</WEmpty>}
            {size !== 'small' && upcoming.length > 1 ? (
              <ul className="hb-list is-quiet">
                {upcoming.slice(1, size === 'medium' ? 4 : 8).map((a) => (
                  <li key={a.id}><span className="hb-list__row is-static"><span className={cx('hb-dot', a.overdue ? 'is-crit' : a.hot ? 'is-attn' : 'is-exec')} aria-hidden="true" /><span className="hb-list__main"><strong>{a.title}</strong><small>{a.who}</small></span><em>{a.allDay ? 'all day' : new Date(a.at).toLocaleDateString([], { weekday: 'short' }) + ' ' + new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</em></span></li>
                ))}
              </ul>
            ) : null}
          </div>
        )
      }}
    </WState>
  )
}

/* ── Closing Desk ───────────────────────────────────────────────────── */

export function ClosingWidget({ size }: WidgetRenderProps) {
  const { load, reload } = useWidgetSource(SOURCES.closings)
  return (
    <WState load={load} what="the Closing Desk" onRetry={reload} shape={size === 'compact' ? 'metric' : 'lines'}>
      {(c) => (
        <div className={cx('hb-close', `is-${size}`)}>
          <div className="hb-row">
            <WFigure value={fmt(c.underContract)} label="under contract" onClick={() => openPath('/closing-desk')} size={size === 'compact' ? 'md' : 'lg'} />
            <WFigure value={fmt(c.actionRequired)} label="need you" tone={(c.actionRequired ?? 0) > 0 ? 'attn' : null} />
            {size !== 'compact' ? <WFigure value={fmt(c.titleBlocked)} label="title blocked" tone={(c.titleBlocked ?? 0) > 0 ? 'crit' : null} /> : null}
          </div>
          {size !== 'compact' ? (
            <>
              <WFacts items={[{ label: 'Closing this week', value: fmt(c.closingsThisWeek) }]} />
              {c.next ? (
                <p className="hb-next"><Icon name="key" size={12} /> Next closing <b>{new Date(c.next.date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</b> · {c.next.name}{c.next.address ? ` · ${c.next.address}` : ''}</p>
              ) : <WEmpty icon="clock">No closing scheduled.</WEmpty>}
            </>
          ) : null}
        </div>
      )}
    </WState>
  )
}

/* ── Workflow ───────────────────────────────────────────────────────── */

export function WorkflowWidget({ size }: WidgetRenderProps) {
  const { load, reload } = useWidgetSource(SOURCES.workflow)
  return (
    <WState load={load} what="workflows" onRetry={reload} shape={size === 'compact' ? 'metric' : 'lines'}>
      {(r) => {
        const t = r.telemetry
        const failed = r.workflows.reduce((n, w) => n + (w.stats.failed_24h ?? 0), 0)
        const list = [...r.workflows].filter((w) => !w.test && w.status !== 'archived').sort((a, b) => (b.stats.needs_you ?? 0) - (a.stats.needs_you ?? 0) || (b.stats.runs_today ?? 0) - (a.stats.runs_today ?? 0))
        return (
          <div className={cx('hb-wf', `is-${size}`)}>
            <div className="hb-row">
              <WFigure value={fmt(t.in_flight)} label="active runs" tone="flow" onClick={() => openPath('/workflow-studio')} />
              <WFigure value={fmt(t.needs_you)} label="held for you" tone={t.needs_you ? 'attn' : null} />
              {size !== 'compact' ? <WFigure value={fmt(failed)} label="failed · 24h" tone={failed ? 'crit' : null} /> : null}
            </div>
            {size !== 'compact' ? <WFacts items={[{ label: 'Runs today', value: fmt(t.runs_today ?? null) }, { label: 'Live automations', value: fmt(t.live_automations), tone: 'flow' }]} /> : null}
            {size === 'compact' || size === 'small' ? null : (
              <ul className="hb-list">
                {list.slice(0, size === 'medium' ? 3 : 6).map((w) => {
                  const ref = workflowObject({ workflowKey: w.workflow_key, label: w.name, source: 'home' })
                  return (
                    <li key={w.workflow_key}>
                      <ObjectMenu object={ref}>
                        <button type="button" className="hb-list__row" {...objectAttrs(ref)} onClick={(e) => handleObjectClick(e, ref)}>
                          <span className={cx('hb-dot', w.status === 'live' ? 'is-flow' : w.status === 'paused' || w.status === 'not_running' ? 'is-attn' : '')} aria-hidden="true" />
                          <span className="hb-list__main"><strong>{w.short_name || w.name}</strong><small>{w.status_note || w.status.replace(/_/g, ' ')}</small></span>
                          <em>{w.stats.needs_you ? `${w.stats.needs_you} held` : w.stats.runs_today != null ? `${fmt(w.stats.runs_today)} today` : ''}</em>
                        </button>
                      </ObjectMenu>
                    </li>
                  )
                })}
              </ul>
            )}
            {r.degraded.length && size !== 'compact' ? <p className="hb-muted">Partial: {r.degraded.join(', ')}</p> : null}
          </div>
        )
      }}
    </WState>
  )
}
