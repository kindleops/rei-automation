// FIXTURE-backed data-safety tests: provenance, PII minimization, secret
// redaction, prompt injection in seller text, suppression correctness.
import test from 'node:test'
import assert from 'node:assert/strict'
import { connect, call, HAPPY } from './helpers.mjs'
import { FIXTURE, FIXTURE_PHONES, FIXTURE_SECRET_NAMES, FIXTURE_OWNER_2, FIXTURE_OWNER_MAILING, INJECTION } from '../fixtures/dataset.mjs'
import { redactString, redactDeep, containsSecret } from '../src/safety/redact.mjs'
import { loadConfig, scrubEnv } from '../src/config.mjs'
import { PROVENANCE_KINDS } from '../src/provenance.mjs'

const digits = (s) => s.replace(/[^0-9]/g, '')

async function allOutputs(c) {
  const out = []
  for (const [name, args] of Object.entries(HAPPY)) out.push([name, await call(c.client, name, args)])
  for (const id of ['FX1002', 'FX1003']) {
    for (const n of ['leadcommand_get_lead', 'leadcommand_get_property', 'leadcommand_get_lead_contact_status', 'leadcommand_get_acquisition_score']) out.push([n, await call(c.client, n, { property_id: id })])
  }
  out.push(['leadcommand_search_properties', await call(c.client, 'leadcommand_search_properties', { address: '101 Fixture Way' })])
  return out
}

test('provenance: every value group carries a known kind; missing is never 0', async () => {
  const c = await connect()
  try {
    const walk = (v, hits) => {
      if (v && typeof v === 'object') {
        if (v.kind && 'source' in v && 'as_of' in v) hits.push(v)
        for (const x of Object.values(v)) walk(x, hits)
      }
      return hits
    }
    for (const [name, r] of await allOutputs(c)) {
      const hits = walk(r.structuredContent.result, [])
      assert.ok(hits.length > 0, `${name} has provenance`)
      for (const h of hits) assert.ok(PROVENANCE_KINDS.includes(h.kind), `${name}: ${h.kind}`)
    }
    const none = await call(c.client, 'leadcommand_get_acquisition_score', { property_id: 'FX1002' })
    const txt = JSON.stringify(none.structuredContent.result)
    assert.equal(/"(aos_score|valuation_mid|recommended_cash_offer)":0\b/.test(txt), false)
    assert.equal(none.structuredContent.result.provenance.kind, 'missing')
    const stale = await call(c.client, 'leadcommand_get_acquisition_score', { property_id: 'FX1003' })
    assert.equal(stale.structuredContent.result.valuation.provenance.kind, 'stale')
    const inf = await call(c.client, 'leadcommand_search_comps', { property_id: 'FX1001' })
    assert.ok(inf.structuredContent.result.rows.some((r) => r.investor.inferred_provenance.kind === 'inferred'))
  } finally { await c.close() }
})

test('PII minimization: no fixture phone (any format) or email appears in any output; a name or mailing value only in the recorded owner_identity block', async () => {
  const c = await connect()
  try {
    for (const [name, r] of await allOutputs(c)) {
      const full = JSON.stringify(r)
      // owner decision A8: the recorded owner's names and mailing address are returned, in owner_identity only
      const res = r.structuredContent?.result
      const text = res && typeof res === 'object' && 'owner_identity' in res ? JSON.stringify({ ...r, structuredContent: { ...r.structuredContent, result: { ...res, owner_identity: null } }, content: null }) : full
      for (const p of FIXTURE_PHONES) {
        assert.equal(full.includes(p), false, `${name} leaks ${p.slice(0, 4)}…`)
        assert.equal(digits(full).includes(digits(p).slice(1)), false, `${name} leaks phone digits`)
      }
      assert.equal(full.toLowerCase().includes(FIXTURE_SECRET_NAMES[2].toLowerCase()), false, `${name} leaks an email`)
      for (const n of [...FIXTURE_SECRET_NAMES, FIXTURE_OWNER_2, FIXTURE_OWNER_MAILING]) assert.equal(text.toLowerCase().includes(n.toLowerCase()), false, `${name} leaks a name / email / mailing value outside owner_identity`)
      assert.equal(/@example\.test/.test(text), false)
      assert.equal(/pk-secret|pk-a|pk-b|pk-c/.test(text), false, `${name} leaks person keys`)
    }
  } finally { await c.close() }
})

