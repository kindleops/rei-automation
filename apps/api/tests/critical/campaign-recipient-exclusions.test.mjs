import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EXCLUSIONS_TABLE,
  EXCLUSION_LOOKUP_FAILED,
  EXCLUSION_DATA_INVALID,
  EXCLUSION_CAMPAIGN_ID_MISSING,
  normalizeExclusionPhone,
  loadCampaignRecipientExclusions,
  isRecipientExcluded,
} from '../../src/lib/domain/campaigns/campaign-recipient-exclusions.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const servicePath = path.join(here, '../../src/lib/domain/campaigns/campaign-automation-service.js')
const migrationPath = path.join(here, '../../supabase/migrations/PROPOSED_20261008120000_campaign_recipient_exclusions.sql')

/** Minimal supabase stub: records the query, returns `rows` for active rows of the requested campaign. */
function stubSupabase({ rows = [], error = null, throws = false } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, filters: {} }
      calls.push(q)
      const chain = {
        select() { return chain },
        eq(col, val) {
          q.filters[col] = val
          if (q.filters.campaign_id !== undefined && q.filters.is_active !== undefined) {
            if (throws) throw new Error('network down')
            const data = rows.filter((r) => r.campaign_id === q.filters.campaign_id && r.is_active === q.filters.is_active)
            return Promise.resolve(error ? { data: null, error } : { data, error: null })
          }
          return chain
        },
      }
      return chain
    },
  }
}

const ROWS = [
  { campaign_id: 'c1', phone_e164: '+13055550101', is_active: true },
  { campaign_id: 'c1', phone_e164: '+13055550202', is_active: false },
  { campaign_id: 'c2', phone_e164: '+13055550303', is_active: true },
]

test('normalization: canonical US E.164 only', () => {
  assert.equal(normalizeExclusionPhone('(305) 555-0101'), '+13055550101')
  assert.equal(normalizeExclusionPhone('13055550101'), '+13055550101')
  assert.equal(normalizeExclusionPhone('+1 305 555 0101'), '+13055550101')
  assert.equal(normalizeExclusionPhone('443055550101'), null)
  assert.equal(normalizeExclusionPhone('1055550101'), null)
  assert.equal(normalizeExclusionPhone(''), null)
})

test('loads only ACTIVE rows for the requested campaign (isolation + deactivation)', async () => {
  const sb = stubSupabase({ rows: ROWS })
  const r = await loadCampaignRecipientExclusions(sb, 'c1')
  assert.equal(r.ok, true)
  assert.deepEqual([...r.phones], ['+13055550101'])
  assert.equal(sb.calls[0].table, EXCLUSIONS_TABLE)
  assert.equal(isRecipientExcluded(r.phones, { canonical_e164: '+13055550303' }), false)
  assert.equal(isRecipientExcluded(r.phones, { to_phone_number: '3055550202' }), false)
})

test('an empty exclusion set is valid and blocks nobody', async () => {
  const r = await loadCampaignRecipientExclusions(stubSupabase({ rows: [] }), 'c9')
  assert.equal(r.ok, true)
  assert.equal(r.phones.size, 0)
  assert.equal(isRecipientExcluded(r.phones, { canonical_e164: '+13055550101' }), false)
})

test('excluded recipient matches graph rows, targets and queue rows in any phone format', async () => {
  const { phones } = await loadCampaignRecipientExclusions(stubSupabase({ rows: ROWS }), 'c1')
  assert.equal(isRecipientExcluded(phones, { canonical_e164: '+13055550101' }), true)
  assert.equal(isRecipientExcluded(phones, { to_phone_number: '3055550101' }), true)
  assert.equal(isRecipientExcluded(phones, { to_phone_number: '1-305-555-0101' }), true)
})

test('fail safe: lookup error, thrown error, missing campaign id and malformed data are never "no exclusions"', async () => {
  assert.equal((await loadCampaignRecipientExclusions(stubSupabase({ error: { message: 'relation missing' } }), 'c1')).error, EXCLUSION_LOOKUP_FAILED)
  assert.equal((await loadCampaignRecipientExclusions(stubSupabase({ throws: true }), 'c1')).error, EXCLUSION_LOOKUP_FAILED)
  assert.equal((await loadCampaignRecipientExclusions(stubSupabase(), null)).error, EXCLUSION_CAMPAIGN_ID_MISSING)
  const bad = await loadCampaignRecipientExclusions(stubSupabase({ rows: [{ campaign_id: 'c1', phone_e164: '305-555-0101', is_active: true }] }), 'c1')
  assert.equal(bad.ok, false)
  assert.equal(bad.error, EXCLUSION_DATA_INVALID)
})

test('retry: a later successful lookup after a transient failure returns the real set (stateless)', async () => {
  const first = await loadCampaignRecipientExclusions(stubSupabase({ throws: true }), 'c1')
  const second = await loadCampaignRecipientExclusions(stubSupabase({ rows: ROWS }), 'c1')
  assert.equal(first.ok, false)
  assert.equal(second.ok, true)
  assert.equal(second.phones.has('+13055550101'), true)
})

test('target build validates exclusions BEFORE the destructive target replacement, then filters', () => {
  const src = fs.readFileSync(servicePath, 'utf8')
  const load = src.indexOf('const exclusionRead = await loadCampaignRecipientExclusions(supabase, campaignId)')
  const del = src.indexOf("await supabase.from('campaign_targets').delete().eq('campaign_id', campaignId)\n    const { collapseGraphRowsToRecipients }")
  assert.ok(load > 0 && del > load, 'exclusions must be loaded and validated before targets are deleted')
  assert.match(src, /row\.queue_eligible && !isRecipientExcluded\(exclusionRead\.phones, row\)/)
})

test('queue planning loads exclusions (fail closed) and drops excluded ready targets', () => {
  const src = fs.readFileSync(servicePath, 'utf8')
  assert.match(src, /const planExclusionRead = await loadCampaignRecipientExclusions\(supabase, campaignId\)/)
  assert.match(src, /if \(!planExclusionRead\.ok\) \{\n\s+return \{ ok: false/)
  assert.match(src, /\(targets \|\| \[\]\)\.filter\(\(target\) => !isRecipientExcluded\(planExclusionRead\.phones, target\)\)/)
})

test('proposed migration enforces the DB-level guarantees the rule relies on', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8')
  assert.match(sql, /UNIQUE \(campaign_id, phone_e164\)/)
  assert.match(sql, /ON CONFLICT ON CONSTRAINT campaign_recipient_exclusions_campaign_phone_key DO UPDATE/)
  assert.match(sql, /campaign_recipient_exclusion_events is append-only/)
  assert.match(sql, /deactivate instead of delete/)
  assert.match(sql, /NOT APPLIED/)
})
