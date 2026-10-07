// ─── negotiation-v3 ─────────────────────────────────────────────────────────
// Negotiation Intelligence v3 (owner brief §41–58, §75–77, §82). Contract:
// ~/.claude/jobs/c39b0175/tmp/acq-os/CONTRACT_negotiation.md
//
// Both flags default OFF (NEGOTIATION_ENGINE_V3, AUTONOMOUS_MONETARY_QUOTES).
// Pure plan / move; the only I/O is the log-then-send gate (quote-log.js).

export {
  buildNegotiationPlan,
  nextNegotiationMove,
  guardMove,
  computeAnchor,
  planLadder,
  resolveAnchorFloorPolicy,
  resolvePlanAsset,
  resolveStrategy,
  resolveAutonomy,
  isFarAboveReality,
  roundDownMoney,
  roundUpMoney,
  NEGOTIATION_ACTIONS,
  QUOTE_TYPES_V3,
  LANGUAGE_BRANCHES,
} from "./plan.js";
export {
  isOfferReady,
  authorityFromScoreRow,
  authorityFromOfferAuthority,
  normalizeLane,
  normalizeAuthority,
  resolvePlanAuthority,
  OFFER_READY_V3_PROJECTION,
  AUTHORITY_SOURCES,
  AUTHORITY_REASONS,
} from "./authority.js";
export { sellerFacingReply, supportiveComps, validateSellerFacing, displayMoney, REFERENCE_WORDING_EN, DISCLOSURE_RULES, DISCLOSURE_POLICY_VERSION } from "./disclosure.js";
export { buildQuoteLogRow, logQuoteThenSend, summarizeNegotiationQuotes, PERSISTED_QUOTE_TYPES } from "./quote-log.js";
export {
  NEGOTIATION_ENGINE_V3_FLAG,
  AUTONOMOUS_MONETARY_QUOTES_FLAG,
  isNegotiationEngineV3Enabled,
  isAutonomousMonetaryQuotesEnabled,
  resolveNegotiationFlags,
} from "./flags.js";
export { NEGOTIATION_V3_DEFAULTS, NEGOTIATION_V3_VERSION, NEGOTIATION_V3_CONFIG_VERSION } from "./config.js";

export { buildNegotiationPlan as default } from "./plan.js";
