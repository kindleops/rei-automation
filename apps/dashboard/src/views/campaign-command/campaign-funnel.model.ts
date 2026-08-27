import type { CampaignPreviewResult } from './campaignWizardAdapter'
import type { CampaignFunnelCounts } from './components/CampaignFunnel'

/**
 * Single mapper from the campaign preview API to the funnel contract.
 *
 * Everything that renders a funnel goes through here, so REACH, campaign detail
 * and autopilot cannot drift into showing three different versions of the same
 * number — which is exactly what happened before the 2026-08-24 data-truth work.
 *
 * Production shape at time of writing (post-bridge, all gates passed):
 *   universe 169,797 -> resolved 139,462 -> sms-capable 117,785
 *     -> routed 165,215 -> READY 112,695
 *     (28,733 local market · 136,482 approved cross-state)
 */

interface CanonicalRouting {
  ok?: boolean
  exact_market_match?: number | null
  approved_state_fallback?: number | null
  no_sender_route?: number | null
  matched?: number | null
  reconciles?: boolean
}

const n = (value: unknown): number => {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export function funnelCountsFromPreview(preview: CampaignPreviewResult | null): CampaignFunnelCounts | null {
  if (!preview) return null

  const coverage = preview.sender_coverage ?? null
  const blocks = preview.exclusive_block_reasons?.counts ?? {}

  // Universe: prefer the addressable property count. It can exceed the graph when
  // the target graph is stale, and that gap is a real freshness loss the operator
  // should see rather than a number we quietly clamp.
  const universe = n(preview.addressable_properties ?? preview.total_matched_properties ?? preview.total_matched)

  const exactMarket = n(coverage?.exact)
  const crossState = n(coverage?.state_fallback)
  const senderCovered = coverage?.routable != null ? n(coverage.routable) : exactMarket + crossState

  // The preview returns a scalar `sender_covered` but usually no `sender_coverage`
  // aggregate and no exclusive block partition. Coercing those absences to 0 made
  // REACH render "Sender route found 0 (−9,084)" above "Ready to send 8,975" — a
  // contradiction, since a ready row by definition has a route, and it disagreed
  // with LAUNCH, which reads the scalar and showed 8,975 covered.
  //
  // So: take the scalar when the aggregate is missing, and only report the stage
  // as unmeasured when neither exists. The local/cross-state SPLIT still comes
  // only from the aggregate, so the routing panel stays separately gated.
  const scalarCovered = preview.sender_covered
  const coverageMeasured = coverage != null || scalarCovered != null
  const blocksMeasured = preview.exclusive_block_reasons?.counts != null

  // Canonical routing split, read straight off campaign_target_graph.routing_tier
  // over the same filtered set. Preferred over the live-inventory tiers above,
  // which are scoped to clean targets and therefore report uncovered = 0 whenever
  // every clean row routes — true, but it cannot account for the whole universe.
  const canonicalRouting = (coverage as { canonical?: CanonicalRouting } | null)?.canonical ?? null
  const canonicalRoutingOk = canonicalRouting?.ok === true
  const splitMeasured = canonicalRoutingOk || coverage != null

  // ── Canonical waterfall ────────────────────────────────────────────────
  // When the exclusive partition is present it IS the frozen eligibility
  // outcome (campaign_target_graph.queue_block_reason), so derive every stage
  // from it. The alternative — the preview's live-inventory recount — does not
  // credit approved cross-state routes: for Philadelphia, PA it reports
  // ready_to_queue 0 while the graph's own partition reconciles to 1,760 with
  // 3,499 rows routed cross-state. Rendering that 0 next to a partition that
  // sums to 1,760 would be a contradiction on one screen.
  const b = preview.exclusive_block_reasons?.counts ?? null
  const matched = n(preview.exclusive_block_reasons?.matched ?? preview.total_matched_properties ?? preview.total_matched)
  const canonicalStages = b && matched > 0
    ? (() => {
        const resolved = matched - n(b.missing_phone)
        const sms = resolved - n(b.wrong_number) - n(b.non_sms_capable)
        const routed = sms - n(b.suppressed) - n(b.pending_prior_touch) - n(b.active_queue_item)
        const readyRows = routed - n(b.no_sender_coverage)
        return { resolved, sms, routed, ready: readyRows }
      })()
    : null

  return {
    universe,
    matched: matched || undefined,
    // "resolved phone" is a PROPERTY count — one graph row is one property.
    resolvedPhone: canonicalStages ? canonicalStages.resolved : n(preview.linked_phones ?? preview.sms_eligible_phones_count),
    smsEligible: canonicalStages ? canonicalStages.sms : n(preview.sms_eligible_phones ?? preview.sms_eligible_phones_count),
    senderCovered: canonicalStages
      ? canonicalStages.routed
      : coverage != null ? senderCovered : n(scalarCovered),
    ready: canonicalStages ? canonicalStages.ready : n(preview.ready_to_queue),
    blocks: {
      missing_phone: n(blocks.missing_phone),
      wrong_number: n(blocks.wrong_number),
      non_sms_capable: n(blocks.non_sms_capable),
      suppressed: n(blocks.suppressed),
      pending_prior_touch: n(blocks.pending_prior_touch),
      active_queue_item: n(blocks.active_queue_item),
      no_sender_coverage: n(blocks.no_sender_coverage),
    },
    routing: canonicalRoutingOk
      ? {
          exactMarket: n(canonicalRouting?.exact_market_match),
          crossState: n(canonicalRouting?.approved_state_fallback),
          noRoute: n(canonicalRouting?.no_sender_route),
          // The canonical tiers partition every MATCHED property, not just the
          // routable ones, so the panel says which denominator it used.
          scope: 'matched' as const,
        }
      : {
          exactMarket,
          crossState,
          noRoute: coverage?.uncovered != null ? n(coverage.uncovered) : Math.max(0, universe - senderCovered),
          scope: 'routable' as const,
        },
    // Vendor DNC is intentionally absent from `blocks`. It is metadata under the
    // operator's contact policy and must never subtract from the funnel.
    flags: {},
    measured: { senderCoverage: coverageMeasured, routingSplit: splitMeasured, blocks: blocksMeasured },
  }
}

/**
 * Freshness loss: properties that exist but have no row in the target graph.
 * Surfaced separately from targeting decisions because it is a pipeline problem,
 * not a filter outcome — conflating the two is what made 45,751 properties
 * silently invisible to Campaigns for 71 days.
 */
export function universeGapFromPreview(preview: CampaignPreviewResult | null): {
  missing: number
  generatedAt: string | null
} | null {
  const gap = preview?.universe_gap
  const missing = n(gap?.not_in_target_graph)
  if (!gap || missing <= 0) return null
  return { missing, generatedAt: gap.graph_generated_at ?? null }
}
