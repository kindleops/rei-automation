/**
 * URL safety for the Browser. Only http/https ever leave this module.
 * - javascript:, data:, file:, blob:, about:, chrome:, view-source: … are rejected.
 * - user:pass@host URLs are rejected (classic phishing spoof "https://bank.com@evil.tld").
 * - The host returned is the WHATWG-normalized ASCII (punycode) host, so a homograph
 *   domain is shown as xn--… rather than a lookalike.
 */
import type { SanitizeResult } from './types'

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/

export function sanitizeUrl(raw: string | null | undefined): SanitizeResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid_url' }
  // Browsers strip tabs/newlines inside URLs ("java\nscript:") — reject instead of guessing.
  const text = raw.trim()
  if (!text || CONTROL.test(text)) return { ok: false, reason: 'invalid_url' }
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'unsafe_scheme' }
  if (u.username || u.password) return { ok: false, reason: 'credentials_in_url' }
  if (!u.hostname || !/^[a-z0-9.-]+$/i.test(u.hostname.replace(/^\[|\]$/g, '').replace(/:/g, ''))) {
    return { ok: false, reason: 'invalid_url' }
  }
  return { ok: true, url: u.href, host: u.hostname.toLowerCase(), insecure: u.protocol === 'http:' }
}

/** The real host to display in chrome (anti-spoofing). Empty string for unsafe/invalid URLs. */
export function displayHost(raw: string | null | undefined): string {
  const r = sanitizeUrl(raw)
  if (!r.ok) return ''
  return r.host.replace(/^www\./, '')
}

/** True when `host` equals one of `hosts` exactly (no suffix matching — avoids evil-hennepin.us). */
export function hostIn(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase()
  return hosts.some((x) => x.toLowerCase() === h)
}
