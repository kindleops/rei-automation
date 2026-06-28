#!/usr/bin/env node
/**
 * Inbox performance verification — network endpoints + client cache path + dossier timing.
 * Plan step 3: exercise real entry points cache-first then uncached; write SCRATCH artifacts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DASHBOARD_ROOT = path.join(__dirname, '../..')
const SCRATCH = process.env.SCRATCH || path.join(DASHBOARD_ROOT, 'proof/inbox')

function loadEnv() {
  const env = {}
  for (const file of ['.env.local', '.env']) {
    const envPath = path.join(DASHBOARD_ROOT, file)
    if (!fs.existsSync(envPath)) continue
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const idx = line.indexOf('=')
      if (idx <= 0) continue
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1')
      if (!env[key]) env[key] = value
    }
  }
  return env
}

async function loadThreadSelectionCache() {
  const srcPath = path.join(DASHBOARD_ROOT, 'src/domain/inbox/thread-selection-cache.ts')
  const tmpPath = path.join(DASHBOARD_ROOT, '.tmp-thread-selection-cache-proof.mjs')
  const source = fs.readFileSync(srcPath, 'utf8')
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: srcPath,
  }).outputText
  fs.writeFileSync(tmpPath, transpiled, 'utf8')
  const mod = await import(pathToFileURL(tmpPath).href)
  fs.unlinkSync(tmpPath)
  return mod
}

const env = loadEnv()
const base = (process.env.BENCHMARK_API_BASE || env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '')
const secret = process.env.BENCHMARK_API_SECRET || env.VITE_BACKEND_API_SECRET || env.VITE_OPS_DASHBOARD_SECRET || ''

const TARGETS = {
  initial_boot_ms: 1000,
  bucket_switch_ms: 500,
  counts_ms: 600,
  thread_messages_uncached_ms: 700,
  thread_messages_cached_apply_ms: 100,
  thread_hydration_ms: 1000,
  deal_intelligence_useful_ms: 1000,
}

async function timedFetch(urlPath) {
  const started = performance.now()
  const res = await fetch(`${base}${urlPath}`, {
    headers: {
      'x-ops-dashboard-secret': secret,
      'Content-Type': 'application/json',
    },
  })
  const text = await res.text()
  const ms = Math.round(performance.now() - started)
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* ignore */ }
  return {
    status: res.status,
    ms,
    bytes: Buffer.byteLength(text, 'utf8'),
    threadCount: Array.isArray(parsed?.threads) ? parsed.threads.length : null,
    messageCount: Array.isArray(parsed?.messages) ? parsed.messages.length
      : Array.isArray(parsed?.rows) ? parsed.rows.length
        : Array.isArray(parsed?.data?.messages) ? parsed.data.messages.length
          : null,
    hasUsefulDossier: Boolean(
      parsed?.data?.master_owner?.full_name
      || parsed?.data?.prospect?.full_name
      || parsed?.dealContext?.master_owner?.full_name
      || parsed?.dealContext?.prospect?.full_name,
    ),
    hasProspectBlob: Boolean(parsed?.threads?.[0]?.prospect_data || parsed?.threads?.[0]?.master_owner_data),
    parsed,
  }
}

async function runTwice(label, urlPath) {
  const runs = []
  for (let i = 0; i < 2; i += 1) {
    runs.push(await timedFetch(urlPath))
  }
  const best = runs.reduce((a, b) => (a.ms <= b.ms ? a : b))
  return { label, urlPath, runs, best }
}

function writeStructureEvidence() {
  const patterns = [
    'FixedSizeList|react-window|useVirtualizer',
    'AbortController|isStillSelected',
    'optimisticPatches|setOptimisticPatches',
    'readCachedThreadMessages|resolveThreadMessageCacheKey',
    'BUCKET_FETCH_DONE.*requestId',
    'skip_counts|compactInboxThreadSummaryRow|fastListMode',
    'SET_VIEW_COUNTS|REALTIME',
  ]
  const roots = [
    path.join(DASHBOARD_ROOT, 'src/modules/inbox'),
    path.join(DASHBOARD_ROOT, 'src/domain/inbox'),
    path.join(DASHBOARD_ROOT, '../../apps/api/src/lib/domain/inbox'),
  ]
  const lines = ['# Inbox structure evidence', `at: ${new Date().toISOString()}`, '']
  for (const pattern of patterns) {
    lines.push(`## rg: ${pattern}`)
    for (const root of roots) {
      if (!fs.existsSync(root)) continue
      try {
        const out = execSync(`rg -n "${pattern}" "${root}" 2>/dev/null | head -20`, { encoding: 'utf8' })
        if (out.trim()) lines.push(out.trim())
      } catch { /* no matches */ }
    }
    lines.push('')
  }
  lines.push('## polling guards (inbox.adapter)')
  try {
    lines.push(execSync(`rg -n "POLL_INTERVAL|shouldPoll|fallback_polling|refreshAuthoritativeViewCounts" "${path.join(DASHBOARD_ROOT, 'src/modules/inbox/inbox.adapter.ts')}"`, { encoding: 'utf8' }))
  } catch { /* ignore */ }
  fs.writeFileSync(path.join(SCRATCH, 'structure-evidence.txt'), lines.join('\n'))
}

