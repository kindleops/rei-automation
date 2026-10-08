/**
 * Lifecycle notification proof on the isolated staging branch, through the
 * CANONICAL writers (not the notifier directly). Capture sink only.
 *
 *   cd apps/api && node --import ./tests/register-live-proof.mjs ../../scripts/staging/notification-proof.mjs
 */
import { readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { assertStaging, readEnvFile } from './guard.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const env = readEnvFile(path.join(ROOT, 'apps/api/.env.scheduling-staging.local'))
await assertStaging({ url: env.STAGING_SUPABASE_URL, serviceKey: env.STAGING_SUPABASE_SERVICE_ROLE_KEY })
const CAP = '/tmp/sched-cert/notif-emails'
rmSync(CAP, { recursive: true, force: true }); mkdirSync(CAP, { recursive: true })
Object.assign(process.env, {
  SUPABASE_URL: env.STAGING_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: env.STAGING_SUPABASE_SERVICE_ROLE_KEY,
  SELLER_PORTAL_ENABLED: '1', SELLER_PORTAL_EMAIL_ENABLED: '1', SELLER_PORTAL_EMAIL_CAPTURE_DIR: CAP,
  SELLER_PORTAL_PUBLIC_BASE_URL: 'http://localhost:3113', STAGING_CERTIFICATION: '1', NODE_ENV: 'test', STAGING_EMAIL_RECIPIENT: '',
})
const { bindOfferToQueueRow } = await import('@/lib/domain/seller-flow/seller-offer-authority.js')
const { setClosingDate } = await import('@/lib/domain/closings/closing-authority.js')
const { revalidateSchedulingEmail } = await import('@/lib/domain/scheduling/scheduling-reminders.js')
const { getDefaultSupabaseClient } = await import('@/lib/supabase/default-client.js')
const db = getDefaultSupabaseClient()

const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }
const mail = () => readdirSync(CAP).sort().map((f) => JSON.parse(readFileSync(path.join(CAP, f), 'utf8')))
const E = '0e000000-5eed-4000-8000-00000000000e'
const run = Date.now()

// Co-owner accounts for property E must exist (both signed in during the e2e proof).
const { data: ids } = await db.from('seller_portal_grants').select('identity_id').eq('opportunity_id', E).is('revoked_at', null)
check('property E has two linked co-owner accounts', ids?.length === 2, `${ids?.length}`)

// ---- offer ready: the canonical sent_at stamp --------------------------------
await db.from('seller_offers').update({ status: 'superseded', superseded_at: new Date().toISOString() }).eq('opportunity_id', E).eq('status', 'active')
const offerId = `proof-offer-E-${run}`
const ins = await db.from('seller_offers').insert({ offer_id: offerId, opportunity_id: E, thread_key: '+15555550105', offer_version: Math.floor(run / 1000) % 100000, offer_type: 'cash', purchase_price: 176000, status: 'active', terms_hash: 'proof', metadata: { fixture: true } })
check('a new offer row is created (not yet sent)', !ins.error, ins.error?.message)
await bindOfferToQueueRow({ offer_id: offerId, send_queue_row_id: `proof-${run}`, supabase: db })
const offerMails = mail().filter((m) => m.kind === 'offer_ready')
check('offer ready → each co-owner emailed once', offerMails.length === 2 && new Set(offerMails.map((m) => m.to)).size === 2, offerMails.map((m) => m.to).join(','))
check('offer email deep-links to /account/offer/ with no token', offerMails.every((m) => m.text.includes('http://localhost:3113/account/offer/') && !/[?&](token|session|code)=/.test(m.html)))
await bindOfferToQueueRow({ offer_id: offerId, send_queue_row_id: `proof-${run}-again`, supabase: db })
check('re-stamping the same offer does not email again', mail().filter((m) => m.kind === 'offer_ready').length === 2)

// ---- closing scheduled / changed: confirmed dates only ----------------------
const caseId = `proof-case-E-${run}`
await db.from('closing_cases').delete().eq('opportunity_id', E)
await db.from('closing_cases').insert({ closing_case_id: caseId, opportunity_id: E, property_address: '19 Birch Lane, Savannah, GA 31401', closing_status: 'not_scheduled', provenance: { fixture: true } })
const d1 = new Date(Date.now() + 20 * 86400e3); d1.setUTCHours(17, 0, 0, 0)
const target = await setClosingDate({ closingCaseId: caseId, scheduledAt: d1.toISOString(), confirmed: false, reason: 'Proof target (fixture)', source: 'operator', actor: 'proof', tz: 'America/New_York' }, { supabase: db })
check('an unconfirmed target date sends nothing', target.ok && mail().filter((m) => m.kind.startsWith('closing')).length === 0, JSON.stringify(target).slice(0, 80))
await setClosingDate({ closingCaseId: caseId, scheduledAt: d1.toISOString(), confirmed: true, reason: 'Proof confirmed (fixture)', source: 'operator_confirmation', actor: 'proof', tz: 'America/New_York' }, { supabase: db })
check('first confirmed date → "closing scheduled" to both', mail().filter((m) => m.kind === 'closing_scheduled').length === 2)
const d2 = new Date(d1.getTime() + 2 * 86400e3)
await setClosingDate({ closingCaseId: caseId, scheduledAt: d2.toISOString(), confirmed: true, reason: 'Proof moved (fixture)', source: 'operator_confirmation', actor: 'proof', tz: 'America/New_York' }, { supabase: db })
const changed = mail().filter((m) => m.kind === 'closing_changed')
check('changed confirmed date → "closing changed" to both, with the new date in their zone', changed.length === 2 && changed.every((m) => /EST|EDT/.test(m.text)), changed[0]?.text?.split('\n')[2])

// ---- reminders: revalidated against the real appointment rows ---------------
const { data: rows } = await db.from('email_queue').select('id, metadata, source_ref').eq('source', 'scheduling').limit(50)
let live = 0, dropped = 0
for (const r of rows || []) {
  const v = await revalidateSchedulingEmail(db, r)
  const { data: a } = await db.from('scheduling_appointments').select('status, start_at').eq('id', r.metadata.appointment_id).maybeSingle()
  const shouldSend = a && ['scheduled', 'confirmed'].includes(a.status) && Date.parse(a.start_at) === Date.parse(r.metadata.start_at)
  if (shouldSend) { if (v.state === 'still_needed') live++ } else if (v.state === 'cancelled') dropped++
}
check('every queued reminder revalidates correctly against staging (live kept, cancelled/moved dropped)', (rows?.length ?? 0) > 0 && live + dropped === rows.length, `${live} kept, ${dropped} dropped of ${rows?.length}`)

// ---- deep links survive authentication on the real site ---------------------
const links = [...new Set(mail().map((m) => (m.text.match(/http:\/\/localhost:3113(\/account\/[a-z-]*\/?)/) || [])[1]).filter(Boolean))]
for (const p of links) {
  const res = await fetch(`http://localhost:3113${p}`, { redirect: 'manual' })
  const loc = res.headers.get('location') || ''
  check(`deep link ${p} → sign-in with continuation`, [302, 303, 307, 308].includes(res.status) && (p === '/account/' ? /\/account\/sign-in\/$/.test(loc) : loc.includes(`next=${encodeURIComponent(p)}`)), loc.replace('http://localhost:3113', ''))
}
console.log(`\n${results.filter(Boolean).length}/${results.length} notification checks passed; kinds captured: ${[...new Set(mail().map((m) => m.kind))].join(', ')}`)
process.exit(results.every(Boolean) ? 0 : 1)
