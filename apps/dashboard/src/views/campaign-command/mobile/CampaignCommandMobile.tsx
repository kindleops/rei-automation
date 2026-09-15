import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import {
  getCampaignMarketInventory,
  getQueueControlSettings,
  type CampaignMarketInventoryResponse,
} from '../../../lib/api/backendClient'
import type { CampaignModel, CampaignSummary } from '../campaigns.types'
import type { CampaignListFilter } from '../campaign-health'

/**
 * Campaign Command — mobile, 393pt.
 *
 * An acquisition operations surface, not a consumer list. The previous attempt
 * failed by removing density: one giant unscoped number, sparse rows, and no
 * KPI / market / routing intelligence, so the screen looked calm but could not
 * be operated from.
 *
 * SCOPE IS THE SPINE. These are different universes and are never mixed:
 *   169,797  seller universe            (whole target graph)
 *   139,462  contact resolved
 *   117,785  SMS-eligible
 *   112,695  globally READY
 *      ~1.0k targeted inside campaigns
 *          READY inside ACTIVE campaigns   <- the KPI, labelled READY·ACTIVE
 * Showing "906" with no universe attached is what made the last version wrong.
 *
 * Zones C (KPI rail), D (inventory ladder) and E (markets) render as ONE
 * continuous command surface — a single panel with internal rules — rather than
 * three stacked cards.
 */

export type Tone = 'running' | 'scheduled' | 'paused' | 'test' | 'built' | 'previewed' | 'failed' | 'draft' | 'done'

export const TONE_LABEL: Record<Tone, string> = {
  running: 'RUNNING',
  scheduled: 'SCHEDULED',
  paused: 'PAUSED',
  test: 'TEST',
  built: 'BUILT',
  previewed: 'PREVIEWED',
  failed: 'FAILED',
  draft: 'DRAFT',
  done: 'COMPLETE',
}

/**
 * The row badge, from the canonical lifecycle status.
 *
 * `built`, `previewed` and `failed` used to fall through the bottom of this
 * function and render as DRAFT. That is a materially different claim: a built
 * campaign HAS resolved its targets, and "Entity Graph · 5 properties" — status
 * `built`, 2 resolved targets — announced itself as DRAFT, i.e. as though no
 * work had happened at all. `failed` reading as DRAFT is worse: it hides a
 * failure behind the most benign state there is.
 *
 * Test mode still wins over everything, because "no SMS will transmit" is the
 * most important thing about a campaign that has it.
 */
export function toneOf(c: CampaignSummary): Tone {
  const s = String(c.status ?? '').toLowerCase()
  if (c.operator_state === 'test_mode') return 'test'
  if (s === 'active' || s === 'activating' || s === 'live_limited') return 'running'
  if (s === 'scheduled' || s === 'queued') return 'scheduled'
  if (s === 'paused') return 'paused'
  if (s === 'completed' || s === 'archived') return 'done'
  if (s === 'failed') return 'failed'
  if (s === 'built') return 'built'
  if (s === 'previewed' || s === 'ready') return 'previewed'
  return 'draft'
}

const nf = (n: number | null | undefined) => Number(n ?? 0).toLocaleString()

/**
 * Three materially different states, which the row used to collapse into one.
 *
 * `total_targets === 0` was read as "no targeting", but 20 of the 23
 * zero-target campaigns on 2026-09-15 carried a real target definition —
 * including "Entity Graph · 5 properties" with five explicit property ids. An
 * operator told "no targeting" reconfigures targeting they already have; what
 * they actually need is a build.
 */
/**
 * Book-wide rollup, extracted so the numbers on the strip are testable without
 * rendering. See the READY comment below for why terminal campaigns are split
 * out rather than summed in.
 */
