/**
 * SEARCH INTELLIGENCE — server-only secret store (§34).
 *
 * The only place a Search Intelligence connector may obtain a credential.
 * A connection row stores a secret REFERENCE (an env-var-shaped NAME such as
 * SI_GSC_PROMINENT), never the secret. This module:
 *   - resolves a reference to its value from the server environment only;
 *   - refuses references that are not reference-shaped (so a key pasted into
 *     a DB row can never be "resolved");
 *   - exposes `describe()` for status surfaces, which reports presence only.
 * No value is logged, returned to a route, or sent to the browser. V1 has no
 * configured secret; every reference resolves to "not configured".
 */

const REF = /^SI_[A-Z0-9_]{2,60}$/;

export function isSecretRef(ref) {
  return typeof ref === 'string' && REF.test(ref);
}

/** Looks like key material rather than a reference — refused everywhere. */
export function looksLikeSecretMaterial(value) {
  if (typeof value !== 'string') return false;
  return /-----BEGIN|private_key|"type"\s*:\s*"service_account"|^ya29\.|^1\/\/|AIza[0-9A-Za-z_-]{20,}/.test(value) || value.length > 200;
}

export function createSecretStore(env = process.env) {
  return {
    /** Presence only — safe for status surfaces. */
    describe(ref) {
      if (!isSecretRef(ref)) return { ref: null, configured: false, reason: 'invalid_reference' };
      const v = env[ref];
      return { ref, configured: typeof v === 'string' && v.length > 0, reason: typeof v === 'string' && v.length > 0 ? null : 'not_configured' };
    },
    /** The value, for a connector's own outbound call. Never return it to a caller that renders. */
    resolve(ref) {
      if (!isSecretRef(ref)) throw Object.assign(new Error('invalid secret reference'), { code: 'invalid_reference' });
      const v = env[ref];
      if (typeof v !== 'string' || !v.length) throw Object.assign(new Error('secret not configured'), { code: 'not_configured' });
      return v;
    },
  };
}
