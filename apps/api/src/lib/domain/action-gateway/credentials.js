// Agent credentials. An agent presents `lcag_<43 base64url chars>` (256 random bits). The gateway never
// stores it: it computes HMAC-SHA256(pepper, token) and the database looks the principal up by that
// digest (public.action_gateway_principal, SECURITY DEFINER: the gateway role cannot enumerate digests).
// The pepper is a 0600 file on the gateway host; a database dump alone cannot mint or test credentials.
// Credentials are verified SERVER-SIDE on every call; nothing in a tool argument selects an identity.
import crypto from 'node:crypto'

export const AGENT_CREDENTIAL_RE = /^lcag_[A-Za-z0-9_-]{43}$/
// SERVICE credentials (one administratively managed integration acting for registered delegate agents): a distinct
// prefix, the same 256 random bits, the same pepper and the same HMAC-SHA256 digest at rest
// (action_gateway.service_principals.credential_digest). A service credential is never an agent credential.
export const SERVICE_CREDENTIAL_RE = /^lcsvc_[A-Za-z0-9_-]{43}$/
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

/** Digest of a presented SERVICE credential; null when it is not service-credential-shaped. */
export function serviceCredentialDigest(pepper, token) {
  if (typeof token !== 'string' || !SERVICE_CREDENTIAL_RE.test(token)) return null
  return crypto.createHmac('sha256', assertPepper(pepper)).update(token, 'utf8').digest('hex')
}

/** Which kind of credential a presented token is shaped as: 'agent', 'service' or null (never throws, never logs). */
export const credentialKind = (token) => (typeof token !== 'string' ? null : AGENT_CREDENTIAL_RE.test(token) ? 'agent' : SERVICE_CREDENTIAL_RE.test(token) ? 'service' : null)

/** A new SERVICE credential + its digest (the OWNER mints; the token is shown once and never stored). */
export function mintServiceCredential(pepper) {
  const token = `lcsvc_${crypto.randomBytes(32).toString('base64url')}`
  return { token, digest: serviceCredentialDigest(pepper, token) }
}

/** A new credential + its digest (the OWNER mints; the token is shown once and never stored). */
export function mintAgentCredential(pepper) {
  const token = `lcag_${crypto.randomBytes(32).toString('base64url')}`
  return { token, digest: credentialDigest(pepper, token) }
}
