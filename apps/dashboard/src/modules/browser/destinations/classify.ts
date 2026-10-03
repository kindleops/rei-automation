/**
 * classifyUrl — embed mode for ANY URL (typed, clicked, or from a destination) by exact-host
 * allowlist derived from the audited registry. Unknown hosts → UNKNOWN, which the Browser
 * must treat as "open externally" until proven embeddable.
 */
import type { EmbedMode, SandboxFlag, UrlClassification } from './types'
import { DESTINATIONS } from './registry-data'
import { sanitizeUrl } from './sanitize'

interface HostEntry { embed: EmbedMode; sandbox?: readonly SandboxFlag[]; destination_id: string }

/**
 * Host → audited embed mode. When records disagree for a host (different paths behave
 * differently), the most restrictive verdict wins.
 */
const SEVERITY: Record<EmbedMode, number> = { EMBEDS: 0, UNKNOWN: 1, AUTH: 2, EXTERNAL_ONLY: 3, BLOCKED: 4 }
const HOSTS = new Map<string, HostEntry>()
for (const d of DESTINATIONS) {
  for (const h of d.hosts) {
    const host = h.toLowerCase()
    const prev = HOSTS.get(host)
    if (!prev || SEVERITY[d.embed] > SEVERITY[prev.embed]) {
      HOSTS.set(host, { embed: d.embed, ...(d.embed === 'EMBEDS' && d.sandbox ? { sandbox: d.sandbox } : {}), destination_id: d.id })
    }
  }
}

/** Hosts PROVEN embeddable — the only candidates for LC's frame-src allowlist. */
export const EMBED_ALLOWLIST: readonly string[] = [...HOSTS.entries()].filter(([, e]) => e.embed === 'EMBEDS').map(([h]) => h).sort()

/** Exact origins for an explicit, minimal CSP `frame-src` (https only). */
export function frameSrcOrigins(): string[] {
  return EMBED_ALLOWLIST.map((h) => `https://${h}`)
}

export function classifyUrl(raw: string): UrlClassification {
  const s = sanitizeUrl(raw)
  if (!s.ok) return { ok: false, embed: 'BLOCKED', reason: s.reason }
  const entry = HOSTS.get(s.host)
  // Plain-http pages never embed inside the HTTPS cockpit (mixed content); open externally.
  if (!entry || s.insecure) return { ok: true, url: s.url, host: s.host, insecure: s.insecure, embed: s.insecure && entry ? 'EXTERNAL_ONLY' : 'UNKNOWN', ...(entry ? { destination_id: entry.destination_id } : {}) }
  return { ok: true, url: s.url, host: s.host, insecure: false, embed: entry.embed, ...(entry.sandbox ? { sandbox: entry.sandbox } : {}), destination_id: entry.destination_id }
}
