// rc-8.5.21 owner acceptance criterion 14: scheduler, plan-time entry points and dispatch eligibility
// are consistent. The campaign feeder's plan-time check, queueAutoReply, the workflow guard /
// condition and the canonical queue writer pass the RECIPIENT PHONE and evidence into the SAME
// recipient-window functions the dispatcher uses (never a bare zone). Grid: 48 h of quarter-hours ×
// profiles (incl. absentee owners) — the entry-point verdict equals the dispatcher's verdict at every
// instant.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluateContactWindow, evaluateDispatchWindow, evaluateRecipientWindowForEntry } from '../../src/lib/supabase/sms-engine.js'
import { evaluateGuardNode } from '../../src/lib/domain/workflow-v2/guard-evaluator.js'
import { evaluateConditionNode } from '../../src/lib/domain/workflow-v2/condition-evaluator.js'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/lib')
const START = Date.parse('2026-10-19T04:00:00.000Z')
const INSTANTS = Array.from({ length: 192 }, (_, i) => START + i * 15 * 60_000)
const PROFILES = [
  { name: 'ET area code + CA property (absentee)', phone: '+13055550123', property: { state: 'CA', zip: '94110' }, timezone: 'America/Los_Angeles' },
  { name: 'non-geographic phone + Denver property', phone: '+15005550123', property: { state: 'CO', zip: '80202' }, timezone: 'America/Denver' },
  { name: 'PT area code + TX property (absentee)', phone: '+14155550123', property: { state: 'TX', zip: '75201' }, timezone: 'America/Chicago' },
  { name: 'local CT seller', phone: '+12145550123', property: { state: 'TX', zip: '75201' }, timezone: 'America/Chicago' },
  { name: 'ET phone, ET mailing, AZ property', phone: '+16175550123', property: { state: 'AZ', zip: '85004' }, mailing: { state: 'MA', zip: null }, timezone: 'America/Phoenix' },
]
const iso = (ms) => new Date(ms).toISOString()

/** The row the dispatcher sees for the same touch (what the entry point would write). */
function dispatcherRow(p, kind, at) {
  return {
    to_phone_number: p.phone, timezone: p.timezone, property_address_state: p.property.state, property_address_zip: p.property.zip,
    scheduled_for: iso(at), scheduled_for_utc: iso(at), created_at: iso(at),
    type: kind === 'campaign' ? 'campaign' : kind === 'reply' ? 'auto_reply' : 'followup',
    metadata: kind === 'reply' ? { type: 'reply', inbound_message_event_id: 'in-1', inbound_received_at: iso(at - 4 * 60_000), conversational_reply: { queued_at: iso(at) } } : { send_kind: kind },
  }
}

test('criterion 14: campaign / follow-up / reply entry-point verdicts equal the dispatcher verdict at every quarter-hour (48 h × profiles × 3 kinds)', () => {
  let compared = 0
  const mismatches = []
  for (const p of PROFILES) {
    for (const kind of ['campaign', 'followup', 'reply']) {
      for (const at of INSTANTS) {
        const entry = evaluateRecipientWindowForEntry({ entry: kind, recipient_phone: p.phone, timezone: p.timezone, property_geography: p.property, mailing_geography: p.mailing || null, inbound_message_event_id: kind === 'reply' ? 'in-1' : null, inbound_received_at: kind === 'reply' ? iso(at - 4 * 60_000) : null, now: iso(at) })
        const row = dispatcherRow(p, kind, at)
        const disp = kind === 'reply' ? evaluateDispatchWindow(row, { now: iso(at), mailingGeography: p.mailing || null }).allowed : evaluateContactWindow(row, { now: iso(at), mailingGeography: p.mailing || null }).allowed
        compared += 1
        if (Boolean(entry.allowed) !== Boolean(disp)) mismatches.push([p.name, kind, iso(at), entry.allowed, disp])
      }
    }
  }
  assert.equal(mismatches.length, 0, JSON.stringify(mismatches.slice(0, 5)))
  assert.equal(compared, PROFILES.length * 3 * 192)
  console.log(`entry-point grid: ${compared} comparisons, 0 mismatches`)
})

