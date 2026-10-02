/**
 * PERMANENT TEMPLATE-CHECK FAILURES ARE HELD, NOT RETRIED (rc-7.1, owner decision 2).
 *
 * A ready target whose message fails the template check (no approved template
 * for its language/use case, or the rendered message fails the lint gate —
 * blank/unsafe seller-name greeting, property-type mismatch) failed the same
 * way on every feeder cycle: it stayed `ready`, was re-rendered every five
 * minutes, and the campaign could never resolve to completed (prod 2026-10-01:
 * Dallas 14 = lint 12 + NO_TEMPLATE 2; Minneapolis 15 = lint 9 + NO_TEMPLATE 6).
 *
 * Now the feeder holds such a target: `target_status = 'blocked'`,
 * `block_reason = 'template_hold:<reason_code>'` and `metadata.template_hold`
 * records the reason, the plain-words detail and the TEMPLATE CATALOGUE
 * FINGERPRINT at hold time. A held target is no longer `ready`, so a campaign
 * whose remaining audience is held can complete.
 *
 * RE-ELIGIBILITY. Nothing about the target changes on its own; what changes is
 * the catalogue (a template approved, added, edited or un-quarantined). Each
 * feeder cycle reads a cheap fingerprint of `sms_templates` (row count, active
 * count, quarantined count, newest updated_at — three head counts and one
 * single-row read, once per feeder run) and releases holds whose fingerprint
 * differs back to `ready`. If the check still fails, the next plan re-holds it
 * under the new fingerprint — one retry per catalogue change, never per cycle.
 * Rebuilding a campaign re-materializes its targets as before.
 *
 * Holds are conditional writes on `target_status = 'ready'` (hold) and
 * `target_status = 'blocked'` + the template_hold prefix (release), so a hold
 * can never overwrite a planned/queued target and a release can never revive
 * a target blocked for any other reason (suppression, DNC, identity...).
 */
import crypto from 'node:crypto'

export const TEMPLATE_HOLD_PREFIX = 'template_hold:'

/** Reason codes that mean "the template check itself failed" (seller-independent of capacity). */
export const TEMPLATE_HOLD_REASONS = new Set(['TEMPLATE_RENDER_LINT_FAILURE', 'NO_TEMPLATE'])

const HOLD_WORDS = {
  NO_TEMPLATE: 'No approved message exists for this seller’s language and situation.',
  TEMPLATE_RENDER_LINT_FAILURE: 'The message failed the template check for this seller.',
}

const clean = (value) => (value === null || value === undefined ? '' : String(value).trim())

export function isTemplateHoldReason(reason) {
  return TEMPLATE_HOLD_REASONS.has(clean(reason))
}

export function isTemplateHeldTarget(target = {}) {
  return clean(target.target_status).toLowerCase() === 'blocked'
    && clean(target.block_reason).startsWith(TEMPLATE_HOLD_PREFIX)
}

/** Plain-words description for operators (no raw codes in UI). */
export function describeTemplateHold(reasonCode) {
  return HOLD_WORDS[clean(reasonCode)] || 'The message failed the template check.'
}

/**
 * Cheap catalogue fingerprint. Changes whenever a template is added/removed,
 * activated/deactivated, quarantined/released, or edited (updated_at).
 */
export async function loadTemplateCatalogFingerprint(supabase) {
  const head = (build) => build(supabase.from('sms_templates').select('id', { count: 'exact', head: true }))
  const [total, active, quarantined, newest] = await Promise.all([
    head((q) => q),
    head((q) => q.eq('is_active', true)),
    head((q) => q.not('quarantined_at', 'is', null)),
    supabase.from('sms_templates').select('updated_at').order('updated_at', { ascending: false, nullsFirst: false }).limit(1),
  ])
  for (const r of [total, active, quarantined, newest]) if (r?.error) throw r.error
  const parts = [
    Number(total.count || 0),
    Number(active.count || 0),
    Number(quarantined.count || 0),
    clean(Array.isArray(newest.data) ? newest.data[0]?.updated_at : ''),
  ]
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)
}

/**
 * Hold targets whose plan skip was a template-check failure.
 * @param {Array<{ target: object, reason: string, detail?: string|null, template_id?: string|null }>} holds
 * @returns {Promise<{ held: number, failed: number }>}
 */
export async function holdTemplateFailedTargets(supabase, holds = [], { fingerprint = null, now = new Date() } = {}) {
  let held = 0
  let failed = 0
  const at = new Date(now).toISOString()
  for (const hold of holds || []) {
    const target = hold?.target || {}
    const reason = clean(hold?.reason)
    if (!target.id || !isTemplateHoldReason(reason)) continue
    const metadata = target.metadata && typeof target.metadata === 'object' ? target.metadata : {}
    const { data, error } = await supabase
      .from('campaign_targets')
      .update({
        target_status: 'blocked',
        block_reason: `${TEMPLATE_HOLD_PREFIX}${reason}`,
        updated_at: at,
        metadata: {
          ...metadata,
          template_hold: {
            reason_code: reason,
            detail: clean(hold.detail) || null,
            template_id: clean(hold.template_id) || null,
            words: describeTemplateHold(reason),
            held_at: at,
            catalog_fingerprint: fingerprint,
            releases_when: 'template_catalogue_changes',
          },
        },
      })
      .eq('id', target.id)
      .eq('target_status', 'ready')
      .select('id')
    if (error) failed += 1
    else if (Array.isArray(data) ? data.length : data) held += 1
  }
  return { held, failed }
}

/**
 * Release this campaign's template holds when the catalogue changed since the
 * hold. Returns how many targets went back to `ready`.
 */
export async function releaseTemplateHoldsOnCatalogChange(supabase, campaignId, { fingerprint, now = new Date() } = {}) {
  if (!fingerprint) return { released: 0, held: 0 }
  const { data, error } = await supabase
    .from('campaign_targets')
    .select('id,metadata,block_reason,target_status')
    .eq('campaign_id', campaignId)
    .eq('target_status', 'blocked')
    .like('block_reason', `${TEMPLATE_HOLD_PREFIX}%`)
    .limit(1000)
  if (error) throw error
  const rows = Array.isArray(data) ? data : []
  const at = new Date(now).toISOString()
  let released = 0
  for (const row of rows) {
    const hold = row.metadata?.template_hold || {}
    if (hold.catalog_fingerprint && hold.catalog_fingerprint === fingerprint) continue
    const metadata = { ...(row.metadata || {}) }
    delete metadata.template_hold
    metadata.template_hold_released = {
      reason_code: hold.reason_code || null,
      held_at: hold.held_at || null,
      released_at: at,
      released_because: 'template_catalogue_changed',
    }
    const { data: updated, error: updateError } = await supabase
      .from('campaign_targets')
      .update({ target_status: 'ready', block_reason: null, updated_at: at, metadata })
      .eq('id', row.id)
      .eq('target_status', 'blocked')
      .like('block_reason', `${TEMPLATE_HOLD_PREFIX}%`)
      .select('id')
    if (!updateError && (Array.isArray(updated) ? updated.length : updated)) released += 1
  }
  return { released, held: rows.length - released }
}
