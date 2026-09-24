import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { CampaignCardMobile } from './CampaignCardMobile'
import './campaign-card-mobile.css'
import {
  getQueueControlSettings,
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

export type Tone = 'blocked' | 'running' | 'scheduled' | 'paused' | 'test' | 'built' | 'previewed' | 'failed' | 'draft' | 'done'

export const TONE_LABEL: Record<Tone, string> = {
  blocked: 'BLOCKED',
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
  /**
   * BLOCKED outranks everything, including test mode.
   *
   * Test mode is a SAFE state — "no SMS will transmit". A quarantined campaign
   * is an UNSAFE one: campaign df0671fa holds 984 target rows for a
   * 186-property explicit selection, 878 of them outside it. The launch path
   * happens to refuse it today for an incidental reason ("no ready recipients
   * in target snapshot"), which tells the operator nothing, so the badge has
   * to carry the real reason.
   */
  if (c.quarantined) return 'blocked'
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
 * The primary state selector (§8).
 *
 * These are the CANONICAL `CampaignListFilter` values. The previous chip row
 * passed `'active'`, which is not one of them — `matchesListFilter` has no
 * branch for it and falls through to `return true`, so the "Active" chip
 * quietly showed every campaign in the book. The `as CampaignListFilter[]`
 * cast on that array is what stopped the compiler from saying so.
 */
export const PRIMARY_FILTERS: Array<{ key: CampaignListFilter; label: string }> = [
  { key: 'live', label: 'Active' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'draft', label: 'Drafts' },
  { key: 'completed', label: 'Completed' },
  { key: 'all', label: 'All' },
]

/** Narrower cuts, kept in the search sheet so the primary row stays short. */
export const SECONDARY_FILTERS: Array<{ key: CampaignListFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'needs_attention', label: 'Needs attention' },
  { key: 'paused', label: 'Paused' },
  { key: 'ready', label: 'Ready' },
  { key: 'archived', label: 'Archived' },
]

/**
 * The one line under the title.
 *
 * Says what is true and what needs a person, in that order, and says nothing
 * when neither is interesting — an empty book should not announce "0 active".
 * Sending posture is appended only when it is NOT the normal live state:
 * "sending live" on every screen is wallpaper, "sending paused" is news.
 */
export function summaryLine(
  roll: { running: number; attention: number; scheduled: number },
  sendMode?: string | null,
): string {
  const bits: string[] = []
  if (roll.running > 0) bits.push(`${roll.running} active`)
  if (roll.scheduled > 0) bits.push(`${roll.scheduled} scheduled`)
  if (roll.attention > 0) bits.push(`${roll.attention} ${roll.attention === 1 ? 'needs' : 'need'} attention`)
  const mode = String(sendMode ?? '').toLowerCase()
  if (mode && mode !== 'live' && mode !== 'normal') bits.push('sending paused')
  return bits.join(' · ')
}

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

/**
 * EXPLICIT TARGETS vs DYNAMIC COHORT — §3.
 *
 * The operator must never confuse the two, because they promise different
 * things: a pinned selection can only ever contain the ids that were picked,
 * while a dynamic cohort is re-resolved at build time and can pick up records
 * added later. Nothing in the mobile UI said which a campaign had.
 *
 * The selected count is shown alongside, because it is the number the operator
 * chose — and it is not the same number as the built target count.
 * campaign_targets is contact-grained, so five selected properties resolve to
 * two rows here and 186 resolve to 984. Showing only the built count is how a
 * widened cohort hides.
 */
export function targetModePhrase(c: CampaignSummary): string | null {
  switch (c.target_mode) {
    case 'explicit':
      return c.explicit_target_count != null
        ? `Explicit · ${nf(c.explicit_target_count)} selected`
        : 'Explicit targets'
    case 'explicit_filtered':
      return c.explicit_target_count != null
        ? `Explicit ${nf(c.explicit_target_count)} + filters`
        : 'Explicit targets + filters'
    case 'dynamic':
      return 'Dynamic cohort'
    default:
      return null
  }
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
  /**
   * THE MARKET INVENTORY FEED IS GONE, NOT HIDDEN.
   *
   * `/api/cockpit/campaigns/market-inventory` has no route and never did: the
   * request fell through to `campaigns/[id]` and was correctly rejected as a
   * non-UUID campaign id, so every single load of this screen fired a
   * guaranteed 400. The INVENTORY ladder and MARKETS strip it fed were already
   * withheld on failure, which meant the only thing the call still produced was
   * a failing request and two components that could never render.
   *
   * Removed rather than left "temporarily unavailable" — a capability with no
   * backend is not unavailable, it does not exist. When a canonical inventory
   * source lands, this is the seam to restore.
   */
  const [sendMode, setSendMode] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  // Canonical operating posture. Loaded alongside the list, never blocking it.
  useEffect(() => {
    let dead = false
    void getQueueControlSettings().then((res) => {
      if (dead || !res.ok) return
      const d = (res.data?.diagnostics ?? {}) as Record<string, unknown>
      setSendMode(d.queue_execution_mode ? String(d.queue_execution_mode) : null)
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
  /*
   * THE BOOK-WIDE RAIL, REDUCED TO WHAT IS TRUE TODAY.
   *
   * This rendered six fixed cells, and on a normal day three of them read 0 —
   * QUEUED, REPLIES, LEADS. Six numbers of which half are zero is not density;
   * it teaches the operator to stop reading the rail. A zero is only worth a
   * cell when its being zero is itself the news, which is true of ATTENTION
   * (nothing needs you) and of nothing else here.
   *
   * ATTENTION is always shown for exactly that reason, and always last, so the
   * rail ends on the only cell that can demand action.
   */
  const kpiCandidates: Array<{ label: string; value: number; tone?: 'live' | 'warn' | 'good'; always?: boolean }> = [
    { label: 'Ready', value: roll.readyLive, tone: roll.readyLive > 0 ? 'live' : undefined },
    { label: 'Sent today', value: k?.sentToday ?? 0 },
    { label: 'Queued', value: k?.scheduledQueueRows ?? 0 },
    { label: 'Replies', value: roll.replies },
    { label: 'Qualified', value: k?.positiveReplies ?? 0, tone: (k?.positiveReplies ?? 0) > 0 ? 'good' : undefined },
    { label: 'Attention', value: roll.attention, tone: roll.attention > 0 ? 'warn' : undefined, always: true },
  ]

  const kpis = kpiCandidates
    .filter((kpi) => kpi.always || kpi.value > 0)
    .map((kpi) => ({ label: kpi.label, value: compact(kpi.value), tone: kpi.tone }))

  return (
    <div className="cmk">
      <header className="cmk__bar">
        <div className="cmk__title">
          <h1 className="cmk__h1">Campaign Command</h1>
          {/* One line of context, in words. The previous header shouted four
              all-caps clauses that wrapped to two lines at 390pt and still did
              not say what needed doing. */}
          <p className="cmk__sub">{summaryLine(roll, sendMode)}</p>
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

      {/* Primary state selector. Always visible: every filter used to live
          behind the search toggle, so the list offered no way to answer
          "what is running?" without typing. */}
      <div className="cmk__states" role="tablist" aria-label="Campaign state">
        {PRIMARY_FILTERS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={statusFilter === key}
            className={`cmk__state-tab${statusFilter === key ? ' is-on' : ''}`}
            onClick={() => onStatusFilterChange(key)}
          >
            {label}
          </button>
        ))}
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
              {SECONDARY_FILTERS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  className={`cmk__find-chip${statusFilter === key ? ' is-on' : ''}`}
                  onClick={() => onStatusFilterChange(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Campaign rows ─────────────────────────────────────────────── */}
        <div className="cmk__list" role="list">
          {loading && campaigns.length === 0
            ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="cmk__card-skeleton" aria-hidden="true" />)
            : campaigns.map((c) => (
                <CampaignCardMobile key={c.id} campaign={c} onOpen={onSelect} />
              ))}

          {!loading && campaigns.length === 0 && (
            <p className="cmk__empty">{filterActive ? 'No campaigns match.' : 'No campaigns yet.'}</p>
          )}
        </div>
      </div>
    </div>
  )
}
