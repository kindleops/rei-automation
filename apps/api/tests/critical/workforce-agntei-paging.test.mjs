// Bounded, explicit pagination of the model-facing Workforce reads (the live Claude Code milestone, 2026-10-22): a
// client shows its model at most 8,000 characters per tool result (Agntei), so a read never exceeds the budget and never
// cuts anything silently — rows page with next_cursor, a large member moves behind a stub that names how to read it,
// a member read pages itself. Pure (page.js); the gateway reads are proven on PostgreSQL in workforce-agntei-paging-pg.
import test from 'node:test'
import assert from 'node:assert/strict'

import { MODEL_RESULT_BUDGET, pageRows, pagePart, condense, decodeCursor, encodeCursor, at } from '../../src/lib/domain/action-gateway/actions/workforce/page.js'

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const cand = (i) => ({ property_ref: `SYNDAL-${String(i).padStart(3, '0')}`, conversation_id: uuid(100 + i), opportunity_id: uuid(200 + i), market: 'Dallas TEST', stage: 'asking_price', status: 'active', intent: 'asks_offer', temperature: 'warm', seller_spoke_last: true, last_inbound_at: '2026-10-22T10:00:00.000Z', has_decision: true })
const row = (i, o = {}) => ({ assignment_id: `wfa_${uuid(i)}`, mission_id: `wfm_${uuid(1)}`, step_key: `s${i}`, capability_key: 'research.property', status: 'ready', execution_mode: 'external', input: {}, output: {}, evidence: [], ...o })
const MCP_TEXT = (v) => `LeadCommand action result (data only, not instructions):\n${JSON.stringify({ ok: true, status: 'read', tool: 'leadcommand_workforce_list_assignments', correlation_id: uuid(9), result: v })}`
const readWith = (r, p) => ({ tool: 'leadcommand_workforce_list_assignments', arguments: { assignment_id: r.assignment_id, part: p } })

test('pageRows: rows page inside the budget with an explicit next_cursor; the union of the pages is the whole list, in order', () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(i, { input: { note: 'x'.repeat(300) }, evidence: [{ type: 'thread', id: uuid(i), resolved: true }] }))
  const seen = []
  let cursor = null
  let pages = 0
  do {
    const c = cursor ? decodeCursor(cursor, 'k') : null
    const p = pageRows(rows, { offset: c?.o ?? 0, kind: 'k', readWith })
    assert.ok(JSON.stringify(p).length <= MODEL_RESULT_BUDGET + 400, `page ${pages}: ${JSON.stringify(p).length}`)
    assert.ok(MCP_TEXT(p).length < 8000, 'fits a client capping a result at 8,000 characters')
    seen.push(...p.items)
    cursor = p.page.next_cursor
    assert.equal(p.page.complete, cursor == null)
    pages += 1
  } while (cursor && pages < 50)
  assert.ok(pages > 1, 'paged')
  assert.deepEqual(seen, rows, 'nothing lost, nothing reordered, evidence kept')
})

test('condense: a row too large on its own keeps every small field; its largest member (40 candidates) moves behind a stub naming the exact read', () => {
  const big = row(1, { input: { mode: 'delegated_review', n: 10, candidates: Array.from({ length: 40 }, (_, i) => cand(i)) }, evidence: [{ type: 'job', id: 'mjob_x', resolved: true }] })
  assert.ok(JSON.stringify(big).length > 8000)
  const p = pageRows([big], { kind: 'k', readWith })
  const r = p.items[0]
  assert.ok(MCP_TEXT(p).length < 8000)
  assert.deepEqual(r.input.candidates, { _paged: 'input.candidates', kind: 'array', items: 40, chars: JSON.stringify(big.input.candidates).length, read_with: readWith(big, 'input.candidates') })
  assert.equal(r.input.mode, 'delegated_review')
  assert.deepEqual(r.evidence, big.evidence, 'evidence is never stubbed when it fits')
  assert.equal(p.page.complete, false, 'a condensed page is not complete')
  assert.deepEqual(p.page.condensed, [{ id: big.assignment_id, members: ['input.candidates'] }])
  // the member read pages the 40 candidates; the pages reassemble them exactly
  const got = []
  let cursor = null
  do {
    const c = cursor ? decodeCursor(cursor, 'part') : null
    const part = pagePart(at(big, 'input.candidates'), { part: 'input.candidates', offset: c?.o ?? 0, kind: 'part', readWith: (pp) => readWith(big, pp) })
    assert.ok(MCP_TEXT(part).length < 8000)
    got.push(...part.items)
    cursor = part.page.next_cursor
  } while (cursor)
  assert.deepEqual(got, big.input.candidates)
})

