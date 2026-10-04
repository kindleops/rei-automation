/**
 * EMAIL IDENTITY — threads, message identity, senders.
 *
 * THREAD KEY is the conversation lineage, chosen by the business object, not
 * by the counterparty address. One title company serves many deals, so
 * address-threading (the old get_email_threads model) would merge unrelated
 * closings into one conversation. Keys:
 *   closing:<closing_case_id>:<title|buyer|lender>
 *   seller:<master_owner_id>:<property_id|any>
 *   contact:<lower(email)>            (manual / unlinked counterparty)
 *   unresolved:<lower(from_email)>    (inbound we could not attribute)
 *
 * MESSAGE IDENTITY. Every outbound row gets an RFC Message-ID we mint before
 * send; follow-ups set In-Reply-To/References to the thread's prior messages
 * so the counterparty's client keeps one conversation. Replies route back by
 * the thread's reply token (reply+<token>@<inbound domain>) when an inbound
 * domain is configured, else by In-Reply-To/References.
 */
import crypto from 'node:crypto'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()

export const isValidEmail = (v) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(clean(v))

export function threadKeyFor({ category, closingCaseId, leg, masterOwnerId, propertyId, email }) {
  if (closingCaseId) return `closing:${closingCaseId}:${leg || category || 'title'}`
  if (category === 'seller' && masterOwnerId) return `seller:${masterOwnerId}:${propertyId || 'any'}`
  if (category === 'unresolved') return `unresolved:${lower(email)}`
  return `contact:${lower(email)}`
}

/** Upsert a thread by key; returns the row. Links are only ever filled, never overwritten with null. */
export async function ensureThread(db, spec) {
  const key = clean(spec.thread_key)
  if (!key) throw new Error('ensureThread: thread_key required')
  const { data: existing } = await db.from('email_threads').select('*').eq('thread_key', key).maybeSingle()
  if (existing) {
    const fill = {}
    for (const k of ['counterparty_email', 'counterparty_name', 'counterparty_role', 'brand_key', 'sender_key', 'subject', 'master_owner_id', 'prospect_id', 'property_id', 'opportunity_id', 'closing_case_id', 'buyer_id', 'title_company_id']) {
      if (!existing[k] && spec[k]) fill[k] = spec[k]
    }
    if (Object.keys(fill).length) {
      fill.updated_at = new Date().toISOString()
      await db.from('email_threads').update(fill).eq('id', existing.id)
      return { ...existing, ...fill }
    }
    return existing
  }
  const row = {
    thread_key: key,
    category: spec.category || 'other',
    counterparty_email: lower(spec.counterparty_email) || null,
    counterparty_name: clean(spec.counterparty_name) || null,
    counterparty_role: clean(spec.counterparty_role) || null,
    brand_key: clean(spec.brand_key) || null,
    sender_key: clean(spec.sender_key) || null,
    subject: clean(spec.subject) || null,
    master_owner_id: spec.master_owner_id || null,
    prospect_id: spec.prospect_id || null,
    property_id: spec.property_id || null,
    opportunity_id: spec.opportunity_id || null,
    closing_case_id: spec.closing_case_id || null,
    buyer_id: spec.buyer_id || null,
    title_company_id: spec.title_company_id || null,
    resolution_status: spec.resolution_status || 'resolved',
    resolution_method: spec.resolution_method || null,
    resolution_candidates: spec.resolution_candidates || [],
    reply_token: spec.reply_token || crypto.randomBytes(9).toString('hex'),
    metadata: spec.metadata || {},
  }
  const { data, error } = await db.from('email_threads').insert(row).select('*').maybeSingle()
  if (error) {
    if (error.code === '23505') {
      const again = await db.from('email_threads').select('*').eq('thread_key', key).maybeSingle()
      if (again.data) return again.data
    }
    throw error
  }
  return data || row
}

export function mintMessageId(domain) {
  const d = lower(domain) || 'leadcommand.local'
  return `<lc.${Date.now().toString(36)}.${crypto.randomBytes(8).toString('hex')}@${d}>`
}

