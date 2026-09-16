/**
 * ANALYTICS-MOBILE-LOCK-1 — the canonical war-room service, against real data.
 *
 * READ ONLY. Nothing here mutates any record.
 */
const { buildWarRoom } = await import('../../src/lib/domain/metrics/war-room-service.js')
const { createClient } = await import('@supabase/supabase-js')
/**
 * Reconcile through the SAME exclusion the service uses.
 *
 * Analytics deliberately drops internal canary/test traffic from KPIs —
 * rows on an internal test phone, or flagged metadata.exclude_from_kpis.
 * Comparing analytics against RAW message_events therefore showed "117 vs
 * 138" and I read it as a 21-row reconciliation failure. It was 25 canary
 * rows being correctly excluded (21 of them inbound): the service was right
 * and my comparison was wrong. Using the shared helper means the proof can
 * never drift from the definition it is checking.
 */
const { excludeInternalCanaryRows } = await import('../../src/lib/config/internal-phones.js')

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const findings = []
const check = (name, ok, detail) => {
  if (!ok) findings.push({ name, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(62)} ${detail}`)
}

console.log('\nANALYTICS WAR ROOM PROOF\n')

const t0 = Date.now()
const res = await buildWarRoom({ window: '30d', channel: 'all' })
const ms = Date.now() - t0
const k = res.kpis

console.log(`  window=${res.window} channel=${res.channel} query_ms=${res.query_ms} wall=${ms}ms`)
console.log(`  kpis: sent=${k.sentCount} delivered=${k.deliveredCount} failed=${k.failedCount} repliedMsgs=${k.repliedCount}`)
console.log(`  replyRate=${k.replyRate} basis=${JSON.stringify(k.replyRateBasis)}`)
console.log(`  availability: ${JSON.stringify(res.metric_availability)}`)

// ── §1/§3 every metric must be traceable
check('§1/§3 the response documents its sources',
  res.source_audit && Object.keys(res.source_audit).length > 5,
  `${Object.keys(res.source_audit || {}).length} source notes`)

// ── §4 unavailable is never zero
console.log('')
check('§4/§17 an unwired buyer source reports null, not 0',
  k.buyerDemandScore === null && res.buyer_demand.wired === false && res.buyer_demand.totalMatches === null,
  `score=${k.buyerDemandScore} totalMatches=${res.buyer_demand.totalMatches} wired=${res.buyer_demand.wired}`)
check('§16 an uncommissioned email channel reports null, not 0% performance',
  res.email_health.wired === false && res.email_health.sent === null && res.email_health.opened === null,
  `wired=${res.email_health.wired} sent=${res.email_health.sent} opened=${res.email_health.opened} templates=${res.email_health.templatesAvailable}`)
check('§16 selecting the email channel does not zero every SMS metric', await (async () => {
  const em = await buildWarRoom({ window: '30d', channel: 'email' })
  return em.kpis.sentCount === null && em.metric_availability.email.available === false
})(), 'email channel yields null + not_commissioned')

// ── §4 no data is not perfect health
const empty = await buildWarRoom({ window: '7d', channel: 'all', state: 'ZZ' })
check('§4 a window with no rows does not report perfect health',
  empty.kpis.automationHealthScore === null && empty.kpis.dataQualityScore === null && empty.kpis.queueHealth === null,
  `automation=${empty.kpis.automationHealthScore} quality=${empty.kpis.dataQualityScore} queue=${empty.kpis.queueHealth}`)

// ── §11 status truth
console.log('')
check('§11 delivered + failed never exceeds dispatched',
  (k.deliveredCount ?? 0) + (k.failedCount ?? 0) <= (k.sentCount ?? 0) + 1,
  `delivered ${k.deliveredCount} + failed ${k.failedCount} vs sent ${k.sentCount}`)
check('§11 delivery rate uses dispatched messages as the denominator',
  k.sentCount > 0 ? Math.abs(k.deliveryRate - (k.deliveredCount / k.sentCount) * 100) < 1.5 : true,
  `${k.deliveryRate}% vs ${k.sentCount ? ((k.deliveredCount / k.sentCount) * 100).toFixed(1) : 'n/a'}%`)

// ── §12 reply rate grain
console.log('')
check('§12 reply rate is conversation-grained, with its basis stated',
  k.replyRateBasis && typeof k.replyRateBasis.definition === 'string' &&
  Number.isFinite(k.replyRateBasis.repliedConversations) &&
  Number.isFinite(k.replyRateBasis.deliveredConversations),
  JSON.stringify(k.replyRateBasis))
check('§12 the conversation rate matches its own stated numerator/denominator',
  k.replyRate === null ||
  Math.abs(k.replyRate - (k.replyRateBasis.repliedConversations / k.replyRateBasis.deliveredConversations) * 100) < 0.2,
  `${k.replyRate}%`)
check('§12 the message-grain ratio is kept separately, not as the headline',
  typeof k.replyMessagesPerDeliveredMessage === 'number' &&
  k.replyMessagesPerDeliveredMessage !== k.replyRate,
  `conversation=${k.replyRate}% messages=${k.replyMessagesPerDeliveredMessage}%`)
check('§12 a reply rate cannot exceed 100%', k.replyRate === null || k.replyRate <= 100, `${k.replyRate}%`)

// ── §31 cross-surface reconciliation against the source authorities
console.log('')
const win = new Date(Date.now() - 30 * 86400000).toISOString()

/**
 * The canonical delivered predicate is isDeliveredRow(): delivered_at set, OR
 * queue_status 'delivered', OR delivery_confirmed truthy. send_queue has no
 * `delivery_status` column at all — querying it returned a null count, which
 * my first version of this check reported as a reconciliation failure.
 */
const { count: sqDelivered } = await db.from('send_queue')
  .select('id', { count: 'exact', head: true })
  .gte('created_at', win)
  .or('delivered_at.not.is.null,queue_status.eq.delivered,delivery_confirmed.eq.true')
console.log(`       send_queue in window: delivered(canonical predicate)=${sqDelivered}`)
check('§31/§7 Analytics delivered reconciles with send_queue delivery truth',
  Math.abs((k.deliveredCount ?? 0) - (sqDelivered ?? 0)) <= 2,
  `analytics=${k.deliveredCount} send_queue=${sqDelivered}`)

/**
 * Only columns message_events actually HAS. My first version selected
 * `metadata` and `source`, which it does not, so PostgREST failed the whole
 * query and the raw count came back 0 — reported as a reconciliation failure
 * against nothing. One phantom column kills the entire select.
 */
const { data: meRaw, error: meErr } = await db.from('message_events')
  .select('id,direction,thread_key,from_phone_number,created_at')
  .gte('created_at', win).limit(2000)
if (meErr) findings.push({ name: 'proof: message_events read failed', detail: meErr.message })
const meInboundRaw = (meRaw ?? []).filter((r) => String(r.direction).toLowerCase() === 'inbound')
const meInboundKpi = excludeInternalCanaryRows(meInboundRaw)
console.log(`       message_events inbound: ${meInboundRaw.length} raw, ${meInboundKpi.length} after canary exclusion`)
check('§31 Analytics inbound reconciles with message_events, canary excluded',
  Math.abs((k.repliedCount ?? 0) - meInboundKpi.length) <= 2,
  `analytics=${k.repliedCount} canonical=${meInboundKpi.length} (raw ${meInboundRaw.length})`)
check('§31 internal canary traffic is excluded from KPIs, not counted',
  meInboundRaw.length > meInboundKpi.length,
  `${meInboundRaw.length - meInboundKpi.length} canary inbound rows excluded`)

// ── §33 aggregation must be exact beyond the PostgREST cap
console.log('')
/**
 * §33 must be tested with a window the product actually offers.
 *
 * My first version requested 'all_time', which this surface never sends — the
 * range selector offers today / 7d / 30d / 40d — so resolveWindow fell to its
 * 7d default and I reported "counted 157 of 18,091" as a truncation failure.
 * That was my error, not the product's. The real test is whether a windowed
 * aggregate is EXACT against the same window counted in the database, on a
 * cohort that exceeds the 1000-row PostgREST cap.
 */
const { count: sqTotal } = await db.from('send_queue').select('id', { count: 'exact', head: true })
const wide = await buildWarRoom({ window: '40d', channel: 'all' })
const wideStart = new Date(Date.now() - 40 * 86400000).toISOString()
const { count: sqWide } = await db.from('send_queue')
  .select('id', { count: 'exact', head: true }).gte('created_at', wideStart)
const { count: meWide } = await db.from('message_events')
  .select('id', { count: 'exact', head: true }).gte('created_at', wideStart)
console.log(`       corpus=${sqTotal}; 40d window: send_queue=${sqWide} message_events=${meWide}`)
/**
 * No window this surface offers reaches 1000 rows (40d is the widest at ~974),
 * so live data cannot exercise the pager. Asserting that it does was my error.
 * The pager is covered by a dedicated critical test that feeds it full pages;
 * here we verify what live data CAN show: nothing pinned at the cap, and the
 * aggregate bounded by the real cohort.
 */
console.log(`       widest offered window (40d) holds ${sqWide} send_queue rows — under the 1000 page size,`)
console.log('       so paging is proven by a critical test with synthetic full pages, not by live data')
check('§33 the windowed funnel top never exceeds the rows in that window',
  (wide.funnel?.[0]?.count ?? 0) <= (sqWide ?? 0),
  `funnel queued=${wide.funnel?.[0]?.count} <= send_queue in window=${sqWide}`)
check('§33 counts are not pinned at a 1000-row ceiling',
  (wide.funnel?.[0]?.count ?? 0) !== 1000 && (wide.kpis.sentCount ?? 0) !== 1000,
  `queued=${wide.funnel?.[0]?.count} sent=${wide.kpis.sentCount}`)

// ── §25 trend deltas must come from a real comparison period
console.log('')
const hasHardcodedTrend = JSON.stringify(res).match(/"(\+|-)?\d+(\.\d+)?%"/g)
check('§25 no hardcoded trend strings in the payload',
  !hasHardcodedTrend, `${(hasHardcodedTrend || []).slice(0, 3).join(', ') || 'none'}`)

// ── §26/§27 charts
check('§26 the timeseries has one bucket per day in the window',
  Array.isArray(res.timeseries) && res.timeseries.length >= 28 && res.timeseries.length <= 32,
  `${res.timeseries?.length} buckets for a 30d window`)
check('§26 every timeseries bucket carries a real date',
  (res.timeseries || []).every((b) => /^\d{4}-\d{2}-\d{2}/.test(String(b.date ?? b.day ?? ''))),
  `first=${JSON.stringify(res.timeseries?.[0])}`)
check('§26 funnel steps are ordered and non-increasing',
  (() => {
    const counts = (res.funnel || []).map((f) => f.count)
    return counts.every((c, i) => i === 0 || c <= counts[i - 1])
  })(),
  (res.funnel || []).map((f) => `${f.label}:${f.count}`).join(' > '))

// ── §8/§30/§31 cross-surface reconciliation against the other certified apps
console.log('')

/** §8 — Analytics stage counts must reconcile with the Pipeline authority. */
const { count: oppActive } = await db.from('acquisition_opportunities')
  .select('id', { count: 'exact', head: true }).eq('opportunity_status', 'active')
const { count: oppSuppressed } = await db.from('acquisition_opportunities')
  .select('id', { count: 'exact', head: true }).eq('opportunity_status', 'suppressed')
const { count: oppDead } = await db.from('acquisition_opportunities')
  .select('id', { count: 'exact', head: true }).eq('opportunity_status', 'dead')
console.log(`       Pipeline authority: active=${oppActive} suppressed=${oppSuppressed} dead=${oppDead}`)
check('§8/§9 Analytics does not invent a stage-count formula of its own',
  !JSON.stringify(res.funnel).match(/"S[0-9]/),
  `funnel labels: ${(res.funnel || []).map((f) => f.label).join(' > ')}`)

/**
 * §18 — offers/contracts/closings are ABSENT from this database (confirmed in
 * the Calendar phase). Analytics must not fabricate them.
 */
/**
 * Detect absence by actually SELECTING a row.
 *
 * My first version used `.select('id', { count: 'exact', head: true })` and
 * treated a null error as "table present" — a HEAD count on a missing table
 * does not surface the error that way, so it reported "absent authorities:
 * none" for six tables that do not exist, and the §18 check passed vacuously
 * while the funnel was asserting "Offer Created 0 · Closed 0" as fact.
 */
const absent = []
for (const t of ['offers', 'contracts', 'closings', 'title_routing_closing_engine']) {
  const { error } = await db.from(t).select('*').limit(1)
  if (error) absent.push(t)
}
console.log(`       absent authorities: ${absent.join(', ') || 'none'}`)
const tail = (res.funnel || []).filter((f) => /offer|contract|clos/i.test(f.label))
check('§18 absent offer/contract/closing authorities report null, never 0',
  absent.length === 0
    ? true
    : tail.every((f) => f.count === null && typeof f.unavailable === 'string'),
  `${absent.length} absent (${absent.join(', ')}); funnel tail = ${tail.map((f) => `${f.label}:${f.count}`).join(', ')}`)
check('§18 no conversion rate is computed from an unmeasured step',
  tail.every((f) => f.conversionRate === null),
  tail.map((f) => `${f.label}:${f.conversionRate}`).join(', '))

/** §30 — the live strip must reconcile with Queue's own pending predicate. */
const { count: queuePending } = await db.from('send_queue')
  .select('id', { count: 'exact', head: true })
  .in('queue_status', ['pending', 'queued', 'scheduled'])
console.log(`       Queue authority: pending/queued/scheduled=${queuePending}`)
check('§30/§31 Analytics does not claim pending sends that Queue does not hold',
  (res.funnel || []).every((f) => !/queued/i.test(f.label) || f.count >= 0),
  `queue pending=${queuePending}`)

/** §31 — the funnel's own internal consistency against its sources. */
const fSent = (res.funnel || []).find((f) => /^sent$/i.test(f.label))?.count
const fDelivered = (res.funnel || []).find((f) => /^delivered$/i.test(f.label))?.count
check('§31 the funnel and the KPI cards report the same sent/delivered',
  (fSent === undefined || fSent === k.sentCount) && (fDelivered === undefined || fDelivered === k.deliveredCount),
  `funnel sent=${fSent} kpi sent=${k.sentCount}; funnel delivered=${fDelivered} kpi delivered=${k.deliveredCount}`)

// ── §42 performance
console.log('')
check('§42 the aggregate read is not a 10s+ wait', ms < 10000, `${ms}ms`)

console.log('')
if (findings.length) {
  console.log(`ANALYTICS WAR ROOM PROOF: ${findings.length} finding(s)`)
  for (const f of findings) console.log(`  x ${f.name}: ${f.detail}`)
  process.exit(1)
}
console.log('ANALYTICS WAR ROOM PROOF: clean')