export function rollupCampaigns(all: CampaignSummary[]) {
  let running = 0, runningTest = 0, scheduled = 0, attention = 0, replies = 0
  let readyLive = 0, readyTerminal = 0
  for (const c of all) {
    const status = String(c.status ?? '').toLowerCase()
    const isActive = status === 'active' || status === 'activating' || status === 'live_limited'
    const isScheduled = status === 'scheduled' || status === 'queued'
    const isTerminal = status === 'archived' || status === 'completed'
    if (isActive) {
      running += 1
      if (c.operator_state === 'test_mode') runningTest += 1
    }
    if (isScheduled) scheduled += 1
    if (attentionOf(c)) attention += 1
    replies += c.reply_count ?? 0
    if (isTerminal) readyTerminal += c.ready_targets
    else readyLive += c.ready_targets
  }
  return { running, runningTest, scheduled, attention, replies, readyLive, readyTerminal }
}

export function targetingPhrase(c: CampaignSummary): string {
  if (c.total_targets > 0) return `${nf(c.total_targets)} target${c.total_targets === 1 ? '' : 's'}`
  if (c.has_target_definition) return 'targeting set · not built'
  return 'no targeting configured'
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/**
 * ATTENTION = needs an operator to act NOW.
 *
 * Explicitly NOT attention: being paused, being a draft, being in test mode, or
 * the global send containment. Those are deliberate operating postures, and
 * counting them turned the metric into a headcount of normal states.
 */
function attentionOf(c: CampaignSummary): string | null {
  const tone = toneOf(c)
  if (tone === 'draft' || tone === 'done') return null

  if (c.launch_readiness === 'blocked') {
    const first = c.launch_blockers?.[0]
    return first ? String(first) : 'Blocked'
  }
  if (tone === 'running' && c.total_targets > 0 && c.ready_targets === 0) return 'Out of ready inventory'
  if (tone === 'running' && c.sent_count === 0) return 'Live but nothing sent'
  if (c.opt_out_rate > 5) return `${c.opt_out_rate.toFixed(1)}% opt-out`
  if (c.sent_count > 0 && c.failed_count / c.sent_count > 0.05) {
    return `${((c.failed_count / c.sent_count) * 100).toFixed(1)}% failing`
  }
  return null
}

/** Canonical queue posture in operator language. Never invented. */
function sendingLabel(raw: string | null | undefined): string {
  const v = String(raw ?? '').trim().toLowerCase()
  if (v === 'normal') return 'SENDING LIVE'
  if (v === 'scoped_canary_only') return 'CANARY ONLY'
  if (v === 'stopped' || v === 'paused' || v === 'pause') return 'SENDING STOPPED'
  if (!v) return 'SENDING UNKNOWN'
  return `SENDING ${v.replace(/_/g, ' ').toUpperCase()}`
}

function automationLabel(raw: string | null | undefined): string | null {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return null
  if (v === 'live_limited') return 'AUTO-REPLY LIMITED'
  if (v === 'internal_only') return 'AUTO-REPLY INTERNAL'
  if (v === 'disabled' || v === 'off') return 'AUTO-REPLY OFF'
  if (v === 'live' || v === 'enabled') return 'AUTO-REPLY LIVE'
  return `AUTO-REPLY ${v.replace(/_/g, ' ').toUpperCase()}`
}

function paceOf(c: CampaignSummary): string {
  const interval = Number(c.send_interval_seconds || 0)
  return interval > 0 ? `${Math.max(1, Math.round(3600 / interval))}/hr` : '—'
}

/** What happens next, in a person's words. Never a bare status echo. */
function nextOf(c: CampaignSummary, tone: Tone): string {
  if (tone === 'running') return c.sent_count > 0 ? 'Sending' : 'Starting'
  if (tone === 'scheduled') {
    const at = c.next_send_at ? new Date(c.next_send_at) : null
    if (at && Number.isFinite(at.getTime()) && at.getTime() > Date.now()) {
      const mins = Math.round((at.getTime() - Date.now()) / 60000)
      if (mins < 60) return `Starts in ${mins}m`
      if (mins < 1440) return `Starts in ${Math.round(mins / 60)}h`
      return `Starts ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    }
    return 'Awaiting start'
  }
  if (tone === 'paused') return c.ready_targets > 0 ? 'Resume to send' : 'Nothing to resume'
  if (tone === 'test') return 'No SMS transmits'
  if (tone === 'done') return 'Finished'
  return c.total_targets === 0 ? 'Needs targeting' : 'Ready to schedule'
}

export function CampaignCommandMobile({
  model,
  campaigns,
  loading,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  onSelect,
  onNew,
}: {
  model: CampaignModel | null
  campaigns: CampaignSummary[]
  loading: boolean
  search: string
  onSearchChange: (value: string) => void
  statusFilter: CampaignListFilter
  onStatusFilterChange: (value: CampaignListFilter) => void
  onSelect: (campaign: CampaignSummary) => void
  onNew: () => void
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [inv, setInv] = useState<CampaignMarketInventoryResponse | null>(null)
  const [sendMode, setSendMode] = useState<string | null>(null)
  const [autoMode, setAutoMode] = useState<string | null>(null)
  const [ladderOpen, setLadderOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement | null>(null)

  // Global inventory + canonical operating posture. Loaded alongside the list,
  // never blocking it.
  useEffect(() => {
    let dead = false
    void getCampaignMarketInventory(10).then((res) => {
      if (!dead && res.ok && res.data?.ok) setInv(res.data)
    })
    void getQueueControlSettings().then((res) => {
      if (dead || !res.ok) return
      const d = (res.data?.diagnostics ?? {}) as Record<string, unknown>
      setSendMode(d.queue_execution_mode ? String(d.queue_execution_mode) : null)
      setAutoMode(d.auto_reply_mode ? String(d.auto_reply_mode) : null)
    })
    return () => { dead = true }
  }, [])

  useEffect(() => { if (searchOpen) searchRef.current?.focus() }, [searchOpen])

  const all = model?.campaigns ?? []

  /**
   * Book-wide rollup.
   *
   * `running` counts CANONICAL status, not tone. toneOf() returns 'test'
   * before it ever checks `active`, which is right for a row badge — test mode
   * is the more important fact about that campaign — but it made the posture
   * line read "0 RUNNING" while /campaigns reported activeCampaigns: 3. The
   * three were active AND in test mode. Counting status and reporting the test
   * split separately says both true things instead of hiding one.
   */
  const roll = useMemo(() => rollupCampaigns(all), [all])

  const k = model?.kpis
  const filterActive = statusFilter !== 'all' || search.trim().length > 0

  /**
   * READY counts the canonical `ready_targets` of every non-terminal campaign.
   *
   * The old value added `ready_targets` only where tone was 'running', and
   * toneOf() returns 'test' before it checks 'active' — so under the
   * canary-only posture nothing qualified and the strip read "READY·ACTIVE 0"
   * while the very first row showed 303 ready. Measured 2026-09-15:
   * active 453 + paused 20 + draft 3 = 476 actionable, against a book-wide
   * canonical 540 that also counts 64 inside archived campaigns.
   */
  const kpis: Array<{ label: string; value: string; tone?: 'live' | 'warn' | 'good' }> = [
    { label: 'READY', value: compact(roll.readyLive), tone: roll.readyLive > 0 ? 'live' : undefined },
    { label: 'SENT TODAY', value: compact(k?.sentToday ?? 0) },
    { label: 'QUEUED', value: compact(k?.scheduledQueueRows ?? 0) },
    { label: 'REPLIES', value: compact(roll.replies) },
    { label: 'LEADS', value: compact(k?.positiveReplies ?? 0), tone: (k?.positiveReplies ?? 0) > 0 ? 'good' : undefined },
    { label: 'ATTENTION', value: String(roll.attention), tone: roll.attention > 0 ? 'warn' : undefined },
  ]

  return (
    <div className="cmk">
      <header className="cmk__bar">
        <div className="cmk__brand">
          <span className="cmk__brand-a">CAMPAIGNS</span>
          <span className="cmk__brand-slash">/</span>
          <span className="cmk__brand-b">COMMAND</span>
        </div>
        <div className="cmk__bar-actions">
          <button
            type="button"
            className={`cmk__ico${filterActive ? ' is-on' : ''}`}
            aria-label="Search and filter"
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Icon name="search" size={16} />
          </button>
          <button type="button" className="cmk__ico" aria-label="New campaign" onClick={onNew}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M9 3.4v11.2M3.4 9h11.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      {/* Canonical operating posture — read from system_control, not invented. */}
      <div className="cmk__posture">
        <span className={`cmk__posture-mode is-${(sendMode ?? 'unknown').toLowerCase()}`}>
          {sendingLabel(sendMode)}
        </span>
        <span className="cmk__posture-sep" aria-hidden="true">·</span>
        <span>
          {roll.running} RUNNING
          {roll.runningTest > 0 ? ` (${roll.runningTest} TEST)` : ''}
        </span>
        <span className="cmk__posture-sep" aria-hidden="true">·</span>
        <span>{roll.scheduled} SCHEDULED</span>
        {automationLabel(autoMode) && (
          <>
            <span className="cmk__posture-sep" aria-hidden="true">·</span>
            <span>{automationLabel(autoMode)}</span>
          </>
        )}
      </div>

      <div className="cmk__scroll">
        {/* ── One continuous command surface: KPI rail + inventory + markets ── */}
        <section className="cmk__panel" aria-label="Operational intelligence">
          <div className="cmk__kpis">
            {kpis.map((kpi) => {
              const idle = kpi.value === '0'
              return (
                <div key={kpi.label} className={`cmk__kpi${idle ? ' is-idle' : ''}`}>
                  <span className="cmk__kpi-label">{kpi.label}</span>
                  <span className={`cmk__kpi-value${kpi.tone ? ` is-${kpi.tone}` : ''}${idle ? ' is-zero' : ''}`}>
                    {kpi.value}
                  </span>
                </div>
              )
            })}
          </div>

          <button
            type="button"
            className="cmk__ladder"
            onClick={() => setLadderOpen((v) => !v)}
            aria-expanded={ladderOpen}
          >
            <span className="cmk__ladder-key">INVENTORY</span>
            <span className="cmk__ladder-main">
              <strong>{inv ? nf(inv.inventory.ready) : '—'}</strong> ready
              <em>of {inv ? nf(inv.inventory.universe_properties) : '—'} sellers</em>
            </span>
            <Icon name={ladderOpen ? 'chevron-up' : 'chevron-down'} size={13} />
          </button>

          {ladderOpen && inv && (
            <div className="cmk__rungs">
              {[
                ['Seller universe', inv.inventory.universe_properties],
                ['Contact resolved', inv.inventory.contact_resolved],
                ['SMS-eligible', inv.inventory.sms_eligible],
                ['READY globally', inv.inventory.ready],
              ].map(([label, value]) => (
                <div key={String(label)} className="cmk__rung">
                  <span>{label}</span>
                  <strong>{nf(Number(value))}</strong>
                </div>
              ))}
              <div className="cmk__rung is-route">
                <span>Routing</span>
                <strong>
                  {nf(inv.inventory.route_local)} local · {nf(inv.inventory.route_cross_state)} cross-state
                  {inv.inventory.route_none > 0 ? ` · ${nf(inv.inventory.route_none)} no route` : ''}
                </strong>
              </div>
            </div>
          )}

          <div className="cmk__markets">
            <div className="cmk__markets-head">
              <span>MARKETS</span>
              <em>global ready inventory</em>
            </div>
            <div className="cmk__markets-scroll">
              {(inv?.markets ?? []).map((m) => {
                const route = m.unrouted === m.universe
                  ? 'no route'
                  : m.cross_state > m.local_route ? 'cross-state' : 'local'
                return (
                  <div key={m.market} className="cmk__market">
                    <span className="cmk__market-name">{m.market}</span>
                    <span className="cmk__market-ready">{compact(m.ready)}</span>
                    <span className={`cmk__market-route is-${route.replace(/\s/g, '-')}`}>{route}</span>
                  </div>
                )
              })}
              {!inv && <div className="cmk__market is-ghost" aria-hidden="true" />}
            </div>
          </div>
        </section>

        {searchOpen && (
          <div className="cmk__find">
            {/* Search filters the loaded page, which is the whole corpus only
                while the server did not cut it off. 40 campaigns today against
                a 200 ceiling; if that ever flips, say so rather than quietly
                searching a prefix. */}
            {model?.truncated && (
              <div className="cmk__find-note" role="status">
                Showing the {nf(all.length)} most recent of more than {nf(model.listCap ?? all.length)} campaigns —
                search covers only these.
              </div>
            )}
            <div className="cmk__find-field">
              <Icon name="search" size={14} />
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search campaigns"
                aria-label="Search campaigns"
              />
            </div>
            <div className="cmk__find-chips">
              {(['all', 'active', 'scheduled', 'paused', 'draft'] as CampaignListFilter[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`cmk__find-chip${statusFilter === key ? ' is-on' : ''}`}
                  onClick={() => onStatusFilterChange(key)}
                >
                  {key === 'all' ? 'All' : key[0].toUpperCase() + key.slice(1)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Campaign rows ─────────────────────────────────────────────── */}
        <div className="cmk__list" role="list">
          {loading && campaigns.length === 0
            ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="cmk__row is-skeleton" aria-hidden="true" />)
            : campaigns.map((c) => {
                const tone = toneOf(c)
                const flag = attentionOf(c)
                const dormant = tone === 'draft'
                if (dormant) {
                  return (
                    <button key={c.id} type="button" role="listitem" className="cmk__row is-dormant" onClick={() => onSelect(c)}>
                      <span className="cmk__row-name">{c.campaign_name || 'Untitled campaign'}</span>
                      <span className="cmk__row-quiet">
                        {TONE_LABEL[tone]} · {targetingPhrase(c)}
                      </span>
                    </button>
                  )
                }
                return (
                  <button key={c.id} type="button" role="listitem" className={`cmk__row is-${tone}`} onClick={() => onSelect(c)}>
                    <span className="cmk__row-top">
                      {tone === 'running' && <span className="cmk__pulse" aria-hidden="true" />}
                      <span className="cmk__row-name">{c.campaign_name || 'Untitled campaign'}</span>
                      <span className={`cmk__row-state is-${tone}`}>{TONE_LABEL[tone]}</span>
                    </span>

                    <span className="cmk__row-geo">
                      {/* Absent market is unavailable metadata, not a fault, and is
                          never inferred from the campaign name. */}
                      <span className={c.market_label ? 'cmk__geo' : 'cmk__geo is-absent'}>
                        {c.market_label || 'No market set'}
                      </span>
                      <em>· {nf(c.total_targets)} targets</em>
                      {c.auto_send_enabled && <span className="cmk__row-auto">AUTO</span>}
                    </span>

                    <span className="cmk__row-metrics">
                      <span className={`cmk__m is-lead${c.ready_targets === 0 ? ' is-nil' : ''}`}>
                        <strong>{compact(c.ready_targets)}</strong><em>ready</em>
                      </span>
                      <span className={`cmk__m${c.sent_count === 0 ? ' is-nil' : ''}`}>
                        <strong>{compact(c.sent_count)}</strong><em>sent</em>
                      </span>
                      <span className={`cmk__m is-pace${paceOf(c) === '—' ? ' is-nil' : ''}`}>
                        <strong>{paceOf(c)}</strong><em>pace</em>
                      </span>
                      <span className={`cmk__m${c.reply_count === 0 ? ' is-nil' : ''}`}>
                        <strong>{compact(c.reply_count)}</strong><em>replies</em>
                      </span>
                      <span className={`cmk__m${c.positive_reply_count > 0 ? ' is-good' : ' is-nil'}`}>
                        <strong>{compact(c.positive_reply_count)}</strong><em>leads</em>
                      </span>
                    </span>

                    <span className="cmk__row-foot">
                      {flag
                        ? <span className="cmk__row-alert">{flag}</span>
                        : <span className="cmk__row-next">{nextOf(c, tone)}</span>}
                    </span>
                  </button>
                )
              })}

          {!loading && campaigns.length === 0 && (
            <p className="cmk__empty">{filterActive ? 'No campaigns match.' : 'No campaigns yet.'}</p>
          )}
        </div>
      </div>
    </div>
  )
}
