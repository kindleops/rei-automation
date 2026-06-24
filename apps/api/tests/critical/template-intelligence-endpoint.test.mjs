import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  buildAggregateFromKpiRow,
  fetchReplyIntentAggregates,
  mergeKpiAndIntentAggregates,
  mergeAggregateIntoMetrics,
} from '../../src/lib/domain/templates/template-intelligence-aggregates.js'
import { kpiRowToMetrics } from '../../src/lib/domain/templates/template-intelligence-contract.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

test('runtime source does not query performance_attributed_replies_v', () => {
  const aggregates = readFileSync(join(root, 'src/lib/domain/templates/template-intelligence-aggregates.js'), 'utf8')
  const service = readFileSync(join(root, 'src/lib/domain/templates/template-intelligence-service.js'), 'utf8')
  assert.doesNotMatch(aggregates, /\.from\(['"]performance_attributed_replies_v['"]\)/)
  assert.doesNotMatch(service, /performance_attributed_replies_v/)
})

test('buildAggregateFromKpiRow maps template_performance_kpis_v fields', () => {
  const bucket = buildAggregateFromKpiRow({
    sends: 20,
    delivered: 18,
    inbound_replies: 4,
    positive_inbound_count: 2,
    ownership_confirmed_replies: 1,
    stage_advanced_count: 1,
    opt_out_count: 0,
    metric_status: 'ok',
  })
  assert.equal(bucket.replies, 4)
  assert.equal(bucket.positive_replies, 2)
  assert.equal(bucket.ownership_confirmed, 1)
  assert.equal(bucket.stage_advanced, 1)
  assert.equal(bucket.attribution_available, true)
  assert.equal(bucket.attribution_source, 'template_performance_kpis_v')
})

test('buildAggregateFromKpiRow marks partial attribution when metric_status missing_source', () => {
  const bucket = buildAggregateFromKpiRow({
    sends: 12,
    delivered: 10,
    inbound_replies: 0,
    metric_status: 'missing_source',
  })
  assert.equal(bucket.attribution_partial, true)
  assert.equal(bucket.replies, null)
})

test('mergeKpiAndIntentAggregates reconciles KPI and message-event intents', () => {
  const merged = mergeKpiAndIntentAggregates(
    { sends: 10, delivered: 9, inbound_replies: 2, positive_inbound_count: 1, metric_status: 'ok' },
    {
      replies: 3,
      positive_replies: 2,
      ownership_confirmed: 1,
      stage_advanced: 1,
      attribution_available: true,
    },
  )
  assert.equal(merged.replies, 2, 'KPI aggregate replies win over intent recount')
  assert.equal(merged.positive_replies, 1, 'KPI positive replies win over intent recount')
  assert.equal(merged.ownership_confirmed, 1)
  assert.equal(merged.stage_advanced, 1)
})

test('mergeAggregateIntoMetrics preserves unavailable rates without throwing', () => {
  const base = kpiRowToMetrics({ sends: 5, delivered: 4, inbound_replies: 0, metric_status: 'missing_source' })
  const merged = mergeAggregateIntoMetrics(base, {
    replies: null,
    positive_replies: null,
    ownership_confirmed: null,
    stage_advanced: null,
    opt_outs: null,
    attribution_partial: true,
    attribution_available: false,
  }, null)
  assert.equal(merged.replies, null)
  assert.equal(merged.rates.reply.value, null)
  assert.equal(merged.rates.reply.unavailable, true)
})

test('fetchReplyIntentAggregates soft-fails without performance_attributed_replies_v', async () => {
  const map = await fetchReplyIntentAggregates(['tpl-a', 'tpl-b'], 'today')
  assert.ok(map instanceof Map)
})