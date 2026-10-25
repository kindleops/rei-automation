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

test('mint-gateway-token --secret-stdin: the secret comes only from a pipe (a REAL subprocess pipe), is never printed, never in argv or a file; a terminal, two values, both modes and an in-repo --out are refused', async () => {
  const { spawnSync } = await import('node:child_process')
  const { main } = await import('../scripts/mint-gateway-token.mjs')
  const secret = `synthetic-test-secret-${'q'.repeat(40)}` // a TEST value, never a real project secret
  const out = path.join(DIR, `gw-stdin-${Date.now()}.jwt`)
  const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../scripts/mint-gateway-token.mjs')
  const r = spawnSync(process.execPath, [script, '--secret-stdin', '--org', ORG, '--out', out, '--days', '7'], { input: `${secret}\n`, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), 'the secret is never printed')
  const token = fs.readFileSync(out, 'utf8').trim()
  assert.ok(!token.includes(secret), 'the token file holds the token only')
  assert.equal(fs.statSync(out).mode & 0o777, 0o600)
  const claims = assertGatewayJwt(token, { orgId: ORG })
  assert.equal(claims.role, 'lc_action_gateway')
  assert.ok(!r.stdout.includes(token), 'the token itself is never printed either')
  // the signature verifies with the piped secret (the HMAC was computed over it, not over a trailing newline)
  const [h, b, sig] = token.split('.')
  const crypto = await import('node:crypto')
  assert.equal(crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url'), sig)
  assert.throws(() => main(['--secret-stdin', '--org', ORG, '--out', path.join(DIR, 'tty.jwt')], { stdinIsTTY: true, readStdin: () => secret }), /needs a pipe/)
  assert.throws(() => main(['--secret-stdin', '--org', ORG, '--out', path.join(DIR, 'two.jwt')], { stdinIsTTY: false, readStdin: () => `${secret}\nsecond` }), /exactly one value/)
  assert.throws(() => main(['--secret-stdin', '--org', ORG, '--out', path.join(DIR, 'ws.jwt')], { stdinIsTTY: false, readStdin: () => ` ${secret}` }), /exactly one value/)
  assert.throws(() => main(['--secret-stdin', '--secret-file', FILES.pepper, '--org', ORG, '--out', path.join(DIR, 'both.jwt')], { stdinIsTTY: false, readStdin: () => secret }), /usage/)
  assert.throws(() => main(['--secret-stdin', '--org', ORG, '--out', path.resolve('in-repo.jwt')], { stdinIsTTY: false, readStdin: () => secret }), /outside the repository/)
  assert.throws(() => main(['--secret-stdin', '--org', ORG, '--out', path.join(DIR, 'short.jwt')], { stdinIsTTY: false, readStdin: () => 'short' }), /32/)
  for (const f of ['tty.jwt', 'two.jwt', 'ws.jwt', 'both.jwt', 'short.jwt']) assert.ok(!fs.existsSync(path.join(DIR, f)), `${f}: nothing written on refusal`)
})
