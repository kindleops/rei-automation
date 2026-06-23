/**
 * Shared critical-test environment contract.
 * - Blocks unmocked external network by default
 * - Resets env snapshot between test files
 */
import { after, before, beforeEach } from 'node:test'
import {
  clearSystemControlCache,
  primeSystemControlCache,
  primeSystemControlValue,
} from '../../src/lib/system-control.js'

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

before(() => {
  installCriticalFetchGuard()
})

beforeEach(() => {
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