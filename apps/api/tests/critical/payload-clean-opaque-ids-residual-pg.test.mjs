// rc-8.5.21.1 — the residual "random id rejected" flake in payload-clean-opaque-ids-pg (H2: 1 of 1,000
// re-apply docs refused). Root cause, captured by a 1M-doc probe on a DISPOSABLE PostgreSQL 17: the
// generator drew two shapes the fix never claimed, both refused BY DESIGN (fail-closed):
//   1. phone: an ALL-DIGIT hex id, e.g. the 12-byte object_id '577579570788251146824852'
//      (p = (10/16)^24 ≈ 1.3e-5 per draw). The fix (PROPOSED_20261019120000_payload_clean_opaque_ids)
//      replaces only hex tokens carrying at least one letter a-f: a bare digit run is
//      indistinguishable from glued phones.
//   2. base64_contact: a 12-byte base64url id whose bytes are valid UTF-8 holding a non-ASCII Unicode
//      digit, e.g. 'QS1CCFHfhdOAA1YZ' → 'A-B\bQ\u07c5…' (NKO DIGIT FIVE), p ≈ 1.6e-5 per draw. The
//      S3 base64 decode check (unchanged by the fix) refuses any decoded text with non_ascii_digits.
// The predicate is unchanged; this file pins both boundaries deterministically (no randomness) so
// they can never again surface as a probabilistic failure.
// AGENT_PG_TEST_DB_URL (disposable local PG 17); skipped — reported, never vacuous — without it.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { pgAvailable, skipReason, freshDb } from '../pg/agent-pg-harness.mjs'

const skip = pgAvailable() ? false : skipReason

// captured verbatim from the probe (shape 5 of randomIdDocs)
const CAPTURED_DOCS = [
  {
    sha1: '6f42149fa80a84b6e7e7e5cefc274572a7e5fb1b',
    digest: '391fd8744359e9928df6705e6118b154',
    sha256: 'c0ccb9eb65e6af4df8fec069bf3a34caac0a722e7c98bc1fbf1b4cf598c549b3',
    object_id: '577579570788251146824852',
  },
]
const CAPTURED_IDS = CAPTURED_DOCS.map((d) => d.object_id)
// captured verbatim: the PG probe (first) and a JS replica of payload_b64_decode, each confirmed in PG
const CAPTURED_B64 = [
  ['QS1CCFHfhdOAA1YZ', 'U+07C5'], ['HDVyETdJwphe2aR3', 'U+0664'], ['D3kWDDsIQk4JTNmm', 'U+0666'], ['dzctEnF6GUPbt2Rb', 'U+06F7'],
  ['34hcJd-DaQcBC920', 'U+07C8'], ['XCdXRxt1cNeJ2alV', 'U+0669'], ['2ad2F2ZTLAVndtij', 'U+0667'],
]

const violation = async (pool, doc) => (await pool.query('select agent.payload_violation($1::jsonb, null) v', [JSON.stringify(doc)])).rows[0].v
const clean = async (pool, doc) => (await pool.query('select agent.payload_is_clean($1::jsonb) c', [JSON.stringify(doc)])).rows[0].c

// deterministic hex stream (sha256 counter mode) — no wall-clock / RNG dependence
function detHex(seed, i, n) {
  let out = ''
  for (let k = 0; out.length < n; k++) out += crypto.createHash('sha256').update(`${seed}:${i}:${k}`).digest('hex')
  return out.slice(0, n)
}

test('PG payload_is_clean residual: the captured all-digit hex draws are refused as a phone (the boundary, by design)', { skip }, async () => {
  const db = await freshDb()
  try {
    for (const doc of CAPTURED_DOCS) assert.equal(await violation(db.pool, doc), 'phone', JSON.stringify(doc))
    for (const id of CAPTURED_IDS) {
      for (const key of ['object_id', 'digest', 'sha256', 'note', 'run_ref']) {
        assert.equal(await clean(db.pool, { [key]: id }), false, `${key}: ${id}`)
      }
      assert.equal(await clean(db.pool, { run_ref: `run_${id}` }), false)
    }
    // the rest of the captured doc is clean: only the zero-letter draw trips the run
    for (const doc of CAPTURED_DOCS) {
      const { object_id, ...rest } = doc
      assert.equal(await clean(db.pool, rest), true, JSON.stringify(rest))
    }
  } finally {
    await db.drop()
  }
})

