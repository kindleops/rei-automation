/**
 * EMAIL CONTENT — normalization, reply extraction, HTML safety.
 *
 * The stored source is never modified (raw text/html kept for audit). These
 * helpers derive what the operator reads and what classification sees: the
 * NEW part of a reply, without quoted history or the signature block.
 */

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()

function addr(v) {
  if (!v) return null
  if (typeof v === 'string') {
    const m = /<([^>]+)>/.exec(v)
    return { email: lower(m ? m[1] : v), name: m ? clean(v.slice(0, m.index)).replace(/^"|"$/g, '') || null : null }
  }
  return { email: lower(v.Address || v.address || v.email), name: clean(v.Name || v.name) || null }
}
const addrs = (v) => [].concat(v || []).map(addr).filter((a) => a && a.email)

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null
  const k = Object.keys(headers).find((x) => x.toLowerCase() === name.toLowerCase())
  const v = k ? headers[k] : null
  return Array.isArray(v) ? v.join(' ') : v ? String(v) : null
}

const msgIds = (v) => (clean(v).match(/<[^<>\s]+>/g) || [])

/**
 * Brevo inbound-parse item → canonical inbound message. Tolerates the
 * generic shape ({from,to,subject,text,html,...}) so another inbound source
 * (e.g. a Cloudflare Email Worker) can post the same contract.
 */
export function normalizeInboundEmail(item = {}) {
  const headers = item.Headers || item.headers || {}
  const from = addr(item.From || item.from) || { email: null, name: null }
  const references = msgIds(headerValue(headers, 'References') || item.References || item.references)
  const messageId = clean(item.MessageId || item.messageId || item.message_id || headerValue(headers, 'Message-ID')) || null
  const inReplyTo = clean(item.InReplyTo || item.inReplyTo || item.in_reply_to || headerValue(headers, 'In-Reply-To')) || null
  const text = String(item.RawTextBody ?? item.text ?? item.text_body ?? '')
  const html = String(item.RawHtmlBody ?? item.html ?? item.html_body ?? '')
  const extracted = clean(item.ExtractedMarkdownMessage)
  const signature = clean(item.ExtractedMarkdownSignature) || null
  const sent = item.SentAtDate || item.sentAt || item.date || headerValue(headers, 'Date')
  const receivedAt = Number.isFinite(Date.parse(sent)) ? new Date(Date.parse(sent)).toISOString() : new Date().toISOString()
  const uuid = [].concat(item.Uuid || item.uuid || [])[0] || null
  const attachments = [].concat(item.Attachments || item.attachments || []).map((a, i) => ({
    index: i,
    filename: clean(a.Name || a.name || a.filename) || `attachment-${i + 1}`,
    content_type: lower(a.ContentType || a.contentType || a.content_type) || 'application/octet-stream',
    size_bytes: Number(a.ContentLength ?? a.size ?? a.size_bytes) || null,
    download_token: clean(a.DownloadToken || a.downloadToken) || null,
    content_id: clean(a.ContentID || a.contentId) || null,
  }))
  const plain = text || htmlToText(html)
  return {
    provider_message_id: clean(uuid) || null,
    message_id_header: messageId,
    in_reply_to: inReplyTo,
    references_headers: references,
    from_email: from.email,
    from_name: from.name,
    to_emails: addrs(item.To || item.to).map((a) => a.email),
    cc_emails: addrs(item.Cc || item.cc).map((a) => a.email),
    subject: clean(item.Subject || item.subject) || null,
    text_body: plain,
    html_body: html || null,
    reply_text: extracted || extractReply(plain).reply,
    signature_text: signature || extractReply(plain).signature,
    received_at: receivedAt,
    attachments,
    headers: pickHeaders(headers),
    spam_score: Number(item.SpamScore ?? item.spam_score) || null,
  }
}