test('criterion 14: ET-area-code seller with a CA property — no entry point admits 21:00–24:00 ET for a campaign or a follow-up; an in-session reply goes at any hour', () => {
  const p = PROFILES[0]
  for (const at of INSTANTS) {
    const etHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(at)))
    for (const kind of ['campaign', 'followup']) {
      const v = evaluateRecipientWindowForEntry({ entry: kind, recipient_phone: p.phone, timezone: p.timezone, property_geography: p.property, now: iso(at) })
      if (etHour >= 21) assert.equal(v.allowed, false, `${kind} at ${iso(at)} (${etHour}:xx ET)`)
    }
    assert.equal(evaluateRecipientWindowForEntry({ entry: 'reply', recipient_phone: p.phone, timezone: p.timezone, property_geography: p.property, inbound_message_event_id: 'in-1', inbound_received_at: iso(at - 3 * 60_000), now: iso(at) }).allowed, true, `reply at ${iso(at)}`)
  }
})

test('criterion 14: the workflow guard and condition nodes give the dispatcher verdict for the recipient (mocked clock over 48 h)', async () => {
  for (const p of PROFILES.slice(0, 3)) {
    for (const at of INSTANTS.filter((_, i) => i % 3 === 0)) {
      mock.timers.enable({ apis: ['Date'], now: at })
      try {
        const ctx = { to_phone_number: p.phone, timezone: p.timezone, property_address_state: p.property.state, property_address_zip: p.property.zip, owner_address_state: p.mailing?.state || null }
        const g = await evaluateGuardNode({ node_type: 'guard.contact_window' }, { context: ctx }, {}, {})
        const c = await evaluateConditionNode({ node_type: 'condition.contact_window_open', config: {} }, { context: ctx }, { supabase: { from: () => ({}) } })
        const disp = evaluateContactWindow(dispatcherRow(p, 'followup', at), { now: iso(at), mailingGeography: p.mailing || null }).allowed
        assert.equal(Boolean(g.passed), disp, `guard ${p.name} ${iso(at)} ${JSON.stringify(g)}`)
        assert.equal(Boolean(c.result), disp, `condition ${p.name} ${iso(at)} ${JSON.stringify(c)}`)
      } finally { mock.timers.reset() }
    }
  }
})

test('criterion 14 (static): every plan-time entry point calls evaluateRecipientWindowForEntry with the recipient phone — never evaluateContactWindow with a bare zone', () => {
  const files = ['domain/outbound/supabase-candidate-feeder.js', 'automation/queueAutoReply.js', 'domain/workflow-v2/guard-evaluator.js', 'domain/workflow-v2/condition-evaluator.js', 'domain/queue/canonical-queue-writer.js']
  for (const f of files) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\/\/.*$/gm, '')
    assert.ok(/evaluateRecipientWindowForEntry|deps\.evaluateContactWindow\(\{\s*entry:/.test(src), `${f} calls the shared entry function`)
    assert.ok(/recipient_phone:/.test(src), `${f} passes the recipient phone`)
    assert.ok(!/evaluateContactWindow\(\{\s*(?:timezone|scheduled_for_utc|contact_window)/.test(src), `${f} still asks with a bare zone`)
    assert.ok(!/timezone:\s*[^,\n]*\|\|\s*["']America\/(?:Chicago|New_York)["']/.test(src) || f.endsWith('supabase-candidate-feeder.js') && !/window_check[\s\S]{0,400}America\/Chicago/.test(src), `${f} defaults a zone`)
  }
  const qar = fs.readFileSync(path.join(SRC, 'automation/queueAutoReply.js'), 'utf8')
  assert.match(qar, /import \{ evaluateRecipientWindowForEntry as defaultWindowCheck \}/)
})