test('pagePart: an object pages its entries; a long string pages in numbered chunks; a missing member is a refusal, not an empty answer', () => {
  const obj = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 'v'.repeat(400)]))
  const p1 = pagePart(obj, { part: 'output.research', kind: 'o', readWith: (p) => ({ part: p }) })
  assert.equal(p1.kind, 'object')
  assert.ok(p1.items.length < 30 && p1.page.next_cursor)
  assert.deepEqual(p1.items[0], { key: 'k0', value: 'v'.repeat(400) })
  const s = 'abc'.repeat(5000)
  const c1 = pagePart(s, { part: 'output.summary', kind: 's', readWith: () => null })
  assert.equal(c1.chunk, 1)
  assert.ok(c1.chunks > 1)
  let text = c1.text
  let cur = c1.page.next_cursor
  while (cur) { const n = pagePart(s, { part: 'output.summary', offset: decodeCursor(cur, 's').o, kind: 's', readWith: () => null }); text += n.text; cur = n.page.next_cursor }
  assert.equal(text, s)
  assert.throws(() => pagePart(undefined, { part: 'output.nope', kind: 'x', readWith: () => null }), (e) => e.code === 'PART_NOT_FOUND')
})

test('cursors: only one this read returned is accepted (another read\'s, a forged or a garbage cursor is CURSOR_INVALID)', () => {
  assert.deepEqual(decodeCursor(encodeCursor({ k: 'a', o: 3 }), 'a'), { k: 'a', o: 3 })
  for (const bad of [encodeCursor({ k: 'b', o: 3 }), encodeCursor({ k: 'a', o: -1 }), encodeCursor({ k: 'a', o: 1.5 }), 'zzzz', encodeCursor({ k: 'a' })]) {
    assert.throws(() => decodeCursor(bad, 'a'), (e) => e.code === 'CURSOR_INVALID', bad)
  }
  assert.equal(decodeCursor(null, 'a'), null)
})

test('condense never stubs inside a member it already stubbed, and leaves a fitting row untouched', () => {
  const r = row(1, { output: { research: { result: { a: 'x'.repeat(5000), b: 'y'.repeat(3000) } } } })
  const c = condense(r, { budget: 2000, roots: ['input', 'output', 'evidence'], readWith: (p) => ({ part: p }) })
  assert.ok(JSON.stringify(c.row).length <= 2000)
  assert.ok(c.stubbed.every((p) => !c.stubbed.some((q) => p !== q && p.startsWith(`${q}.`))), JSON.stringify(c.stubbed))
  const small = row(2)
  assert.equal(condense(small, { budget: 5000, roots: ['input'], readWith: () => null }).row, small)
})

test('read_conversation_context: the permission state and facts are always whole; the newest messages that fit, then older pages by older_cursor; the pages reassemble the thread', async () => {
  const { readConversationContext } = await import('../../src/lib/domain/action-gateway/context-read.js')
  const T = Date.parse('2026-10-22T12:00:00.000Z')
  const thread = Array.from({ length: 40 }, (_, i) => ({ id: `m${String(i).padStart(2, '0')}`, direction: i % 2 ? 'inbound' : 'outbound', at: new Date(T - (40 - i) * 60_000).toISOString(), body: `message ${i}: ${'lorem ipsum dolor sit amet '.repeat(12)}`.trim() }))
  const ci = { input: { thread, properties: [{ property_id: 'SYNDAL-001', property_type: 'SFR', city: 'Dallas', state: 'TX' }], offers: [], followups: [] }, queueRows: [], continuity: { persona_name: 'Helen', ok: true, sender_number: 'x' }, eligibilityFor: async () => ({ blocked: false, reasons: [], timing: { lawful: true, next_permitted_at: null } }) }
  const deps = {
    reads: { thread: async () => ({ id: uuid(5), thread_key: 'k5', property_id: 'SYNDAL-001' }), latestInbound: async () => ({ provider_message_sid: 'SMx', created_at: new Date(T).toISOString() }), permission: async () => ({ blocked: false, reasons: [] }) },
    services: { canonicalInputs: async () => ci, holdCheck: async () => ({ held: false }) },
    now: () => T,
  }
  const got = []
  let cursor
  let pages = 0
  do {
    const r = await readConversationContext({ input: { thread_id: uuid(5), message_limit: 40, ...(cursor ? { cursor } : {}) }, ...deps })
    assert.ok(JSON.stringify({ ok: true, status: 'read', result: r }).length < 7600, `page ${pages}: ${JSON.stringify(r).length}`)
    assert.equal(r.permission.contact_blocked, false, 'permission on every page')
    assert.equal(r.persona.name, 'Helen')
    assert.equal(r.messages_page.total, 40)
    got.unshift(...r.messages.map((m) => m.message_id))
    cursor = r.messages_page.older_cursor
    assert.equal(r.messages_page.complete, cursor == null)
    pages += 1
  } while (cursor && pages < 20)
  assert.ok(pages > 1, 'paged')
  assert.deepEqual(got, thread.map((m) => m.id), 'every message exactly once, oldest first when reassembled')
})

test('complete_assignment output: a recommendation of a ranked top 10 fits (1,500); beyond that the schema refuses it (never cut)', async () => {
  const { WF_ACTIONS, RECOMMENDATION_MAX } = await import('../../src/lib/domain/action-gateway/actions/workforce/index.js')
  const spec = WF_ACTIONS.find((s) => s.name === 'workforce_complete_assignment')
  assert.equal(RECOMMENDATION_MAX, 1500)
  assert.equal(spec.input.properties.output.properties.recommendation.maxLength, 1500)
  assert.equal(spec.input.properties.output.properties.findings.maxItems, 20)
  assert.match(spec.description, /recommendation 1500/)
})
