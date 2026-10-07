import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  linkSaleToOwner, classifyOwner, inferSale, emptyMatrix, addToMatrix, validationStats, inferredInvestorLabel, saleBuyerOfRecord,
  TIERS, INVESTOR_TIERS, LINK_RULE,
} from '../../src/lib/domain/market-intelligence/mi-inferred-investor.js'
import { missingInferredColumns, INFERRED_COLUMNS, inferredMetaOf, inferredAggFromRow, stackIdentity, topStacks, loadInferred } from '../../src/lib/domain/market-intelligence/mi-inferred-source.js'
import { resolveSaleOwnerRow, saleOwnerIds, salePropertyKeys, createSaleOwnerReader } from '../../src/lib/domain/market-intelligence/mi-sale-owner.js'
import { inferredValues, INFERRED_IDS } from '../../src/lib/domain/market-intelligence/mi-metric-values.js'
import { METRIC_BY_ID } from '../../src/lib/domain/market-intelligence/mi-metric-registry.js'

const MIG = join(import.meta.dirname, '../../../../supabase/migrations')
const migration = () => readFileSync(join(MIG, 'PROPOSED_20261005140000_market_intel_inferred_investor.sql'), 'utf8')

test('link: only the most recent sale with no later transfer and a post-recording owner snapshot inherits today\'s owner', () => {
  const base = { propertyId: 'p1', soldOn: '2025-06-01', isLatestSale: true, laterTransferOn: null, ownerObservedOn: '2026-08-15' }
  assert.deepEqual(linkSaleToOwner(base), { linked: true, reason: 'linked' })
  assert.equal(linkSaleToOwner({ ...base, propertyId: null }).reason, 'no_property')
  assert.equal(linkSaleToOwner({ ...base, isLatestSale: false }).reason, 'not_latest_sale')
  // a later recording of the SAME transaction (≤ 45 days) does not break the link; a real later transfer does
  assert.equal(linkSaleToOwner({ ...base, laterTransferOn: '2025-07-10' }).reason, 'linked')
  assert.equal(linkSaleToOwner({ ...base, laterTransferOn: '2025-07-20' }).reason, 'later_transfer')
  assert.equal(linkSaleToOwner({ ...base, ownerObservedOn: null }).reason, 'no_owner_record')
  // an owner snapshot taken before the deed could be recorded may still show the SELLER
  assert.equal(linkSaleToOwner({ ...base, soldOn: '2026-08-01' }).reason, 'owner_snapshot_before_sale')
  assert.equal(linkSaleToOwner({ ...base, soldOn: '2026-07-16' }).reason, 'linked') // exactly the lag
  assert.equal(LINK_RULE.recording_lag_days, 30)
})

test('tiers: strong / likely / trust / absentee-only / no signal, each with its evidence', () => {
  const t = (sig) => classifyOwner(sig).tier
  assert.equal(t({ corporate: true, outOfState: true }), 'strong')
  assert.equal(t({ corporate: true, mailStack: 2 }), 'strong')
  assert.equal(t({ mailStack: 3 }), 'likely') // a stack is an individual's ONLY signal → Likely (owner decision)
  assert.equal(t({ mailStack: 12, outOfState: true }), 'strong')
  assert.equal(t({ corporate: true }), 'likely') // an LLC alone is only LIKELY (brief §48)
  assert.equal(t({ outOfState: true, mailStack: 2 }), 'likely')
  assert.equal(t({ trust: true }), 'trust_estate') // trusts are their own class, not investor by default
  assert.equal(t({ trust: true, outOfState: true, mailStack: 2 }), 'trust_estate')
  assert.equal(t({ trust: true, mailStack: 5 }), 'likely') // …unless they stack
  assert.equal(t({ outOfState: true }), 'absentee_only')
  assert.equal(t({ mailStack: 2 }), 'no_signal') // an in-state pair (a household) is not investor evidence
  assert.equal(t({}), 'no_signal')
  assert.equal(t({ mailStack: 4, residentOwner: true }), 'no_signal') // the owner lives there
  assert.equal(t({ corporate: true, residentOwner: true }), 'likely')
  assert.deepEqual(classifyOwner({ corporate: true, outOfState: true, mailStack: 7 }).evidence, ['entity_owner', 'out_of_state_mailing', 'mailing_stack_3_plus'])
  assert.deepEqual(INVESTOR_TIERS, ['strong', 'likely'])
  assert.equal(inferSale({ propertyId: 'p', soldOn: '2025-01-01', isLatestSale: false, corporate: true }).tier, null)
})

