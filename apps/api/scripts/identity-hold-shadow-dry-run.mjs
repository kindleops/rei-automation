#!/usr/bin/env node
/**
 * READ-ONLY dry run of the identity-hold shadow evaluator.
 *
 *   SUPABASE_DB_URL=… node apps/api/scripts/identity-hold-shadow-dry-run.mjs \
 *     --out=/path/dry-run.csv [--campaign=<uuid>] [--markets="Dallas, TX|Houston, TX"]
 *
 * Every session is `default_transaction_read_only=on` with a 30 s statement
 * timeout, one market per query. It reads the campaign target graph (queue-
 * eligible rows only) and the seller.* evidence, runs the PURE evaluator, and
 * writes a CSV plus a JSON summary. It writes nothing to the database and does
 * not change readiness, the graph or campaign targets.
 *
 * Phones are masked to the last four digits in the CSV.
 */
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { evaluateIdentityHoldShadow, summarizeIdentityHoldShadow } from '../src/lib/domain/campaigns/identity-hold-shadow.js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=')
  return [k, v.join('=') || true]
}))
const DB_URL = process.env.SUPABASE_DB_URL || (fs.existsSync('/tmp/.dburl') ? fs.readFileSync('/tmp/.dburl', 'utf8').trim() : '')
const OUT = args.out || 'dry-run.csv'
const CAMPAIGN = args.campaign || 'cbc2a5d3-b4d4-4297-a168-1ac69e643ee0'
const MARKETS = String(args.markets || 'Minneapolis, MN|Dallas, TX|Houston, TX|Tampa, FL').split('|')
if (!DB_URL) { console.error('no database url'); process.exit(2) }

// Phone-group stats across ALL requested markets (the dedup groups a cohort, not a market).
const PHONE_GROUP_SQL = `
  select canonical_e164 as phone, count(*)::int as rows,
         count(distinct master_owner_id)::int as distinct_master_owners,
         count(distinct seller_person_key)::int as distinct_person_keys,
         count(*) filter (where seller_person_key is null)::int as null_person_rows,
         min(seller_person_key) as person_key
  from public.campaign_target_graph
  where market = any($1) and queue_eligible and canonical_e164 is not null
  group by canonical_e164 having count(distinct master_owner_id) > 1`

