/**
 * CANONICAL FACT READS for typed conditions. Each condition reads the owning
 * authority's own table/view for the run's exact identity. A read that fails
 * or cannot resolve the identity returns null — the runtime then HOLDS the run
 * ("facts unavailable"); it never guesses a branch.
 */

const clean = (v) => String(v ?? '').trim()

async function one(q) {
  const { data, error } = await q
  if (error) return { error }
  return { row: Array.isArray(data) ? data[0] ?? null : data ?? null }
}

export async function readConditionFacts(key, run, deps = {}) {
  const db = deps.supabase
  const s = run.context?.trigger || {}
  const now = deps.now ? Date.parse(deps.now) : Date.now()
  if (!db) return null
  switch (key) {
    case 'seller.conversation_open': {
      if (!clean(s.thread_key)) return null
      const r = await one(db.from('v_inbox_thread_state_buckets').select('thread_key, in_needs_review, in_new_replies').eq('thread_key', s.thread_key).limit(1))
      if (r.error) return null
      return { in_needs_review: Boolean(r.row?.in_needs_review), in_new_replies: Boolean(r.row?.in_new_replies) }
    }
    case 'seller.replied_since': {
      if (!clean(s.thread_key)) return null
      const r = await one(db.from('inbox_thread_state').select('thread_key, last_inbound_at').eq('thread_key', s.thread_key).limit(1))
      if (r.error) return null
      return { last_inbound_at: r.row?.last_inbound_at ?? null, since: run.started_at }
    }
    case 'seller.asking_price_known': {
      if (!clean(s.opportunity_id)) return null
      const r = await one(db.from('acquisition_opportunities').select('id, metadata').eq('id', s.opportunity_id).limit(1))
      if (r.error || !r.row) return null
      return { asking_price: r.row.metadata?.seller_facts?.asking_price ?? null }
    }
    case 'seller.contactable': {
      if (!clean(s.thread_key)) return null
      try {
        const { evaluateCanonicalContactability, CONTACT_CHECK_MODES } = await import('@/lib/domain/compliance/evaluate-canonical-contactability.js')
        const r = await (deps.contactability || evaluateCanonicalContactability)({ thread_key: s.thread_key, master_owner_id: s.master_owner_id || null, contact_check_mode: CONTACT_CHECK_MODES.ENQUEUE }, { supabase: db })
        return { contactable: r && r.blocked === false }
      } catch { return null }
    }
    case 'closing.title_acknowledged':
    case 'closing.commitment_received':
    case 'closing.clear_to_close':
    case 'closing.cancelled': {
      if (!clean(s.closing_case_id)) return null
      const r = await one(db.from('closing_cases').select('closing_case_id, title_acknowledged_at, title_commitment_received_at, clear_to_close_at, terminal_outcome').eq('closing_case_id', s.closing_case_id).limit(1))
      if (r.error || !r.row) return null
      return r.row
    }
    case 'closing.emd_verified': {
      if (!clean(s.closing_case_id)) return null
      const { data, error } = await db.from('emd_receipts').select('status').eq('closing_case_id', s.closing_case_id)
      if (error) return null
      return { emd_verified: (data || []).some((x) => x.status === 'verified') }
    }
    case 'campaign.active': {
      if (!clean(s.campaign_id)) return null
      const r = await one(db.from('campaigns').select('id, status').eq('id', s.campaign_id).limit(1))
      if (r.error || !r.row) return null
      return { status: r.row.status }
    }
    case 'email.address_healthy': {
      const email = clean(s.recipient || s.email).toLowerCase()
      if (!email) return null
      const r = await one(db.from('email_address_health').select('email_address, status').eq('email_address', email).limit(1))
      if (r.error) return null
      return { status: r.row?.status || 'unknown' }
    }
    case 'time.deadline_passed': {
      const deadline = run.context?.vars?.deadline || s.deadline
      return deadline ? { deadline, now } : null
    }
    default:
      return null
  }
}
