import { useMemo } from 'react'
import { Icon } from '../../../shared/icons'
import { openInboxThread } from '../../../modules/mobile/mobile-inbox-bridge'
import type { CampaignSummary } from '../campaigns.types'
import { describeIntent } from '../campaign-responses'
import type { CockpitRead } from './cockpit-api'
import {
  ago, degradedFacts, nf, nextLine, nowFacts, sourceOf, spineOf, whenIn,
  type Attention, type ExecState, type SpineNode,
} from './cockpit-model'
import { Section, Skeleton, StateChip, Unavailable, cls } from './cockpit-ui'
import { CockpitTargets, type TargetFilter } from './CockpitTargets'
import type { CockpitTargetRow } from './cockpit-api'

export type RoomMode = 'overview' | 'targets' | 'activity'

export type HeaderAction = { id: string; label: string; tone?: 'danger' | 'go' | 'neutral' }

const MODES: Array<{ key: RoomMode; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'targets', label: 'Targets' },
  { key: 'activity', label: 'Activity' },
]

const USE_CASE_WORDS: Record<string, string> = {
  ownership_check: 'Ownership check',
}

export function useCaseWords(code: string | null | undefined): string | null {
  const key = String(code ?? '').trim()
  if (!key) return null
  return USE_CASE_WORDS[key] ?? key.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase())
}

// ── header ──────────────────────────────────────────────────────────────────

