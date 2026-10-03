import { useContext, useMemo } from 'react'
import { LCButton, LCStatus } from '../../../../../shared/lc'
import { useOperatorName } from '../../../../../shared/useOperatorName'
import { greetingFor } from '../../../home-signals'
import { resolveSystemState, type HomeSignals } from '../../../useHomeSignals'
import { buildBrief, headline } from '../../../../../modules/brief/brief-model'
import { useBriefFacts } from '../../../../../modules/brief/brief-sources'
import { BriefLines } from '../../../../../modules/brief/BriefLines'
import { openBrief, useBriefSeen } from '../../../../../modules/brief/brief-store'
import { GoalBar, GoalReadout } from '../../../../analytics/goals/GoalParts'
import { attentionRank, goalState, goalTerms, goalTitle } from '../../../../analytics/goals/goals-model'
import { useGoals } from '../../../../analytics/goals/goals-store'
import { SOURCES } from '../board-data'
import type { WidgetRenderProps } from '../widget-registry'
import { cx, openPath, useNow, useWidgetSource, WidgetRuntimeContext } from '../widget-runtime'
import { WEmpty, WFigure } from '../widget-ui'
import '../../../../../modules/brief/brief.css'
import '../../../../analytics/goals/goals.css'
import './goals-brief-widgets.css'

/**
 * HOME · INTELLIGENCE BRIEF + GOALS widgets.
 *
 *   home.brief      (upgrade, same id) the greeting and system state, then
 *                   the top statements of the Intelligence Brief — each one
 *                   citing the object or app it came from; "Open brief" opens
 *                   the full plane
 *   analytics.goals the operator's goals: period-to-date vs target from the
 *                   Analytics engine, behind-pace first
 *
 * Both read only shared sources (Home's source cache, the story store, the
 * goals store) — nothing here computes a value.
 */

const LINES: Record<string, number> = { compact: 0, small: 1, medium: 3, wide: 3, large: 6, tall: 6, feature: 6 }

export function IntelligenceBriefWidget({ size }: WidgetRenderProps) {
  const rt = useContext(WidgetRuntimeContext)
  const name = useOperatorName()
  const nowMs = useNow(60_000)
  const queue = useWidgetSource(SOURCES.queue)
  const facts = useBriefFacts(rt.active, nowMs)
  const brief = useMemo(() => buildBrief(facts), [facts])
  const lastSeen = useBriefSeen()
  const system = resolveSystemState({ queue: queue.load } as unknown as HomeSignals)
  const now = new Date(nowMs)
  const first = name?.trim().split(/\s+/)[0] || null
  const n = LINES[size] ?? 3
  const shown = brief.lines.slice(0, n)
  const wideRow = size === 'wide' || size === 'feature'
  return (
    <div className={cx('hb-brief hb-ibrief', `is-${size}`)} data-tone={system.tone}>
      <p className="hb-brief__status">
        <span className={cx('hb-orb', `is-${system.tone}`)} aria-hidden="true" />
        <span>{system.label}</span>
        <span className="hb-sep" aria-hidden="true" />
        <time dateTime={now.toISOString()}>{now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</time>
      </p>
      <h2 className="hb-brief__greeting">{greetingFor(now)}{first ? `, ${first}` : ''}.</h2>
      <p className="hb-brief__line">{headline(brief)}</p>
      {shown.length ? <div className={cx('hb-ibrief__lines', wideRow && 'is-row')}><BriefLines lines={shown} lastSeen={lastSeen} dense={size !== 'feature' && size !== 'large' && size !== 'tall'} /></div> : null}
      {size !== 'compact' ? (
        <div className="hb-ibrief__foot">
          <LCButton variant="quiet" size="sm" icon="briefing" onClick={openBrief}>{brief.lines.length > shown.length ? `Open brief · ${brief.lines.length}` : 'Open brief'}</LCButton>
          {brief.unavailable.length ? <span className="hb-brief__note">Not included: {brief.unavailable.map((u) => u.section.replace('_', ' ')).join(', ')}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

export function GoalsWidget({ size }: WidgetRenderProps) {
  const rt = useContext(WidgetRuntimeContext)
  const s = useGoals(rt.active)
  const active = s.goals.filter((g) => g.status === 'active')
  const ordered = active.slice().sort((a, b) => attentionRank(s.progress.byId[a.goal_id]) - attentionRank(s.progress.byId[b.goal_id]))
  const measured = active.filter((g) => s.progress.byId[g.goal_id]?.status === 'ok')
  const onPace = measured.filter((g) => attentionRank(s.progress.byId[g.goal_id]) >= 4).length
  const behind = measured.filter((g) => attentionRank(s.progress.byId[g.goal_id]) === 0).length
  if (!s.ready) return <WEmpty icon="clock">Opening your goals…</WEmpty>
  if (!active.length) {
    return (
      <div className="hb-goals is-empty">
        <WEmpty icon="activity">No goals set. Set targets on Analytics metrics.</WEmpty>
        {size !== 'compact' ? <LCButton variant="quiet" size="sm" icon="plus" onClick={() => openPath('/analytics?lens=goals&goal=new')}>New goal</LCButton> : null}
      </div>
    )
  }
  if (size === 'compact' || size === 'small') {
    const top = ordered[0]
    const p = s.progress.byId[top.goal_id]
    return (
      <div className={cx('hb-goals', `is-${size}`)}>
        <WFigure value={`${onPace}/${active.length}`} label="on pace or met" tone={behind > 0 ? 'attn' : measured.length ? 'ok' : null} sub={behind > 0 ? `${behind} behind` : null} onClick={() => openPath('/analytics?lens=goals')} />
        {size === 'small' ? (
          <button type="button" className="hb-goals__one" onClick={() => openPath('/analytics?lens=goals')}>
            <span>{goalTitle(top, s.catalogue)}</span>
            <GoalBar p={p} label={goalState(p).label} />
          </button>
        ) : null}
      </div>
    )
  }
  const max = size === 'medium' ? 3 : size === 'wide' ? 4 : 8
  return (
    <div className={cx('hb-goals', `is-${size}`)}>
      <div className="hb-goals__head">
        <b>{active.length}</b><span>goal{active.length === 1 ? '' : 's'}</span>
        {behind > 0 ? <LCStatus label={`${behind} behind`} tone="attn" quiet /> : measured.length ? <LCStatus label="On pace" tone="ok" quiet /> : null}
        {s.persistence === 'local' ? <small title={s.note ?? undefined}>on this device</small> : null}
      </div>
      <ul className={cx('hb-goals__list', size === 'wide' && 'is-cols')}>
        {ordered.slice(0, max).map((g) => {
          const p = s.progress.byId[g.goal_id]
          return (
            <li key={g.goal_id}>
              <button type="button" className="hb-goals__row" onClick={() => openPath('/analytics?lens=goals')} title={goalTerms(g, s.catalogue)}>
                <span className="hb-goals__name">{goalTitle(g, s.catalogue)}<small>{goalTerms(g, s.catalogue)}</small></span>
                <GoalReadout p={p} catalogue={s.catalogue} metricId={g.metric_id} compact />
                <GoalBar p={p} label={goalState(p).label} />
              </button>
            </li>
          )
        })}
      </ul>
      {active.length > max ? <p className="hb-muted">+{active.length - max} more in Analytics</p> : null}
    </div>
  )
}
