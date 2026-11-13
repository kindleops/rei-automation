// Opaque, signed keyset cursors. A cursor binds: the tool, a hash of the
// filters it was issued for, the principal, and the last key returned. It is
// HMAC-SHA256 signed with a per-process random key, so a cursor
//   * cannot be forged or edited (signature),
//   * cannot be replayed against different filters / another tool (binding),
//   * cannot be handed to another principal (binding),
//   * expires with the server process (key rotation on restart) or after TTL.
import crypto from 'node:crypto'
import { err } from './errors.mjs'
import { canonicalJson } from '@/lib/agent/research/pii.js'

export const CURSOR_TTL_MS = 30 * 60_000

export function createCursorCodec({ key = crypto.randomBytes(32), now = () => Date.now() } = {}) {
  const sign = (body) => crypto.createHmac('sha256', key).update(body).digest('base64url').slice(0, 32)
  const bindHash = (tool, filters, principal) => crypto.createHash('sha256').update(canonicalJson({ tool, filters, principal })).digest('base64url').slice(0, 16)
  return {
    encode({ tool, filters, principal, after }) {
      const body = Buffer.from(JSON.stringify({ v: 1, b: bindHash(tool, filters, principal), a: String(after), t: now() })).toString('base64url')
      return `lc1.${body}.${sign(body)}` // a versioned prefix: never mistakable for a JWT
    },
    /** @returns {string} the `after` key, or throws invalid_input */
    decode(cursor, { tool, filters, principal }) {
      const s = String(cursor || '')
      const [ver, body, sig] = s.split('.')
      if (ver !== 'lc1' || !body || !sig || s.length > 400) throw err('invalid_input', 'cursor is malformed', { code: 'CURSOR_INVALID' })
      const want = sign(body)
      if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) throw err('invalid_input', 'cursor signature is not valid for this server', { code: 'CURSOR_INVALID' })
      let o
      try { o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { throw err('invalid_input', 'cursor is malformed', { code: 'CURSOR_INVALID' }) }
      if (o.v !== 1 || o.b !== bindHash(tool, filters, principal)) throw err('invalid_input', 'cursor was issued for different filters, tool or principal', { code: 'CURSOR_MISMATCH' })
      if (!Number.isFinite(o.t) || now() - o.t > CURSOR_TTL_MS) throw err('invalid_input', 'cursor expired', { code: 'CURSOR_EXPIRED' })
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(String(o.a))) throw err('invalid_input', 'cursor is malformed', { code: 'CURSOR_INVALID' })
      return String(o.a)
    },
  }
}
