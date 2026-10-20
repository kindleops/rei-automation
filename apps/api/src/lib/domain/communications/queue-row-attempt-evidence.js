/**
 * queue-row-attempt-evidence.js (rc-8.5.21 RUN-09)
 *
 * READ-ONLY: the §11 attempts recorded for a set of queue rows, so the processing-lease reaper
 * (domain/queue/processing-lease-recovery.js) can tell a provably-unsent crashed row from an ambiguous
 * one. The §11 tables are read and written only from this domain; this module never writes.
 *
 * A failed read is { ok: false } — the caller must then treat every row as ambiguous. Never throws.
 * @returns {Promise<{ ok: boolean, byRow: Map<string, object[]> }>}
 */
const clean = (v) => String(v ?? '').trim()

export async function loadQueueRowAttemptEvidence(supabase, queueRowIds = []) {
  const ids = [...new Set((queueRowIds || []).map(clean).filter(Boolean))]
  const byRow = new Map(ids.map((id) => [id, []]))
  if (!ids.length) return { ok: true, byRow }
  if (!supabase || typeof supabase.from !== 'function') return { ok: false, byRow }
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await supabase
        .from('seller_communication_attempts')
        .select('id,queue_row_id,logical_communication_id,provider_request_started_at,provider_response_received_at,provider_message_id,http_status,provider_status,transport_phase,delivery_possibility,outcome_class,completed_at')
        .in('queue_row_id', ids.slice(i, i + 100))
      if (error) return { ok: false, byRow }
      for (const a of data || []) {
        const k = clean(a.queue_row_id)
        if (byRow.has(k)) byRow.get(k).push(a)
      }
    }
    return { ok: true, byRow }
  } catch {
    return { ok: false, byRow }
  }
}

export default loadQueueRowAttemptEvidence