test('the SQL tier rule (public.mi_owner_tier) equals the JS rule for every signal combination', () => {
  const sql = migration()
  const body = /returns text language sql immutable as \$\$\s*select (case[\s\S]*?end)\s*\$\$;/.exec(sql)[1]
  // translate the CASE into a JS function: when X then 'Y' → if (X) return 'Y'
  const js = body.replace(/^case/, '').replace(/end$/, '')
    .replace(/when (.+?) then ('[a-z_]+')/g, (_, cond, tier) => `if (${cond.replace(/\bnot /g, '!').replace(/\band\b/g, '&&').replace(/\bor\b/g, '||').replace(/([^<>!=])=([^=])/g, '$1===$2')}) return ${tier};`)
    .replace(/else ('[a-z_]+')/, 'return $1;')
  // eslint-disable-next-line no-new-func
  const sqlTier = new Function('p_corp', 'p_trust', 'p_oos', 'p_stack', 'p_resident', js)
  let n = 0
  for (const corp of [false, true]) for (const trust of [false, true]) for (const oos of [false, true]) for (const stack of [1, 2, 3, 9]) for (const res of [false, true]) {
    assert.equal(sqlTier(corp, trust, oos, stack, res), classifyOwner({ corporate: corp, trust, outOfState: oos, mailStack: stack, residentOwner: res }).tier, JSON.stringify({ corp, trust, oos, stack, res }))
    n += 1
  }
  assert.equal(n, 64)
})

test('validation: confusion matrix → precision / recall against recorded investor buyers', () => {
  const m = emptyMatrix()
  for (let i = 0; i < 80; i += 1) addToMatrix(m, 'strong', true)
  for (let i = 0; i < 10; i += 1) addToMatrix(m, 'likely', false)
  for (let i = 0; i < 20; i += 1) addToMatrix(m, 'no_signal', true)
  for (let i = 0; i < 890; i += 1) addToMatrix(m, 'no_signal', false)
  const v = validationStats(m)
  assert.equal(v.tp, 80); assert.equal(v.fp, 10); assert.equal(v.fn, 20); assert.equal(v.tn, 890)
  assert.equal(v.precision, 80 / 90)
  assert.equal(v.recall, 0.8)
  assert.equal(v.tiers.strong.precision, 1)
  assert.equal(validationStats(emptyMatrix()).precision, null)
})

test('label: unmistakable, with base and validation; never a bare share', () => {
  assert.equal(inferredInvestorLabel({ share: 0.41, linked: 210_000, precision: 0.87, validationN: 9000 }),
    'Inferred investor (owner-based) · 41% of 210K linked sales · validated 87% precision vs recorded buyers')
  assert.equal(inferredInvestorLabel({ share: 0.2, linked: 1500, precision: null, validationN: 0 }), 'Inferred investor (owner-based) · 20% of 1.5K linked sales · not validated')
})

test('buyer of record: deed buyer first; else today\'s owner when linked; persons never named; else "Buyer not on record"', () => {
  const name = (x) => (/LLC|INC|HOLDINGS/.test(x) ? x : null)
  assert.equal(saleBuyerOfRecord({ buyer: 'ACME HOLDINGS LLC', buyer_kind: 'company' }, null, name).label, 'ACME HOLDINGS LLC')
  assert.equal(saleBuyerOfRecord({ buyer: null, buyer_kind: 'person' }, null, name).label, 'Individual buyer')
  assert.equal(saleBuyerOfRecord({}, { linked: false, reason: 'not_latest_sale' }, name).label, 'Buyer not on record')
  const linked = { linked: true, reason: 'linked' }
  assert.equal(saleBuyerOfRecord({}, { ...linked, corporate: true }, name).label, 'Company (name not on record) · current owner of record')
  assert.equal(saleBuyerOfRecord({}, { ...linked, corporate: true, ownerName: 'BLUE OAK HOLDINGS LLC' }, name).label, 'BLUE OAK HOLDINGS LLC · current owner of record')
  assert.equal(saleBuyerOfRecord({}, { ...linked, residentOwner: true }, name).label, 'Individual (owner-occupant) · current owner of record')
  assert.equal(saleBuyerOfRecord({}, { ...linked, outOfState: true }, name).label, 'Individual (absentee · out-of-state mailing) · current owner of record')
  const indiv = saleBuyerOfRecord({}, { ...linked, ownerName: 'JOHN SMITH' }, name)
  assert.equal(indiv.label, 'Individual (occupancy not on record) · current owner of record')
  assert.equal(indiv.name, null)
})

