// The agent DB credential is judged by CLIENT-side TLS (our socket: encrypted, authorized
// against the Supabase CA, peer name = configured host). Server-side pg_stat_ssl behind
// Supavisor describes the pooler → Postgres hop and is informational only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { clientTlsState, assertAgentPoolTls } from '../../src/lib/agent/live/live-agent.js'

const sock = ({ encrypted = true, authorized = true, cn = '*.pooler.supabase.com', err = null } = {}) => ({ connection: { stream: { encrypted, authorized, authorizationError: err, getProtocol: () => 'TLSv1.3', getPeerCertificate: () => ({ subject: { CN: cn }, issuer: { CN: 'Supabase Intermediate 2021 CA' } }) } } })
const HOST = 'aws-1-us-west-2.pooler.supabase.com'

test('client TLS: verified + encrypted + wildcard name match ⇒ ok', () => {
  const st = clientTlsState(sock(), HOST)
  assert.equal(st.ok, true)
  assert.equal(st.peer_cn, '*.pooler.supabase.com')
  assert.equal(clientTlsState(sock({ cn: 'db.lcppdrmrdfblstpcbgpf.supabase.co' }), 'db.lcppdrmrdfblstpcbgpf.supabase.co').ok, true)
})

test('client TLS: plaintext, unverified, wrong name, multi-label wildcard, or no socket ⇒ not ok', () => {
  assert.equal(clientTlsState(sock({ encrypted: false }), HOST).ok, false)
  assert.equal(clientTlsState(sock({ authorized: false, err: 'SELF_SIGNED_CERT_IN_CHAIN' }), HOST).ok, false)
  assert.equal(clientTlsState(sock({ cn: '*.evil.example.com' }), HOST).ok, false)
  assert.equal(clientTlsState(sock(), 'a.b.pooler.supabase.com').ok, false, 'a wildcard covers one label only')
  assert.equal(clientTlsState({ connection: { stream: { encrypted: false } } }, HOST).ok, false)
  assert.equal(clientTlsState(null, HOST).ok, false)
})

test('production gate: assertAgentPoolTls throws AGENT_DATABASE_TLS_NOT_VERIFIED on an unverified client and releases it', async () => {
  const env = { NODE_ENV: 'production', AGENT_DATABASE_URL: `postgresql://agent_api.ref:pw@${HOST}:6543/postgres`, AGENT_DATABASE_CA_PEM: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----' }
  let released = 0
  const pool = (c) => ({ connect: async () => ({ ...c, release: () => { released += 1 } }) })
  assert.equal((await assertAgentPoolTls(pool(sock()), env)).ok, true)
  await assert.rejects(assertAgentPoolTls(pool(sock({ authorized: false })), env), { code: 'AGENT_DATABASE_TLS_NOT_VERIFIED' })
  await assert.rejects(assertAgentPoolTls(pool(sock({ encrypted: false, authorized: false })), env), { code: 'AGENT_DATABASE_TLS_NOT_VERIFIED' })
  assert.equal(released, 3)
})
