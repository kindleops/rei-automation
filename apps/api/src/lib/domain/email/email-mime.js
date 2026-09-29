/**
 * Minimal RFC 5322 / MIME parser for inbound mail from Cloudflare Email
 * Routing (the Email Worker forwards the raw message). Dependency-free:
 * headers (unfolded, RFC 2047 encoded-words), nested multipart, base64 /
 * quoted-printable, charset decoding, attachments as Buffers.
 *
 * Output matches the generic shape normalizeInboundEmail() accepts.
 */

const MAX_DEPTH = 8

function splitHeadBody(buf) {
  const s = buf.toString('latin1')
  let i = s.indexOf('\r\n\r\n')
  let sep = 4
  if (i < 0) { i = s.indexOf('\n\n'); sep = 2 }
  if (i < 0) return { head: s, body: Buffer.alloc(0) }
  return { head: s.slice(0, i), body: buf.subarray(i + sep) }
}

function decodeCharset(bytes, charset = 'utf-8') {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '')
  try { return new TextDecoder(cs === 'us-ascii' ? 'utf-8' : cs).decode(bytes) } catch { return new TextDecoder('utf-8').decode(bytes) }
}

export function decodeEncodedWords(value) {
  return String(value ?? '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_, charset, enc, text) => {
    const bytes = enc.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1')
    return decodeCharset(bytes, charset)
  })
}

export function parseHeaders(head) {
  const out = {}
  const lines = head.replace(/\r\n/g, '\n').split('\n')
  let cur = null
  for (const line of lines) {
    if (/^[ \t]/.test(line) && cur) { out[cur][out[cur].length - 1] += ` ${line.trim()}`; continue }
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line)
    if (!m) continue
    cur = m[1].toLowerCase()
    ;(out[cur] ||= []).push(m[2])
  }
  const flat = {}
  for (const [k, v] of Object.entries(out)) flat[k] = v.length === 1 ? decodeEncodedWords(Buffer.from(v[0], 'latin1').toString('utf8')) : v.map((x) => decodeEncodedWords(Buffer.from(x, 'latin1').toString('utf8')))
  return flat
}

function param(header, name) {
  const re = new RegExp(`${name}\\*?=\\s*("([^"]*)"|([^;\\s]+))`, 'i')
  const m = re.exec(String(header || ''))
  if (!m) return null
  let v = m[2] ?? m[3]
  // RFC 2231 charset''value
  if (/^[\w-]+''/.test(v)) v = decodeURIComponent(v.replace(/^[\w-]+''/, ''))
  return decodeEncodedWords(v)
}

function decodeTransfer(body, encoding) {
  const enc = String(encoding || '7bit').toLowerCase().trim()
  if (enc === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (enc === 'quoted-printable') {
    const s = body.toString('latin1').replace(/=\r?\n/g, '')
    const bytes = []
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2 } else bytes.push(s.charCodeAt(i) & 0xff)
    }
    return Buffer.from(bytes)
  }
  return body
}

function walk(buf, depth, acc) {
  const { head, body } = splitHeadBody(buf)
  const h = parseHeaders(head)
  const ctype = String(h['content-type'] || 'text/plain').toLowerCase()
  const type = ctype.split(';')[0].trim()
  const disposition = String(h['content-disposition'] || '').toLowerCase()
  if (type.startsWith('multipart/') && depth < MAX_DEPTH) {
    const boundary = param(h['content-type'], 'boundary')
    if (!boundary) return h
    const s = body.toString('latin1')
    const delim = `--${boundary}`
    const parts = s.split(delim).slice(1)
    for (const p of parts) {
      if (p.startsWith('--')) break
      // The CRLF before a delimiter belongs to the delimiter (RFC 2046), not the part.
      walk(Buffer.from(p.replace(/^\r?\n/, '').replace(/\r?\n$/, ''), 'latin1'), depth + 1, acc)
    }
    return h
  }
  const decoded = decodeTransfer(body, h['content-transfer-encoding'])
  const filename = param(h['content-disposition'], 'filename') || param(h['content-type'], 'name')
  const isAttachment = disposition.startsWith('attachment') || (filename && !type.startsWith('text/'))
  if (isAttachment || (!type.startsWith('text/') && !type.startsWith('multipart/'))) {
    acc.attachments.push({ filename: filename || `attachment-${acc.attachments.length + 1}`, contentType: type, size: decoded.length, content: decoded, contentId: String(h['content-id'] || '').replace(/[<>]/g, '') || null })
  } else if (type === 'text/html' && acc.html === null) {
    acc.html = decodeCharset(decoded, param(h['content-type'], 'charset'))
  } else if (type === 'text/plain' && acc.text === null) {
    acc.text = decodeCharset(decoded, param(h['content-type'], 'charset'))
  }
  return h
}

/** Raw RFC 822 bytes → { from, to, cc, subject, text, html, messageId, inReplyTo, references, date, headers, attachments } */
export function parseMime(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  const acc = { text: null, html: null, attachments: [] }
  const h = walk(buf, 0, acc)
  const one = (v) => (Array.isArray(v) ? v[0] : v) || ''
  return {
    from: one(h.from),
    to: String(one(h.to)).split(',').map((x) => x.trim()).filter(Boolean),
    cc: String(one(h.cc)).split(',').map((x) => x.trim()).filter(Boolean),
    subject: one(h.subject),
    text: acc.text || '',
    html: acc.html || '',
    messageId: one(h['message-id']) || null,
    inReplyTo: one(h['in-reply-to']) || null,
    references: one(h.references) || '',
    date: one(h.date) || null,
    headers: Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Array.isArray(v) ? v.join(' ') : v])),
    attachments: acc.attachments,
  }
}
