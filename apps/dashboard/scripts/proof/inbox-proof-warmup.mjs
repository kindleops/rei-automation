import fs from 'node:fs'
import path from 'node:path'

export function loadDashboardEnv(dashboardRoot) {
  for (const name of ['.env.local', '.env']) {
    const envPath = path.join(dashboardRoot, name)
    if (!fs.existsSync(envPath)) continue
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const idx = line.indexOf('=')
      if (idx <= 0) continue
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1')
      if (!process.env[key]) process.env[key] = value
    }
  }
}

export function getOpsSecret() {
  return process.env.BENCHMARK_API_SECRET
    || process.env.VITE_OPS_DASHBOARD_SECRET
    || process.env.VITE_BACKEND_API_SECRET
    || ''
}

function warmupHeaders() {
  const secret = getOpsSecret()
  return secret ? { 'x-ops-dashboard-secret': secret } : {}
}

async function fetchWarm(baseUrl, path, iterations = 2) {
  const headers = warmupHeaders()
  for (let i = 0; i < iterations; i += 1) {
    try {
      await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(12_000) })
    } catch { /* ignore */ }
  }
}

function pick(row, ...keys) {
  for (const key of keys) {
    const value = row?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function resolveThreadKey(row) {
  if (!row || typeof row !== 'object') return null
  return row.conversation_thread_id
    || row.conversationThreadId
    || row.canonical_thread_key
    || row.id
    || row.thread_key
    || row.threadKey
    || null
}

/** Mirror shipped thread-messages query shape so dev JIT warms the real browser path. */
export function buildThreadMessagesWarmupPath(row) {
  const threadKey = resolveThreadKey(row)
  if (!threadKey) return null
  const conversationThreadId = pick(row, 'conversation_thread_id', 'conversationThreadId', 'canonical_thread_key', 'id')
  const rowThreadKey = pick(row, 'thread_key', 'threadKey')
  const legacyThreadKey = pick(row, 'legacy_thread_key', 'legacyThreadKey') || (rowThreadKey && !rowThreadKey.startsWith('ct:') ? rowThreadKey : '')
  const canonicalE164 = pick(row, 'canonical_e164', 'canonicalE164')
  const phone = pick(row, 'phone', 'phone_number', 'phoneNumber', 'seller_phone', 'sellerPhone', 'display_phone', 'displayPhone')
  const bestPhone = pick(row, 'best_phone', 'bestPhone')
  const sellerPhone = pick(row, 'seller_phone', 'sellerPhone')
  const normalizedPhone = pick(row, 'normalized_phone', 'normalizedPhone') || canonicalE164 || phone || bestPhone || sellerPhone
  const propertyId = pick(row, 'property_id', 'propertyId')
  const prospectId = pick(row, 'prospect_id', 'prospectId')
  const masterOwnerId = pick(row, 'master_owner_id', 'masterOwnerId', 'owner_id', 'ownerId')

  const params = new URLSearchParams()
  params.set('offset', '0')
  params.set('limit', '50')
  if (conversationThreadId) params.set('conversation_thread_id', conversationThreadId)
  if (legacyThreadKey) params.set('legacy_thread_key', legacyThreadKey)
  if (normalizedPhone) params.set('normalized_phone', normalizedPhone)
  if (canonicalE164) {
    params.set('canonical_e164', canonicalE164)
    params.set('phone_e164', canonicalE164)
  }
  if (phone) params.set('phone', phone)
  if (bestPhone) params.set('best_phone', bestPhone)
  if (sellerPhone) params.set('seller_phone', sellerPhone)
  if (propertyId) params.set('property_id', propertyId)
  if (prospectId) params.set('prospect_id', prospectId)
  if (masterOwnerId) {
    params.set('master_owner_id', masterOwnerId)
    params.set('owner_id', masterOwnerId)
  }

  return `/api/cockpit/inbox/thread-messages?thread_key=${encodeURIComponent(threadKey)}&${params.toString()}`
}

/**
 * Warm API JIT + connection paths before browser proofs.
 * Requires ops secret from dashboard .env.local when using preview proxy.
 */
export async function warmThreadMessagesInBrowser(page, baseUrl, rowIndex = 1) {
  const headers = warmupHeaders()
  try {
    const livePath = '/api/cockpit/inbox/live?limit=10&skip_counts=1&skip_delivery=1&timeout_mode=initial_boot'
    const live = await fetch(`${baseUrl}${livePath}`, { headers, signal: AbortSignal.timeout(12_000) })
    const payload = await live.json()
    const threads = payload?.threads ?? payload?.data?.threads ?? []
    const row = threads[rowIndex] ?? threads[0]
    const msgPath = buildThreadMessagesWarmupPath(row)
    if (!msgPath) return
    const secret = getOpsSecret()
    await page.evaluate(async ({ url, secret }) => {
      const hdrs = secret ? { 'x-ops-dashboard-secret': secret } : {}
      for (let i = 0; i < 3; i += 1) {
        try {
          await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(12_000) })
        } catch { /* ignore */ }
      }
    }, { url: `${baseUrl}${msgPath}`, secret })
  } catch { /* ignore */ }
}

export async function warmupInboxApi(baseUrl) {
  await fetchWarm(baseUrl, '/api/cockpit/health', 2)
  const livePath = '/api/cockpit/inbox/live?limit=10&skip_counts=1&skip_delivery=1&timeout_mode=initial_boot'
  await fetchWarm(baseUrl, livePath, 3)

  try {
    const headers = warmupHeaders()
    const live = await fetch(`${baseUrl}${livePath}`, { headers, signal: AbortSignal.timeout(12_000) })
    const payload = await live.json()
    const threads = payload?.threads ?? payload?.data?.threads ?? []
    for (const row of threads.slice(0, 3)) {
      const msgPath = buildThreadMessagesWarmupPath(row)
      if (msgPath) await fetchWarm(baseUrl, msgPath, 4)
    }
  } catch { /* ignore */ }
}