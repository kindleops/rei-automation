/**
 * Scheduling core — encryption of calendar credentials at rest.
 *
 * AES-256-GCM in the API process; the database only ever stores ciphertext.
 * Keys come from SCHEDULING_TOKEN_KEYS, a JSON map of key id → base64 32-byte
 * key, and SCHEDULING_TOKEN_ACTIVE_KEY names the one used for new writes. Old
 * keys stay in the map until every row has been re-encrypted, so rotation
 * needs no downtime. Plaintext tokens are never logged or returned.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class TokenCryptoError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function keyring(env = process.env) {
  let keys;
  try {
    keys = JSON.parse(String(env.SCHEDULING_TOKEN_KEYS || '{}'));
  } catch {
    throw new TokenCryptoError('token_keys_invalid');
  }
  const active = String(env.SCHEDULING_TOKEN_ACTIVE_KEY || '').trim();
  const decoded = {};
  for (const [id, b64] of Object.entries(keys)) {
    const key = Buffer.from(String(b64), 'base64');
    if (key.length !== 32) throw new TokenCryptoError('token_key_wrong_length');
    decoded[id] = key;
  }
  return { keys: decoded, active };
}

export function tokenCryptoConfigured(env = process.env) {
  try {
    const { keys, active } = keyring(env);
    return Boolean(active && keys[active]);
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext, env = process.env) {
  const { keys, active } = keyring(env);
  if (!active || !keys[active]) throw new TokenCryptoError('token_keys_not_configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys[active], iv);
  cipher.setAAD(Buffer.from(`scheduling:${active}`));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: ['v1', active, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.'), keyId: active };
}

export function decryptSecret(ciphertext, env = process.env) {
  const [v, id, iv, tag, ct] = String(ciphertext || '').split('.');
  if (v !== 'v1' || !id || !iv || !tag || !ct) throw new TokenCryptoError('token_ciphertext_invalid');
  const { keys } = keyring(env);
  if (!keys[id]) throw new TokenCryptoError('token_key_missing');
  try {
    const decipher = createDecipheriv('aes-256-gcm', keys[id], Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`scheduling:${id}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new TokenCryptoError('token_decrypt_failed');
  }
}