test('PG payload_is_clean residual: the same captured digits with ANY one letter a-f are an id token → clean', { skip }, async () => {
  const db = await freshDb()
  try {
    const bad = []
    for (const id of CAPTURED_IDS) {
      for (let i = 0; i < id.length; i++) {
        for (const ch of ['a', 'f', 'B']) {
          const v = id.slice(0, i) + ch + id.slice(i + 1)
          for (const doc of [{ object_id: v }, { note: v }, { run_ref: `run_${v}` }, { refs: [v] }]) {
            if (!(await clean(db.pool, doc))) bad.push(JSON.stringify(doc))
          }
        }
      }
    }
    assert.deepEqual(bad, [])
  } finally {
    await db.drop()
  }
})

test('PG payload_is_clean residual: zero-letter digit runs of every hex-id length stay refused (glued phones are never an id)', { skip }, async () => {
  const db = await freshDb()
  try {
    for (const s of ['61255501476125550148', '6125550147612555014800000000', '0'.repeat(32), '6125550147'.repeat(4), '1'.repeat(64)]) {
      for (const doc of [{ object_id: s }, { note: s }, { digest: s }]) {
        assert.equal(await violation(db.pool, doc), 'phone', JSON.stringify(doc))
      }
    }
  } finally {
    await db.drop()
  }
})

test('PG payload_is_clean residual: 2,500 deterministic letter-bearing hex ids of every generator length → 0 rejections', { skip }, async () => {
  const db = await freshDb()
  try {
    const docs = []
    for (let i = 0; docs.length < 2_500; i++) {
      const doc = { digest: detHex('d', i, 32), sha1: detHex('s1', i, 40), sha256: detHex('s2', i, 64), object_id: detHex('o', i, 24), run_ref: `run_${detHex('r', i, 32)}` }
      if (Object.values(doc).every((v) => /[a-f]/.test(v.replace(/^run_/, '')))) docs.push(doc)
    }
    const r = await db.pool.query(`select count(*)::int n from jsonb_array_elements($1::jsonb) e where not agent.payload_is_clean(e)`, [JSON.stringify(docs)])
    assert.equal(r.rows[0].n, 0)
  } finally {
    await db.drop()
  }
})

test('PG payload_is_clean residual: captured base64url ids that decode to text with a non-ASCII digit are refused as base64_contact (by design)', { skip }, async () => {
  const db = await freshDb()
  try {
    for (const [s, cp] of CAPTURED_B64) {
      const r = (await db.pool.query(`select agent.payload_violation(jsonb_build_object('opaque', $1::text)) v, agent.payload_string_violation(agent.payload_b64_decode($1), '', 1) inner_v, agent.payload_b64_decode($1) d`, [s])).rows[0]
      assert.equal(r.v, 'base64_contact', s)
      assert.equal(r.inner_v, 'non_ascii_digits', s)
      assert.ok([...r.d].some((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') === cp), `${s} decodes to text holding ${cp}`)
      // an encoded phone in exotic digits is exactly what this check exists for
    }
    const exotic = Buffer.from('\u0666\u0661\u0662\u0665\u0665\u0665\u0660\u0661\u0664\u0667', 'utf8').toString('base64url')
    assert.equal(await violation(db.pool, { opaque: exotic }), 'base64_contact', 'an Arabic-Indic phone, base64url-encoded, is still refused')
  } finally {
    await db.drop()
  }
})

test('PG payload_is_clean residual: 2,000 deterministic 12-byte base64url ids whose bytes are NOT UTF-8 → 0 rejections', { skip }, async () => {
  const db = await freshDb()
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true })
    const docs = []
    for (let i = 0; docs.length < 2_000; i++) {
      const raw = Buffer.from(detHex('b64', i, 24), 'hex')
      try { utf8.decode(raw); continue } catch { docs.push({ opaque: raw.toString('base64url') }) }
    }
    const r = await db.pool.query(`select count(*)::int n from jsonb_array_elements($1::jsonb) e where not agent.payload_is_clean(e)`, [JSON.stringify(docs)])
    assert.equal(r.rows[0].n, 0)
  } finally {
    await db.drop()
  }
})
