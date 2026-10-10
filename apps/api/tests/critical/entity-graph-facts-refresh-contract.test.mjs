/**
 * RC 8.5.5 — eg_property_facts refresh contract.
 *
 * The full backfill runs from scripts/entity-graph/backfill-eg-property-facts.mjs
 * (operator, local, chunked); the incremental refresh runs from the Worker's
 * 5-minute lane. Both write through the SAME helpers exported here, so a row
 * written by either is the same row.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FACTS_REFRESH_LOCK_KEY,
  factRecords,
  factsBaseColumns,
  factsUpsertSql,
  inRefreshBlackout,
  refreshPropertyFacts,
} from '../../src/lib/domain/entity-graph/entity-graph-facts-refresh.js'
import { factsTableColumns } from '../../src/lib/domain/entity-graph/entity-graph-facts-ddl.js'
import { COMPUTED_FACTS } from '../../src/lib/domain/entity-graph/entity-graph-facts.js'

test('blackout: 11:15 ≤ t < 14:30 UTC skips the incremental refresh', () => {
  const at = (h, m) => new Date(Date.UTC(2026, 9, 10, h, m))
  assert.equal(inRefreshBlackout(at(11, 14)), false)
  assert.equal(inRefreshBlackout(at(11, 15)), true)
  assert.equal(inRefreshBlackout(at(14, 29)), true)
  assert.equal(inRefreshBlackout(at(14, 30)), false)
  assert.equal(inRefreshBlackout(at(3, 0)), false)
})

test('refresh is inert without EG_FACTS_REFRESH_ENABLED=true, and incremental is inert inside the blackout', async () => {
  const pool = { connect: () => { throw new Error('must not connect') } }
  assert.deepEqual(await refreshPropertyFacts({ mode: 'incremental', pool, env: {} }), { ok: false, skipped: 'EG_FACTS_REFRESH_ENABLED is not true' })
  const blackout = () => new Date(Date.UTC(2026, 9, 10, 12, 0))
  assert.deepEqual(await refreshPropertyFacts({ mode: 'incremental', pool, env: { EG_FACTS_REFRESH_ENABLED: 'true' }, now: blackout }), { ok: false, skipped: 'heavy_read_blackout' })
})

test('write contract: every table column is written, plain from the view row, computed from the facts map, dates as ISO', () => {
  const columns = factsTableColumns()
  const base = factsBaseColumns(columns)
  assert.ok(base.includes('property_id'))
  for (const c of columns.filter((x) => x.plain)) assert.ok(base.includes(c.col), `base read carries plain column ${c.col}`)
  const runAt = new Date('2026-10-10T05:00:00Z')
  const plain = columns.find((c) => c.plain)
  const computed = COMPUTED_FACTS[0].col
  const recs = factRecords(
    [{ property_id: 7, [plain.col]: new Date('2026-01-02T00:00:00Z') }],
    new Map([['7', { [computed]: 'x' }]]),
    runAt,
    columns,
  )
  assert.equal(recs.length, 1)
  assert.equal(recs[0].property_id, 7)
  assert.equal(recs[0][plain.col], '2026-01-02T00:00:00.000Z')
  assert.equal(recs[0][computed], 'x')
  assert.equal(recs[0].refreshed_at, runAt.toISOString())
  assert.equal(Object.keys(recs[0]).length, columns.length + 1, 'one key per column + refreshed_at; missing values are null, never absent')
  const sql = factsUpsertSql(columns)
  assert.match(sql, /jsonb_populate_recordset\(null::public\.eg_property_facts, \$1::jsonb\)/)
  assert.match(sql, /on conflict \("property_id"\) do update set/)
  assert.equal(typeof FACTS_REFRESH_LOCK_KEY, 'number')
})
