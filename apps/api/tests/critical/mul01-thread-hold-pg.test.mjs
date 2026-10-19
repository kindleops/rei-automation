// blind-eval v2 MUL-01 (safety; owner rule 2026-10-17), on a DISPOSABLE PostgreSQL 17 with the REAL hold
// registry, the follow-up lifecycle and the send_queue hold trigger: once the ambiguous two-property
// "No" records its thread hold (recordOwnershipAttributionHold — the inbound path's writer), NO layer can
// produce a nurture row, a queue row or a send for the thread; the hold is recorded and visible.
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { lifecycleDb, seedWorld, seedThread, planNurture, materialize, trapTransport, intentsOf, rowsOf, sel } from '../helpers/followup-lifecycle-pg.mjs'
import { recordOwnershipAttributionHold } from '../../src/lib/domain/holds/ownership-attribution-hold.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'

const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null) // the REAL registry answers

test('PG MUL-01: the recorded ownership-attribution thread hold ⇒ zero materialized rows, the queue trigger refuses any row, zero sends; the hold is recorded once', { skip }, async () => {
  const env = await lifecycleDb()
  const net = trapTransport()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550177'
    const { inboundId } = await seedThread(env.pool, { phone, property: 'p1', inboundBody: 'No' })
    // the hold is recorded by the inbound path (idempotent)
    const h1 = await recordOwnershipAttributionHold({ supabase: env.sb, thread_key: phone, property_ids: ['p1'], source_message_id: inboundId, basis: 'several_open_ownership_questions' })
    const h2 = await recordOwnershipAttributionHold({ supabase: env.sb, thread_key: phone, property_ids: ['p1'], source_message_id: inboundId, basis: 'several_open_ownership_questions' })
    assert.deepEqual([h1.ok, h1.recorded, h2.ok, h2.existing], [true, true, true, true], JSON.stringify([h1, h2]))
    const holds = await sel(env.pool, `select hold_type, reason, blocked_capabilities from public.automation_holds where thread_key = $1 and released_at is null`, [phone])
    assert.equal(holds.length, 1)
    assert.equal(holds[0].reason, 'ownership_denial_property_unresolved')
    assert.ok(!holds[0].blocked_capabilities.includes('manual_send'))
    // even if some writer planned a nurture, the lifecycle never materializes it
    await planNurture(env.sb, phone, { inboundId, property: 'p1' })
    await materialize(env)
    assert.equal((await rowsOf(env.pool, phone)).length, 0, 'no follow-up row')
    for (const i of await intentsOf(env.pool, phone)) assert.ok(['held', 'not_executable', 'cancelled', 'superseded'].includes(i.state), `intent ${i.state} ${i.reason}`)
    // the queue trigger refuses any automated row for the thread (a reply, a close, a campaign touch)
    await assert.rejects(
      env.pool.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key, type, metadata) values ('mul01-close', 'queued', 'Understood, thanks for replying.', $1::text, $1::text, 'auto_reply', '{}'::jsonb)`, [phone]),
      /AUTOMATION_HOLD/,
    )
    assert.equal((await sel(env.pool, `select count(*)::int n from public.send_queue where thread_key = $1 and queue_status in ('queued','scheduled','pending','processing','ready','approved')`, [phone]))[0].n, 0)
    assert.deepEqual(net.hits, [], 'zero sends')
  } finally { net.restore(); await env.db.drop() }
})