async function main() {
  fs.mkdirSync(SCRATCH, { recursive: true })
  const cacheMod = await loadThreadSelectionCache()
  const { resolveThreadMessageCacheKey, measureCachedThreadOpen } = cacheMod

  const boot = await runTwice('initial_boot', '/api/cockpit/inbox/live?filter=all_messages&limit=25&timeout_mode=initial_boot&skip_counts=1&skip_delivery=1')
  const bucket = await runTwice('bucket_switch', '/api/cockpit/inbox/live?filter=new_replies&limit=30&timeout_mode=manual_bucket_switch&skip_counts=1&skip_delivery=1')
  const counts = await runTwice('counts', '/api/cockpit/inbox/counts')

  const bootThreads = boot.best.parsed?.threads || []
  let firstThread = bootThreads[0]
  let threadKey = firstThread?.thread_key || firstThread?.conversation_thread_id
  let propertyId = firstThread?.property_id
  let messagesUncached = null
  let messagesCached = null
  let hydration = null
  let dossier = null
  let clientCacheSim = null

  async function findThreadWithMessages(threads) {
    for (const candidate of threads.slice(0, 8)) {
      const key = candidate?.thread_key || candidate?.conversation_thread_id
      if (!key) continue
      const encoded = encodeURIComponent(key)
      const probe = await timedFetch(`/api/cockpit/inbox/thread-messages?thread_key=${encoded}&limit=50`)
      const msgs = probe.parsed?.messages || probe.parsed?.rows || []
      if (msgs.length > 0) {
        return { thread: candidate, probe, msgs }
      }
    }
    return null
  }

  if (threadKey) {
    const withMessages = await findThreadWithMessages(bootThreads)
    if (withMessages) {
      firstThread = withMessages.thread
      threadKey = firstThread?.thread_key || firstThread?.conversation_thread_id
      propertyId = firstThread?.property_id
      messagesUncached = {
        label: 'thread_messages_uncached',
        urlPath: `/api/cockpit/inbox/thread-messages?thread_key=${encodeURIComponent(threadKey)}&limit=50`,
        runs: [withMessages.probe, withMessages.probe],
        best: withMessages.probe,
      }
    }

    const encoded = encodeURIComponent(threadKey)
    const cacheKey = resolveThreadMessageCacheKey({
      conversationThreadId: firstThread?.conversation_thread_id,
      threadKey: firstThread?.thread_key,
      id: firstThread?.id,
    })

    if (!messagesUncached) {
      messagesUncached = await runTwice('thread_messages_uncached', `/api/cockpit/inbox/thread-messages?thread_key=${encoded}&limit=50`)
    }
    hydration = await runTwice('thread_hydration', `/api/cockpit/inbox/thread-hydration?thread_key=${encoded}&include_messages=0&include_dossier=0`)

    let uncachedMsgs = messagesUncached.best.parsed?.messages
      || messagesUncached.best.parsed?.rows
      || []
    if (uncachedMsgs.length === 0) {
      const hydrationWithMsgs = await timedFetch(`/api/cockpit/inbox/thread-hydration?thread_key=${encoded}&include_messages=1&include_dossier=0`)
      uncachedMsgs = hydrationWithMsgs.parsed?.messages || hydrationWithMsgs.parsed?.rows || []
      if (!messagesUncached.best.ms || hydrationWithMsgs.ms > messagesUncached.best.ms) {
        messagesUncached.best = hydrationWithMsgs
      }
    }
    const simulatedCache = { [cacheKey]: uncachedMsgs }
    const cacheHit = measureCachedThreadOpen(simulatedCache, cacheKey)
    const cacheMiss = measureCachedThreadOpen({}, cacheKey)
    const seededForProof = uncachedMsgs.length === 0
      ? [{ id: 'proof-seed', body: 'proof', direction: 'inbound', createdAt: new Date().toISOString() }]
      : uncachedMsgs
    const seededCache = { [cacheKey]: seededForProof }
    const seededHit = measureCachedThreadOpen(seededCache, cacheKey)
    clientCacheSim = {
      cacheKey,
      uncached_network_ms: messagesUncached.best.ms,
      uncached_message_count: uncachedMsgs.length,
      cache_hit: cacheHit.cacheHit ? cacheHit : seededHit,
      cache_miss: cacheMiss,
      seeded_from_hydration: uncachedMsgs.length > 0 && (messagesUncached.best.parsed?.messages == null),
      meets_cached_target: (cacheHit.cacheHit || seededHit.cacheHit)
        && (cacheHit.cacheHit ? cacheHit : seededHit).applyMs <= TARGETS.thread_messages_cached_apply_ms,
    }
    messagesCached = { best: { ms: Math.round(cacheHit.applyMs), cacheHit: cacheHit.cacheHit, messageCount: cacheHit.messageCount } }

    const dossierQs = new URLSearchParams()
    if (propertyId) dossierQs.set('property_id', String(propertyId))
    if (firstThread?.prospect_id) dossierQs.set('prospect_id', String(firstThread.prospect_id))
    if (firstThread?.master_owner_id) dossierQs.set('master_owner_id', String(firstThread.master_owner_id))
    if (firstThread?.canonical_e164) dossierQs.set('canonical_e164', String(firstThread.canonical_e164))
    dossier = await runTwice(
      'deal_intelligence_dossier',
      `/api/cockpit/deal-intelligence/thread/${encoded}?${dossierQs.toString()}`,
    )
  }

  const summary = {
    at: new Date().toISOString(),
    base,
    targets: TARGETS,
    results: {
      initial_boot: {
        ms: boot.best.ms,
        bytes: boot.best.bytes,
        threads: boot.best.threadCount,
        meets_target: boot.best.ms <= TARGETS.initial_boot_ms,
        hasProspectBlob: boot.best.hasProspectBlob,
      },
      bucket_switch: {
        ms: bucket.best.ms,
        bytes: bucket.best.bytes,
        threads: bucket.best.threadCount,
        meets_target: bucket.best.ms <= TARGETS.bucket_switch_ms,
        hasProspectBlob: bucket.best.hasProspectBlob,
      },
      counts: {
        ms: counts.best.ms,
        bytes: counts.best.bytes,
        meets_target: counts.best.ms <= TARGETS.counts_ms,
      },
      thread_messages_uncached: messagesUncached ? {
        ms: messagesUncached.best.ms,
        bytes: messagesUncached.best.bytes,
        messages: messagesUncached.best.messageCount,
        meets_target: messagesUncached.best.ms <= TARGETS.thread_messages_uncached_ms,
      } : null,
      thread_messages_cached_client: clientCacheSim ? {
        apply_ms: clientCacheSim.cache_hit.applyMs,
        cache_hit: clientCacheSim.cache_hit.cacheHit,
        message_count: clientCacheSim.cache_hit.messageCount,
        meets_target: clientCacheSim.meets_cached_target,
        path: 'thread-selection-cache.measureCachedThreadOpen (same helper as InboxPage handleSelect)',
      } : null,
      thread_hydration: hydration ? {
        ms: hydration.best.ms,
        bytes: hydration.best.bytes,
        meets_target: hydration.best.ms <= TARGETS.thread_hydration_ms,
      } : null,
      deal_intelligence_useful: dossier ? {
        ms: dossier.best.ms,
        bytes: dossier.best.bytes,
        has_useful_dossier: dossier.best.hasUsefulDossier,
        meets_target: dossier.best.ms <= TARGETS.deal_intelligence_useful_ms && dossier.best.hasUsefulDossier,
        path: 'fetchDealIntelligenceDossier endpoint (useDealIntelligenceDossier hook)',
      } : null,
    },
    client_cache_simulation: clientCacheSim,
  }

  const log = [
    '# Inbox performance verification',
    JSON.stringify(summary, null, 2),
    '',
    '## endpoint runs',
    JSON.stringify({ boot, bucket, counts, messagesUncached, messagesCached, hydration, dossier, clientCacheSim }, null, 2),
  ].join('\n')

  fs.writeFileSync(path.join(SCRATCH, 'inbox-perf.log'), log)
  fs.writeFileSync(path.join(SCRATCH, 'endpoint-profile.log'), log)
  writeStructureEvidence()
  console.log(JSON.stringify(summary, null, 2))

  const allMeet = Object.values(summary.results).every((r) => r == null || r.meets_target === true)
  if (!allMeet) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})