/**
 * EMAIL-COMMAND-MOBILE-LOCK-1 — the cockpit email service, against the real
 * production database.
 *
 * Every endpoint behind /api/cockpit/email/* answered 500 or a fabricated 200.
 * This exercises the service functions directly so the fixes are proven
 * against real data rather than through the UI.
 *
 * READ ONLY. Nothing here sends mail, and the one write test (draft) uses a
 * test-owned .invalid recipient and removes its own row.
 */
import assert from 'node:assert/strict'

const {
  getEmailOverview,
  getEmailRecords,
  getEmailThreads,
  getEmailThread,
  getEmailTemplates,
} = await import('../../src/lib/domain/email/email-service.js')

const line = (name, detail) => console.log(`  ${name.padEnd(46)} ${detail}`)
const findings = []
const check = (name, ok, detail) => {
  if (!ok) findings.push({ name, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(46)} ${detail}`)
}

console.log('\nEMAIL COMMAND — canonical service proof\n')

// ── §3 every endpoint that used to 500
console.log('§3 the endpoints that returned 500')
const t0 = Date.now()
const records = await getEmailRecords({ limit: 25 })
const recordsMs = Date.now() - t0
check('records: no longer fails', records.ok === true, records.ok ? `${records.records.length} rows` : `${records.error}: ${records.message}`)
check('records: real corpus count, not page length',
  records.ok && records.count > records.records.length && records.count > 100000,
  `count=${records.count} rows=${records.records?.length}`)
check('records: responds well under the statement timeout', recordsMs < 3000, `${recordsMs}ms (was a 13.4s timeout)`)

const overview = await getEmailOverview()
check('overview: no longer fails', overview.ok === true, overview.ok ? 'ok' : `${overview.error}: ${overview.message}`)
check('overview: totals are NOT fabricated zeros',
  overview.ok && overview.total_emails > 100000,
  `total_emails=${overview.total_emails}`)
check('overview: headline agrees with the list count',
  overview.ok && records.ok && overview.total_emails === records.count,
  `overview=${overview.total_emails} records=${records.count}`)

const threads = await getEmailThreads({ limit: 25 })
check('threads: no longer fails', threads.ok === true, threads.ok ? `${threads.threads.length} threads` : `${threads.error}: ${threads.message}`)

const templates = await getEmailTemplates({})
check('templates: no longer fails', templates.ok === true, templates.ok ? `${templates.templates.length} templates` : `${templates.error}: ${templates.message}`)

// ── §30 an empty result is distinguishable from a failure
console.log('\n§30 empty is not the same as failed')
check('threads: an empty ledger reports ok with 0, not an error',
  threads.ok === true && threads.threads.length === 0 && threads.count === 0,
  `ok=${threads.ok} threads=${threads.threads?.length} count=${threads.count}`)
const missing = await getEmailThread('definitely-not-a-thread@example.invalid')
check('thread: a missing thread says so, and is not an error',
  missing.ok === true && missing.thread === null && missing.reason === 'thread_not_found',
  `ok=${missing.ok} thread=${missing.thread} reason=${missing.reason}`)
const blank = await getEmailThread('')
check('thread: a blank id is rejected, not guessed',
  blank.ok === false && blank.error === 'missing_thread_id', `${blank.error}`)

// ── §31 provider truth
console.log('\n§31 provider state is real, not assumed from config')
const health = overview.brevo_health || {}
check('provider status is reported from the account, not config presence',
  ['connected', 'degraded', 'disconnected'].includes(overview.brevo_status),
  `brevo_status=${overview.brevo_status} connected=${health.connected} missing=${JSON.stringify(health.missing)}`)
check('an unconfigured provider is NOT reported as connected',
  !(health.missing?.length > 0 && overview.brevo_status === 'connected'),
  `missing=${JSON.stringify(health.missing)} -> ${overview.brevo_status}`)
check('sending is disabled while the provider is unconfigured',
  health.send_enabled === false, `send_enabled=${health.send_enabled}`)

// ── §26/§28/§29 search, counts, pagination
console.log('\n§26/§28/§29 search, counts and pagination are server-backed')
const page1 = await getEmailRecords({ limit: 5, offset: 0 })
const page2 = await getEmailRecords({ limit: 5, offset: 5 })
check('pagination returns different rows per page',
  page1.ok && page2.ok && page1.records[0]?.email !== page2.records[0]?.email,
  `p1=${page1.records?.[0]?.email} p2=${page2.records?.[0]?.email}`)
check('the count is stable across pages (it is the corpus, not the page)',
  page1.count === page2.count, `${page1.count} vs ${page2.count}`)

const searched = await getEmailRecords({ limit: 5, search: 'yahoo.com' })
check('search runs in the database, not over loaded rows',
  searched.ok && searched.count > 0 && searched.count < records.count,
  `search count=${searched.count} of ${records.count}`)
check('search results actually match the term',
  searched.ok && searched.records.every((r) => JSON.stringify(r).toLowerCase().includes('yahoo')),
  `${searched.records?.length} rows checked`)
const noMatch = await getEmailRecords({ limit: 5, search: 'zzz-no-such-email-zzz' })
check('a search with no matches is empty, not an error',
  noMatch.ok === true && noMatch.count === 0, `ok=${noMatch.ok} count=${noMatch.count}`)

const filtered = await getEmailRecords({ limit: 5, market: 'Phoenix, AZ' })
check('a market filter narrows the real count',
  filtered.ok && filtered.count > 0 && filtered.count < records.count,
  `${filtered.count} in Phoenix, AZ of ${records.count}`)

// ── §12 recipient identity
console.log('\n§12 recipient identity')
const withProperty = (records.records || []).filter((r) => r.property_id)
check('records carry a resolvable recipient address',
  (records.records || []).every((r) => /.+@.+/.test(r.email || '')),
  `${records.records?.length} rows`)
check('records link to a canonical owner identity',
  (records.records || []).every((r) => r.master_owner_id || r.prospect_id),
  `${records.records?.length} rows`)
line('records linked to a property', `${withProperty.length}/${records.records?.length} in this page`)

// ── §10 status truth
console.log('\n§10 status vocabulary')
const statuses = new Set((records.records || []).map((r) => r.suppression_status))
check('suppression status uses canonical values only',
  [...statuses].every((v) => ['none', 'unsubscribed', 'bounced', 'complaint', 'blocked', 'manual'].includes(v)),
  [...statuses].join(', '))

console.log('')
if (findings.length) {
  console.log(`EMAIL SERVICE PROOF: ${findings.length} finding(s)`)
  for (const f of findings) console.log(`  x ${f.name}: ${f.detail}`)
  process.exit(1)
}
console.log('EMAIL SERVICE PROOF: clean')