test('owner identity (owner decision A8): lead and property reads return the recorded owner — names, holder kind, mailing address — with provenance, listed untrusted; phones and emails stay withheld', async () => {
  const c = await connect()
  try {
    for (const tool of ['leadcommand_get_lead', 'leadcommand_get_property']) {
      const r = await call(c.client, tool, { property_id: 'FX1001' })
      assert.notEqual(r.isError, true, JSON.stringify(r.structuredContent?.error))
      const o = r.structuredContent.result.owner_identity
      assert.deepEqual(o.names, [FIXTURE_SECRET_NAMES[0], FIXTURE_OWNER_2], `${tool}: owner_name and owner_2_name as recorded, one entry per distinct name`)
      assert.deepEqual(o.entity_type, { recorded: 'individual', corporate: false }, `${tool}: the recorded owner_type, never guessed`)
      assert.equal(o.mailing_address, FIXTURE_OWNER_MAILING)
      assert.equal(o.provenance.kind, 'fact')
      assert.match(o.provenance.source, /eg_property_facts/)
      assert.match(o.contacts, /never returned/)
      for (const f of ['result.owner_identity.names[]', 'result.owner_identity.mailing_address', 'result.owner_identity.entity_type.recorded']) assert.ok(r.structuredContent.untrusted_fields.includes(f), `${tool} lists ${f} as untrusted`)
      const text = JSON.stringify(r)
      for (const p of FIXTURE_PHONES) assert.equal(digits(text).includes(digits(p).slice(1)), false, `${tool} leaks phone digits`)
      assert.equal(text.includes(FIXTURE_SECRET_NAMES[2]), false, `${tool} leaks an email`)
      assert.equal(text.includes(FIXTURE_SECRET_NAMES[1]), false, `${tool} returns no prospect (skip-trace person) name`)
    }
    // a property with no owner fields recorded says so, never a guess
    const none = (await call(c.client, 'leadcommand_get_property', { property_id: 'FX1003' })).structuredContent.result.owner_identity
    assert.deepEqual(none.names, [FIXTURE_SECRET_NAMES[0]], 'owner_name alone is still the recorded owner')
    assert.equal(none.mailing_address, null)
    assert.equal(none.entity_type.recorded, null)
  } finally { await c.close() }
})

test('PII minimization: protected-class vendor flags are dropped (safeFlags)', async () => {
  const c = await connect()
  try {
    const r = await call(c.client, 'leadcommand_get_lead', { property_id: 'FX1001' })
    assert.equal(r.structuredContent.result.signal_labels.some((x) => /senior/i.test(x)), false)
    const p = await call(c.client, 'leadcommand_get_property', { property_id: 'FX1001' })
    assert.equal(JSON.stringify(p).toLowerCase().includes('senior owner'), false)
  } finally { await c.close() }
})

test('PII minimization: the contact-status tool returns handles only — no digits beyond counts', async () => {
  const c = await connect()
  try {
    const r = await call(c.client, 'leadcommand_get_lead_contact_status', { property_id: 'FX1001' })
    for (const ct of r.structuredContent.result.contacts) {
      assert.match(ct.contact, /^C[0-9]$/)
      assert.equal(Object.keys(ct).some((k) => /^phone$|(^|_)(e164|phone_number)$/.test(k)), false)
    }
  } finally { await c.close() }
})

test('second net: a phone or email smuggled into an untrusted field is masked before it leaves', async () => {
  const fx = { ...FIXTURE, tables: { ...FIXTURE.tables, campaigns: FIXTURE.tables.campaigns.map((x, i) => (i === 0 ? { ...x, name: 'Call me at (555) 010-0199 or x@example.test' } : x)) } }
  const c = await connect({ fixture: fx })
  try {
    const r = await call(c.client, 'leadcommand_get_campaign_metrics', { campaign_id: FIXTURE.tables.campaigns[0].id })
    const name = r.structuredContent.result.campaigns[0].name
    assert.equal(name.includes('010-0199'), false)
    assert.equal(name.includes('@example.test'), false)
    assert.match(name, /•••-••99/)
    assert.match(name, /\[email withheld\]/)
  } finally { await c.close() }
})

test('secret redaction: redactor removes JWTs, keys, DB URLs, PEM, bearer tokens; audit lines carry none', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnopqrstu'
  const s = `key=${jwt} postgres://agent_api:hunter2@db.example.test:5432/postgres sb_secret_abcdefghijklmnop Bearer abcdefghijklmnopqrstuvwxyz -----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE----- password=hunter2`
  const out = redactString(s)
  for (const bad of [jwt, 'hunter2', 'sb_secret_abcdefghijklmnop', 'abcdefghijklmnopqrstuvwxyz', 'MIIB']) assert.equal(out.includes(bad), false, bad)
  assert.equal(containsSecret(out), false)
  assert.deepEqual(redactDeep({ service_role_key: 'x', nested: { authorization: 'Bearer y' } }), { service_role_key: '[redacted]', nested: { authorization: '[redacted]' } })
  const c = await connect()
  try {
    await call(c.client, 'leadcommand_get_lead_contact_status', { property_id: 'FX1001' })
    const text = JSON.stringify(c.audit)
    for (const p of FIXTURE_PHONES) assert.equal(digits(text).includes(digits(p).slice(1)), false)
    assert.equal(text.includes('00000000-0000-4000-8000-0000000000b1'), false, 'principal id is hashed in audit')
    for (const rec of c.audit.filter((a) => a.event === 'tool_call')) {
      assert.ok(rec.correlation_id && rec.tool && rec.outcome && 'latency_ms' in rec && 'scope' in rec, 'audit fields')
      assert.equal('input' in rec || 'arguments' in rec || 'result' in rec, false, 'no raw inputs or results in audit')
    }
  } finally { await c.close() }
})

