// ─── negotiation-v3/view.js ─────────────────────────────────────────────────
// §82 operator read model for Deal Intelligence / Inbox: seller ask, opening
// anchor, current LC position, target, autonomous limit, ceiling, plus why.
// OPERATOR-ONLY. Nothing here is seller-facing text. Rendered only when
// NEGOTIATION_ENGINE_V3 is on (the API omits the block otherwise).

import { authoritativeOfferFromScore } from "@/lib/acquisition/offerAuthority.js";
import { buildNegotiationPlan, nextNegotiationMove } from "./plan.js";
import { summarizeNegotiationQuotes } from "./quote-log.js";

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function buildNegotiationDeskView({ ade_snapshot = null, offer_authority = null, property = {}, seller = {}, quotes = null, situation = null, now = Date.now(), env = process.env } = {}) {
  // ONE money interface (agent D's offer authority, CONTRACT_offer_authority.md).
  const oa = offer_authority || (ade_snapshot ? authoritativeOfferFromScore(ade_snapshot, { now, env }) : null);
  const plan = buildNegotiationPlan({ offer_authority: oa, property, seller, situation, now, env });
  const history = quotes == null ? null : summarizeNegotiationQuotes(quotes);
  const lc = history?.lc_positions || [];
  const preview = nextNegotiationMove(plan, { lc_positions: lc, seller_positions: [] }, { kind: lc.length ? "counter" : "price", amount: num(seller.asking_price) });
  return {
    // Never blank (owner 10-07): numbers + grade + why whenever the authority supplied them.
    status: !plan.ok ? "no_numbers" : plan.autonomy.eligible ? "autonomous_eligible" : "operator_approval",
    asset: plan.asset,
    ask: num(seller.asking_price),
    anchor: plan.opening_anchor,
    currentPosition: history?.current_position || null,
    quotesCaptured: quotes != null,
    target: plan.target,
    autonomousLimit: plan.autonomous_limit,
    ceiling: plan.ceiling,
    anchorFloor: plan.anchor_floor,
    investorPrice: plan.investor_price,
    lane: plan.lane,
    grade: plan.authority.confidence_grade,
    fallbackRung: plan.authority.fallback_rung,
    autonomy: { eligible: plan.autonomy.eligible, ladderPosition: plan.autonomy.ladder_position, reasons: plan.autonomy.reasons },
    anchorFloorPolicy: plan.anchor_floor_policy || null,
    perUnit: plan.per_unit,
    ladder: plan.ladder.map((r) => ({ step: r.step, kind: r.kind, amount: r.amount })),
    authority: plan.authority,
    strategy: { situation: plan.strategy.situation, angle: plan.strategy.angle, creativeProbe: plan.strategy.creative_probe },
    nextMove: {
      action: preview.action,
      amount: preview.amount,
      proposal: preview.proposal?.amount ?? null,
      quoteType: preview.quote_type || preview.proposal?.quote_type || null,
      rule: preview.rule_branch,
      // The seller-facing reply (position-only by default), pre-populated for review.
      reply: (preview.reply || preview.proposal?.reply)
        ? { branch: (preview.reply || preview.proposal.reply).branch, text: (preview.reply || preview.proposal.reply).text_en }
        : null,
    },
    why: plan.explain.map((e) => e.text),
    version: plan.version,
    configVersion: plan.config_version,
  };
}

export default buildNegotiationDeskView;
