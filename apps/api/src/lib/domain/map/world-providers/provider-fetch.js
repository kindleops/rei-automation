/**
 * WORLD PROVIDERS — the only way LeadCommand's server reaches a third-party
 * public source (camera networks, public-safety feeds, weather alerts).
 *
 * Every request is to a host the provider's registry entry allowlists: https
 * only (unless the registry says an agency serves http alone), no credentials
 * in the URL, no IP literals or single-label hosts, default port. Requests are
 * timed out and size-capped, and an error never carries the upstream URL —
 * a keyed URL must not reach a log line or a client. There is no endpoint
 * anywhere that fetches a URL a caller supplies.
 */

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
export const USER_AGENT = 'LeadCommand-WorldProviders/1.0 (+https://ops.leadcommand.ai)'

/** True when `host` is allowed: exact entry, or on a dot boundary of a ".suffix" entry. */
export function hostAllowed(host, allowlist = []) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '')
  if (!h) return false
  return allowlist.some((entry) => {
    const e = String(entry || '').toLowerCase().trim()
    if (!e) return false
    if (e.startsWith('.')) return h.endsWith(e) && h.length > e.length
    return h === e
  })
}

/** Is this URL one we are willing to request for this provider? { ok, url } | { ok:false, reason } */
export function validateUpstreamUrl(raw, provider, { hosts = provider?.image_hosts } = {}) {
  let u
  try { u = new URL(String(raw || '')) } catch { return { ok: false, reason: 'unparseable_url' } }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && provider?.allow_http === true)) return { ok: false, reason: 'scheme_not_allowed' }
  if (u.username || u.password) return { ok: false, reason: 'credentials_in_url' }
  const host = u.hostname.toLowerCase()
  if (!host || host === 'localhost' || !host.includes('.') || IPV4.test(host) || host.startsWith('[') || host.includes(':')) return { ok: false, reason: 'host_not_allowed' }
  if (u.port && !(provider?.allowed_ports || []).includes(u.port)) return { ok: false, reason: 'port_not_allowed' }
  if (!hostAllowed(host, hosts)) return { ok: false, reason: 'host_not_allowed' }
  return { ok: true, url: u.toString() }
}

const scrub = (msg) => String(msg || '').replace(/https?:\/\/\S+/g, '<url>').slice(0, 300)

async function readTextCapped(res, max) {
  const len = Number(res.headers.get('content-length'))
  if (Number.isFinite(len) && len > max) throw new Error('response_too_large')
  const text = await res.text()
  if (text.length > max) throw new Error('response_too_large')
  return text
}

/**
 * Fetch helpers handed to an adapter: metadata hosts only, timed out,
 * size-capped. `json` / `text` / `buffer` throw scrubbed errors.
 */
export function makeProviderFetch(provider, { fetchImpl = globalThis.fetch, timeoutMs = 45_000, maxBytes = 40 * 1024 * 1024, userAgent = USER_AGENT } = {}) {
  const get = async (url, { headers = {}, accept = '*/*' } = {}) => {
    const v = validateUpstreamUrl(url, provider, { hosts: provider.metadata_hosts })
    if (!v.ok) throw new Error(`source_${v.reason}`)
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(v.url, { redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': userAgent, Accept: accept, ...headers } })
      if (res.url && res.url !== v.url && !validateUpstreamUrl(res.url, provider, { hosts: provider.metadata_hosts }).ok) throw new Error('source_redirected_off_allowlist')
      if (!res.ok) throw new Error(`source_http_${res.status}`)
      return res
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('source_timeout')
      throw new Error(scrub(error?.message || 'source_fetch_failed'))
    } finally { clearTimeout(t) }
  }
  return {
    json: async (url, o) => JSON.parse(await readTextCapped(await get(url, { ...o, accept: 'application/json, application/geo+json' }), maxBytes)),
    text: async (url, o) => readTextCapped(await get(url, o), maxBytes),
    buffer: async (url, o) => {
      const buf = Buffer.from(await (await get(url, o)).arrayBuffer())
      if (buf.length > maxBytes) throw new Error('response_too_large')
      return buf
    },
  }
}

export { scrub as scrubProviderError }
