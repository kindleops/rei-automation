/**
 * EMAIL-COMMAND-MOBILE-LOCK-1 §13/§15/§16/§18/§19 — the send path, proven to
 * the maximum SAFE level.
 *
 * NO EMAIL IS TRANSMITTED BY THIS SCRIPT. Brevo is unconfigured in this
 * environment (no BREVO_API_KEY / BREVO_SENDER_EMAIL), so the service forces
 * dry-run and never reaches the provider. Every assertion below is about
 * refusal, durability and idempotency — not delivery.
 */
const svc = await import('../../src/lib/domain/email/email-service.js')
const { createClient } = await import('@supabase/supabase-js')

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const findings = []
const check = (name, ok, detail) => {
  if (!ok) findings.push({ name, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(52)} ${detail}`)
}

const SUPPRESSED = 'kendrinko@yahoo.com'   // suppressed for this proof, removed after
const TEST_TO = 'email-send-proof@example.invalid'
/**
 * A sender is supplied in the payload rather than configured in the database.
 * resolveSenderIdentity() accepts one (source: "payload"), so the durable-write
 * and idempotency paths can be exercised without provisioning a production
 * sender identity. Transmission is still impossible: Brevo is unconfigured, so
 * the service forces dry-run before it would ever call the provider.
 */
const SENDER = { sender_email: 'proof-sender@example.invalid', sender_name: 'Proof Sender' }

console.log('\nEMAIL SEND SAFETY PROOF (no transmission)\n')

/**
 * Self-contained: the proof creates the suppression row it needs and removes
 * it again, so it can be re-run and never depends on leftover state. A
 * suppression row is fail-safe — its only effect is to PREVENT sending.
 *
 * It also clears its own rows BEFORE asserting. Cleaning up only at the end is
 * not enough: a row left by a previous run made "the refusal wrote no queue
 * row" fail against state this run never created.
 */
for (const addr of [TEST_TO, SUPPRESSED]) {
  await db.from('email_queue').delete().eq('to_email', addr)
  await db.from('email_events').delete().eq('to_email', addr)
}
await db.from('email_queue').delete().eq('queue_key', 'draft:email-send-proof-draft')

await db.from('email_suppression').upsert({
  email_address: SUPPRESSED,
  reason: 'hard_bounce',
  source: 'send-safety-proof',
  suppression_status: 'bounced',
  is_active: true,
  last_event_at: new Date(Date.now() - 2 * 86400000).toISOString(),
}, { onConflict: 'email_address' })

// ── §31 the provider really is off
const health = await (await import('../../src/lib/domain/email/brevo-provider.js')).getBrevoHealth()
check('provider is unconfigured, so nothing can transmit',
  health.connected === false && health.send_enabled === false,
  `connected=${health.connected} send_enabled=${health.send_enabled} missing=${JSON.stringify(health.missing)}`)

// ── §13 suppression is respected
console.log('\n§13 suppression')
const sup = await svc.checkEmailSuppression(SUPPRESSED)
check('a suppressed address is reported as suppressed',
  sup.suppressed === true, `suppressed=${sup.suppressed} reason=${sup.reason ?? sup.status ?? ''}`)

const blocked = await svc.sendManualEmail({
  to: SUPPRESSED, subject: 'proof — must never send', body: '<p>must never send</p>', ...SENDER,
})
check('manual send REFUSES a suppressed address',
  blocked.ok === false && blocked.blocked === true && blocked.error === 'email_suppressed',
  `ok=${blocked.ok} blocked=${blocked.blocked} error=${blocked.error}`)
check('the refusal wrote no queue row',
  (await db.from('email_queue').select('id', { count: 'exact', head: true }).eq('to_email', SUPPRESSED)).count === 0,
  'queue rows for the suppressed address')

const clean = await svc.checkEmailSuppression(TEST_TO)
check('a clean address is not falsely suppressed', clean.suppressed === false, `suppressed=${clean.suppressed}`)

// ── §16/§15 the safe send path
console.log('\n§15/§16 durable outbound, no transmission')
const first = await svc.sendManualEmail({
  to: TEST_TO, subject: 'proof — safe path', body: '<p>safe path</p>',
  idempotency_key: 'email-send-proof-1', ...SENDER,
})
check('a send with the provider off is reported as NOT sent',
  first.ok === true && first.sent === false,
  `ok=${first.ok} sent=${first.sent} dry_run=${first.dry_run} no_send=${first.no_send}`)
check('it is explicitly marked no-send rather than successful',
  first.no_send === true || first.dry_run === true, `dry_run=${first.dry_run} no_send=${first.no_send}`)

const queued = await db.from('email_queue').select('*').eq('to_email', TEST_TO)
check('a durable outbound row exists', (queued.data || []).length === 1, `${(queued.data || []).length} row(s)`)
const row = (queued.data || [])[0] || {}
check('the durable row is NOT stamped sent or delivered',
  !['sent', 'delivered'].includes(String(row.queue_status || '').toLowerCase()) && !row.sent_at && !row.delivered_at,
  `queue_status=${row.queue_status} sent_at=${row.sent_at} delivered_at=${row.delivered_at}`)
check('thread identity is the counterparty address',
  String(row.to_email || '').toLowerCase() === TEST_TO, `to_email=${row.to_email}`)

// ── §18 idempotency
console.log('\n§18 idempotency')
const second = await svc.sendManualEmail({
  to: TEST_TO, subject: 'proof — safe path', body: '<p>safe path</p>',
  idempotency_key: 'email-send-proof-1', ...SENDER,
})
check('a repeated send is reported as a duplicate, not a second send',
  second.duplicate === true || second.already_queued === true,
  `duplicate=${second.duplicate} already_queued=${second.already_queued} sent=${second.sent}`)
const afterRepeat = await db.from('email_queue').select('id', { count: 'exact', head: true }).eq('to_email', TEST_TO)
check('a repeated send creates NO second queue row', afterRepeat.count === 1, `${afterRepeat.count} row(s)`)

// ── §19 a draft is not a send
console.log('\n§19 drafts')
const draft = await svc.saveEmailDraft({
  to: TEST_TO, subject: 'proof — draft', body: '<p>draft body</p>', draft_key: 'email-send-proof-draft',
})
check('a draft saves', draft.ok === true, `ok=${draft.ok} status=${draft.status}`)
check('a draft is NOT sent', draft.sent === false && draft.status === 'draft', `sent=${draft.sent} status=${draft.status}`)
const draftRow = await db.from('email_queue').select('*').eq('queue_key', 'draft:email-send-proof-draft').maybeSingle()
check('the draft row is stored with a draft status, not a dispatchable one',
  String(draftRow.data?.queue_status).toLowerCase() === 'draft', `queue_status=${draftRow.data?.queue_status}`)

const draftAgain = await svc.saveEmailDraft({
  to: TEST_TO, subject: 'proof — draft edited', body: '<p>edited</p>', draft_key: 'email-send-proof-draft',
})
const draftCount = await db.from('email_queue').select('id', { count: 'exact', head: true }).eq('queue_key', 'draft:email-send-proof-draft')
check('re-saving a draft updates it instead of queueing another',
  draftAgain.ok === true && draftCount.count === 1, `${draftCount.count} row(s)`)

// ── §12 recipient validation
console.log('\n§12 recipient identity')
for (const bad of ['', '   ', 'not-an-email', 'a@b, c@d']) {
  const res = await svc.sendManualEmail({ to: bad, subject: 's', body: 'b' })
  check(`refuses recipient ${JSON.stringify(bad)}`, res.ok === false, `error=${res.error}`)
}

// ── §18/§17 inbound webhook idempotency
console.log('\n§18 inbound idempotency')
const WEBHOOK_EMAIL = 'inbound-proof@example.invalid'
await db.from('email_events').delete().eq('to_email', WEBHOOK_EMAIL)
await db.from('email_events').delete().eq('event_key', 'brevo:inbound-proof:delivered')
await db.from('email_suppression').delete().eq('email_address', WEBHOOK_EMAIL)

const providerEvent = {
  event: 'delivered',
  email: WEBHOOK_EMAIL,
  'message-id': 'inbound-proof-msg-1',
  id: 'inbound-proof-evt-1',
  subject: 'inbound proof',
  date: new Date().toISOString(),
}

const wh1 = (await svc.handleBrevoWebhookEvents([providerEvent])).results
check('a provider event is accepted', wh1[0]?.ok === true, JSON.stringify(wh1[0] ?? {}).slice(0, 140))
const afterFirst = await db.from('email_events').select('id', { count: 'exact', head: true }).eq('event_key', wh1[0].event_key)
check('it writes exactly one ledger row', afterFirst.count === 1, `${afterFirst.count} row(s)`)

/**
 * §18 — REPLAY. Providers retry. The same event delivered twice must not
 * become two messages. email_events.event_key is UNIQUE and the write is an
 * upsert on it, so the second delivery updates rather than inserts.
 */
const wh2 = (await svc.handleBrevoWebhookEvents([providerEvent])).results
const afterSecond = await db.from('email_events').select('id', { count: 'exact', head: true }).eq('event_key', wh1[0].event_key)
check('replaying the SAME event creates no second row',
  wh2[0]?.ok === true && afterSecond.count === 1, `ok=${wh2[0]?.ok} rows=${afterSecond.count}`)
check('the replay derives the same event key, not a time-based one',
  wh2[0]?.event_key === wh1[0]?.event_key, `${wh1[0]?.event_key} vs ${wh2[0]?.event_key}`)

// A genuinely different event must still be recorded.
const other = (await svc.handleBrevoWebhookEvents([{ ...providerEvent, event: 'opened', id: 'inbound-proof-evt-2' }])).results
check('a different event is not swallowed by the dedupe',
  other[0]?.ok === true && other[0]?.event_key !== wh1[0]?.event_key,
  `${other[0]?.event_key}`)

/**
 * §13/§32 — a hard bounce must create suppression, which is what makes the
 * send path refuse that address afterwards.
 */
const bounce = (await svc.handleBrevoWebhookEvents([{
  event: 'hard_bounce', email: WEBHOOK_EMAIL, 'message-id': 'inbound-proof-msg-1',
  id: 'inbound-proof-evt-3', reason: 'mailbox does not exist', date: new Date().toISOString(),
}])).results
check('a hard bounce is recorded', bounce[0]?.ok === true, JSON.stringify(bounce[0] ?? {}).slice(0, 120))
const supAfterBounce = await svc.checkEmailSuppression(WEBHOOK_EMAIL)
check('§13 a hard bounce suppresses the address',
  supAfterBounce.suppressed === true, `suppressed=${supAfterBounce.suppressed} reason=${supAfterBounce.reason ?? ''}`)
const blockedAfterBounce = await svc.sendManualEmail({
  to: WEBHOOK_EMAIL, subject: 'must not send', body: '<p>x</p>', ...SENDER,
})
check('§13 sending to a bounced address is refused',
  blockedAfterBounce.ok === false && blockedAfterBounce.error === 'email_suppressed',
  `error=${blockedAfterBounce.error}`)

await db.from('email_events').delete().eq('to_email', WEBHOOK_EMAIL)
await db.from('email_suppression').delete().eq('email_address', WEBHOOK_EMAIL)
await db.from('email_queue').delete().eq('to_email', WEBHOOK_EMAIL)

// ── cleanup
console.log('\ncleanup')
await db.from('email_queue').delete().eq('to_email', TEST_TO)
await db.from('email_queue').delete().eq('to_email', SUPPRESSED)
await db.from('email_queue').delete().eq('queue_key', 'draft:email-send-proof-draft')
await db.from('email_suppression').delete().eq('email_address', SUPPRESSED)
await db.from('email_events').delete().eq('to_email', TEST_TO)
await db.from('email_events').delete().eq('to_email', SUPPRESSED)
const leftQueue = await db.from('email_queue').select('id', { count: 'exact', head: true })
const leftSup = await db.from('email_suppression').select('id', { count: 'exact', head: true })
const leftEvents = await db.from('email_events').select('id', { count: 'exact', head: true })
check('every row this proof created is removed',
  leftQueue.count === 0 && leftSup.count === 0,
  `email_queue=${leftQueue.count} email_suppression=${leftSup.count} email_events=${leftEvents.count}`)

console.log('')
if (findings.length) {
  console.log(`SEND SAFETY PROOF: ${findings.length} finding(s)`)
  for (const f of findings) console.log(`  x ${f.name}: ${f.detail}`)
  process.exit(1)
}
console.log('SEND SAFETY PROOF: clean — no email transmitted')
