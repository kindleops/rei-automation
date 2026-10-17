/**
 * Shared critical-test environment contract.
 * - Blocks unmocked external network by default
 * - Resets env snapshot between test files
 * - Isolates the on-disk runtime-state store per test process
 */
// MUST run before any src/ module resolves the runtime-state root: the shared
// /tmp root leaked system-control caches and per-instance ledgers across test
// processes, producing order-dependent claim-containment results.
process.env.RUNTIME_STATE_ROOT = `/tmp/rea-runtime-state-test-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

import { after, before, beforeEach } from 'node:test'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { __setDeps as setNotificationIntelligenceDeps } from '../../src/lib/domain/notifications/notification-intelligence-service.js'
import {
  clearSystemControlCache,
  primeSystemControlCache,
  primeSystemControlValue,
} from '../../src/lib/system-control.js'

// AUTOMATION HOLD test seam (P0 2026-10-16). Production resolves holds through
// the automation_hold_for RPC and FAILS CLOSED when it cannot (no client / no
// rpc / error). The ~800 legacy suites use bespoke Supabase fakes with no rpc,
// so without this seam every one of them would read "held". Default: no holds.
// The hold suites (automation-hold-*.test.mjs) clear this seam and exercise the
// real fail-closed resolver against fakes that implement the RPC.
__setAutomationHoldResolverForTests(() => ({ held: false, fail_closed: false, holds: [], hold_ids: [], reason: null, source: 'test_default_no_holds' }))

const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
])

const originalFetch = globalThis.fetch
const envSnapshot = { ...process.env }
delete envSnapshot.SUPABASE_URL
delete envSnapshot.SUPABASE_SERVICE_ROLE_KEY
delete envSnapshot.SUPABASE_ANON_KEY
let fetchGuardInstalled = false
let activeFile = null

/** Env keys set at test-file module scope (e.g. Discord role fixtures) must survive per-test reset. */
const PRESERVED_ENV_PREFIXES = ['DISCORD_']

const DEFAULT_TEST_SYSTEM_FLAGS = Object.freeze({
  discord_actions_enabled: true,
  discord_alerts_enabled: true,
  allow_weak_identity_outbound: false,
  feeder_enabled: true,
  outbound_sms_enabled: true,
  queue_auto_enqueue_enabled: true,
})

const DEFAULT_TEST_SYSTEM_VALUES = Object.freeze({
  require_local_routing: 'false',
  allow_regional_fallback_for_first_touch: 'false',
  campaign_mode: 'test',
  queue_emergency_stop_at: '',
})

function isAllowedUrl(url) {
  try {
    const parsed = new URL(String(url))
    if (parsed.protocol === 'file:') return true
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return ALLOWED_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

export function installCriticalFetchGuard() {
  if (fetchGuardInstalled) return
  fetchGuardInstalled = true

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url
    if (!isAllowedUrl(url)) {
      const host = (() => {
        try {
          return new URL(String(url)).host
        } catch {
          return String(url)
        }
      })()
      throw new Error(
        `CRITICAL_TEST_NETWORK_BLOCKED: unmocked external fetch to ${host}. ` +
          `Inject deps.supabase / provider mocks — do not use production credentials.`
      )
    }
    return originalFetch(input, init)
  }
}

function shouldPreserveEnvKey(key) {
  return PRESERVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
}

export function resetCriticalProcessEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot) && !shouldPreserveEnvKey(key)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (!shouldPreserveEnvKey(key)) {
      process.env[key] = value
    }
  }
}

export function primeDefaultTestSystemFlags() {
  clearSystemControlCache()
  for (const [key, value] of Object.entries(DEFAULT_TEST_SYSTEM_FLAGS)) {
    primeSystemControlCache(key, value)
  }
  for (const [key, value] of Object.entries(DEFAULT_TEST_SYSTEM_VALUES)) {
    primeSystemControlValue(key, value)
  }
}

export function bindCriticalTestFile(fileUrl) {
  activeFile = fileUrl
}

/**
 * The notification intelligence service builds its own Supabase client, so a
 * test that triggers a notification upsert reaches the placeholder host, gets
 * blocked by the guard, and then burns 1s+2s+4s of postgrest retry backoff
 * before warning and continuing. It only ever cost latency - it warns rather
 * than failing - but seven seconds per affected test is seven seconds.
 *
 * The module already exposes a supabase_override seam, so making it hermetic
 * costs nothing and changes no runtime behaviour: this stub is installed only
 * inside the critical-test environment.
 */
function makeInertNotificationClient() {
  const result = { data: null, error: null }
  const chain = new Proxy(
    {
      then: (onF, onR) => Promise.resolve(result).then(onF, onR),
      maybeSingle: async () => result,
      single: async () => result,
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop]
        return () => chain
      },
    }
  )
  return { from: () => chain }
}

before(() => {
  installCriticalFetchGuard()
  setNotificationIntelligenceDeps({ supabase_override: makeInertNotificationClient() })
})

// rc-8.5.21: the automation-hold port (lib/domain/holds-port) FAILS CLOSED when no registry is
// bound. Tests that do not exercise holds get a bound "no hold" registry before every test; the
// hold tests reset it (__resetAutomationHoldChecker) to prove the fail-closed default.
const HOLD_CHECKER = Symbol.for('lc.automation_hold.checker')
export const TEST_NO_HOLD_CHECKER = async () => ({ held: false, hold_type: null, reason: null, hold_id: null })
beforeEach(() => {
  globalThis[HOLD_CHECKER] = TEST_NO_HOLD_CHECKER
  resetCriticalProcessEnv()
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  delete process.env.SUPABASE_ANON_KEY
  for (const key of Object.keys(process.env)) {
    if (PRESERVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) && !process.env[key]) {
      delete process.env[key]
    }
  }
  primeDefaultTestSystemFlags()
})

after(() => {
  resetCriticalProcessEnv()
})

export function assertFetchGuardBlocksExternal() {
  installCriticalFetchGuard()
  return globalThis.fetch('https://placeholder.supabase.co/rest/v1/system_control')
}