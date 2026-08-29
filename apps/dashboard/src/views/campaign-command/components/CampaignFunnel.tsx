import { useMemo, useState } from 'react'
import { cls } from '../campaign-formatters'

/**
 * The canonical Campaign funnel.
 *
 * One component, one contract, reused by REACH, campaign detail and autopilot so
 * the operator never sees two different versions of the same number.
 *
 * Design rules earned from the 2026-08-24 data-truth work:
 *
 *  1. Stages are PROPERTIES, not "contacts". One graph row is one property. The
 *     old copy said "Reachable Contacts" over a property count while the distinct
 *     phone count was ~15% lower.
 *  2. Losses come from the EXCLUSIVE block partition (each property has exactly
 *     one operational reason), so the numbers reconcile: ready + Σreasons = matched.
 *     Overlapping diagnostics live in `flags`, never in the waterfall.
 *  3. Vendor DNC is METADATA. It is never a funnel loss and never subtracted —
 *     55,753 properties carry it and 39,271 of those are READY.
 *  4. Sender coverage is split into exact-market vs approved CROSS-STATE, because
 *     "covered" alone hides that most volume sends from another state.
 */

export interface CampaignFunnelCounts {
  universe: number
  /**
   * Rows actually present in the target graph for this targeting. The exclusive
   * partition sums with `ready` to THIS, not to `universe` — the difference is
   * the freshness gap surfaced separately as universe_gap.
   */
  matched?: number
  resolvedPhone: number
  smsEligible: number
  senderCovered: number
  ready: number
  /** Exclusive partition — sums with `ready` to `universe`. */
  blocks: {
    missing_phone?: number
    wrong_number?: number
    non_sms_capable?: number
    suppressed?: number
    pending_prior_touch?: number
    active_queue_item?: number
    no_sender_coverage?: number
  }
  routing: {
    exactMarket: number
    crossState: number
    noRoute: number
    /** Which denominator the tiers partition: every matched property, or only routable ones. */
    scope?: 'matched' | 'routable'
  }
  /** Non-blocking diagnostics. Shown, never subtracted. */
  flags?: {
    vendorDnc?: number
    vendorDncReady?: number
  }
  /**
   * Which parts the source actually measured. The preview endpoint returns no
   * sender-coverage aggregate and no block partition, and coercing those to 0
   * made the funnel claim "Sender route found 0" above "Ready to send 8,975".
   * Absent means measured, so existing callers are unaffected.
   */
  measured?: {
    senderCoverage?: boolean
    /** The local vs cross-state split, which needs the aggregate, not the scalar. */
    routingSplit?: boolean
    blocks?: boolean
  }
}

const BLOCK_META: Record<string, { label: string; why: string; tone: 'hard' | 'soft' | 'routing' }> = {
  missing_phone: {
    label: 'No phone on file',
    why: 'No contact resolved from the seller model for this property.',
    tone: 'hard',
  },
  non_sms_capable: {
    label: 'Landline — cannot receive SMS',
    why: 'A phone exists but the line type cannot receive text messages.',
    tone: 'hard',
  },
  wrong_number: {
    label: 'Known wrong number',
    why: 'Confirmed wrong number from a previous conversation.',
    tone: 'hard',
  },
  suppressed: {
    label: 'Opted out / suppressed',
    why: 'Our own opt-out or an operational exclusion. Not vendor DNC.',
    tone: 'soft',
  },
  pending_prior_touch: {
    label: 'Contacted recently',
    why: 'Touched in the last 30 days — cooling down before the next message.',
    tone: 'soft',
  },
  active_queue_item: {
    label: 'Already queued',
    why: 'This property already has a message waiting to send.',
    tone: 'soft',
  },
  no_sender_coverage: {
    label: 'No sender route',
    why: 'No eligible live sender for this market, and no approved route to one.',
    tone: 'routing',
  },
}

const fmt = (n: number | null | undefined) => Number(n ?? 0).toLocaleString()
const pct = (n: number, of: number) => (of > 0 ? Math.max(0, Math.min(100, (n / of) * 100)) : 0)