// Held candidates in one market, with all evidence. Indexed keys only.
const MARKET_SQL = `
  with g as (
    select graph_id, property_id, market, canonical_e164 as phone, seller_person_key, master_owner_id,
           identity_alignment, extra_data->>'contact_lane' as lane, owner_name, property_address_full,
           coalesce(podio_tags ilike '%tired landlord%', false) as tired_landlord
      , queue_eligible, queue_block_reason
    from public.campaign_target_graph
    where market = $1
      and (queue_eligible
           or (extra_data->>'contact_lane' = 'entity_contact' and queue_block_reason in ('non_sms_capable', 'missing_phone')))
  ), h as (
    select g.*, ec.property_id is not null as has_entity, ec.requires_review, ec.exclusion_reasons, ec.evidence_codes,
           ec.entity_status, ec.owning_entity_name, ec.owning_entity_id, ec.selected_person_key, ec.selected_phone, ec.contact_role
    from g left join seller.property_entity_contact_v1 ec on ec.property_id = g.property_id
    where not g.queue_eligible
       or g.seller_person_key is null
       or (ec.property_id is not null and coalesce(ec.requires_review, true))
       or g.phone = any($2)
  )
  select h.*,
    -- entity-lane person evidence
    o.individual_key is not null as person_found, o.matching_type, o.matches_property_owner, o.likely_owner, o.likely_renting, o.full_name as person_name, o.given_name as person_given_name, o.surname as person_surname,
    (h.selected_person_key is not null and exists (select 1 from seller.owner_portfolio_property opp
       where opp.individual_key = h.selected_person_key and opp.property_id = h.property_id)) as in_portfolio,
    (select count(*) > 0 from seller.owner_phone op where op.individual_key = h.selected_person_key and op.phone_value = h.selected_phone) as phone_is_own,
    (select bool_or(op.do_not_call) from seller.owner_phone op where op.individual_key = h.selected_person_key and op.phone_value = h.selected_phone) as phone_dnc,
    (select count(distinct upper(e2.owning_entity_name))::int from seller.property_entity_contact_v1 e2
       where h.selected_person_key is not null and e2.selected_person_key = h.selected_person_key) as entity_fanout,
    (select array_agg(distinct w.officer_role) from comp_private.w8c_buyer_company_relationships w
       where h.selected_person_key is not null and h.owning_entity_id like '%:%'
         and w.person_entity_id = 'person:' || h.selected_person_key
         and w.company_entity_id = 'company:' || split_part(h.owning_entity_id, ':', 2) || ':' || split_part(h.owning_entity_id, ':', 1)) as registry_officer_roles,
    -- R4: other owner-side principals of this property with a clean wireless phone
    (select coalesce(json_agg(json_build_object(
              'individual_key', o2.individual_key, 'full_name', o2.full_name, 'given_name', o2.given_name, 'surname', o2.surname,
              'matching_type', o2.matching_type, 'matches_property_owner', o2.matches_property_owner, 'likely_renting', o2.likely_renting,
              'phone', op.phone_value, 'phone_type', op.phone_type, 'slot', op.slot, 'phone_dnc', op.do_not_call,
              'phone_suppressed', exists (select 1 from public.sms_suppression_list sl
                                          where sl.phone_e164 = '+1' || op.phone_value and coalesce(sl.is_active, true))
            ) order by o2.individual_key, op.slot), '[]'::json)
       from seller.owner_portfolio_property opp
       join seller.owner o2 on o2.individual_key = opp.individual_key
       join seller.owner_phone op on op.individual_key = o2.individual_key
      where h.has_entity and opp.property_id = h.property_id
        and opp.individual_key is distinct from h.selected_person_key
        and o2.matching_type in ('mailing_address','company_auto_match','company_tiebreaker','company_level2_auto_match','company_level2_tiebreaker','trust_auto_match')
        and op.phone_type in ('W','Wireless') and not op.is_encrypted and op.phone_value ~ '^[0-9]{10}$') as alt_principals,
    -- missing-linkage evidence
    r.owner_resolution_status as res_status, r.co_owner_individual_key, r.deed_owner_name, r.operational_owner_name, r.reason_codes,
    (select coalesce(json_agg(json_build_object(
              'individual_key', x.individual_key, 'given_name', ow.given_name, 'surname', ow.surname, 'full_name', ow.full_name,
              'likely_owner', ow.likely_owner, 'likely_renting', ow.likely_renting, 'phone_dnc', x.dnc)), '[]'::json)
       from (select op.individual_key, bool_or(op.do_not_call) as dnc
               from seller.owner_portfolio_property opp
               join seller.owner_phone op on op.individual_key = opp.individual_key
              where h.seller_person_key is null and opp.property_id = h.property_id and op.phone_value = h.phone
              group by op.individual_key) x
       left join seller.owner ow on ow.individual_key = x.individual_key) as phone_holders,
    ct.block_reason as campaign_block_reason, ct.target_status as campaign_target_status
  from h
  left join seller.owner o on o.individual_key = h.selected_person_key
  left join seller.property_owner_resolution_v1 r on r.property_id = h.property_id
  left join lateral (select t.block_reason, t.target_status from public.campaign_targets t
                      where t.campaign_id = $3 and t.property_id = h.property_id limit 1) ct on true`

