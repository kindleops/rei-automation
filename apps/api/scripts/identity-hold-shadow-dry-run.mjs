#!/usr/bin/env node
/**
 * READ-ONLY dry run of the campaign identity release predicate.
 *
 *   node apps/api/scripts/identity-hold-shadow-dry-run.mjs --out=/path/dry-run.csv \
 *     [--campaign=<uuid>] [--markets="Dallas, TX|Houston, TX"]
 *
 * Session: default_transaction_read_only=on, statement_timeout 30 s, one market
 * per query. Evidence comes from the SAME SQL the live accessor runs — the block
 * between BEGIN/END EVIDENCE QUERY in
 * supabase/migrations/PROPOSED_20261005120000_campaign_identity_release_evidence.sql,
 * executed with bound parameters (nothing is created). The verdict comes from
 * identity-release.js, the live predicate; R4 is reported, never released.
 *
 * Phones are masked to the last four digits in the CSV. Writes nothing to the DB.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { evaluateIdentityHoldShadow } from '../src/lib/domain/campaigns/identity-hold-shadow.js'
import { summarizeIdentityRelease } from '../src/lib/domain/campaigns/identity-release.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=')
  return [k, v.join('=') || true]
}))
const DB_URL = process.env.SUPABASE_DB_URL || (fs.existsSync('/tmp/.dburl') ? fs.readFileSync('/tmp/.dburl', 'utf8').trim() : '')
const OUT = args.out || 'dry-run.csv'
const CAMPAIGN = args.campaign || 'cbc2a5d3-b4d4-4297-a168-1ac69e643ee0'
const MARKETS = String(args.markets || 'Minneapolis, MN|Dallas, TX|Houston, TX|Tampa, FL').split('|')
if (!DB_URL) { console.error('no database url'); process.exit(2) }

const MIGRATION = path.resolve(here, '../../../supabase/migrations/PROPOSED_20261005120000_campaign_identity_release_evidence.sql')
const migrationSql = fs.readFileSync(MIGRATION, 'utf8')
const EVIDENCE_SQL = migrationSql
  .split('-- BEGIN EVIDENCE QUERY')[1]
  .split('-- END EVIDENCE QUERY')[0]
  .replace(/\bp_property_ids\b/g, '$1::text[]')
  .replace(/\bp_phones\b/g, '$2::text[]')

// Phone groups across the requested markets (the dedup groups a cohort).
const PHONE_GROUP_SQL = `
  select canonical_e164 as phone, count(*)::int as rows,
         count(distinct master_owner_id)::int as distinct_master_owners,
         count(distinct seller_person_key)::int as distinct_person_keys,
         count(*) filter (where seller_person_key is null)::int as null_person_rows,
         min(seller_person_key) as person_key
  from public.campaign_target_graph
  where market = any($1) and queue_eligible and canonical_e164 is not null
  group by canonical_e164 having count(distinct master_owner_id) > 1`

// Rows the build would hold (plus entity rows with no SMS channel, R4 report only).
const CANDIDATE_SQL = `
  select g.graph_id, g.property_id, g.market, g.canonical_e164, g.seller_person_key, g.master_owner_id,
         g.identity_alignment, g.owner_name, g.queue_eligible, g.queue_block_reason,
         g.extra_data->>'contact_lane' as lane,
         coalesce(g.podio_tags ilike '%tired landlord%', false) as tired_landlord,
         (ec.property_id is not null) as has_entity, coalesce(ec.requires_review, true) as review,
         ct.block_reason as campaign_block_reason, ct.target_status as campaign_target_status
  from public.campaign_target_graph g
  left join seller.property_entity_contact_v1 ec on ec.property_id = g.property_id
  left join lateral (select t.block_reason, t.target_status from public.campaign_targets t
                      where t.campaign_id = $3 and t.property_id = g.property_id limit 1) ct on true
  where g.market = $1
    and ((g.queue_eligible and (g.seller_person_key is null
                                or (ec.property_id is not null and coalesce(ec.requires_review, true))
                                or g.canonical_e164 = any($2)))
         or (not g.queue_eligible and g.extra_data->>'contact_lane' = 'entity_contact'
             and g.queue_block_reason in ('non_sms_capable', 'missing_phone')))`

// R4 (NOT APPROVED) report-only candidates.
const ALT_SQL = `
  select opp.property_id,
         json_agg(json_build_object(
           'individual_key', o2.individual_key, 'full_name', o2.full_name, 'given_name', o2.given_name, 'surname', o2.surname,
           'matching_type', o2.matching_type, 'matches_property_owner', o2.matches_property_owner, 'likely_renting', o2.likely_renting,
           'phone', op.phone_value, 'phone_type', op.phone_type, 'slot', op.slot,
           'phone_suppressed', exists (select 1 from public.sms_suppression_list sl
                                       where sl.phone_e164 = '+1' || op.phone_value and coalesce(sl.is_active, true)),
           'tags_on_property', (select string_agg(pr.matching_flags, ',') from public.prospects pr
                                where pr.individual_key = o2.individual_key and pr.linked_property_ids_json ? opp.property_id))) as alt
  from seller.owner_portfolio_property opp
  join seller.owner o2 on o2.individual_key = opp.individual_key
  join seller.owner_phone op on op.individual_key = o2.individual_key
  where opp.property_id = any($1)
    and op.phone_type in ('W','Wireless') and not op.is_encrypted and op.phone_value ~ '^[0-9]{10}$'
  group by opp.property_id`

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function main() {
  const client = new pg.Client({ connectionString: DB_URL, options: '-c default_transaction_read_only=on -c statement_timeout=30000' })
  await client.connect()
  try {
    const groups = new Map((await client.query(PHONE_GROUP_SQL, [MARKETS])).rows.map((r) => [r.phone, r]))
    const records = []
    for (const market of MARKETS) {
      const cands = (await client.query(CANDIDATE_SQL, [market, [...groups.keys()], CAMPAIGN])).rows
      const evidence = new Map()
      const alts = new Map()
      for (let i = 0; i < cands.length; i += 300) {
        const chunk = cands.slice(i, i + 300)
        const res = await client.query(EVIDENCE_SQL, [chunk.map((c) => c.property_id), chunk.map((c) => c.canonical_e164)])
        for (const r of res.rows) evidence.set(r.property_id, r.evidence)
        const entityIds = chunk.filter((c) => c.has_entity).map((c) => c.property_id)
        if (entityIds.length) for (const r of (await client.query(ALT_SQL, [entityIds])).rows) alts.set(r.property_id, r.alt)
      }
      for (const c of cands) {
        const ev = evidence.get(c.property_id) || {}
        const g = groups.get(c.canonical_e164) || null
        const row = {
          ...ev,
          property_id: c.property_id,
          owner_name: c.owner_name,
          seller_person_key: c.seller_person_key,
          canonical_e164: c.canonical_e164,
          queue_eligible: c.queue_eligible,
          queue_block_reason: c.queue_block_reason,
          entity_contact_requires_review: c.has_entity ? c.review : false,
          ambiguous_phone_ownership: Boolean(g),
          phone_group: g,
          alt_principals: alts.get(c.property_id) || [],
        }
        const verdict = evaluateIdentityHoldShadow(row)
        if (verdict.held) records.push({ c, ev, verdict })
      }
      console.error(`${market}: ${cands.length} candidate rows`)
    }

    const header = ['market', 'property_id', 'tired_landlord', 'contact_lane', 'in_campaign', 'campaign_block_reason', 'phone_last4',
      'hold_reasons', 'primary_reason', 'released_live', 'tier', 'release_rule', 'remaining_holds', 'r4_report_only',
      'owner_name', 'entity', 'contact_person', 'contact_matching_tags', 'person_match_type', 'resolution_status', 'evidence']
    const lines = [header.join(',')]
    for (const { c, ev, verdict } of records) {
      const person = ev.person || {}
      lines.push([
        c.market, c.property_id, c.tired_landlord, c.lane, c.campaign_target_status ? 'yes' : 'no', c.campaign_block_reason,
        c.canonical_e164 ? String(c.canonical_e164).slice(-4) : '', verdict.reasons.join('+'), verdict.primary,
        Boolean(verdict.released), verdict.tier || '', verdict.release_rule || '', (verdict.remaining_holds || []).join('+'),
        verdict.r4 ? `${verdict.r4.outcome}${verdict.r4.hold ? `:${verdict.r4.hold}` : ''}` : '',
        c.owner_name, ev.entity?.owning_entity_name, person.full_name || ev.phone_holders?.[0]?.full_name || '',
        person.tags_on_property || ev.phone_holders?.[0]?.tags_on_property || '', person.matching_type, ev.resolution?.status,
        JSON.stringify(verdict.evidence || {}),
      ].map(csvCell).join(','))
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, lines.join('\n') + '\n')

    const pick = (fn) => summarizeIdentityRelease(records.filter(fn).map((x) => x.verdict))
    const r4 = (fn) => records.filter(fn).filter((x) => x.verdict.r4?.outcome === 'would_substitute').length
    const summary = {
      generated_at: new Date().toISOString(),
      markets: MARKETS,
      campaign_id: CAMPAIGN,
      ambiguous_phone_groups: groups.size,
      all_markets: pick(() => true),
      by_market: Object.fromEntries(MARKETS.map((m) => [m, pick((x) => x.c.market === m)])),
      campaign_cohort: pick((x) => ['entity_contact_requires_review', 'missing_identity_linkage', 'ambiguous_phone_ownership'].includes(x.c.campaign_block_reason)),
      tired_landlord: pick((x) => x.c.tired_landlord),
      tired_landlord_entity_lane: pick((x) => x.c.tired_landlord && x.c.lane === 'entity_contact'),
      r4_not_approved_would_substitute: { all_markets: r4(() => true), tired_landlord: r4((x) => x.c.tired_landlord) },
    }
    fs.writeFileSync(OUT.replace(/\.csv$/, '') + '.summary.json', JSON.stringify(summary, null, 2))
    console.log(JSON.stringify({ all_markets: summary.all_markets, campaign_cohort: summary.campaign_cohort, tired_landlord: summary.tired_landlord, r4: summary.r4_not_approved_would_substitute }, null, 2))
  } finally {
    await client.end()
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