test('sale-owner resolver: one row → link, tier and display buyer; ids are validated and capped', async () => {
  const row = { comp_id: 't:1', property_id: 'p1', sold_on: '2025-03-01', buyer: null, buyer_kind: null, is_latest_sale: true, later_transfer_on: null, owner_observed_on: '2026-08-20',
    is_corporate_owner: true, is_trust: false, out_of_state_owner: true, mail_stack: 14, resident_owner: false, owner_name: 'JANE DOE' }
  const r = resolveSaleOwnerRow(row)
  assert.equal(r.owner_link.linked, true)
  assert.equal(r.inferred.tier, 'strong')
  assert.equal(r.buyer_of_record.label, 'Company (name not on record) · current owner of record') // a person-like name is withheld
  const resold = resolveSaleOwnerRow({ ...row, is_latest_sale: false })
  assert.equal(resold.buyer_of_record.label, 'Buyer not on record')
  assert.equal(resold.inferred, null)
  assert.deepEqual(saleOwnerIds('t:1, p:abc ,bad id,t:1'), ['t:1', 'p:abc'])
  assert.equal(saleOwnerIds(Array.from({ length: 300 }, (_, i) => `t:${i}`)).length, 100)
  const calls = []
  const read = createSaleOwnerReader({ query: async (sql, params) => { calls.push(params); return { rows: [row] } } })
  const map = await read('t:1')
  assert.equal(map.get('t:1').inferred.tier, 'strong')
  assert.deepEqual(calls[0], [['t:1']])
  // Comp Intelligence rows: property id + sale date
  assert.deepEqual(salePropertyKeys('P-9@2025-03-01, bad, P-9@2025-03-01'), { keys: ['P-9@2025-03-01'], ids: ['P-9'], dates: ['2025-03-01'] })
  const byProp = await read.byProperty('p1@2025-03-01')
  assert.deepEqual(calls[1], [['p1'], ['2025-03-01']])
  assert.equal(byProp.size, 1)
})

