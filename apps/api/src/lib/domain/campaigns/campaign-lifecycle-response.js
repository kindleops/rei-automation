/**
 * Standard JSON contract for Campaign Command operator actions.
 */

export function wrapCampaignActionResponse(input = {}) {
  const counts = input.counts && typeof input.counts === 'object' ? input.counts : {}
  return {
    ok: input.ok !== false,
    campaign_id: input.campaign_id || null,
    run_id: input.run_id || null,
    previous_state: input.previous_state ?? input.from ?? null,
    state: input.state ?? input.to ?? null,
    persisted_status: input.persisted_status ?? input.to ?? null,
    message: input.message || null,
    counts,
    blockers: Array.isArray(input.blockers) ? input.blockers : [],
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
    error: input.ok === false ? (input.error || input.code || 'action_failed') : undefined,
    code: input.ok === false ? (input.code || input.error || 'action_failed') : undefined,
    idempotent: Boolean(input.idempotent),
    inserted: input.inserted ?? undefined,
    skipped: input.skipped ?? undefined,
  }
}