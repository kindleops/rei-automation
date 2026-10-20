// The PATCH /api/cockpit/pipeline/opportunities/[id]/stage request → transitionOpportunityStage input.
/**
 * R1 (docs/ACTION-MCP-AUDIT.md §0.8): the stage transition's AUTHORITY inputs are server-owned. `source`,
 * `actor`, `offer_event`, `valuation_mid` and `mao` decide which gates apply (a `closing_authority` / manual
 * source or a forged offer event skipped them), so a request body that carries any of them is refused, and the
 * source / actor are derived from the authenticated identity: an ops-dashboard session is a person in the
 * Pipeline UI (source 'pipeline'). Only the caller's intent passes through.
 */
export const SERVER_OWNED_STAGE_FIELDS = Object.freeze(['source', 'actor', 'offer_event', 'valuation_mid', 'mao', 'last_updated_source', 'last_updated_by']);
const CALLER_STAGE_FIELDS = Object.freeze(['to_stage', 'stage', 'reason', 'outcome', 'idempotency_key', 'next_action', 'next_action_due']);

export function stageTransitionInput(body = {}, auth = {}) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const forged = SERVER_OWNED_STAGE_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(src, k));
  if (forged.length) return { ok: false, error: 'server_owned_fields', fields: forged, message: 'source, actor, offer events and valuations are set by the server, never by the request.' };
  const input = Object.fromEntries(CALLER_STAGE_FIELDS.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));
  return { ok: true, input: { ...input, source: 'pipeline', actor: `ops_dashboard:${String(auth?.via || 'session').slice(0, 60)}` } };
}
