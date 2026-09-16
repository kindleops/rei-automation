/**
 * CALENDAR-MOBILE-LOCK-1 — the calendar nexus service, against real data.
 *
 * READ ONLY. Nothing here reschedules, cancels or sends anything.
 */
const { fetchCalendarNexusEvents } = await import('../../src/lib/domain/calendar/calendar-nexus-service.js')

const findings = []
const check = (name, ok, detail) => {
  if (!ok) findings.push({ name, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(58)} ${detail}`)
}

const day = (offset = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toISOString().slice(0, 10)
}

console.log('\nCALENDAR NEXUS PROOF\n')

// ── §1/§3 the aggregator answers from real authorities
const res = await fetchCalendarNexusEvents({
  start_date: day(-30),
  end_date: day(30),
  timezone: 'America/Phoenix',
})

check('§3 the aggregator succeeds', res.ok === true, `ok=${res.ok} events=${res.events?.length}`)
console.log(`       sources: ${JSON.stringify(res.source_counts)}`)
console.log(`       timezone: ${JSON.stringify(res.timezone)}`)
console.log(`       actionable: ${JSON.stringify(res.actionable_counts)}`)

const events = res.events || []

// ── §2 every item keeps its provenance
check('§2 every event names its source table and canonical id',
  events.every((e) => e.source_table && e.source_record_id),
  `${events.filter((e) => !e.source_table || !e.source_record_id).length} without provenance`)
check('§4 every event has a specific type, never a generic "event"',
  events.every((e) => e.event_type && !['event', 'meeting'].includes(String(e.event_type).toLowerCase())),
  [...new Set(events.map((e) => e.event_type))].join(', ') || 'none')

// ── §5/§22 seller and property identity must be resolved when resolvable
const withOwner = events.filter((e) => e.master_owner_id)
const unresolvedWithOwner = withOwner.filter(
  (e) => !e.seller_name || /unresolved|unknown/i.test(e.seller_name),
)

/**
 * The honest form of this assertion.
 *
 * Requiring zero unresolved sellers is too strict: some master_owners rows
 * genuinely have display_name NULL (e.g. the canaryprop_* test records), and
 * for those "unresolved" is the truthful answer, not a bug. What must be zero
 * is events left unresolved while a name DOES exist in canonical authority.
 */
const { createClient } = await import('@supabase/supabase-js')
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})
const unresolvedOwnerIds = [...new Set(unresolvedWithOwner.map((e) => e.master_owner_id))]
let nameableButUnresolved = []
if (unresolvedOwnerIds.length) {
  const { data } = await db
    .from('master_owners')
    .select('master_owner_id, display_name')
    .in('master_owner_id', unresolvedOwnerIds.slice(0, 400))
  const named = new Set((data ?? []).filter((r) => String(r.display_name ?? '').trim()).map((r) => r.master_owner_id))
  nameableButUnresolved = unresolvedWithOwner.filter((e) => named.has(e.master_owner_id))
}

check('§5 no event is left unresolved while canonical authority HAS a name',
  nameableButUnresolved.length === 0,
  `${nameableButUnresolved.length} resolvable-but-unresolved; ` +
  `${unresolvedWithOwner.length} of ${withOwner.length} unresolved, all with no name on record`)

const withProperty = events.filter((e) => e.property_id)
const unresolvedProperty = withProperty.filter(
  (e) => !e.property_address || /pending resolution|unknown/i.test(e.property_address),
)
check('§5 an event with a property_id shows a real address',
  unresolvedProperty.length === 0,
  `${unresolvedProperty.length} of ${withProperty.length} property-linked events unresolved`)

check('§30 a resolver read failure is reported, not silently unresolved',
  res.reconciliation?.hydration_error === null,
  `hydration_error=${JSON.stringify(res.reconciliation?.hydration_error)}`)

// ── §14/§37 non-actionable work must not read as live
const suppressed = events.filter((e) => ['suppressed', 'dead', 'cancelled', 'canceled'].includes(String(e.status).toLowerCase()))
check('§14 suppressed/dead/cancelled work is marked non-actionable',
  suppressed.every((e) => e.actionable === false),
  `${suppressed.filter((e) => e.actionable !== false).length} of ${suppressed.length} still marked actionable`)
check('§14 non-actionable work is never "due soon"',
  suppressed.every((e) => e.due_soon === false),
  `${suppressed.filter((e) => e.due_soon).length} marked due_soon`)
check('§9 non-actionable work is never "overdue"',
  suppressed.every((e) => e.overdue === false),
  `${suppressed.filter((e) => e.overdue).length} marked overdue`)
check('§14 non-actionable work never claims completion_state "scheduled"',
  suppressed.every((e) => e.completion_state !== 'scheduled'),
  [...new Set(suppressed.map((e) => e.completion_state))].join(', ') || 'none')
check('§14 each non-actionable item states WHY',
  suppressed.every((e) => Boolean(e.non_actionable_reason)),
  [...new Set(suppressed.map((e) => e.non_actionable_reason))].join(', ') || 'none')

const completed = events.filter((e) => String(e.status).toLowerCase() === 'completed')
check('§37 completed work is not actionable',
  completed.every((e) => e.actionable === false),
  `${completed.length} completed events`)

// ── §29 counts come from predicates, and exclude finished work
const kpi = (id) => res.kpis?.find((k) => k.id === id)?.value
const dueToday = kpi('due-today')
const actionableToday = events.filter((e) => {
  if (e.actionable === false) return false
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(e.start_timestamp))
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return key === today
}).length
check('§7/§29 Due Today matches an operator-timezone predicate',
  dueToday === actionableToday, `kpi=${dueToday} recomputed=${actionableToday}`)
check('§29 Due Today excludes completed work',
  !completed.some((e) => {
    const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(e.start_timestamp))
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    return key === today && e.actionable !== false
  }),
  `${completed.length} completed in window`)
check('§29 Overdue counts only items flagged overdue',
  kpi('overdue') === events.filter((e) => e.overdue).length,
  `kpi=${kpi('overdue')} flagged=${events.filter((e) => e.overdue).length}`)
check('§29 Workflow Wakes counts actionable workflow work only',
  kpi('workflow-wakes') === events.filter((e) => e.actionable !== false && ['workflow_wake', 'workflow_task'].includes(e.event_type)).length,
  `kpi=${kpi('workflow-wakes')}`)

// ── §7 the operator timezone genuinely changes the day boundary
const utcRun = await fetchCalendarNexusEvents({ start_date: day(-30), end_date: day(30) })
check('§7 the applied timezone is reported, and a UTC fallback is visible',
  utcRun.timezone?.applied === 'UTC' && utcRun.timezone?.supplied_by_client === false &&
  res.timezone?.applied === 'America/Phoenix' && res.timezone?.supplied_by_client === true,
  `with=${JSON.stringify(res.timezone)} without=${JSON.stringify(utcRun.timezone)}`)
check('§7 an invalid timezone does not take the request down',
  (await fetchCalendarNexusEvents({ start_date: day(-1), end_date: day(1), timezone: 'Not/AZone' })).ok === true,
  'invalid IANA zone tolerated')

// ── §28 no dead filters
console.log('')
const avail = res.layer_availability || {}
const availableLayers = Object.entries(avail).filter(([, v]) => v.available).map(([k]) => k)
const deadLayers = Object.entries(avail).filter(([, v]) => !v.available).map(([k, v]) => `${k}(${v.reason})`)
console.log(`       layers available: ${availableLayers.join(', ')}`)
console.log(`       layers with no authority: ${deadLayers.join(', ')}`)
check('§28 layer availability is reported so dead filters can be hidden',
  Object.keys(avail).length > 0 && availableLayers.length > 0,
  `${availableLayers.length} available, ${deadLayers.length} without authority`)
check('§28 a layer whose tables are absent is reported unavailable',
  ['offers', 'contracts', 'closings', 'buyers', 'manual_events'].every((l) => avail[l] && avail[l].available === false),
  `offers=${avail.offers?.available} contracts=${avail.contracts?.available} closings=${avail.closings?.available} buyers=${avail.buyers?.available} manual=${avail.manual_events?.available}`)
check('§18 there is no scheduled-email authority, and it is not faked',
  avail.email && avail.email.available === false && avail.email.reason === 'no_authority',
  JSON.stringify(avail.email))
check('§30 an absent table is distinguished from an empty one',
  Object.values(res.source_availability || {}).some((v) => v.state === 'absent') &&
  Object.values(res.source_availability || {}).some((v) => v.state === 'available'),
  JSON.stringify(Object.fromEntries(Object.entries(res.source_availability || {}).map(([k, v]) => [k, v.state]))))

// ── §36 no duplicate durable work
const ids = events.map((e) => e.event_id)
check('§36 no duplicate event ids', new Set(ids).size === ids.length,
  `${ids.length} events, ${new Set(ids).size} unique`)
check('§36 the reconciliation agrees there are no duplicates',
  res.reconciliation?.duplicate_events === 0, `${res.reconciliation?.duplicate_events}`)

// ── §11 S1 cadence comes from the canonical planner, not a calendar formula
const s1 = events.filter((e) => JSON.stringify(e.metadata || {}).includes('S1_'))
if (s1.length) {
  console.log(`       S1-coded events: ${s1.length}, reasoning codes: ${[...new Set(s1.map((e) => (e.metadata?.last_reasoning_code) || '?'))].join(', ')}`)
  check("§11 an S1-planned follow-up uses the planner's own due date",
    s1.every((e) => {
      const planned = e.metadata?.negotiation_state?.next_action_due_at
      return !planned || new Date(planned).getTime() === new Date(e.start_timestamp).getTime()
    }),
    `${s1.length} S1 events checked against negotiation_state.next_action_due_at`)
}

// ── §42 performance
check('§42 the aggregate read is not a 10s+ wait',
  (res.performance?.total_ms ?? 0) < 8000, `${res.performance?.total_ms}ms across ${res.performance?.backend_queries} queries`)

console.log('')
if (findings.length) {
  console.log(`CALENDAR NEXUS PROOF: ${findings.length} finding(s)`)
  for (const f of findings) console.log(`  x ${f.name}: ${f.detail}`)
  process.exit(1)
}
console.log('CALENDAR NEXUS PROOF: clean')
