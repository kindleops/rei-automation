/**
 * S1 + lead visibility in the Pipeline read model:
 *   - every card carries its conversation's archive / snooze / unread facts (read-only)
 *   - with the overlay OFF the deal query never names the overlay columns
 *   - with it ON, an archived deal leaves the working views and appears under view=archived
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { getPipelineCommandFeed, getPipelineCommandOverview } from '../../src/lib/domain/opportunity/pipeline-command-service.js'

const NOW = Date.now()
const iso = (ms) => new Date(ms).toISOString()

function fakeClient({ opps, threads }) {
  const selects = []
  const from = (table) => {
    const state = { table }
    const proxy = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const rows = table === 'acquisition_opportunities' ? opps : table === 'inbox_thread_state' ? threads : []
          return (resolve) => resolve({ data: rows, error: null })
        }
        return (...args) => {
          if (prop === 'select') selects.push({ table, columns: String(args[0] ?? '') })
          return proxy
        }
      },
    })
    void state
    return proxy
  }
  return { from, selects }
}

const opp = (id, extra = {}) => ({
  id, acquisition_stage: 'offer_interest', opportunity_status: 'active', primary_thread_key: `+1612555${id.slice(0, 4)}`,
  last_activity_at: iso(NOW - 3600_000), stage_entered_at: iso(NOW - 86400_000), primary_property_id: `p-${id}`, ...extra,
})

test('cards carry the conversation facts; overlay off never names overlay columns', async () => {
  const a = opp('1111aaaa-0000-4000-8000-000000000001')
  const client = fakeClient({
    opps: [a],
    threads: [{ thread_key: a.primary_thread_key, is_archived: true, archived_at: iso(NOW - 1000), archive_scope: 'conversation', snoozed_until: iso(NOW + 86400_000), is_read: false }],
  })
  const feed = await getPipelineCommandFeed({ view: 'all' }, { supabase: client })
  assert.equal(feed.rows.length, 1)
  assert.deepEqual(
    { archived: feed.rows[0].conversation.archived, scope: feed.rows[0].conversation.archiveScope, unread: feed.rows[0].conversation.unread, snoozed: Boolean(feed.rows[0].conversation.snoozedUntil) },
    { archived: true, scope: 'conversation', unread: true, snoozed: true },
  )
  assert.equal(feed.rows[0].archived, null)
  const dealSelects = client.selects.filter((s) => s.table === 'acquisition_opportunities').map((s) => s.columns)
  assert.ok(dealSelects.length > 0 && dealSelects.every((c) => !c.includes('archived_at')), 'no phantom column while the flag is off')
})

test('overlay on: an archived deal leaves working views, shows under view=archived, keeps its status', async () => {
  const live = opp('2222bbbb-0000-4000-8000-000000000002')
  const hidden = opp('3333cccc-0000-4000-8000-000000000003', { opportunity_status: 'nurture', archived_at: iso(NOW - 5000), archived_by: 'op', archive_reason: 'cleanup' })
  const client = fakeClient({ opps: [live, hidden], threads: [] })
  const deps = { supabase: client, visibilityGate: async () => ({ enabled: true }) }
  const all = await getPipelineCommandFeed({ view: 'all', q: 'x1' }, deps)
  assert.deepEqual(all.rows.map((r) => r.id), [live.id])
  const archived = await getPipelineCommandFeed({ view: 'archived', q: 'x1' }, deps)
  assert.deepEqual(archived.rows.map((r) => r.id), [hidden.id])
  assert.equal(archived.rows[0].status, 'nurture', 'archive never changes status')
  assert.ok(client.selects.some((s) => s.table === 'acquisition_opportunities' && s.columns.includes('archived_at')))
  const overview = await getPipelineCommandOverview({ q: 'x1' }, deps)
  assert.equal(overview.totals.archived, 1)
  const off = await getPipelineCommandOverview({ q: 'x2' }, { supabase: fakeClient({ opps: [live], threads: [] }) })
  assert.equal(off.totals.archived, null, 'not a zero while the overlay is off')
})