test('inferred source: schema guard, build meta, stack naming (companies only), top stacks', async () => {
  assert.ok(missingInferredColumns([]).length > 0)
  const all = Object.entries(INFERRED_COLUMNS).flatMap(([t, cols]) => cols.map((c) => ({ t, c })))
  assert.deepEqual(missingInferredColumns(all), [])
  assert.equal(inferredMetaOf({ notes: {} }), null)
  const meta = inferredMetaOf({ notes: { inferred_investor: { sales: 100, linked: 60, matrix: { strong: { recorded_investor: 8, recorded_other: 1 }, no_signal: { recorded_investor: 1, recorded_other: 30 } } } } })
  assert.equal(meta.validation.precision, 8 / 9)
  assert.equal(stackIdentity({ label: 'ACME HOLDINGS LLC', label_n: 3, named_n: 4 }).name, 'ACME HOLDINGS LLC')
  assert.equal(stackIdentity({ label: 'ACME HOLDINGS LLC', label_n: 1, named_n: 1 }).name, null) // one purchase is not enough
  assert.equal(stackIdentity({ label: 'WILLIAMS,MICHAEL', label_n: 5, named_n: 5 }).name, null) // a person is never named
  assert.equal(stackIdentity({ label: 'FANNIE MAE', label_n: 5, named_n: 5 }).name, null) // lenders are not portfolios
  assert.equal(stackIdentity({ label: 'Tule River Homebuyer Earned Equity Agency', label_n: 6, named_n: 7 }).name, null) // public bodies are co-buyers, not owners
  // loadInferred: not installed → unavailable; a build without notes → not_built
  const loader = (missing, rows = {}) => ({ inferredSchema: async () => missing, inferred: async (name) => rows[name] || [] })
  assert.equal((await loadInferred({ loader: loader(['x.y']), build: {} })).reason, 'not_installed')
  assert.equal((await loadInferred({ loader: loader([]), build: { notes: {} } })).reason, 'not_built')
  assert.equal(await loadInferred({ loader: {}, build: {} }), null)
  const inf = await loadInferred({ loader: loader([], {
    stacks: [{ stack_id: 1, props_n: 40, corp_n: 40, oos_n: 30, trust_n: 0, linked_n: 3, named_n: 2, label: 'ACME HOLDINGS LLC', label_n: 2 }, { stack_id: 2, props_n: 5, corp_n: 0, oos_n: 0, trust_n: 0, linked_n: 2, named_n: 0, label: null, label_n: 0 }],
    activity: [{ stack_id: 1, d: 9000, zip: '75217', state: 'TX', city_key: 'TX:dallas', asset: 'sfr' }, { stack_id: 1, d: 9001, zip: '75217', state: 'TX', city_key: 'TX:dallas', asset: 'sfr' },
      { stack_id: 2, d: 9002, zip: '75217', state: 'TX', city_key: 'TX:dallas', asset: 'sfr' }, { stack_id: 1, d: 100, zip: '75217', state: 'TX', city_key: 'TX:dallas', asset: 'sfr' }],
  }), build: { build_id: 3, notes: { inferred_investor: { matrix: {} } } } })
  const top = topStacks(inf, 'zip:75217', { window: { from: 8000, to: 9999 }, asset: { codes: null } }, (a) => `zip:${a.zip}`)
  assert.deepEqual(top.map((s) => [s.label, s.linked_purchases, s.properties_at_mailing_address]), [['ACME HOLDINGS LLC', 2, 40], ['Unnamed owner portfolio', 1, 5]])
})

test('inferred values: unavailable without the extension; with it, share of LINKED sales plus coverage, label and validation', () => {
  const none = inferredValues(null)
  for (const id of INFERRED_IDS) { assert.equal(none[id].status, 'unavailable'); assert.ok(METRIC_BY_ID[id], id); assert.equal(METRIC_BY_ID[id].requires, 'inferred_investor') }
  const meta = inferredMetaOf({ notes: { inferred_investor: { matrix: { strong: { recorded_investor: 87, recorded_other: 13 } } } } })
  const agg = inferredAggFromRow({ sale_count: 500, linked_count: 210, strong_n: 60, likely_n: 26, trust_n: 4, absentee_n: 20, no_signal_n: 100, stack3_n: 40 }, meta)
  const v = inferredValues(agg)
  assert.equal(v.inferred_investor_count.value, 86)
  assert.equal(v.inferred_investor_share.value, 86 / 210)
  assert.equal(v.inferred_investor_share.coverage, 210 / 500)
  assert.equal(v.inferred_investor_share.label, 'Inferred investor (owner-based) · 41% of 210 linked sales · validated 87% precision vs recorded buyers')
  assert.equal(v.owner_link_coverage.value, 0.42)
  const thin = inferredValues(inferredAggFromRow({ sale_count: 20, linked_count: 10, strong_n: 5 }, meta))
  assert.equal(thin.inferred_investor_share.status, 'insufficient')
})

