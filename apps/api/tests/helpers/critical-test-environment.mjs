/**
 * Shared critical-test environment contract.
 * - Blocks unmocked external network by default
 * - Resets env snapshot between test files
 */
import { after, before, beforeEach } from 'node:test'

const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
])

const originalFetch = globalThis.fetch
const envSnapshot = { ...process.env }
let fetchGuardInstalled = false
let activeFile = null

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

export function resetCriticalProcessEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(envSnapshot)) {
    process.env[key] = value
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
})

after(() => {
  resetCriticalProcessEnv()
})

export function assertFetchGuardBlocksExternal() {
  installCriticalFetchGuard()
  return globalThis.fetch('https://placeholder.supabase.co/rest/v1/system_control')
}