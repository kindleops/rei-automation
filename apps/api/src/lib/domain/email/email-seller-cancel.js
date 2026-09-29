/**
 * Cross-channel stop for seller email. Called by the seller orchestrator on
 * EVERY seller inbound (SMS or email): pending automated seller email for that
 * owner/property is withdrawn, so a question the seller just answered by text
 * is never also asked by email. Dependency-free on purpose — it sits on the
 * SMS hot path.
 */
export async function cancelPendingSellerEmails({ master_owner_id = null, property_id = null, reason = 'seller_replied', supabase } = {}) {
  if (!supabase || (!master_owner_id && !property_id)) return { ok: true, cancelled: 0, reason: 'no_scope' }
  let q = supabase.from('email_queue')
    .update({ queue_status: 'superseded', cancel_reason: reason, is_locked: false, updated_at: new Date().toISOString() })
    .eq('source', 'seller')
    .in('queue_status', ['pending_send', 'scheduled', 'awaiting_approval', 'draft'])
  if (master_owner_id) q = q.eq('master_owner_id', String(master_owner_id))
  if (property_id) q = q.eq('property_id', String(property_id))
  const { data, error } = await q.select('id')
  if (error) {
    // The table may not exist yet in an environment without the migration.
    if (/relation .*email_queue|does not exist|schema cache/i.test(String(error.message || ''))) return { ok: true, cancelled: 0, reason: 'email_schema_absent' }
    return { ok: false, cancelled: 0, reason: error.message }
  }
  return { ok: true, cancelled: (data || []).length, reason }
}