function RoomHeader({
  c, k, state, primary, more, busy, onAction, moreOpen, setMoreOpen, inspOpen, onToggleInspector, onOpenNav, showNavToggle,
}: {
  c: CampaignSummary
  k: CockpitRead | null
  state: ExecState
  primary: HeaderAction | null
  more: HeaderAction[]
  busy: string | null
  onAction: (id: string) => void
  moreOpen: boolean
  setMoreOpen: (v: boolean) => void
  inspOpen: boolean
  onToggleInspector: () => void
  onOpenNav: () => void
  showNavToggle: boolean
}) {
  const source = sourceOf(c, k)
  const lineage = k?.lineage ?? c.lineage ?? null
  const stage = lineage?.stage_code
  const useCase = useCaseWords(lineage?.template_use_case)
  return (
    <header className="cpk-head">
      {showNavToggle ? (
        <button type="button" className="cpk-icon-btn cpk-head__nav" onClick={onOpenNav} aria-label="Show campaigns">
          <Icon name="list" size={15} />
        </button>
      ) : null}
      <div className="cpk-head__id">
        <div className="cpk-head__line">
          <h2 className="cpk-head__title" title={c.campaign_name}>{c.campaign_name || 'Untitled campaign'}</h2>
          <StateChip state={state} />
        </div>
        <p className="cpk-head__meta">
          <span className="cpk-tag is-channel">SMS</span>
          <span>{source.label}{source.detail ? ` · ${source.detail}` : ''}</span>
          {stage || useCase ? (
            <span className="cpk-head__seq" title="The campaign's first touch. No Workflow Studio workflow is attached to this campaign.">
              <i aria-hidden="true" />
              {[stage, useCase].filter(Boolean).join(' · ')}
            </span>
          ) : null}
          {lineage?.timezone ? <span>{lineage.timezone.replace('America/', '').replace('_', ' ')} time</span> : null}
        </p>
      </div>
      <div className="cpk-head__actions">
        {primary ? (
          <button
            type="button"
            className={cls('cpk-btn', primary.tone === 'go' ? 'is-primary' : 'is-solid', busy === primary.id && 'is-busy')}
            onClick={() => onAction(primary.id)}
            disabled={busy !== null}
          >
            {busy === primary.id ? <span className="cpk-spin" aria-hidden="true" /> : null}
            {primary.label}
          </button>
        ) : null}
        <div className="cpk-menu-wrap">
          <button type="button" className="cpk-icon-btn" aria-label="More actions" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)} disabled={busy !== null}>
            <Icon name="more" size={16} />
          </button>
          {moreOpen ? (
            <>
              <button type="button" className="cpk-menu__scrim" aria-label="Close menu" onClick={() => setMoreOpen(false)} />
              <div className="cpk-menu" role="menu">
                {more.map((a) => (
                  <button key={a.id} type="button" role="menuitem" className={cls('cpk-menu__item', a.tone === 'danger' && 'is-danger')} onClick={() => { setMoreOpen(false); onAction(a.id) }}>
                    {a.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <button type="button" className={cls('cpk-icon-btn', inspOpen && 'is-on')} aria-label={inspOpen ? 'Hide inspector' : 'Show inspector'} aria-pressed={inspOpen} onClick={onToggleInspector}>
          <Icon name="layout-split" size={15} />
        </button>
      </div>
    </header>
  )
}

// ── degraded banner ─────────────────────────────────────────────────────────

function DegradedBanner({ k }: { k: CockpitRead }) {
  const facts = degradedFacts(k)
  return (
    <section className="cpk-degraded" role="status" aria-label="Campaign execution degraded">
      <div className="cpk-degraded__title">
        <span className="cpk-degraded__glyph" aria-hidden="true">▲</span>
        Campaign execution degraded
      </div>
      <dl className="cpk-degraded__facts">
        {facts.map((f) => (
          <div key={f.key} className={cls('cpk-dfact', `is-${f.tone}`)}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

// ── spine ───────────────────────────────────────────────────────────────────

function Spine({ nodes }: { nodes: SpineNode[] }) {
  return (
    <ol className="cpk-spine" aria-label="Execution spine">
      {nodes.map((n, i) => (
        <li key={n.key} className={cls('cpk-node', `is-${n.state}`)}>
          {i > 0 ? <span className="cpk-node__link" aria-hidden="true" /> : null}
          <span className="cpk-node__dot" aria-hidden="true" />
          <span className="cpk-node__label">{n.label}</span>
          <span className="cpk-node__value" key={`${n.key}-${n.value ?? 'na'}`}>
            {n.pending ? '…' : n.value === null ? '—' : nf(n.value)}
          </span>
          <span className="cpk-node__of">
            {n.of !== null && n.value !== null ? `of ${nf(n.of)}` : n.unit}
            {n.pct !== null ? <b>{n.pct}%</b> : null}
          </span>
          {n.note ? <span className={cls('cpk-node__note', n.noteTone && `is-${n.noteTone}`)}>{n.note}</span> : null}
          {n.key === 'replied' && n.value === null && !n.pending ? <span className="cpk-node__note is-muted">unavailable</span> : null}
        </li>
      ))}
    </ol>
  )
}

// ── attention ───────────────────────────────────────────────────────────────

function AttentionPlane({ items, onAction, busy }: { items: Attention[]; onAction: (id: string) => void; busy: string | null }) {
  if (!items.length) return null
  return (
    <section className="cpk-attn" aria-label="Needs your attention">
      <div className="cpk-attn__eyebrow">Needs your attention</div>
      {items.map((a) => (
        <article key={a.key} className={cls('cpk-attn__item', `is-${a.severity}`)}>
          <h4 className="cpk-attn__title">{a.title}</h4>
          <p className="cpk-attn__detail">{a.detail}</p>
          <dl className="cpk-attn__facts">
            {a.stopped ? (<div><dt>Stopped?</dt><dd>{a.stopped}</dd></div>) : null}
            <div><dt>What to do</dt><dd>{a.todo}</dd></div>
          </dl>
          {a.actions.length ? (
            <div className="cpk-attn__actions">
              {a.actions.map((act, i) => (
                <button key={act.id} type="button" className={cls('cpk-btn', i === 0 ? 'is-warn' : 'is-ghost')} onClick={() => onAction(act.id)} disabled={busy !== null}>
                  {act.label}
                </button>
              ))}
            </div>
          ) : null}
        </article>
      ))}
    </section>
  )
}

// ── source + geography ──────────────────────────────────────────────────────

function SourceCohort({ c, k, onViewMap, mapState }: {
  c: CampaignSummary
  k: CockpitRead | null
  onViewMap: () => void
  mapState: { busy: boolean; note: string | null }
}) {
  const lineage = k?.lineage ?? c.lineage ?? null
  const source = sourceOf(c, k)
  const n = lineage?.explicit_property_count ?? null
  const pinned = lineage && (lineage.kind === 'map_area' || lineage.kind === 'entity_graph' || lineage.kind === 'selection')
  return (
    <Section title="Source cohort" className="cpk-card cpk-source" meta={source.label}>
      {!lineage ? <Unavailable what="Source" /> : (
        <>
          <dl className="cpk-specs">
            <div className="cpk-spec"><dt className="cpk-spec__label">Type</dt><dd className="cpk-spec__value">{source.label}</dd></div>
            {pinned ? (
              <div className="cpk-spec"><dt className="cpk-spec__label">Exact cohort</dt><dd className="cpk-spec__value">{n !== null ? `${nf(n)} properties, pinned by id` : 'No ids pinned'}</dd></div>
            ) : null}
            {lineage.kind === 'map_area' && lineage.area ? (
              <div className="cpk-spec">
                <dt className="cpk-spec__label">Drawn area</dt>
                <dd className="cpk-spec__value">
                  {lineage.area.vertices ? `${nf(lineage.area.vertices)}-point outline` : 'Outline'}
                  {lineage.area.property_count !== null ? ` · ${nf(lineage.area.property_count)} properties inside` : ''}
                  {lineage.area.truncated ? ' · truncated at draw time' : ''}
                  <span className="cpk-spec__sub">{lineage.area.polygon_stored ? 'Outline stored' : 'Only the bounds and point count were stored — the id list is the exact cohort'}</span>
                </dd>
              </div>
            ) : null}
            {lineage.kind === 'entity_graph' && lineage.handoff_mode ? (
              <div className="cpk-spec"><dt className="cpk-spec__label">Handoff</dt><dd className="cpk-spec__value">{lineage.handoff_mode === 'selection' ? 'A selection made in Entity Graph' : lineage.handoff_mode}</dd></div>
            ) : null}
            {lineage.filters.length ? (
              <div className="cpk-spec">
                <dt className="cpk-spec__label">Conditions</dt>
                <dd className="cpk-spec__value">
                  <ul className="cpk-filters">
                    {lineage.filters.map((f, i) => (
                      <li key={`${f.field_key}-${i}`}>
                        <b>{f.field_key.replace(/^[a-z_]+\./, '').replace(/_/g, ' ')}</b>
                        <span>{f.operator?.replace(/_/g, ' ') ?? ''}</span>
                        <span className="cpk-filters__v">
                          {f.value.kind === 'list' ? `${(f.value.sample ?? []).join(', ')}${(f.value.count ?? 0) > (f.value.sample?.length ?? 0) ? ` +${(f.value.count ?? 0) - (f.value.sample?.length ?? 0)}` : ''}`
                            : f.value.kind === 'boolean' ? (f.value.value ? 'yes' : 'no')
                              : f.value.kind === 'empty' ? '—' : String(f.value.value ?? '')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            ) : null}
            {lineage.kind === 'none' ? <p className="cpk-muted">No audience definition is stored on this campaign.</p> : null}
          </dl>
          <div className="cpk-source__actions">
            <button type="button" className="cpk-btn is-ghost" onClick={onViewMap} disabled={mapState.busy || lineage.kind === 'none' || (!pinned && !c.total_targets)}>
              {mapState.busy ? <span className="cpk-spin" aria-hidden="true" /> : <Icon name="map" size={13} />}
              {lineage.kind === 'map_area' ? 'View exact area on map' : pinned ? 'View cohort on map' : 'View audience on map'}
            </button>
            {mapState.note ? <span className="cpk-source__note">{mapState.note}</span> : null}
          </div>
        </>
      )}
    </Section>
  )
}

function Geography({ k, loading }: { k: CockpitRead | null; loading: boolean }) {
  const g = k?.geography ?? null
  const max = g?.markets.reduce((m, x) => Math.max(m, x.targets), 0) ?? 0
  return (
    <Section title="Geography" className="cpk-card cpk-geo" meta={g ? `${nf(g.market_count)} ${g.market_count === 1 ? 'market' : 'markets'}` : null}>
      {!k ? (loading ? <Skeleton lines={3} /> : <Unavailable what="Geography" />) : !g ? <Unavailable what="Geography" /> : !g.total ? (
        <p className="cpk-muted">No audience built yet.</p>
      ) : (
        <ul className="cpk-geo__list">
          {g.markets.slice(0, 6).map((m) => (
            <li key={`${m.market}-${m.state}`}>
              <span className="cpk-geo__name">{m.market ?? 'No market'}{m.state && !(m.market ?? '').endsWith(m.state) ? ` · ${m.state}` : ''}</span>
              <span className="cpk-geo__bar"><i style={{ width: `${max ? Math.max(4, Math.round((m.targets / max) * 100)) : 0}%` }} /></span>
              <b>{nf(m.targets)}</b>
            </li>
          ))}
          {g.market_count > 6 ? <li className="cpk-muted">+{nf(g.market_count - 6)} more markets</li> : null}
          {g.truncated ? <li className="cpk-muted">Counted from the first {nf(g.total)} targets.</li> : null}
        </ul>
      )}
    </Section>
  )
}

// ── timeline ────────────────────────────────────────────────────────────────

const EVENT_WORDS: Record<string, string> = {
  'campaign.created': 'Draft saved',
  'campaign.updated': 'Settings changed',
  'campaign.targets_built': 'Audience built',
  'campaign.targets_build_refused': 'Audience build refused',
  'campaign.targets_build_skipped': 'Audience build skipped',
  'campaign.activated': 'Went live',
  'campaign.converted_to_live': 'Switched to live',
  'campaign.launch_blocked': 'Launch blocked',
  'campaign.quarantined_target_integrity': 'Put on hold — targeting',
  'campaign.queue_plan_refused_target_integrity': 'Queue plan refused — targeting',
  'campaign.cloned': 'Duplicated',
  'campaign.paused': 'Paused',
  'campaign.resumed': 'Resumed',
  'campaign.completed': 'Completed',
}

type TimelineItem = { id: string; at: string; title: string; detail: string | null; tone: string }

export function timelineOf(k: CockpitRead): TimelineItem[] {
  const items: TimelineItem[] = k.timeline.events.map((e) => {
    const refill = e.type === 'campaign.launch_scheduled'
    return {
      id: e.id,
      at: e.at,
      title: refill ? `Feeder queued ${nf(e.rows_created ?? 0)} ${e.rows_created === 1 ? 'message' : 'messages'}` : (EVENT_WORDS[e.type] ?? e.title ?? e.type),
      detail: refill ? null : (e.description ?? (e.blockers.length ? e.blockers.join(', ') : null)),
      tone: e.severity === 'error' ? 'bad' : e.severity === 'warning' ? 'warn' : refill ? 'exec' : e.severity === 'success' ? 'ok' : 'muted',
    }
  })
  if (k.sends.first_sent_at) items.push({ id: 'first-send', at: k.sends.first_sent_at, title: 'First message sent', detail: null, tone: 'exec' })
  if (k.sends.last_sent_at && k.sends.last_sent_at !== k.sends.first_sent_at) items.push({ id: 'last-send', at: k.sends.last_sent_at, title: 'Last message sent', detail: null, tone: 'exec' })
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

function Timeline({ k, limit, onAll }: { k: CockpitRead; limit?: number; onAll?: () => void }) {
  const items = timelineOf(k)
  const shown = limit ? items.slice(0, limit) : items
  const tz = k.window.timezone
  const idle = k.timeline.idle_feeder_checks
  return (
    <Section
      title="Timeline"
      className="cpk-card cpk-tl"
      meta={k.unavailable.includes('timeline') ? 'partly unavailable' : `${nf(items.length)} operational events`}
      action={onAll && items.length > (limit ?? 0) ? <button type="button" className="cpk-link" onClick={onAll}>All activity</button> : null}
    >
      {!items.length ? <p className="cpk-muted">No operational events recorded.</p> : (
        <ol className="cpk-tl__list">
          {shown.map((it) => (
            <li key={it.id} className={cls('cpk-tl__item', `is-${it.tone}`)}>
              <span className="cpk-tl__dot" aria-hidden="true" />
              <span className="cpk-tl__title">{it.title}</span>
              <time className="cpk-tl__at" dateTime={it.at}>{whenIn(it.at, tz)}</time>
              {it.detail ? <span className="cpk-tl__detail">{it.detail}</span> : null}
            </li>
          ))}
        </ol>
      )}
      {idle && idle.count > 0 ? (
        <p className="cpk-tl__idle">The feeder also checked {nf(idle.count)} times without adding anything{idle.last_at ? ` (last ${ago(idle.last_at)})` : ''}.</p>
      ) : null}
    </Section>
  )
}

function Replies({ k }: { k: CockpitRead }) {
  const r = k.responses
  const tz = k.window.timezone
  return (
    <Section title="Latest replies" className="cpk-card cpk-replies" meta={r ? `${nf(r.sellers_replied)} of ${nf(r.sellers_messaged)} sellers replied` : null}>
      {!r ? <Unavailable what="Replies" /> : !r.latest.length ? <p className="cpk-muted">No seller has replied yet.</p> : (
        <ul className="cpk-replies__list">
          {r.latest.map((m) => {
            const intent = describeIntent(m.intent)
            return (
              <li key={`${m.seller_phone}-${m.at}`}>
                <button type="button" className="cpk-reply" disabled={!m.thread_key} onClick={() => m.thread_key && openInboxThread({ threadKey: m.thread_key })}>
                  <span className="cpk-reply__who">{m.seller_name ?? m.seller_phone}</span>
                  <span className={cls('cpk-reply__intent', `is-${intent.tone}`)}>{intent.label}</span>
                  <time className="cpk-reply__at">{whenIn(m.at, tz)}</time>
                  {m.message ? <span className="cpk-reply__msg">“{m.message}”</span> : null}
                  {m.thread_key ? <span className="cpk-reply__open">Open conversation <Icon name="chevron-right" size={12} /></span> : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <p className="cpk-muted cpk-replies__foot">Inbox has no campaign filter yet — each reply opens its own conversation.</p>
    </Section>
  )
}

// ── the room ────────────────────────────────────────────────────────────────

export function CockpitRoom(props: {
  c: CampaignSummary
  k: CockpitRead | null
  kLoading: boolean
  kError: string | null
  state: ExecState
  attention: Attention[]
  mode: RoomMode
  onMode: (m: RoomMode) => void
  primary: HeaderAction | null
  more: HeaderAction[]
  busy: string | null
  onHeaderAction: (id: string) => void
  onAttentionAction: (id: string) => void
  moreOpen: boolean
  setMoreOpen: (v: boolean) => void
  inspOpen: boolean
  onToggleInspector: () => void
  onOpenNav: () => void
  showNavToggle: boolean
  onViewMap: () => void
  mapState: { busy: boolean; note: string | null }
  targetFilter: TargetFilter
  onTargetFilter: (f: TargetFilter) => void
  selectedTargetId: string | null
  onSelectTarget: (row: CockpitTargetRow) => void
}) {
  const { c, k, kLoading, kError, state, attention, mode } = props
  const spine = useMemo(() => spineOf(c, k, kLoading), [c, k, kLoading])
  const next = nextLine(c, k)
  const live = ['active', 'activating', 'live_limited'].includes(String(c.status))
  const facts = k && live && state.key !== 'degraded' ? nowFacts(k) : null

  return (
    <main className="cpk-room" aria-label={c.campaign_name}>
      <RoomHeader
        c={c} k={k} state={state} primary={props.primary} more={props.more} busy={props.busy}
        onAction={props.onHeaderAction} moreOpen={props.moreOpen} setMoreOpen={props.setMoreOpen}
        inspOpen={props.inspOpen} onToggleInspector={props.onToggleInspector}
        onOpenNav={props.onOpenNav} showNavToggle={props.showNavToggle}
      />

      {k && state.key === 'degraded' ? <DegradedBanner k={k} /> : null}

      <div className="cpk-modes" role="tablist" aria-label="View">
        {MODES.map((m) => (
          <button key={m.key} type="button" role="tab" aria-selected={mode === m.key} className={cls('cpk-mode', mode === m.key && 'is-on')} onClick={() => props.onMode(m.key)}>
            {m.label}
            {m.key === 'targets' ? <b>{nf(k?.targets?.total ?? c.total_targets)}</b> : null}
          </button>
        ))}
        {kLoading ? <span className="cpk-modes__sync" aria-live="polite"><span className="cpk-spin" aria-hidden="true" /> Reading live state…</span> : null}
        {!kLoading && kError ? <span className="cpk-modes__sync is-bad">Live state unavailable — showing the campaign list’s numbers.</span> : null}
        {k && k.unavailable.length ? <span className="cpk-modes__sync is-warn">Unavailable: {k.unavailable.join(', ')}</span> : null}
      </div>

      <div className="cpk-room__scroll">
        {mode === 'overview' ? (
          <div className="cpk-overview">
            {c.total_targets > 0 || (k?.targets?.total ?? 0) > 0 ? <Spine nodes={spine} /> : null}

            {next || facts ? (
              <section className="cpk-now" aria-label="Now">
                {facts ? (
                  <dl className="cpk-now__facts">
                    {facts.map((f) => (
                      <div key={f.key} className={cls('cpk-now__fact', f.tone && `is-${f.tone}`)}>
                        <dt>{f.label}</dt>
                        <dd>{f.value}</dd>
                        {f.sub ? <dd className="cpk-now__sub">{f.sub}</dd> : null}
                      </div>
                    ))}
                  </dl>
                ) : null}
                {next ? (
                  <p className="cpk-next"><span className="cpk-next__label">Next</span>{next}</p>
                ) : null}
              </section>
            ) : live && kLoading ? <Skeleton lines={2} /> : null}

            <AttentionPlane items={attention} onAction={props.onAttentionAction} busy={props.busy} />

            <div className="cpk-grid">
              <SourceCohort c={c} k={k} onViewMap={props.onViewMap} mapState={props.mapState} />
              <Geography k={k} loading={kLoading} />
            </div>

            {k ? <Timeline k={k} limit={8} onAll={() => props.onMode('activity')} /> : kLoading ? <Skeleton lines={4} /> : null}
          </div>
        ) : null}

        {mode === 'targets' ? (
          <CockpitTargets
            campaign={c}
            k={k}
            filter={props.targetFilter}
            onFilter={props.onTargetFilter}
            selectedId={props.selectedTargetId}
            onSelect={props.onSelectTarget}
          />
        ) : null}

        {mode === 'activity' ? (
          k ? (
            <div className="cpk-activity">
              <Timeline k={k} />
              <Replies k={k} />
            </div>
          ) : kLoading ? <Skeleton lines={6} /> : <Unavailable what="Activity" />
        ) : null}
      </div>
    </main>
  )
}