test('generated migration: patches the applied objects by insertion; rollback restores them verbatim; never applied here', () => {
  const base = readFileSync(join(MIG, '20261004150000_market_intel_geo_rollup.sql'), 'utf8')
  const mig = migration()
  const rb = readFileSync(join(MIG, 'PROPOSED_20261005140000_market_intel_inferred_investor_rollback.sql'), 'utf8')
  const pre = readFileSync(join(MIG, 'PROPOSED_20261005140000_market_intel_inferred_investor_pretest.sql'), 'utf8')
  const fn = (txt, name) => new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;\\n`).exec(txt)[0]
  for (const name of ['mi_rollup_run_unit', 'mi_rollup_units', 'mi_rollup_fingerprint']) assert.ok(rb.includes(fn(base, name)), `rollback restores ${name}`)
  assert.ok(mig.includes("if v_kind = 'i' then return public.mi_infer_run_unit(p_build, p_unit, p_as_of); end if;"))
  assert.ok(mig.includes('m.property_id\n  from public.mv_map_market_sales m'))
  assert.match(mig, /'i:validate', 'finalize', 'i:cleanup'/)
  assert.match(mig, /'i:link:7', 'i:stacks'/)
  // link v2: contiguous property_id range slices (bounds per build), set-based, no per-row probes
  assert.ok(!/hashtext/.test(mig), 'link slices are property_id ranges, not hash buckets')
  assert.ok(mig.includes("'inferred_link_bounds'") && mig.includes('with s as materialized'))
  assert.ok(!/exists \(select 1 from comp_private\.comp_canonical_transactions/.test(mig), 'no correlated transfer probe')
  assert.ok(mig.includes('when tx.last_event > s.sold_on + 45 then \'later_transfer\''))
  assert.ok(mig.includes('when cp.last_observed_at::date - s.sold_on < 30 then \'owner_snapshot_before_sale\''))
  // the pre-step covering index, and the pretest's hard per-unit limit
  const pix = readFileSync(join(MIG, 'PROPOSED_20261005140000_market_intel_inferred_investor_pre_index.sql'), 'utf8')
  assert.match(pix, /create index concurrently if not exists comp_properties_mi_owner_cover\s+on comp_private\.comp_properties \(property_id\)\s+include \(last_observed_at, is_corporate_owner, is_trust, out_of_state_owner, owner_mailing_identity_key_v1\)/)
  assert.ok(pre.includes("comp_properties_mi_owner_cover') AND i.indisvalid"), 'pretest refuses without the index')
  // gates: every unit HARD FAIL at >= 15 s; linking units PASS only < 8 s, 8-15 s is SOFT FAIL (do not apply)
  assert.ok(pre.includes('IF u_ms >= 15000 THEN') && pre.includes("'pretest FAILED (HARD, unit >= 15000 ms)"))
  assert.ok(pre.includes('ELSIF u_ms >= 8000 THEN') && pre.includes("RAISE NOTICE 'pretest unit % = % rows / % ms PASS'"))
  // plan safety: the mapping is analyzed before its first reader; geography units use hash joins only
  assert.ok(mig.includes('analyze public.mi_sale_owner_link;') && mig.includes("perform set_config('enable_nestloop', 'off', true);"))
  assert.ok(pre.includes("'pretest SOFT FAIL — do not apply"))
  assert.ok(pre.includes("'i:g:city', 'i:g:zip', 'i:validate', 'i:cleanup'"), 'pretest times every inferred unit')
  assert.match(mig, /'i:clusters', 'i:bounds', 'i:link:0'/)
  // geography units read only the compact per-sale mapping, never a base table
  const g = /elsif v_kind = 'g' then([\s\S]*?)elsif v_kind = 'validate'/.exec(mig)[1]
  assert.ok(g.includes('from public.mi_sale_owner_link s') && !/comp_private\.comp_|mv_map_market_sales|mi_rollup_sales_v/.test(g))
  // post-apply verification: read-only, asserts recorded counts equal build 2's
  const ver = readFileSync(join(MIG, 'PROPOSED_20261005140000_market_intel_inferred_investor_verify.sql'), 'utf8')
  assert.ok(!/\b(insert|update|delete|create|alter|drop|truncate)\b/i.test(ver.replace(/^--.*$/gm, '')), 'verify is read-only')
  assert.ok(ver.includes("RAISE EXCEPTION 'verify FAILED: recorded counts of build % differ from the live source") && ver.includes("('strong', 95776)") && ver.includes("('likely', 60997)"))
  const proof = readFileSync(join(MIG, 'PROPOSED_20261005140000_market_intel_inferred_investor_plan_proof.sql'), 'utf8')
  assert.ok(proof.includes('explain (analyze, buffers'))
  assert.ok(!/cron\.schedule/.test(mig), 'no schedule change')
  assert.ok(pre.includes(mig) && pre.includes("ELSE 'pretest ok' END") && /RAISE EXCEPTION '%: build/.test(pre), 'pretest embeds the migration and rolls back')
  // investor_count (recorded) is never touched by the extension
  assert.ok(!/update public\.mi_geo_period_rollup/i.test(mig))
  for (const t of TIERS) assert.ok(mig.includes(`v_${t}_known`))
})
