// Agent credentials. An agent presents `lcag_<43 base64url chars>` (256 random bits). The gateway never
// stores it: it computes HMAC-SHA256(pepper, token) and the database looks the principal up by that
// digest (public.action_gateway_principal, SECURITY DEFINER: the gateway role cannot enumerate digests).
// The pepper is a 0600 file on the gateway host; a database dump alone cannot mint or test credentials.
// Credentials are verified SERVER-SIDE on every call; nothing in a tool argument selects an identity.
import crypto from 'node:crypto'

export const AGENT_CREDENTIAL_RE = /^lcag_[A-Za-z0-9_-]{43}$/
export const PEPPER_MIN_BYTES = 32

export function assertPepper(pepper) {
  const p = Buffer.isBuffer(pepper) ? pepper : Buffer.from(String(pepper || ''), 'utf8')
  if (p.length < PEPPER_MIN_BYTES) throw Object.assign(new Error('the credential pepper must be at least 32 bytes'), { code: 'PEPPER_INVALID' })
  return p
}

/** Digest of a presented credential; null when it is not credential-shaped (never throws, never logs). */
export function credentialDigest(pepper, token) {
  if (typeof token !== 'string' || !AGENT_CREDENTIAL_RE.test(token)) return null
  return crypto.createHmac('sha256', assertPepper(pepper)).update(token, 'utf8').digest('hex')
}

/** A new credential + its digest (the OWNER mints; the token is shown once and never stored). */
export function mintAgentCredential(pepper) {
  const token = `lcag_${crypto.randomBytes(32).toString('base64url')}`
  return { token, digest: credentialDigest(pepper, token) }
}
