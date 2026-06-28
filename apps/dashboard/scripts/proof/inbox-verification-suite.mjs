#!/usr/bin/env node
/**
 * Unified inbox verification — single pass gate on observed metrics.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync, spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DASHBOARD_ROOT = path.join(__dirname, '../..')
const API_ROOT = path.join(DASHBOARD_ROOT, '../api')
const SCRATCH = process.env.SCRATCH || path.join(DASHBOARD_ROOT, 'proof/inbox')

function run(cmd, cwd, logFile) {
  const started = Date.now()
  try {
    const out = execSync(cmd, { cwd, env: { ...process.env, SCRATCH }, encoding: 'utf8', stdio: 'pipe' })
    fs.writeFileSync(logFile, out)
    return { ok: true, ms: Date.now() - started, out }
  } catch (err) {
    const out = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message}`
    fs.writeFileSync(logFile, out)
    return { ok: false, ms: Date.now() - started, out }
  }
}

function readJson(file) {
  if (!fs.existsSync(file)) return null
  const raw = fs.readFileSync(file, 'utf8')
  try { return JSON.parse(raw) } catch { /* fall through */ }
  const summaryMatch = raw.match(/\{\s*"at":[\s\S]*\}\s*$/m)
  if (summaryMatch) {
    try { return JSON.parse(summaryMatch[0]) } catch { /* fall through */ }
  }
  return null
}

async function main() {
  fs.mkdirSync(SCRATCH, { recursive: true })
  const steps = {}

  steps.seller = run('npm run proof:seller-inbound-orchestration', API_ROOT, path.join(SCRATCH, 'seller-proof.log'))
  steps.inbox_units = run(
    'NODE_ENV=test node --import ./tests/register-aliases.mjs --test tests/critical/inbox-compact-row-regression.test.mjs tests/critical/inbox-live-v2-service.test.mjs tests/critical/inbox-bucket-counting.test.mjs tests/critical/inbox-canonical-row-contract.test.mjs',
    API_ROOT,
    path.join(SCRATCH, 'inbox-units.log'),
  )
  steps.endpoint_perf = run('node scripts/proof/inbox-perf-verification.mjs', DASHBOARD_ROOT, path.join(SCRATCH, 'endpoint-profile.log'))
  steps.poll_scheduler = run('npx tsx scripts/proof/inbox-poll-scheduler.test.ts', DASHBOARD_ROOT, path.join(SCRATCH, 'inbox-poll-scheduler.log'))
  steps.thread_session = run('npx tsx scripts/proof/inbox-thread-session-proof.ts', DASHBOARD_ROOT, path.join(SCRATCH, 'inbox-thread-session.log'))
  steps.client_path = run('node scripts/proof/inbox-client-path-proof.mjs', DASHBOARD_ROOT, path.join(SCRATCH, 'inbox-client-path-suite.log'))
  steps.headless = run('node scripts/proof/inbox-headless-verification.mjs', DASHBOARD_ROOT, path.join(SCRATCH, 'inbox-headless-suite.log'))

  const threadSession = readJson(path.join(SCRATCH, 'inbox-thread-session.log'))
  const clientPath = readJson(path.join(SCRATCH, 'inbox-client-path.log'))
  const headless = readJson(path.join(SCRATCH, 'inbox-headless.log'))

  const pass = steps.seller.ok
    && steps.inbox_units.ok
    && steps.endpoint_perf.ok
    && steps.poll_scheduler.ok
    && steps.thread_session.ok
    && steps.client_path.ok
    && steps.headless.ok
    && clientPath?.pass === true
    && headless?.pass === true
    && threadSession?.meets_targets
    && Object.values(threadSession.meets_targets).every(Boolean)

  const summary = {
    at: new Date().toISOString(),
    scratch: SCRATCH,
    steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { ok: v.ok, ms: v.ms }])),
    thread_session_meets: threadSession?.meets_targets ?? null,
    client_path_pass: clientPath?.pass ?? null,
    headless_pass: headless?.pass ?? null,
    headless_best: headless?.best ? {
      firstRowDomMs: headless.best.firstRowDomMs,
      firstRowVisibleMs: headless.best.firstRowVisibleMs,
      lastUncachedMessagesMs: headless.best.lastUncachedMessagesMs,
      lastBucketSwitchMs: headless.best.proof?.lastBucketSwitchMs,
      lastThreadSelectCacheApplyMs: headless.best.proof?.lastThreadSelectCacheApplyMs,
    } : null,
    pass,
  }

  fs.writeFileSync(path.join(SCRATCH, 'inbox-verification-suite.log'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  if (!pass) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})