export const CampaignFunnel = ({
  counts,
  compact = false,
}: {
  counts: CampaignFunnelCounts
  compact?: boolean
}) => {
  const [openLosses, setOpenLosses] = useState(false)
  const [openRouting, setOpenRouting] = useState(false)

  const coverageMeasured = counts.measured?.senderCoverage !== false
  const splitMeasured = counts.measured?.routingSplit !== false
  const blocksMeasured = counts.measured?.blocks !== false

  const stages = useMemo(
    () => [
      { key: 'universe', label: 'Properties', value: counts.universe },
      { key: 'resolved', label: 'Contact resolved', value: counts.resolvedPhone },
      { key: 'sms', label: 'SMS-capable', value: counts.smsEligible },
      { key: 'covered', label: 'Sender route found', value: counts.senderCovered, unknown: !coverageMeasured },
      { key: 'ready', label: 'Ready to send', value: counts.ready, accent: true },
    ],
    [counts, coverageMeasured],
  )

  const losses = useMemo(
    () =>
      Object.entries(counts.blocks)
        .map(([key, value]) => ({ key, value: Number(value ?? 0), ...(BLOCK_META[key] ?? { label: key, why: '', tone: 'soft' as const }) }))
        .filter((l) => l.value > 0)
        .sort((a, b) => b.value - a.value),
    [counts.blocks],
  )

  const lossTotal = losses.reduce((sum, l) => sum + l.value, 0)
  // The partition must close. If it does not, say so rather than render a funnel
  // that silently loses rows.
  // Only meaningful when the partition was actually returned; an absent partition
  // is not a failed reconciliation.
  const reconciles =
    counts.measured?.blocks === false ||
    counts.ready + lossTotal === (counts.matched ?? counts.universe)
  const dncReady = counts.flags?.vendorDncReady ?? 0

  return (
    <div className={cls('cfx', compact && 'cfx--compact')}>
      {/* An empty universe is not a measured zero. Rendering "0 ready of 0
          properties · 0%" on a campaign with no targeting applied asserts a
          percentage over a denominator that was never counted, which is how the
          BUILD chip came to claim "Ready to schedule" on an empty draft. */}
      {counts.universe > 0 ? (
        <div className="cfx__hero">
          <div className="cfx__hero-value">{fmt(counts.ready)}</div>
          <div className="cfx__hero-label">Ready to send now</div>
          <div className="cfx__hero-sub">
            of {fmt(counts.universe)} properties · {pct(counts.ready, counts.universe).toFixed(0)}%
          </div>
        </div>
      ) : (
        <div className="cfx__hero is-empty">
          <div className="cfx__hero-value">—</div>
          <div className="cfx__hero-label">Nothing to send</div>
          <div className="cfx__hero-sub">No properties match this targeting</div>
        </div>
      )}

      {/* With no matched properties the stages, routing split and loss waterfall
          are all vacuously zero — the exclusive partition has nothing to
          partition. Five zero rows and two zero toggles read as measurement;
          the hero above already states the real situation. */}
      {counts.universe > 0 && (
      <>
      <ol className="cfx__stages" aria-label="Campaign reach funnel">
        {stages.map((stage, i) => {
          // An unmeasured stage must not anchor the next stage's drop, or the
          // loss shows up against the wrong step.
          const prevStage = [...stages.slice(0, i)].reverse().find((p) => !p.unknown)
          const prev = prevStage ? prevStage.value : stage.value
          const dropped = Math.max(0, prev - stage.value)
          if (stage.unknown) {
            return (
              <li key={stage.key} className="cfx__stage is-unknown">
                <div className="cfx__stage-row">
                  <span className="cfx__stage-label">{stage.label}</span>
                  <span className="cfx__stage-value">—</span>
                </div>
                <div className="cfx__stage-drop is-note">not measured in preview</div>
              </li>
            )
          }
          return (
            <li key={stage.key} className={cls('cfx__stage', stage.accent && 'is-accent')}>
              <div className="cfx__stage-bar" style={{ width: `${pct(stage.value, counts.universe)}%` }} />
              <div className="cfx__stage-row">
                <span className="cfx__stage-label">{stage.label}</span>
                <span className="cfx__stage-value">{fmt(stage.value)}</span>
              </div>
              {i > 0 && dropped > 0 && (
                <div className="cfx__stage-drop">−{fmt(dropped)}</div>
              )}
            </li>
          )
        })}
      </ol>

      {/* Sender routing — split, because "covered" alone hides cross-state volume. */}
      {splitMeasured ? (
      <button
        type="button"
        className={cls('cfx__panel-toggle', openRouting && 'is-open')}
        onClick={() => setOpenRouting((v) => !v)}
        aria-expanded={openRouting}
      >
        <span>Sender routing</span>
        <span className="cfx__panel-hint">
          {fmt(counts.routing.exactMarket)} local · {fmt(counts.routing.crossState)} cross-state
        </span>
      </button>
      ) : (
        <div className="cfx__panel-toggle is-static">
          <span>Sender routing</span>
          <span className="cfx__panel-hint">Not measured in preview</span>
        </div>
      )}
      {openRouting && splitMeasured && (
        <div className="cfx__panel">
          <div className="cfx__route-row">
            <span className="cfx__route-dot is-exact" />
            <span className="cfx__route-label">Local sender in the same market</span>
            <strong>{fmt(counts.routing.exactMarket)}</strong>
          </div>
          <div className="cfx__route-row">
            <span className="cfx__route-dot is-cross" />
            <span className="cfx__route-label">Approved out-of-state sender</span>
            <strong>{fmt(counts.routing.crossState)}</strong>
          </div>
          <div className="cfx__route-row">
            <span className="cfx__route-dot is-none" />
            <span className="cfx__route-label">No route available</span>
            <strong>{fmt(counts.routing.noRoute)}</strong>
          </div>
          <p className="cfx__panel-note">
            Cross-state routing sends from an approved sender in another state. It is normal,
            healthy routing — every route resolves to a live, eligible number.
            {counts.routing.scope === 'matched'
              ? ' Tiers below partition every matched property.'
              : ' Tiers below cover routable properties only.'}
          </p>
        </div>
      )}

      {/* Losses — exclusive partition, so these actually add up. */}
      {blocksMeasured ? (
      <button
        type="button"
        className={cls('cfx__panel-toggle', openLosses && 'is-open')}
        onClick={() => setOpenLosses((v) => !v)}
        aria-expanded={openLosses}
      >
        <span>Why the rest can’t send</span>
        <span className="cfx__panel-hint">{fmt(lossTotal)} excluded</span>
      </button>
      ) : (
        <div className="cfx__panel-toggle is-static">
          <span>Why the rest can’t send</span>
          <span className="cfx__panel-hint">Not measured in preview</span>
        </div>
      )}
      {openLosses && blocksMeasured && (
        <div className="cfx__panel">
          {losses.map((loss) => (
            <div key={loss.key} className={cls('cfx__loss', `is-${loss.tone}`)}>
              <div className="cfx__loss-head">
                <span className="cfx__loss-label">{loss.label}</span>
                <span className="cfx__loss-value">
                  {fmt(loss.value)}
                  <em>{pct(loss.value, counts.universe).toFixed(1)}%</em>
                </span>
              </div>
              <p className="cfx__loss-why">{loss.why}</p>
            </div>
          ))}
          {!reconciles && (
            <p className="cfx__panel-warn">
              These figures don’t reconcile to the property total — treat them as approximate
              and re-check the target graph.
            </p>
          )}
        </div>
      )}

      </>
      )}

      {/* Vendor DNC: metadata, never a loss. Stated explicitly so nobody reads its
          absence from the waterfall as an omission. */}
      {Number(counts.flags?.vendorDnc ?? 0) > 0 && (
        <div className="cfx__meta">
          <span className="cfx__meta-chip">Vendor DNC</span>
          <span className="cfx__meta-text">
            {fmt(counts.flags?.vendorDnc)} flagged by the data vendor
            {dncReady > 0 && <> · {fmt(dncReady)} still sending</>}
          </span>
          <span className="cfx__meta-note">Not a block under your contact policy</span>
        </div>
      )}
    </div>
  )
}