function toRow(r, groups) {
  const g = groups.get(r.phone) || null
  return {
    graph_id: r.graph_id,
    property_id: r.property_id,
    market: r.market,
    phone: r.phone,
    queue_eligible: r.queue_eligible,
    queue_block_reason: r.queue_block_reason,
    alt_principals: r.alt_principals || [],
    seller_person_key: r.seller_person_key,
    owner_name: r.owner_name,
    entity: r.has_entity ? {
      requires_review: r.requires_review, exclusion_reasons: r.exclusion_reasons, evidence_codes: r.evidence_codes,
      entity_status: r.entity_status, owning_entity_name: r.owning_entity_name, selected_person_key: r.selected_person_key,
    } : null,
    person: r.has_entity && r.person_found ? {
      matching_type: r.matching_type, matches_property_owner: r.matches_property_owner, likely_owner: r.likely_owner,
      likely_renting: r.likely_renting, in_portfolio: r.in_portfolio, phone_is_own: r.phone_is_own, phone_dnc: r.phone_dnc,
      entity_fanout: r.entity_fanout, given_name: r.person_given_name, surname: r.person_surname,
      full_name: r.person_name, registry_officer_roles: r.registry_officer_roles || [],
    } : null,
    resolution: { status: r.res_status, co_owner_individual_key: r.co_owner_individual_key, deed_owner_name: r.deed_owner_name, operational_owner_name: r.operational_owner_name },
    phone_holders: r.phone_holders || [],
    phone_group: g ? { ...g } : null,
  }
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function main() {
  const client = new pg.Client({ connectionString: DB_URL, options: '-c default_transaction_read_only=on -c statement_timeout=30000' })
  await client.connect()
  try {
    const groupsRes = await client.query(PHONE_GROUP_SQL, [MARKETS])
    const groups = new Map(groupsRes.rows.map((r) => [r.phone, r]))
    const ambiguousPhones = [...groups.keys()]
    const records = []
    for (const market of MARKETS) {
      const res = await client.query(MARKET_SQL, [market, ambiguousPhones, CAMPAIGN])
      for (const r of res.rows) {
        const row = toRow(r, groups)
        const ev = evaluateIdentityHoldShadow(row)
        if (!ev.held) continue
        records.push({ r, row, ev })
      }
      console.error(`${market}: ${res.rows.length} candidate rows`)
    }

    const header = ['market', 'property_id', 'tired_landlord', 'contact_lane', 'in_campaign', 'campaign_block_reason', 'phone_last4', 'hold_reasons', 'primary_reason',
      'would_release', 'tier', 'rules', 'remaining_holds', 'owner_name', 'entity', 'contact_person', 'person_match_type',
      'resolution_status', 'title_name', 'evidence']
    const lines = [header.join(',')]
    for (const { r, ev } of records) {
      const evidence = Object.assign({}, ...ev.results.filter((x) => x.evidence).map((x) => x.evidence))
      lines.push([
        r.market, r.property_id, r.tired_landlord, r.lane, r.campaign_target_status ? 'yes' : 'no', r.campaign_block_reason,
        r.phone ? String(r.phone).slice(-4) : '', ev.reasons.join('+'), ev.primary, ev.would_release, ev.tier || '',
        (ev.rules || []).join('+'), (ev.remaining_holds || []).join('+'), r.owner_name, r.owning_entity_name,
        r.person_name || (r.phone_holders?.[0]?.full_name ?? ''), r.matching_type, r.res_status,
        r.operational_owner_name || r.deed_owner_name, JSON.stringify(evidence),
      ].map(csvCell).join(','))
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, lines.join('\n') + '\n')

    const evaluations = records.map((x) => x.ev)
    const campaignEvaluations = records.filter((x) => x.r.campaign_target_status).map((x) => x.ev)
    const byMarket = {}
    for (const m of MARKETS) byMarket[m] = summarizeIdentityHoldShadow(records.filter((x) => x.r.market === m).map((x) => x.ev))
    const summary = {
      generated_at: new Date().toISOString(),
      markets: MARKETS,
      campaign_id: CAMPAIGN,
      ambiguous_phone_groups: groups.size,
      all_markets: summarizeIdentityHoldShadow(evaluations),
      campaign_cohort: summarizeIdentityHoldShadow(campaignEvaluations),
      by_market: byMarket,
      tired_landlord: summarizeIdentityHoldShadow(records.filter((x) => x.r.tired_landlord).map((x) => x.ev)),
      tired_landlord_entity_lane: summarizeIdentityHoldShadow(records.filter((x) => x.r.tired_landlord && x.r.lane === 'entity_contact').map((x) => x.ev)),
    }
    fs.writeFileSync(OUT.replace(/\.csv$/, '') + '.summary.json', JSON.stringify(summary, null, 2))
    console.log(JSON.stringify({ all_markets: summary.all_markets, campaign_cohort: summary.campaign_cohort }, null, 2))
  } finally {
    await client.end()
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
