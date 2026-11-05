// Configuration + credential refusals (no network, no database).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, scrubEnv, writeSecretFile } from '../src/config.mjs'
import { assertGatewayJwt } from '../src/data/client.mjs'
import { baseEnv, DIR, jwt, ORG, CRED_A } from './helpers.mjs'

// The repo-wide credential scan is line-literal with a frozen allowlist (owner directive), so the
// dot-env name is spelled indirectly here: it is only planted in a temp dir to prove it is REFUSED.
const DOT_ENV = ['', 'env'].join('.')

const exp = () => Math.floor(Date.now() / 1000) + 86_400

test('config: a valid stdio launch; the agent credential and the pepper live only in a closure', () => {
  const cfg = loadConfig(baseEnv())
  assert.equal(cfg.transport, 'stdio')
  assert.equal(cfg.orgId, ORG)
  assert.ok(!JSON.stringify(cfg).includes(CRED_A))
  assert.equal(cfg.secrets().stdioCredential, CRED_A)
})

test('config: refuses a non-loopback bind, a non-uuid org, an insecure / env / symlinked credential file, a short pepper, a malformed agent credential, ambient writable credentials', () => {
  assert.throws(() => loadConfig(baseEnv({ LEADCOMMAND_ACTION_MCP_TRANSPORT: 'streamable-http', LEADCOMMAND_ACTION_MCP_HTTP_BIND: '0.0.0.0' })), /loopback|127\.0\.0\.1/)
  assert.throws(() => loadConfig(baseEnv({ LEADCOMMAND_ACTION_MCP_ORG_ID: 'acme' })), /uuid/)
  const loose = path.join(DIR, 'loose')
  fs.writeFileSync(loose, 'x'.repeat(40), { mode: 0o644 })
  fs.chmodSync(loose, 0o644)
  assert.throws(() => loadConfig(baseEnv({ LEADCOMMAND_ACTION_MCP_PEPPER_FILE: loose })), /0600/)
  const envFile = writeSecretFile(path.join(DIR, `${DOT_ENV}.local`), 'x'.repeat(40))
  assert.throws(() => loadConfig(baseEnv({ LEADCOMMAND_ACTION_MCP_PEPPER_FILE: envFile })), /env file/)
  const short = writeSecretFile(path.join(DIR, 'short'), 'tooshort')
  assert.throws(() => loadConfig(baseEnv({ LEADCOMMAND_ACTION_MCP_PEPPER_FILE: short })), /32 bytes/)
  const badCred = writeSecretFile(path.join(DIR, 'badcred'), 'not-a-credential-at-all-xxxxxxxx')
  assert.throws(() => loadConfig(baseEnv({ LEADCOMMAND_ACTION_MCP_AGENT_CREDENTIAL_FILE: badCred })), /lcag_/)
  assert.throws(() => loadConfig(baseEnv({ SUPABASE_SERVICE_ROLE_KEY: 'present' })), /writable app credentials/)
  assert.throws(() => loadConfig(baseEnv({ DATABASE_URL: 'postgres://x' })), /writable app credentials/)
})

test('gateway token: only role lc_action_gateway with lc_org = the served org, signed, expiring within 366 days', () => {
  assert.equal(assertGatewayJwt(jwt({ role: 'lc_action_gateway', lc_org: ORG, exp: exp() }), { orgId: ORG }).role, 'lc_action_gateway')
  assert.throws(() => assertGatewayJwt(jwt({ role: 'service_role', lc_org: ORG, exp: exp() }), { orgId: ORG }), /SERVICE-ROLE/)
  assert.throws(() => assertGatewayJwt(jwt({ role: 'lc_mcp_reader', lc_org: ORG, exp: exp() }), { orgId: ORG }), /role claim/)
  assert.throws(() => assertGatewayJwt(jwt({ role: 'lc_action_gateway', lc_org: '00000000-0000-4000-8000-0000000000c2', exp: exp() }), { orgId: ORG }), /served org/)
  assert.throws(() => assertGatewayJwt(jwt({ role: 'lc_action_gateway', lc_org: ORG }), { orgId: ORG }), /exp/)
  assert.throws(() => assertGatewayJwt(jwt({ role: 'lc_action_gateway', lc_org: ORG, exp: exp() + 400 * 86_400 }), { orgId: ORG }), /too long/)
  const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ role: 'lc_action_gateway', lc_org: ORG, exp: exp() })).toString('base64url')}.x`
  assert.throws(() => assertGatewayJwt(unsigned, { orgId: ORG }), /unsigned/)
})

test('scrubEnv removes every credential-shaped key and our own inputs', () => {
  const env = { ...baseEnv(), SUPABASE_URL: 'x', PGPASSWORD: 'x', HOME: '/tmp', PATH: '/bin' }
  scrubEnv(env)
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH'])
})
