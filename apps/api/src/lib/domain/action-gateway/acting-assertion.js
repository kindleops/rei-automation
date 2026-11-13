// Acting-agent assertions for SERVICE credentials (PROPOSED_20261105120000_action_gateway_service_principals.sql).
//
// A service credential (lcsvc_...) proves WHICH INTEGRATION is calling. It does not prove which agent is acting: a
// bare X-LC-Acting-Agent header is a claim anyone holding the credential could make for any delegate. So every tool
// call through a service credential also carries X-LC-Acting-Assertion: an Ed25519 signature, by the ACTING AGENT'S
// own key, over the exact call (agent, MCP tool name, canonical hash of the raw arguments, time). The owner registers
// each delegate's PUBLIC key (service_delegates.assertion_key); the private key never leaves the integration's secret
// store, where only the runtime executing as that agent signs with it. A signature for one agent, tool or argument set
// never verifies for another, and an old signature expires after ASSERTION_SKEW_MS.
//
// Header:  X-LC-Acting-Assertion: v1.<unix ms>.<base64url Ed25519 signature>
// Message: lc-acting-assertion-v1\n<agent id>\n<mcp tool name>\n<sha256 hex of canonical JSON args>\n<unix ms>
import crypto from 'node:crypto'
import { hashCanonical } from '../../agent/runtime/canonical.js'

export const ACTING_ASSERTION_HEADER = 'x-lc-acting-assertion'
export const ASSERTION_SKEW_MS = 120_000
export const ASSERTION_KEY_RE = /^[A-Za-z0-9_-]{43}$/
const HEADER_RE = /^v1\.(\d{13})\.([A-Za-z0-9_-]{86})$/

export function assertionMessage({ agent, tool, args, ts }) {
  return `lc-acting-assertion-v1\n${agent}\n${tool}\n${hashCanonical(args ?? {})}\n${ts}`
}

/** The registered public key (raw 32-byte Ed25519, base64url) as a KeyObject, or null when malformed. */
export function publicKeyOf(raw) {
  if (typeof raw !== 'string' || !ASSERTION_KEY_RE.test(raw)) return null
  try { return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' }) } catch { return null }
}

/** A new Ed25519 key pair: { publicKey (base64url raw, safe to show and register), privateKey (PKCS#8 PEM, secret) }. */
export function newAssertionKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return { publicKey: publicKey.export({ format: 'jwk' }).x, privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) }
}

/** Sign one call (the integration side; used by tests and by clients written in JavaScript). */
export function signActingAssertion({ privateKey, agent, tool, args, now = Date.now() }) {
  const ts = Math.trunc(now)
  const sig = crypto.sign(null, Buffer.from(assertionMessage({ agent, tool, args, ts }), 'utf8'), typeof privateKey === 'string' ? crypto.createPrivateKey(privateKey) : privateKey)
  return `v1.${ts}.${sig.toString('base64url')}`
}

/**
 * Verify the assertion for one call. Returns null when valid, otherwise a refusal code:
 * ACTING_ASSERTION_REQUIRED, ACTING_ASSERTION_MALFORMED, ACTING_ASSERTION_KEY_MISSING, ACTING_ASSERTION_STALE,
 * ACTING_ASSERTION_INVALID.
 */
export function verifyActingAssertion({ publicKey, header, agent, tool, args, now = Date.now() }) {
  if (header == null || header === '') return 'ACTING_ASSERTION_REQUIRED'
  const m = typeof header === 'string' ? HEADER_RE.exec(header.trim()) : null
  if (!m) return 'ACTING_ASSERTION_MALFORMED'
  const key = publicKeyOf(publicKey)
  if (!key) return 'ACTING_ASSERTION_KEY_MISSING'
  const ts = Number(m[1])
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > ASSERTION_SKEW_MS) return 'ACTING_ASSERTION_STALE'
  let ok = false
  try { ok = crypto.verify(null, Buffer.from(assertionMessage({ agent, tool, args, ts }), 'utf8'), key, Buffer.from(m[2], 'base64url')) } catch { ok = false }
  return ok ? null : 'ACTING_ASSERTION_INVALID'
}
