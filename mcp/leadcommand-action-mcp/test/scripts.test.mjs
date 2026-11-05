// The owner scripts: the gateway token is exactly the role the server accepts; the agent credential is written
// 0600 outside the repo and only its digest is printed.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mintGatewayToken } from '../scripts/mint-gateway-token.mjs'
import { assertGatewayJwt } from '../src/data/client.mjs'
import { credentialDigest } from '@/lib/domain/action-gateway/credentials.js'
import { DIR, ORG, PEPPER, FILES } from './helpers.mjs'

test('mint-gateway-token: role lc_action_gateway + lc_org; the server accepts it; bounds enforced', () => {
  const t = mintGatewayToken('s'.repeat(40), { org: ORG, days: 30 })
  assert.equal(assertGatewayJwt(t, { orgId: ORG }).role, 'lc_action_gateway')
  assert.throws(() => mintGatewayToken('short', { org: ORG }), /32/)
  assert.throws(() => mintGatewayToken('s'.repeat(40), { org: 'x' }), /uuid/)
  assert.throws(() => mintGatewayToken('s'.repeat(40), { org: ORG, days: 365 }), /days/)
})

test('mint-agent-credential: writes a 0600 credential, prints only its digest and the owner SQL', async () => {
  const { main } = await import('../scripts/mint-agent-credential.mjs')
  const out = path.join(DIR, 'agt_test.credential')
  const chunks = []
  const w = process.stdout.write
  process.stdout.write = (c) => { chunks.push(String(c)); return true }
  try { main(['--pepper-file', FILES.pepper, '--agent-id', 'agt_test', '--out', out]) } finally { process.stdout.write = w }
  const token = fs.readFileSync(out, 'utf8').trim()
  assert.equal(fs.statSync(out).mode & 0o777, 0o600)
  const printed = chunks.join('')
  assert.ok(!printed.includes(token))
  assert.ok(printed.includes(credentialDigest(PEPPER, token)))
  assert.throws(() => main(['--pepper-file', FILES.pepper, '--agent-id', 'agt_test', '--out', path.resolve('x.credential')]), /repository/)
})
