/**
 * A SELLER REPLY UN-ARCHIVES THE THREAD (owner rule: "a reply always
 * unarchives"), whatever scope archived it — except identity_alignment, which
 * archives a duplicate thread IDENTITY (resurrecting it would reintroduce the
 * split-identity row the dedup collapsed).
 *
 * 2026-10-12 investigation (read-only, prod 7ade94e2): inbox_thread_state
 * 542f27d2 (thread_key +16128072000, scope NULL) was archived 09-04, got an
 * inbound on 10-07 13:14Z, and stayed archived. The stored key and the inbound
 * key were IDENTICAL — the format-mismatch hypothesis did not hold for it. The
 * inbound had no seller context (idempotency_ledger: "handled by unknown
 * router", context_not_found), and handle-textgrid-inbound returned through the
 * unknown-router branch BEFORE the un-archive step. So the un-archive now runs
 * on every inbound, from both branches, through this one helper.
 *
 * Lookup is by the canonical thread key the message write uses (the inbound
 * E.164), then by canonical_e164 for a row stored under another key format
 * (e.g. bare 10-digit). Nothing matched → logged, never silent.
 */
const clean = (value) => String(value ?? '').trim()

function e164Of(value) {
  const digits = clean(value).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return clean(value) || null
}

/**
 * @returns {Promise<{ ok: boolean, matched: number, unarchived: string[], preserved: string[], reason?: string }>}
 */
export async function unarchiveThreadOnInbound({
  supabase,
  inboundFrom,
  messageId = null,
  branch = 'known_context',
  patch,
  log = () => {},
} = {}) {
  const key = clean(inboundFrom)
  if (!supabase || !key) return { ok: false, matched: 0, unarchived: [], preserved: [], reason: 'missing_input' }
  const e164 = e164Of(key)
  const select = 'thread_key,canonical_e164,is_archived,archive_scope'

  const { data: exact, error: exactError } = await supabase.from('inbox_thread_state').select(select).eq('thread_key', key).limit(5)
  if (exactError) throw exactError
  let rows = Array.isArray(exact) ? exact : []
  if (!rows.length && e164) {
    const { data: byPhone, error: phoneError } = await supabase.from('inbox_thread_state').select(select).eq('canonical_e164', e164).limit(10)
    if (phoneError) throw phoneError
    rows = Array.isArray(byPhone) ? byPhone : []
  }
  if (!rows.length) {
    log('textgrid.inbound_unarchive_no_thread_row', { message_id: messageId, inbound_from: key, canonical_e164: e164, branch })
    return { ok: true, matched: 0, unarchived: [], preserved: [], reason: 'no_thread_row' }
  }

  const unarchived = []
  const preserved = []
  for (const row of rows) {
    if (row?.is_archived !== true) continue
    const scope = clean(row.archive_scope).toLowerCase()
    if (scope === 'identity_alignment') { preserved.push(clean(row.thread_key)); continue }
    await patch({
      threadKey: clean(row.thread_key),
      patch: { is_archived: false, archive_scope: null },
      supabase,
      meta: {
        change_source: 'system',
        source_view: 'inbound_auto_unarchive',
        reason: 'inbound_message_received',
        prior_archive_scope: scope || null,
        inbound_branch: branch,
        matched_by: clean(row.thread_key) === key ? 'thread_key' : 'canonical_e164',
      },
    })
    unarchived.push(clean(row.thread_key))
  }
  return { ok: true, matched: rows.length, unarchived, preserved }
}