test('secret redaction: a secret-shaped value in data is refused, never returned', async () => {
  const fx = { ...FIXTURE, tables: { ...FIXTURE.tables, campaigns: FIXTURE.tables.campaigns.map((x, i) => (i === 0 ? { ...x, name: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnopqrstu' } : x)) } }
  const c = await connect({ fixture: fx })
  try {
    const r = await call(c.client, 'leadcommand_get_campaign_metrics', { campaign_id: FIXTURE.tables.campaigns[0].id })
    assert.equal(r.isError, true)
    assert.equal(r.structuredContent.error.code, 'SECRET_GUARD')
    assert.equal(JSON.stringify(r).includes('eyJhbGci'), false)
  } finally { await c.close() }
})

test('secret redaction: credentials are moved out of process.env at boot (scrub) and never enumerable on config', () => {
  const env = { LEADCOMMAND_MCP_DATA: 'fixture', SUPABASE_SERVICE_ROLE_KEY: 'x', SUPABASE_URL: 'https://a', DATABASE_URL: 'postgres://u:p@h/d', ANTHROPIC_API_KEY: 'k', PATH: '/bin', HOME: '/h' }
  const cfg = loadConfig(env)
  assert.equal(JSON.stringify(cfg).includes('postgres://'), false)
  const n = scrubEnv(env)
  assert.equal(n, 5)
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH'])
})

test('prompt injection: seller message text never leaves; injected imported text appears only under untrusted_fields', async () => {
  const c = await connect()
  try {
    const { tools: before } = await c.client.listTools()
    for (const [name, r] of await allOutputs(c)) {
      const sc = r.structuredContent
      const text = JSON.stringify(sc)
      assert.equal(text.includes('my number is'), false, `${name}: seller message preview leaked`)
      if (!text.includes('IGNORE ALL PREVIOUS INSTRUCTIONS')) continue
      assert.equal(sc.trust.content, 'data_only')
      assert.ok(sc.untrusted_fields.length > 0, `${name}: injected text present but no untrusted_fields declared`)
      // every occurrence sits at a declared untrusted path
      const paths = []
      const walk = (v, p) => {
        if (typeof v === 'string' && v.includes('IGNORE ALL PREVIOUS')) paths.push(p)
        else if (Array.isArray(v)) v.forEach((x) => walk(x, `${p}[]`))
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k)
      }
      walk(sc, '')
      for (const p of paths) {
        const declared = sc.untrusted_fields.some((u) => (u.endsWith('.*') ? p.startsWith(u.slice(0, -2)) : p === u))
        assert.ok(declared, `${name}: injected text at undeclared path ${p}`)
      }
    }
    const { tools: after } = await c.client.listTools()
    assert.deepEqual(after.map((t) => t.name), before.map((t) => t.name), 'injected text cannot change the tool surface')
    assert.equal(after.some((t) => /send|sms|launch|suppress|write|update|delete/i.test(t.name.replace('leadcommand_get_lead_contact_status', ''))), false)
  } finally { await c.close() }
  assert.ok(INJECTION.length > 0)
})

test('prompt injection: control / bidi characters are stripped from untrusted text', async () => {
  const fx = { ...FIXTURE, tables: { ...FIXTURE.tables, campaigns: FIXTURE.tables.campaigns.map((x, i) => (i === 0 ? { ...x, name: 'Spring‮txet nedih​\u0007 sale' } : x)) } }
  const c = await connect({ fixture: fx })
  try {
    const r = await call(c.client, 'leadcommand_get_campaign_metrics', { campaign_id: FIXTURE.tables.campaigns[0].id })
    assert.equal(r.structuredContent.result.campaigns[0].name, 'Springtxet nedih sale')
  } finally { await c.close() }
})

test('suppression correctness: active row → suppressed; inactive row → not suppressed; lookup failure → unknown (never not_suppressed)', async () => {
  const c = await connect()
  try {
    const s3 = (await call(c.client, 'leadcommand_get_lead_contact_status', { property_id: 'FX1003' })).structuredContent.result
    assert.equal(s3.contacts[0].suppression.state, 'suppressed')
    assert.deepEqual(s3.contacts[0].suppression.types, ['opt_out'])
    assert.equal(s3.summary.suppressed_contacts, 1)
    assert.equal(s3.summary.thread_suppressed, true)
    assert.equal(s3.readiness.state, 'held_suppressed')
    const s1 = (await call(c.client, 'leadcommand_get_lead_contact_status', { property_id: 'FX1001' })).structuredContent.result
    assert.equal(s1.contacts[0].suppression.state, 'not_suppressed', 'an INACTIVE suppression row does not suppress')
  } finally { await c.close() }
  const broken = await connect({ faults: { failTables: ['sms_suppression_list'] } })
  try {
    const r = (await call(broken.client, 'leadcommand_get_lead_contact_status', { property_id: 'FX1003' })).structuredContent.result
    assert.ok(r.contacts.every((x) => x.suppression.state === 'unknown'))
    assert.equal(r.summary.unknown_suppression_contacts, r.contacts.length)
  } finally { await broken.close() }
})
