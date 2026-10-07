// ─── negotiation-v3/view.js ─────────────────────────────────────────────────
// §82 operator read model for Deal Intelligence / Inbox: seller ask, opening
// anchor, current LC position, target, autonomous limit, ceiling, plus why.
// OPERATOR-ONLY. Nothing here is seller-facing text. Rendered only when
// NEGOTIATION_ENGINE_V3 is on (the API omits the block otherwise).

import { buildNegotiationPlan, nextNegotiationMove } from "./plan.js";
import { summarizeNegotiationQuotes } from "./quote-log.js";

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function buildNegotiationDeskView({ ade_snapshot = null, property = {}, seller = {}, quotes = null, situation = null, now = Date.now(), env = process.env } = {}) {
  const plan = buildNegotiationPlan({ ade_snapshot, property, seller, situation, now, env });
  const history = quotes == null ? null : summarizeNegotiationQuotes(quotes);
  const lc = history?.lc_positions || [];
  const preview = nextNegotiationMove(plan, { lc_positions: lc, seller_positions: [] }, { kind: lc.length ? "counter" : "price", amount: num(seller.asking_price) });
  return {
    status: plan.ok ? "authorized" : "no_autonomous_money",
    asset: plan.asset,
    ask: num(seller.asking_price),
    anchor: plan.opening_anchor,
    currentPosition: history?.current_position || null,
    quotesCaptured: quotes != null,
    target: plan.target,
    autonomousLimit: plan.autonomous_limit,
    ceiling: plan.ceiling,
    fairFloor: plan.fair_floor,
    perUnit: plan.per_unit,
    ladder: plan.ladder.map((r) => ({ step: r.step, kind: r.kind, amount: r.amount })),
    authority: plan.authority,
    // When authority fails, the engine numbers are shown as NON-authoritative reference only.
    engineReference: plan.ok ? null : plan.engine_reference,
    strategy: { situation: plan.strategy.situation, angle: plan.strategy.angle, creativeProbe: plan.strategy.creative_probe },
    nextMove: {
      action: preview.action,
      amount: preview.amount,
      proposal: preview.proposal?.amount ?? null,
      quoteType: preview.quote_type || preview.proposal?.quote_type || null,
      rule: preview.rule_branch,
    },
    why: [...plan.explain.map((e) => e.text), ...(plan.reasons.length ? [`Held: ${plan.reasons.join(", ")}`] : [])],
    version: plan.version,
    configVersion: plan.config_version,
  };
}

export default buildNegotiationDeskView;
