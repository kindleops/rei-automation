// Sealed conversation references. Inbox thread keys ARE phone numbers (E.164),
// so neither the model, the approval record nor the audit ever holds one: they
// hold `thr_<letters>`, an AES-256-GCM seal of the thread key under a server
// secret. The encoding uses only the letters a–p (one per hex nibble), so a ref
// can never look like a phone number to agent.payload_is_clean().
//
// Properties that matter for safety:
//   * opaque: the model cannot read or reconstruct the phone;
//   * unforgeable: a ref the model invents (or copies out of a message body)
//     fails authentication and is refused — the agent can only act on threads
//     a server read returned;
//   * bound: the org id is the GCM additional data, so a ref minted for one org
//     never opens in another.
import crypto from 'node:crypto'
import { AgentError } from '../runtime/store.js'

const PREFIX = 'thr_'
const enc = (buf) => buf.toString('hex').replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)])
const dec = (s) => Buffer.from(s.replace(/[a-p]/g, (c) => 'abcdefghijklmnop'.indexOf(c).toString(16)), 'hex')

function keyFor(secret) {
  const s = String(secret || '')
  if (s.length < 16) throw new AgentError('THREAD_REF_SECRET_REQUIRED', 'a ≥16-char secret is required to seal thread refs')
  return crypto.createHash('sha256').update(`lc.agent.thread_ref.v1|${s}`).digest()
}

export function createThreadRefCodec({ secret }) {
  const key = keyFor(secret)
  return Object.freeze({
    seal(thread_key, org_id) {
      const iv = crypto.randomBytes(12)
      const c = crypto.createCipheriv('aes-256-gcm', key, iv)
      c.setAAD(Buffer.from(String(org_id)))
      const ct = Buffer.concat([c.update(String(thread_key), 'utf8'), c.final()])
      return `${PREFIX}${enc(Buffer.concat([iv, c.getAuthTag(), ct]))}`
    },
    /** @returns {string|null} the thread key, or null when the ref is forged / foreign / malformed */
    open(ref, org_id) {
      const s = String(ref || '')
      if (!s.startsWith(PREFIX) || !/^[a-p]+$/.test(s.slice(PREFIX.length)) || s.length > 400) return null
      try {
        const raw = dec(s.slice(PREFIX.length))
        if (raw.length < 29) return null
        const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
        d.setAAD(Buffer.from(String(org_id)))
        d.setAuthTag(raw.subarray(12, 28))
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
      } catch {
        return null
      }
    },
  })
}

export const THREAD_REF_SCHEMA = Object.freeze({ type: 'string', minLength: 30, maxLength: 400, pattern: '^thr_[a-p]+$' })
