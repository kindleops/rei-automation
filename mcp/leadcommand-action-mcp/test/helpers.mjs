// Test helpers. Credential files are real 0600 files in a temp dir (never in the repo); the gateway token and
// public key are JWT-SHAPED test values (no network ever verifies them: tests inject the database client or a
// fake gateway). The live data path is exercised end to end in e2e-pg.test.mjs against a DISPOSABLE PostgreSQL.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildApp } from '../src/app.mjs'
import { writeSecretFile } from '../src/config.mjs'
import { createActionCatalog } from '@/lib/domain/action-gateway/catalog.js'
import { TIER_LABEL } from '@/lib/domain/action-gateway/constants.js'

export const ORG = '00000000-0000-4000-8000-0000000000c1'
export const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-action-mcp-'))
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
export const jwt = (payload) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.${crypto.randomBytes(24).toString('base64url')}`
const exp = () => Math.floor(Date.now() / 1000) + 30 * 86_400
export const CRED_A = `lcag_${crypto.randomBytes(32).toString('base64url')}`
export const CRED_B = `lcag_${crypto.randomBytes(32).toString('base64url')}`
export const PEPPER = 'action-gateway-test-pepper-0123456789abcdef-not-a-secret'

export const FILES = {
  pepper: writeSecretFile(path.join(DIR, 'pepper'), PEPPER),
  apiKey: writeSecretFile(path.join(DIR, 'anon'), jwt({ role: 'anon', iss: 'supabase', exp: exp() })),
  gatewayJwt: writeSecretFile(path.join(DIR, 'gateway.jwt'), jwt({ role: 'lc_action_gateway', lc_org: ORG, iss: 'supabase', iat: Math.floor(Date.now() / 1000), exp: exp() })),
  agentA: writeSecretFile(path.join(DIR, 'agent-a'), CRED_A),
}

export function baseEnv(over = {}) {
  return {
    LEADCOMMAND_ACTION_MCP_ORG_ID: ORG,
    LEADCOMMAND_ACTION_MCP_SUPABASE_URL: 'http://127.0.0.1:59999',
    LEADCOMMAND_ACTION_MCP_API_KEY_FILE: FILES.apiKey,
    LEADCOMMAND_ACTION_MCP_GATEWAY_JWT_FILE: FILES.gatewayJwt,
    LEADCOMMAND_ACTION_MCP_PEPPER_FILE: FILES.pepper,
    LEADCOMMAND_ACTION_MCP_AGENT_CREDENTIAL_FILE: FILES.agentA,
    ...over,
  }
}

/** A fake gateway with the real catalog: records every call; answers a scripted result. */
export function fakeGateway({ answer = null, whoami = null } = {}) {
  const catalog = createActionCatalog()
  const calls = []
  return {
    calls,
    listTools: () => [...catalog.actions(), ...catalog.reads()].map((s) => ({ name: s.name, title: s.title, description: s.description, input: s.input, tier: TIER_LABEL[s.tier], capability: s.capability, implemented: s.implemented !== false, read: catalog.isRead(s.name), scope: s.scope || null, risk: s.risk || null })),
    async call(o) {
      calls.push(o)
      if (!catalog.get(o.tool)) return { ok: false, status: 'error', tool: o.tool, unknownTool: true, error: { class: 'invalid_input', code: 'UNKNOWN_ACTION', message: 'unknown', retryable: false } }
      return answer ? answer(o) : { ok: true, status: 'succeeded', tool: o.tool, intent_id: crypto.randomUUID(), state: 'succeeded', code: 'OK', result: {} }
    },
    async whoami(credential) { return whoami ? whoami(credential) : { ok: credential === CRED_A || credential === CRED_B, agent_id: credential === CRED_A ? 'agt_a' : 'agt_b', error: { code: 'CREDENTIAL_UNKNOWN' } } },
    async recover() { return { scanned: 0, results: [] } },
  }
}

export async function connect({ env = baseEnv(), gateway = fakeGateway(), db = null, ...rest } = {}) {
  const events = []
  const app = await buildApp({ env, gateway: db ? undefined : gateway, db, auditSink: (r) => events.push(r), scrub: false, ...rest })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await app.server.connect(st)
  const client = new Client({ name: 'leadcommand-action-mcp-test', version: '1.0.0' })
  await client.connect(ct)
  return { app, client, events, gateway, async close() { await client.close(); await app.close() } }
}
