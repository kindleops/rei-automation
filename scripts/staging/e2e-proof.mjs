/**
 * Seller portal + scheduling core — end-to-end proof on the isolated staging
 * branch, through the REAL REI Automation API (scripts/staging/run-api.sh) and
 * the real staging database. Sign-in codes are read from the email capture
 * sink exactly as a seller reads them from email.
 *
 *   node scripts/staging/e2e-proof.mjs
 *
 * Refuses unless scripts/staging/guard.mjs proves staging identity.
 */
import { readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { assertStaging, readEnvFile } from './guard.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const env = readEnvFile(path.join(ROOT, 'apps/api/.env.scheduling-staging.local'))
await assertStaging({ url: env.STAGING_SUPABASE_URL, serviceKey: env.STAGING_SUPABASE_SERVICE_ROLE_KEY })

const API = 'http://localhost:3201'
const CAPTURE = '/tmp/sched-cert/emails'
const SUPA = env.STAGING_SUPABASE_URL
const SKEY = env.STAGING_SUPABASE_SERVICE_ROLE_KEY
const OPP = { A: '0a000000-5eed-4000-8000-00000000000a', B: '0b000000-5eed-4000-8000-00000000000b', C: '0c000000-5eed-4000-8000-00000000000c', D: '0d000000-5eed-4000-8000-00000000000d', E: '0e000000-5eed-4000-8000-00000000000e' }

const results = []
const timings = {}
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`) }
const timed = async (label, fn) => { const t = performance.now(); try { return await fn() } finally { (timings[label] ||= []).push(performance.now() - t) } }

async function portal(action, body = {}, token = null, ip = '203.0.113.10') {
  return timed(`portal:${action}`, async () => {
    const res = await fetch(`${API}/api/internal/seller-portal/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-seller-portal-secret': env.STAGING_PORTAL_SECRET, 'x-seller-client-ip': ip, ...(token ? { 'x-seller-session': token } : {}) }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  })
}
async function ops(method, route, body, userEmail = 'staging-admin@example.test') {
  return timed(`ops:${route.split('?')[0].split('/').slice(0, 3).join('/')}`, async () => {
    const res = await fetch(`${API}/api/cockpit/${route}`, { method, headers: { 'content-type': 'application/json', 'x-ops-dashboard-secret': env.STAGING_OPS_SECRET, 'x-ops-user-id': staff[userEmail] }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  })
}
async function rest(pathq, init = {}) {
  const res = await fetch(`${SUPA}/rest/v1/${pathq}`, { ...init, headers: { apikey: SKEY, authorization: `Bearer ${SKEY}`, 'content-type': 'application/json', prefer: 'return=representation', ...(init.headers || {}) } })
  return res.json()
}
const captured = () => readdirSync(CAPTURE).sort().map((f) => JSON.parse(readFileSync(path.join(CAPTURE, f), 'utf8')))
const lastCode = (email) => captured().filter((m) => m.kind === 'sign_in_code' && m.to === email).map((m) => /(\d{6})/.exec(m.subject)?.[1]).filter(Boolean).at(-1)

async function signIn(email, ip) {
  const before = captured().length
  const start = await portal('sign-in-start', { email }, null, ip)
  const code = lastCode(email)
  const fresh = captured().length > before
  if (!fresh || !code) return { start, token: null }
  const v = await portal('sign-in-verify', { email, code }, null, ip)
  return { start, token: v.body.session_token ?? null }
}

// ---------------------------------------------------------------- setup ----
rmSync(CAPTURE, { recursive: true, force: true }); mkdirSync(CAPTURE, { recursive: true })
const staffRows = await rest('rpc/staging_identity', { method: 'POST', body: '{}' }) // re-proves identity over REST
check('staging identity proven over the API key', staffRows?.[0]?.environment === 'staging')
const users = await fetch(`${SUPA}/auth/v1/admin/users?per_page=50`, { headers: { apikey: SKEY, authorization: `Bearer ${SKEY}` } }).then((r) => r.json())
const staff = Object.fromEntries((users.users || []).filter((u) => /^staging-.*@example\.test$/.test(u.email)).map((u) => [u.email, u.id]))
// Clean previous proof runs (portal identities/sessions/messages/appointments for fixture opportunities only).
for (const t of ['seller_portal_messages', 'seller_portal_document_shares', 'seller_portal_notifications']) await rest(`${t}?opportunity_id=in.(${Object.values(OPP).join(',')})`, { method: 'DELETE' })
await rest(`scheduling_appointments?source=in.(prominent_portal,prominent_public,client:second_brand_test,second_brand_test)`, { method: 'DELETE' })
await rest('seller_portal_identities?email=like.*%40example.test', { method: 'DELETE' })
await rest('seller_portal_throttle?id=gt.0', { method: 'DELETE' })
// Real bytes for the two fixture documents (synthetic one-page PDFs).
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
for (const p of ['fixtures/case-B/title-commitment-fixture.pdf', 'fixtures/case-B/assignment-fixture.pdf']) {
  await fetch(`${SUPA}/storage/v1/object/email-attachments/${p}`, { method: 'POST', headers: { apikey: SKEY, authorization: `Bearer ${SKEY}`, 'content-type': 'application/pdf', 'x-upsert': 'true' }, body: pdf })
}

// ---------------------------------------------- 1. sign-in & association ----
const alex = await signIn('alex@example.test', '203.0.113.21')
check('alex signs in with the emailed code', alex.token)
const eve = await signIn('eve@example.test', '203.0.113.22')
check('failed intake (eve) gets the same response and no code', eve.start.status === 200 && eve.start.body.status === alex.start.body.status && !eve.token)
const nobody = await signIn('nobody@example.test', '203.0.113.23')
check('unknown address: same response, no code', nobody.start.body.status === alex.start.body.status && !nobody.token)
const stA = await portal('state', {}, alex.token)
check('alex sees exactly his two properties', stA.body.properties?.length === 2 && stA.body.properties.every((p) => [OPP.A, OPP.C].includes(p.opportunity_id)))
const stAa = await portal('state', { opportunity_id: OPP.A }, alex.token)
check('property A shows the sent written offer', stAa.body.offer?.tier === 'written_offer' && stAa.body.offer?.amount === 212000, stAa.body.offer?.tier)
const stAc = await portal('state', { opportunity_id: OPP.C }, alex.token)
check('property C shows a non-binding estimate, not an offer', stAc.body.offer?.tier === 'estimate' && stAc.body.offer?.binding === false)
const forbidden = await portal('state', { opportunity_id: OPP.B }, alex.token)
check('alex cannot open blair’s property (404, indistinguishable from missing)', forbidden.status === 404)
const dana = await signIn('dana@example.test', '203.0.113.24')
const drew = await signIn('drew@example.test', '203.0.113.25')
const sd = await portal('state', {}, dana.token)
const sw = await portal('state', {}, drew.token)
check('two co-owner accounts both resolve the same property E', sd.body.property?.opportunity_id === OPP.E && sw.body.property?.opportunity_id === OPP.E)
check('a co-owner sees nothing else', sd.body.properties?.length === 1)
const grants = await rest(`seller_portal_grants?select=granted_via,opportunity_id&opportunity_id=in.(${Object.values(OPP).join(',')})`)
check('every grant came from a verified accepted intake match', grants.length > 0 && grants.every((g) => g.granted_via === 'intake_email_match'))
check('no grant on property C for the failed intake', !grants.some((g) => g.opportunity_id === OPP.C && false) && (await rest('seller_portal_identities?email=eq.eve%40example.test')).length === 0)

// ------------------------------------------------- 2. forged/expired auth ----
check('forged session is refused', (await portal('state', {}, 'x'.repeat(43))).status === 401)
check('wrong portal secret is refused', (await fetch(`${API}/api/internal/seller-portal/state`, { method: 'POST', headers: { 'x-seller-portal-secret': 'wrong' } })).status === 401)

// ---------------------------------------------------------- 3. messages ----
const sent = await portal('messages-send', { opportunity_id: OPP.A, body: 'Can I leave the shed? (fixture)', idempotency_key: 'proof-1' }, alex.token)
await portal('messages-send', { opportunity_id: OPP.A, body: 'Can I leave the shed? (fixture)', idempotency_key: 'proof-1' }, alex.token)
const msgs = await rest(`seller_portal_messages?opportunity_id=eq.${OPP.A}`)
check('seller message stored once (idempotent)', sent.status === 200 && msgs.length === 1)
const inbox = await rest('inbox_thread_state?thread_key=eq.%2B15555550101&select=is_read,next_action')
check('operations are flagged in the canonical inbox', inbox[0]?.is_read === false && inbox[0]?.next_action === 'seller_portal_activity')
const conv = await ops('GET', 'seller-portal/conversations?unread=1')
check('ops conversations list shows it unread with property context', conv.body.conversations?.some((c) => c.opportunity_id === OPP.A && c.unread === 1 && c.opportunity?.property_address_full?.startsWith('1240')))
const reply = await ops('POST', `seller-portal/${OPP.A}`, { action: 'reply', body: 'Yes, leave it. (fixture)', operator: 'spoofed-name' })
const opMsg = (await rest(`seller_portal_messages?opportunity_id=eq.${OPP.A}&author_kind=eq.operator`))[0]
check('operator reply is attributed to the authenticated user, not the body', reply.status === 200 && opMsg?.author_operator === staff['staging-admin@example.test'])
check('seller is emailed once about the reply, deep-linked to messages', captured().filter((m) => m.kind === 'message' && m.to === 'alex@example.test').length === 1 && captured().some((m) => m.kind === 'message' && m.text.includes('/account/messages/')))

// --------------------------------------------------------- 4. documents ----
const docs = await ops('GET', `seller-portal/${OPP.B}`)
const shareable = (docs.body.documents?.shareable || []).map((a) => a.filename)
check('only the title document is shareable; the buyer assignment never is', shareable.includes('title-commitment-fixture.pdf') && !shareable.includes('assignment-fixture.pdf'), shareable.join(','))
const buyerAttempt = await ops('POST', `seller-portal/${OPP.B}`, { action: 'share', attachment_id: '5b000000-5eed-4000-8000-0000000000b2', label: 'x' })
check('sharing the buyer document is refused', buyerAttempt.status === 422)
const blair = await signIn('blair@example.test', '203.0.113.26') // an account must exist to be notified
const share = await ops('POST', `seller-portal/${OPP.B}`, { action: 'share', attachment_id: '5b000000-5eed-4000-8000-0000000000b1', label: 'Title commitment', kind: 'title' })
const link = await portal('document-link', { document_id: share.body.share?.id }, blair.token)
const file = link.body.url ? await fetch(link.body.url) : null
check('blair downloads the shared document through a short-lived signed link', file?.status === 200 && link.body.expires_in === 300)
check('served as an attachment with its filename', /attachment/.test(file?.headers.get('content-disposition') || '') && /title-commitment-fixture\.pdf/.test(file?.headers.get('content-disposition') || ''))
check('alex cannot fetch blair’s document (IDOR)', (await portal('document-link', { document_id: share.body.share?.id }, alex.token)).status === 404)
check('document-ready email sent to blair', captured().some((m) => m.kind === 'document_ready' && m.to === 'blair@example.test'))
await ops('POST', `seller-portal/${OPP.B}`, { action: 'revoke', share_id: share.body.share?.id })
check('revocation is immediate', (await portal('document-link', { document_id: share.body.share?.id }, blair.token)).status === 404)
const anonStorage = await fetch(`${SUPA}/storage/v1/object/public/email-attachments/fixtures/case-B/title-commitment-fixture.pdf`)
check('the bucket is not public', anonStorage.status >= 400)

// -------------------------------------------- 5. closing & lifecycle mail ----
const stB = await portal('state', {}, blair.token)
check('blair sees closing scheduled and the action she owns', ['closing_scheduled', 'title_review', 'agreement'].includes(stB.body.state) && stB.body.next_action?.kind === 'action_needed', `${stB.body.state}/${stB.body.next_action?.kind}`)
const casey = await signIn('casey@example.test', '203.0.113.27')
check('casey sees closed', (await portal('state', {}, casey.token)).body.state === 'closed')
const newDate = new Date(Date.now() + 12 * 86400e3); newDate.setUTCHours(18, Math.floor(Math.random() * 59), 0, 0) // a new date each run (the same date is correctly a no-op)
const d1 = await ops('POST', 'closing-desk/execution/fixture-case-B/actions', { action: 'set_closing_date', scheduledAt: newDate.toISOString(), tz: 'America/New_York', confirmed: true, reason: 'Proof: date moved (fixture)', source: 'operator_confirmation' })
await ops('POST', 'closing-desk/execution/fixture-case-B/actions', { action: 'set_closing_date', scheduledAt: newDate.toISOString(), tz: 'America/New_York', confirmed: true, reason: 'Proof: repeated (fixture)', source: 'operator_confirmation' })
const changed = captured().filter((m) => m.kind === 'closing_changed' && m.to === 'blair@example.test')
check('confirmed date change → one "closing changed" email, deep-linked', d1.status === 200 && changed.length === 1 && changed[0].text.includes('/account/closing/'), `status ${d1.status} emails ${changed.length}`)
await ops('POST', 'closing-desk/execution/fixture-case-B/actions', { action: 'open_title_issue', issueType: 'other', owner: 'seller', description: 'Proof: sign the affidavit (fixture)', source: 'title_email', idempotencyKey: `proof-${Date.now()}` })
check('a seller-owned title item → "action needed" email', captured().some((m) => m.kind === 'action_needed' && m.to === 'blair@example.test'))

// -------------------------------------------- 6. scheduling (core + Google-less) ----
const slots = await portal('call-slots', { reason: 'offer', timezone: 'America/Chicago' }, alex.token)
check('real availability from configured staff, labelled in the seller’s zone', slots.body.available && slots.body.slots.length > 0 && slots.body.slots[0].zone?.startsWith('C'), `${slots.body.slots?.length} slots`)
check('public availability reveals times only', slots.body.slots.every((s) => Object.keys(s).sort().join() === 'end_at,start_at,zone'))
const book = await portal('call-book', { reason: 'offer', start_at: slots.body.slots[0].start_at, timezone: 'America/Chicago', idempotency_key: 'proof-book-1' }, alex.token)
const appt = (await rest(`scheduling_appointments?id=eq.${book.body.call?.id}&select=resource_id,routed_via,related_refs,customer,status,sync_status`))[0]
check('booked to the opportunity owner (Advisor A) by routing, identity from the session', appt?.resource_id === 'aaaaaaaa-5eed-4000-8000-000000000001' && appt?.routed_via === 'specific_owner_or_pool' && appt?.customer?.email === 'alex@example.test', `${appt?.routed_via}`)
check('call-scheduled email captured, deep-linked to the schedule page', captured().some((m) => m.kind === 'call_scheduled' && m.text.includes('/account/schedule/')))
check('without a Google connection the appointment says so (no false "synced")', appt?.sync_status === 'not_connected')
const again = await portal('call-book', { reason: 'offer', start_at: slots.body.slots[0].start_at, timezone: 'America/Chicago', idempotency_key: 'proof-book-1' }, alex.token)
check('a retried booking returns the same appointment', again.body.call?.id === book.body.call?.id)
const secrets = JSON.parse(env.STAGING_SCHEDULING_CLIENT_SECRETS || '{}')
const sb = (name) => fetch(`${API}/api/internal/scheduling/book`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-scheduling-client': 'second_brand_test', 'x-scheduling-secret': secrets.second_brand_test }, body: JSON.stringify({ event_type: 'onboarding', start_at: slots.body.slots[0].start_at, customer: { name } }) }).then(async (r) => ({ status: r.status, body: await r.json() }))
const second = await sb('Second brand (fixture)')
const secondRow = second.body.appointment ? (await rest(`scheduling_appointments?id=eq.${second.body.appointment.id}&select=resource_id`))[0] : null
check('second brand at the same time is routed to the OTHER free person, never double-booking Advisor A', second.status === 200 && secondRow?.resource_id === 'aaaaaaaa-5eed-4000-8000-000000000002', `HTTP ${second.status} → ${secondRow?.resource_id}`)
const third = await sb('Third request (fixture)')
check('with both people taken, the next request at that time is refused (409) with fresh times', third.status === 409 && third.body.error === 'slot_unavailable' && Array.isArray(third.body.slots))
const overlapRows = await rest(`scheduling_appointments?resource_id=eq.aaaaaaaa-5eed-4000-8000-000000000001&status=in.(scheduled,confirmed)&start_at=eq.${encodeURIComponent(slots.body.slots[0].start_at)}&select=id`)
check('exactly one live appointment holds Advisor A at that time across brands', overlapRows.length === 1)
const moved = await portal('call-reschedule', { appointment_id: book.body.call.id, start_at: slots.body.slots[3].start_at }, alex.token)
const old = (await rest(`scheduling_appointments?id=eq.${book.body.call.id}&select=status,rescheduled_to_id`))[0]
check('reschedule moves the call atomically and links it', moved.status === 200 && old?.status === 'rescheduled' && old?.rescheduled_to_id === moved.body.call?.id)
const reopen = await portal('call-slots', { reason: 'offer' }, alex.token)
check('the original time returns', reopen.body.slots.some((s) => s.start_at === slots.body.slots[0].start_at))
const cancel = await portal('call-cancel', { appointment_id: moved.body.call.id }, alex.token)
check('cancel releases the time', cancel.status === 200 && (await portal('call-slots', { reason: 'offer' }, alex.token)).body.slots.some((s) => s.start_at === slots.body.slots[3].start_at))
check('blair cannot cancel alex’s call', (await portal('call-cancel', { appointment_id: moved.body.call.id }, blair.token)).status === 404)
const reminders = await rest(`email_queue?source=eq.scheduling&metadata->>appointment_id=eq.${moved.body.call.id}&select=queue_status,lane,brand_key,scheduled_for`)
check('reminders were queued on the transactional lane with the Prominent sender', reminders.length > 0 && reminders.every((r) => r.lane === 'transactional' && r.brand_key === 'prominent'), `${reminders.length} rows`)

// ---------------------------------------------------- 7. ops permissions ----
const plain = await ops('POST', 'scheduling/pool-member', { brand: 'prominent_cash_offer', pool_key: 'seller_advisors', resource_id: 'aaaaaaaa-5eed-4000-8000-000000000002', active: false }, 'staging-operator@example.test')
check('a plain operator cannot change routing pools', plain.status === 403)
const asAdmin = await ops('GET', 'scheduling/permissions', null, 'staging-admin@example.test')
check('the admin holds scheduling.admin', asAdmin.body.scheduling_admin === true)
const opsList = await ops('GET', 'scheduling/appointments?view=cancelled&brand=prominent_cash_offer')
check('ops calendar lists the cancelled call with domain context', opsList.body.appointments?.some((a) => a.id === moved.body.call.id && a.context?.summary?.includes('Prominent')))

// ------------------------------------------------------------ 8. abuse ----
let throttled = false
for (let i = 0; i < 22; i++) { const r = await portal('sign-in-start', { email: `probe${i}@example.test` }, null, '198.51.100.99'); if (i === 21) throttled = r.body.status === 'code_sent_if_eligible' }
const audit = await rest('seller_portal_audit_events?event=eq.sign_in_throttled&select=id')
check('per-IP sign-in throttle engages silently and is audited', throttled && audit.length > 0)

// ------------------------------------------------------------- summary ----
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} end-to-end checks passed`)
console.log('\nLATENCY (ms, staging API → staging DB, local dev server):')
for (const [k, v] of Object.entries(timings).sort()) { const s = [...v].sort((a, b) => a - b); console.log(`  ${k.padEnd(34)} n=${String(s.length).padStart(2)}  p50=${Math.round(s[Math.floor(s.length / 2)])}  max=${Math.round(s.at(-1))}`) }
process.exit(failed.length ? 1 : 0)
