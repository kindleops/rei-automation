/**
 * LEADCOMMAND-OWNED OPEN + CLICK TRACKING.
 *
 * Tokens are 144-bit random values stored with the message/link they belong
 * to — unguessable, non-sensitive (no ids, no seller data in the URL),
 * scoped to exactly one message (open) or one link (click). A tampered or
 * unknown token resolves to nothing.
 *
 * The click redirect NEVER takes a destination from the request: it looks up
 * the URL recorded at send time. It cannot become an open redirect.
 *
 * Every hit is recorded as a canonical event with a signal class
 * (likely_human / privacy_proxy / automated / unknown). The IP is used only
 * transiently to recognise Apple's privacy proxy; neither IP nor user agent
 * is stored (engagement telemetry, not fingerprinting).
 */
import crypto from 'node:crypto'

import { recordEmailEvent } from './email-telemetry.js'

const clean = (v) => String(v ?? '').trim()

export const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

const newToken = () => crypto.randomBytes(18).toString('base64url')
const TOKEN_RE = /^[A-Za-z0-9_-]{20,40}$/

const SCANNER_UA = /(bot|crawler|spider|scanner|barracuda|mimecast|proofpoint|symantec|messagelabs|trend ?micro|forcepoint|sophos|fireeye|cisco|ironport|safelinks|urldefense|python|curl|wget|go-http|java\/|okhttp|headless|phantom|libwww|http-client|axios|node-fetch)/i
const PROXY_UA = /(googleimageproxy|ggpht\.com|yahoomailproxy|outlook-image-proxy|YahooMailProxy)/i
const BROWSER_UA = /(mozilla\/5\.0.+(applewebkit|gecko|trident)|outlook|thunderbird|microsoft office)/i

function isAppleProxyIp(ip) {
  // Apple Mail Privacy Protection fetches from Apple-owned space (17.0.0.0/8).
  return /^17\./.test(clean(ip))
}

/**
 * @param {'open'|'click'} kind
 * @returns {{ signalClass: string, confidence: number }}
 */
export function classifySignal(kind, { ua = '', ip = '', secondsSinceSent = null, burst = false } = {}) {
  if (SCANNER_UA.test(ua)) return { signalClass: 'automated', confidence: 0.9 }
  if (kind === 'click' && burst) return { signalClass: 'automated', confidence: 0.8 }
  if (secondsSinceSent !== null && secondsSinceSent >= 0 && secondsSinceSent < (kind === 'click' ? 10 : 3)) return { signalClass: 'automated', confidence: 0.7 }
  if (kind === 'open' && (PROXY_UA.test(ua) || isAppleProxyIp(ip) || ua === 'Mozilla/5.0')) return { signalClass: 'privacy_proxy', confidence: 0.8 }
  if (BROWSER_UA.test(ua)) return { signalClass: 'likely_human', confidence: kind === 'click' ? 0.7 : 0.5 }
  return { signalClass: 'unknown', confidence: 0 }
}

/**
 * Rewrite a message for tracking. Idempotent across transport retries: an
 * existing open token and link rows are reused, so a retried send carries the
 * same URLs.
 */
export async function applyTracking(db, row, baseUrl) {
  const base = clean(baseUrl).replace(/\/+$/, '')
  const html = row.html_body || row.email_body
  if (!base || !html) return { html: null, token: null, links: [] }
  const token = row.tracking_token || newToken()
  const { data: existing } = await db.from('email_links').select('*').eq('queue_id', row.id)
  const byIndex = new Map((existing || []).map((l) => [l.link_index, l]))
  const links = []
  let i = 0
  const rewritten = html.replace(/<a\b([^>]*?)href\s*=\s*"([^"]+)"([^>]*)>/gi, (tag, pre, href, post) => {
    const url = href.replace(/&amp;/g, '&')
    if (!/^https?:\/\//i.test(url)) return tag
    const index = i++
    const link = byIndex.get(index) || { token: newToken(), queue_id: row.id, link_index: index, destination_url: url }
    links.push(link)
    return `<a${pre}href="${base}/c/${link.token}"${post}>`
  })
  const fresh = links.filter((l) => !byIndex.has(l.link_index))
  if (fresh.length) {
    const { error } = await db.from('email_links').insert(fresh)
    if (error && error.code !== '23505') throw error
  }
  const pixel = `<img src="${base}/o/${token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`
  const out = /<\/body>/i.test(rewritten) ? rewritten.replace(/<\/body>/i, `${pixel}</body>`) : `${rewritten}\n${pixel}`
  return { html: out, token, links }
}

function secondsSince(at, now) {
  const t = Date.parse(at)
  return Number.isFinite(t) ? Math.round((now - t) / 1000) : null
}

/** Pixel hit → open_signal event. Always answers with the GIF (even for unknown tokens). */
export async function recordOpen(db, rawToken, { ua = '', ip = '', now = Date.now() } = {}) {
  const token = clean(rawToken).replace(/\.gif$/i, '')
  if (!TOKEN_RE.test(token)) return { recorded: false, reason: 'bad_token' }
  const { data: msg } = await db.from('email_queue').select('*').eq('tracking_token', token).maybeSingle()
  if (!msg) return { recorded: false, reason: 'unknown_token' }
  const cls = classifySignal('open', { ua, ip, secondsSinceSent: secondsSince(msg.sent_at, now) })
  // Same client re-rendering within a minute is one open, not several.
  const bucket = Math.floor(now / 60000)
  const r = await recordEmailEvent(db, { type: 'open_signal', source: 'leadcommand_tracking_pixel', message: msg, at: new Date(now).toISOString(), key: `pixel:${msg.id}:${bucket}:${cls.signalClass}`, signalClass: cls.signalClass, signalConfidence: cls.confidence })
  return { recorded: r.recorded, signalClass: cls.signalClass }
}

/** Click → click event + the STORED destination. Unknown/tampered token → no redirect. */
export async function recordClick(db, rawToken, { ua = '', ip = '', now = Date.now() } = {}) {
  const token = clean(rawToken)
  if (!TOKEN_RE.test(token)) return { destination: null, reason: 'bad_token' }
  const { data: link } = await db.from('email_links').select('*').eq('token', token).maybeSingle()
  if (!link) return { destination: null, reason: 'unknown_token' }
  const { data: msg } = await db.from('email_queue').select('*').eq('id', link.queue_id).maybeSingle()
  if (!/^(https?:\/\/|mailto:)/i.test(link.destination_url)) return { destination: null, reason: 'unsafe_destination' }
  if (msg) {
    // Several links of one message clicked within 2s = a security scanner walking the email.
    const since = new Date(now - 2000).toISOString()
    const { data: recent } = await db.from('email_events').select('link_id').eq('queue_id', msg.id).eq('event_type', 'click').gte('event_at', since)
    const burst = (recent || []).some((e) => e.link_id && e.link_id !== link.id)
    const cls = classifySignal('click', { ua, ip, secondsSinceSent: secondsSince(msg.sent_at, now), burst })
    await recordEmailEvent(db, { type: 'click', source: 'leadcommand_click_redirect', message: msg, at: new Date(now).toISOString(), key: `click:${link.id}:${Math.floor(now / 5000)}`, signalClass: cls.signalClass, signalConfidence: cls.confidence, linkId: link.id, extra: { metadata: { link_index: link.link_index } } })
  }
  return { destination: link.destination_url }
}
