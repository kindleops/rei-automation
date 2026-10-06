/**
 * COMMAND WALL — credential primitives.
 *
 * - Display tokens are 256-bit random values with a recognisable `lcw_` prefix
 *   (so middleware can refuse them on every non-wall route without a lookup).
 * - Only a keyed hash is ever stored: HMAC-SHA256 with COMMAND_WALL_TOKEN_PEPPER
 *   when configured, else SHA-256. A database read never yields a usable token.
 * - Pairing codes are short and typed by a human, so they are only ever a
 *   rendezvous: single-use, minutes-long, rate-limited, never an authority.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

export const DISPLAY_TOKEN_PREFIX = 'lcw_'
// No I/O (letters) and no 0/1 (digits): nothing a TV font makes ambiguous.
export const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
export const CODE_DIGITS = '23456789'
export const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z]{4}-[2-9]{4}$/

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function mintDisplayToken() {
  return `${DISPLAY_TOKEN_PREFIX}${b64url(randomBytes(32))}`
}

export function mintSecret(bytes = 24) {
  return b64url(randomBytes(bytes))
}

export function mintId(prefix = 'cwd') {
  return `${prefix}_${b64url(randomBytes(12))}`
}

export function mintPairingCode() {
  let a = ''
  let b = ''
  for (let i = 0; i < 4; i += 1) a += CODE_LETTERS[randomInt(CODE_LETTERS.length)]
  for (let i = 0; i < 4; i += 1) b += CODE_DIGITS[randomInt(CODE_DIGITS.length)]
  return `${a}-${b}`
}

/** Operator-typed codes: tolerate case, spaces and a missing dash. */
export function normalizePairingCode(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (s.length !== 8) return null
  const code = `${s.slice(0, 4)}-${s.slice(4)}`
  return PAIRING_CODE_PATTERN.test(code) ? code : null
}

export function looksLikeDisplayToken(raw) {
  return typeof raw === 'string' && raw.startsWith(DISPLAY_TOKEN_PREFIX) && raw.length >= DISPLAY_TOKEN_PREFIX.length + 40 && raw.length <= 96
}

export function hashSecret(value, { purpose = 'token', env = process.env } = {}) {
  const pepper = String(env.COMMAND_WALL_TOKEN_PEPPER || '').trim()
  const input = `command-wall:${purpose}:${value}`
  return pepper
    ? createHmac('sha256', pepper).update(input).digest('hex')
    : createHash('sha256').update(input).digest('hex')
}

export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

/** A coarse, non-reversible client fingerprint for rate limits and audit (never the raw IP). */
export function clientKey(request) {
  const h = request?.headers
  const ip = String(h?.get?.('cf-connecting-ip') || h?.get?.('x-forwarded-for') || h?.get?.('x-real-ip') || 'local').split(',')[0].trim()
  return createHash('sha256').update(`cw-ip:${ip}`).digest('hex').slice(0, 24)
}
