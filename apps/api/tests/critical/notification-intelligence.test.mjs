/**
 * notification-intelligence.test.mjs
 *
 * Unit tests for LeadCommand Notification Intelligence backend.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EVENT_CATALOG,
  NOTIFICATION_ACTION_TYPES,
  NOTIFICATION_DOMAINS,
  NOTIFICATION_SEVERITIES,
  renderTitleTemplate,
} from '@/lib/domain/notifications/notification-event-catalog.js'

import {
  THRESHOLDS,
  buildDedupKey,
  buildGroupingKey,
  isRateLimited,
  isMuted,
  upsertNotificationEvent,
  __setDeps,
  __resetDeps,
} from '@/lib/domain/notifications/notification-intelligence-service.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSupabaseMock(tableState = {}) {
  const state = {
    notification_events: [],
    notification_action_audit: [],
    ...tableState,
  }

  const mock = {
    state,
    from(table) {
      const rows = state[table] ?? []
      const filters = []
      let selected = '*'
      let upsertMode = null
      let conflictKey = null
      let limitN = null
      let orderSpec = null
      let rangeSpec = null
      let countExact = false

      const applyFilters = (data) => {
        let result = [...data]
        for (const f of filters) {
          if (f.type === 'eq') {
            result = result.filter((r) => r[f.col] === f.val)
          }
          if (f.type === 'in') {
            result = result.filter((r) => f.val.includes(r[f.col]))
          }
          if (f.type === 'is_null') {
            result = result.filter((r) => r[f.col] == null)
          }
        }
        if (orderSpec) {
          result.sort((a, b) => {
            const av = a[orderSpec.col]
            const bv = b[orderSpec.col]
            return orderSpec.asc ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1)
          })
        }
        if (limitN != null) result = result.slice(0, limitN)
        if (rangeSpec) result = result.slice(rangeSpec.from, rangeSpec.to + 1)
        return result
      }

      const chain = {
        select(cols, opts = {}) {
          selected = cols
          countExact = opts.count === 'exact'
          return chain
        },
        insert(row) {
          const payload = Array.isArray(row) ? row : [row]
          for (const r of payload) {
            if (!r.id) r.id = `evt-${state[table].length + 1}`
            state[table].push({ ...r })
          }
          return {
            select: () => ({
              maybeSingle: async () => ({ data: state[table][state[table].length - 1], error: null }),
            }),
          }
        },
        upsert(row, opts = {}) {
          upsertMode = true
          conflictKey = opts.onConflict
          const key = row[conflictKey]
          const existing = state[table].find((r) => r[conflictKey] === key)
          if (existing) Object.assign(existing, row)
          else state[table].push({ ...row, id: row.id || `evt-${state[table].length + 1}` })
          return {
            select: () => ({
              maybeSingle: async () => ({
                data: state[table].find((r) => r[conflictKey] === key),
                error: null,
              }),
            }),
          }
        },
        update(patch) {
          return {
            eq(col, val) {
              const target = state[table].find((r) => r[col] === val)
              if (target) Object.assign(target, patch)
              return {
                select: () => ({
                  maybeSingle: async () => ({ data: target, error: null }),
                }),
              }
            },
            in(col, vals) {
              const updated = state[table].filter((r) => vals.includes(r[col]))
              for (const row of updated) Object.assign(row, patch)
              return {
                select: async () => ({ data: updated, error: null }),
              }
            },
          }
        },
        eq(col, val) { filters.push({ type: 'eq', col, val }); return chain },
        in(col, val) { filters.push({ type: 'in', col, val }); return chain },
        is(col, val) { if (val === null) filters.push({ type: 'is_null', col }); return chain },
        or() { return chain },
        order(col, opts = {}) { orderSpec = { col, asc: opts.ascending !== false }; return chain },
        range(from, to) { rangeSpec = { from, to }; return chain },
        limit(n) { limitN = n; return chain },
        maybeSingle: async () => {
          const data = applyFilters(rows)[0] ?? null
          return { data, error: null }
        },
        then(resolve) {
          const data = applyFilters(rows)
          return Promise.resolve(resolve({ data, error: null, count: data.length }))
        },
      }
      return chain
    },
  }
  return mock
}

test('EVENT_CATALOG covers all domains with minimum counts', () => {
  const byDomain = {}
  for (const entry of Object.values(EVENT_CATALOG)) {
    byDomain[entry.domain] = (byDomain[entry.domain] || 0) + 1
  }

  assert.ok(byDomain.campaigns >= 20, `campaigns: ${byDomain.campaigns}`)
  assert.ok(byDomain.templates >= 12, `templates: ${byDomain.templates}`)
  assert.ok(byDomain.numbers >= 15, `numbers: ${byDomain.numbers}`)
  assert.ok(byDomain.markets >= 14, `markets: ${byDomain.markets}`)
  assert.ok(byDomain.inbox >= 20, `inbox: ${byDomain.inbox}`)
  assert.ok(byDomain.acquisition >= 18, `acquisition: ${byDomain.acquisition}`)
  assert.ok(byDomain.closing >= 20, `closing: ${byDomain.closing}`)
  assert.ok(byDomain.workflow >= 15, `workflow: ${byDomain.workflow}`)
  assert.ok(byDomain.platform >= 14, `platform: ${byDomain.platform}`)
  assert.ok(byDomain.intelligence >= 5, `intelligence: ${byDomain.intelligence}`)

  for (const domain of NOTIFICATION_DOMAINS) {
    assert.ok(byDomain[domain] > 0, `missing events for domain ${domain}`)
  }
})

test('NOTIFICATION_ACTION_TYPES registry is complete for catalog defaults', () => {
  const actionSet = new Set(NOTIFICATION_ACTION_TYPES)
  for (const [eventType, entry] of Object.entries(EVENT_CATALOG)) {
    for (const action of entry.defaultActions) {
      assert.ok(actionSet.has(action), `${eventType} references unknown action ${action}`)
    }
    assert.ok(NOTIFICATION_SEVERITIES.includes(entry.defaultSeverity), `${eventType} bad severity`)
    assert.ok(NOTIFICATION_DOMAINS.includes(entry.domain), `${eventType} bad domain`)
  }
})

test('renderTitleTemplate interpolates placeholders', () => {
  const title = renderTitleTemplate('Campaign paused — {{campaign_name}}', { campaign_name: 'TX SFR' })
  assert.equal(title, 'Campaign paused — TX SFR')
})

test('buildDedupKey is deterministic per day and scope', () => {
  const ref = new Date('2026-06-26T15:00:00.000Z')
  const key1 = buildDedupKey('campaign_pause_recommended', 'camp-123', ref)
  const key2 = buildDedupKey('campaign_pause_recommended', 'camp-123', ref)
  assert.equal(key1, key2)
  assert.match(key1, /^campaign_pause_recommended:camp-123:2026-06-26$/)
})

test('buildGroupingKey groups by event type and entity', () => {
  const key = buildGroupingKey('inbox_hot_lead', 'thread-abc')
  assert.equal(key, 'group:inbox_hot_lead:thread-abc')
})

test('upsertNotificationEvent dedupes by deduplication_key', async () => {
  const mock = makeSupabaseMock()
  __setDeps({ supabase_override: mock, now_override: '2026-06-26T12:00:00.000Z', rate_limit_cache: new Map() })

  const first = await upsertNotificationEvent({
    event_type: 'campaign_pause_recommended',
    deduplication_key: 'test:dedup:1',
    source_entity_id: 'camp-1',
    title_vars: { campaign_name: 'Test Campaign' },
    description: 'Initial',
  })
  assert.equal(first.ok, true)
  assert.equal(first.evolved, false)

  const second = await upsertNotificationEvent({
    event_type: 'campaign_pause_recommended',
    deduplication_key: 'test:dedup:1',
    source_entity_id: 'camp-1',
    title_vars: { campaign_name: 'Test Campaign' },
    description: 'Updated reason',
  })
  assert.equal(second.ok, true)
  assert.equal(second.evolved, true)

  const row = mock.state.notification_events.find((r) => r.deduplication_key === 'test:dedup:1')
  assert.equal(row.group_count, 2)
  assert.match(row.description, /2 occurrences/)

  __resetDeps()
})

test('severity mapping uses catalog defaults', async () => {
  const mock = makeSupabaseMock()
  __setDeps({ supabase_override: mock, now_override: '2026-06-26T12:00:00.000Z', rate_limit_cache: new Map() })

  await upsertNotificationEvent({
    event_type: 'campaign_scale_up_recommended',
    deduplication_key: 'test:scale:1',
    source_entity_id: 'camp-2',
    title_vars: { campaign_name: 'Scale Camp' },
  })

  const row = mock.state.notification_events[0]
  assert.equal(row.severity, 'positive')
  assert.equal(row.domain, 'campaigns')
  assert.equal(row.sound_category, 'opportunity')
  assert.ok(Array.isArray(row.available_actions))
  assert.ok(row.available_actions.includes('approve_scale'))

  __resetDeps()
})

test('isRateLimited blocks within window', () => {
  __setDeps({
    now_override: '2026-06-26T12:00:00.000Z',
    rate_limit_cache: new Map(),
  })

  assert.equal(isRateLimited('key-a', 60000), false)
  assert.equal(isRateLimited('key-a', 60000), true)

  __setDeps({ now_override: '2026-06-26T12:02:00.000Z' })
  assert.equal(isRateLimited('key-a', 60000), false)

  __resetDeps()
})

test('isMuted respects scoped mutes and expiry', () => {
  const prefs = {
    mutes: [
      { mute_scope: 'domain', mute_target_id: 'inbox', muted_until: '2026-06-27T00:00:00.000Z' },
      { mute_scope: 'event_type', mute_target_id: 'platform_queue_lag_detected' },
    ],
  }

  __setDeps({ now_override: '2026-06-26T12:00:00.000Z' })
  assert.equal(isMuted('domain', 'inbox', prefs), true)
  assert.equal(isMuted('domain', 'campaigns', prefs), false)
  assert.equal(isMuted('event_type', 'platform_queue_lag_detected', prefs), true)

  __setDeps({ now_override: '2026-06-28T00:00:00.000Z' })
  assert.equal(isMuted('domain', 'inbox', prefs), false)

  __resetDeps()
})

test('grouping evolution increments group_count on repeat dedup', async () => {
  const mock = makeSupabaseMock()
  __setDeps({ supabase_override: mock, now_override: '2026-06-26T12:00:00.000Z', rate_limit_cache: new Map() })

  for (let i = 0; i < 3; i++) {
    await upsertNotificationEvent({
      event_type: 'sender_delivery_spike_failure',
      deduplication_key: 'sender:dedup:1',
      source_entity_id: '+15551234567',
      title_vars: { sender_number: '+15551234567' },
      description: `Failure batch ${i + 1}`,
    })
  }

  const row = mock.state.notification_events[0]
  assert.equal(row.group_count, 3)
  assert.match(row.description, /3 occurrences/)

  __resetDeps()
})

test('THRESHOLDS align with proactive notification sample size', () => {
  assert.equal(THRESHOLDS.MIN_SAMPLE_SIZE, 50)
})