function pickHeaders(h) {
  const keep = ['message-id', 'in-reply-to', 'references', 'date', 'auto-submitted', 'x-autoreply', 'precedence', 'list-unsubscribe', 'reply-to', 'return-path']
  const out = {}
  for (const [k, v] of Object.entries(h || {})) if (keep.includes(k.toLowerCase())) out[k.toLowerCase()] = Array.isArray(v) ? v.join(' ') : String(v)
  return out
}

/** Dedupe identity: provider id, else Message-ID, else content hash fields. */
export function inboundDedupeKey(msg) {
  if (msg.message_id_header) return `msgid:${lower(msg.message_id_header)}`
  if (msg.provider_message_id) return `provider:${msg.provider_message_id}`
  return `hash:${lower(msg.from_email)}:${msg.received_at}:${clean(msg.subject).slice(0, 80)}`
}

/** Auto-replies / bounces / list mail must never drive automation. */
export function isAutomatedMail(msg) {
  const h = msg.headers || {}
  if (/auto-(replied|generated)/i.test(h['auto-submitted'] || '')) return 'auto_submitted'
  if (h['x-autoreply']) return 'auto_reply'
  if (/bulk|list|junk/i.test(h.precedence || '')) return 'bulk'
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(msg.from_email || '')) return 'system_sender'
  if (/^(automatic reply|out of (the )?office|auto(matic)? ?reply|undeliverable|delivery status notification)/i.test(msg.subject || '')) return 'auto_reply'
  return null
}

const QUOTE_MARKERS = [
  /^On .{3,200}wrote:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}/mi,
  /^_{5,}\s*$/m,
  /^From:\s.+\n(?:Sent|Date):\s/mi,
  /^Sent from my (iPhone|iPad|Android|mobile)/mi,
]

/** The new content of a reply, its signature, and whether quoted history followed. */
export function extractReply(text = '') {
  let body = String(text).replace(/\r\n/g, '\n')
  let quoted = false
  let cut = body.length
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(body)
    if (m && m.index < cut) { cut = m.index; quoted = true }
  }
  const lines = body.slice(0, cut).split('\n')
  // Trailing "> quoted" block.
  while (lines.length && /^\s*>/.test(lines[lines.length - 1])) { lines.pop(); quoted = true }
  body = lines.join('\n')
  let signature = null
  const sig = /\n--\s*\n([\s\S]*)$/.exec(body)
  if (sig) { signature = sig[1].trim(); body = body.slice(0, sig.index) }
  return { reply: body.replace(/\n{3,}/g, '\n\n').trim(), signature, quoted }
}

export function htmlToText(html = '') {
  return String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Sanitize inbound HTML for display: allowlist of structural tags, no
 * scripts/styles/iframes/forms/event handlers, no remote images (tracking),
 * links forced external (rel=noopener, target=_blank, flagged data-external).
 */
const ALLOWED = new Set(['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'blockquote', 'a', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'hr', 'pre', 'code'])
export function sanitizeEmailHtml(html = '') {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    // Paired dangerous elements go with their content; any unpaired opener after.
    .replace(/<(script|style|head|title|iframe|object|embed|form|textarea|select|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|style|head|title|iframe|object|embed|form|input|button|textarea|select|svg|math|link|meta|base)\b[^>]*>/gi, '')
  s = s.replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (tag, name, attrs) => {
    const n = name.toLowerCase()
    if (!ALLOWED.has(n)) return ''
    if (tag.startsWith('</')) return `</${n}>`
    if (n === 'a') {
      const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs)
      const url = href ? (href[2] ?? href[3] ?? '') : ''
      const safe = /^(https?:|mailto:)/i.test(url.trim()) ? url.trim().replace(/"/g, '&quot;') : null
      return safe ? `<a href="${safe}" target="_blank" rel="noopener noreferrer nofollow" data-external="1">` : '<a>'
    }
    return `<${n}>`
  })
  return s.trim()
}

export const _internal = { addr, msgIds }