/** In-Reply-To = the most recent message in the thread; References = the chain (bounded). */
export function threadingHeaders(priorMessageIds = []) {
  const ids = priorMessageIds.map(clean).filter(Boolean)
  if (!ids.length) return { inReplyTo: null, references: null }
  const chain = ids.slice(-10)
  return { inReplyTo: chain[chain.length - 1], references: chain.join(' ') }
}

export function replyAddressFor(thread, inboundDomain) {
  const d = lower(inboundDomain)
  if (!d || !thread?.reply_token) return null
  return `reply+${thread.reply_token}@${d}`
}

/** reply+<token>@domain → token. */
export function parseReplyToken(addresses = []) {
  for (const a of [].concat(addresses)) {
    const m = /reply\+([a-f0-9]{8,64})@/i.exec(clean(a))
    if (m) return m[1].toLowerCase()
  }
  return null
}

/**
 * Resolve the sending identity for a brand. email_senders is the registry:
 * sender_key = brand key, provider_api_key_name names the env var holding the
 * brand's Brevo key (BREVO_<BRAND>_API_KEY), metadata.inbound_domain enables
 * reply routing. Falls back to the default active sender.
 */
/**
 * messages_sent_today is a per-UTC-day counter. Nothing resets the column, so
 * it is only meaningful when last_sent_at is today: a stale counter from an
 * earlier day reads as 0 (and the dispatcher's next increment restarts it).
 * Without this the sender would stall permanently at daily_limit total sends.
 */
export function sentTodayOf(sender = {}, now = Date.now()) {
  const last = Date.parse(sender.last_sent_at)
  if (!Number.isFinite(last)) return 0
  return new Date(last).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? Number(sender.messages_sent_today) || 0 : 0
}

export async function resolveBrandSender(db, brandKey, env = process.env, now = Date.now()) {
  const { data: senders, error } = await db.from('email_senders').select('*').eq('is_active', true)
  if (error) return { ok: false, code: 'sender_lookup_failed' }
  const rows = senders || []
  const s = rows.find((r) => brandKey && lower(r.sender_key) === lower(brandKey)) || rows.find((r) => r.is_default) || null
  if (!s) return { ok: false, code: 'sender_identity_missing' }
  if (clean(s.sender_status) && !['active', 'verified', 'warm', 'warming'].includes(lower(s.sender_status))) {
    return { ok: false, code: 'sender_unavailable', status: s.sender_status, sender_key: s.sender_key }
  }
  const keyName = clean(s.provider_api_key_name) || 'BREVO_API_KEY'
  const apiKey = clean(env[keyName])
  if (!apiKey) return { ok: false, code: 'provider_key_missing', key_name: keyName, sender_key: s.sender_key }
  const domain = clean(s.domain) || lower(s.from_email).split('@')[1]
  return {
    ok: true,
    sender: {
      sender_key: s.sender_key,
      email: lower(s.from_email),
      name: clean(s.sender_name) || 'Acquisitions',
      reply_to_email: lower(s.reply_to_email) || null,
      domain,
      inbound_domain: clean(s.metadata?.inbound_domain) || clean(env.EMAIL_INBOUND_DOMAIN) || null,
      // e.g. https://track.reivesti.com — a host that routes to LeadCommand's
      // public tracking endpoints. Absent → provider telemetry only.
      tracking_base_url: clean(s.metadata?.tracking_base_url) || null,
      // Compliance (lane-scoped automated mail): the sender's postal address and
      // the public base for /u/<token> one-click unsubscribe.
      postal_address: clean(s.metadata?.postal_address) || null,
      unsubscribe_base_url: clean(s.metadata?.unsubscribe_base_url) || clean(s.metadata?.tracking_base_url) || null,
      unsubscribe_footer_text: clean(s.metadata?.unsubscribe_footer_text) || null,
      api_key: apiKey,
      daily_limit: s.daily_limit ?? null,
      messages_sent_today: sentTodayOf(s, now),
    },
  }
}
