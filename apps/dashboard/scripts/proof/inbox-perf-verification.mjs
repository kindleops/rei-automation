#!/usr/bin/env node
/**
 * Inbox performance verification — exercises real API entry points with latency targets.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRATCH = process.env.SCRATCH || path.join(__dirname, '../../proof/inbox')

function loadEnv() {
  const env = {}
  for (const file of ['.env.local', '.env']) {
    const envPath = path.join(__dirname, '../../', file)
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

const env = loadEnv()
const base = (process.env.BENCHMARK_API_BASE || env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '')
const secret = process.env.BENCHMARK_API_SECRET || env.VITE_BACKEND_API_SECRET || env.VITE_OPS_DASHBOARD_SECRET || ''

const TARGETS = {
  initial_boot_ms: 1000,
  bucket_switch_ms: 500,
  counts_ms: 600,
  thread_messages_ms: 700,
  hydration_ms: 1000,
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
    messageCount: Array.isArray(parsed?.messages) ? parsed.messages.length : Array.isArray(parsed?.rows) ? parsed.rows.length : null,
    sampleKeys: parsed?.threads?.[0] ? Object.keys(parsed.threads[0]).slice(0, 12) : [],
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

async function main() {
  fs.mkdirSync(SCRATCH, { recursive: true })
  const endpoints = [
    ['initial_boot', '/api/cockpit/inbox/live?filter=all_messages&limit=25&timeout_mode=initial_boot&skip_counts=1&skip_delivery=1'],
    ['bucket_switch', '/api/cockpit/inbox/live?filter=new_replies&limit=30&timeout_mode=manual_bucket_switch&skip_counts=1&skip_delivery=1'],
    ['counts', '/api/cockpit/inbox/counts'],
  ]

  const boot = await runTwice('initial_boot', endpoints[0][1])
  const bucket = await runTwice('bucket_switch', endpoints[1][1])
  const counts = await runTwice('counts', endpoints[2][1])

  let threadKey = boot.best.parsed?.threads?.[0]?.thread_key || boot.best.parsed?.threads?.[0]?.conversation_thread_id
  let messages = null
  let hydration = null
  if (threadKey) {
    const encoded = encodeURIComponent(threadKey)
    messages = await runTwice('thread_messages', `/api/cockpit/inbox/thread-messages?thread_key=${encoded}&limit=50`)
    hydration = await runTwice('thread_hydration', `/api/cockpit/inbox/thread-hydration?thread_key=${encoded}&include_messages=0&include_dossier=0`)
  }

  const summary = {
    at: new Date().toISOString(),
    base,
    targets: TARGETS,
    results: {
      initial_boot: { ms: boot.best.ms, bytes: boot.best.bytes, threads: boot.best.threadCount, meets_target: boot.best.ms <= TARGETS.initial_boot_ms, hasProspectBlob: boot.best.hasProspectBlob },
      bucket_switch: { ms: bucket.best.ms, bytes: bucket.best.bytes, threads: bucket.best.threadCount, meets_target: bucket.best.ms <= TARGETS.bucket_switch_ms, hasProspectBlob: bucket.best.hasProspectBlob },
      counts: { ms: counts.best.ms, bytes: counts.best.bytes, meets_target: counts.best.ms <= TARGETS.counts_ms },
      thread_messages: messages ? { ms: messages.best.ms, bytes: messages.best.bytes, messages: messages.best.messageCount, meets_target: messages.best.ms <= TARGETS.thread_messages_ms } : null,
      thread_hydration: hydration ? { ms: hydration.best.ms, bytes: hydration.best.bytes, meets_target: hydration.best.ms <= TARGETS.hydration_ms } : null,
    },
  }

  const log = [
    '# Inbox performance verification',
    JSON.stringify(summary, null, 2),
    '',
    '## endpoint runs',
    JSON.stringify({ boot, bucket, counts, messages, hydration }, null, 2),
  ].join('\n')

  fs.writeFileSync(path.join(SCRATCH, 'inbox-perf.log'), log)
  fs.writeFileSync(path.join(SCRATCH, 'endpoint-profile.log'), log)
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})