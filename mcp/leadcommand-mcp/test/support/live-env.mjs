// Live-mode launch environments for tests: credential FILES (0600, in a temp dir) that hold
// synthetic test tokens (fake signatures), never a real credential.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { READER_TOKEN, ANON_KEY } from './fake-postgrest.mjs'
import { FIXTURE_OWNER, FIXTURE_ORG } from '../../fixtures/dataset.mjs'
import { SCOPE_NAMES } from '../../src/authz/scopes.mjs'

export const ALL_SCOPES = SCOPE_NAMES.join(' ')

export function tmpDir(prefix = 'lcmcp-live-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function writeSecret(dir, name, value, mode = 0o600) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, value, { mode })
  fs.chmodSync(p, mode)
  return p
}

/** A complete live env. `reader` / `apiKey` replace the token values; `over` adds or overrides variables. */
export function liveEnv({ dir = tmpDir(), reader = READER_TOKEN, apiKey = ANON_KEY, over = {} } = {}) {
  return {
    LEADCOMMAND_MCP_DATA: 'live',
    LEADCOMMAND_MCP_SUPABASE_URL: 'https://fixture-project.supabase.test',
    LEADCOMMAND_MCP_READER_JWT_FILE: writeSecret(dir, 'reader.jwt', reader),
    LEADCOMMAND_MCP_API_KEY_FILE: writeSecret(dir, 'public.key', apiKey),
    LEADCOMMAND_MCP_PRINCIPAL_USER_ID: FIXTURE_OWNER,
    LEADCOMMAND_MCP_ORG_ID: FIXTURE_ORG,
    LEADCOMMAND_MCP_SCOPES: ALL_SCOPES,
    ...over,
  }
}

export const LIVE_MEMBERSHIP = Object.freeze([{ org_id: FIXTURE_ORG, user_id: FIXTURE_OWNER, role: 'owner' }])
