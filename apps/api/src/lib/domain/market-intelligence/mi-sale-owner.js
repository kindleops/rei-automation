/**
 * THE SHARED SALE-BUYER RESOLVER (owner request 2026-10-05): "For a property's MOST RECENT
 * sale, with no later transfer, the current owner IS the buyer."
 *
 * One bounded, indexed, read-only query per batch of ≤ 100 sales (comp ids from
 * mv_map_market_sales), then the pure rules of mi-inferred-investor.js:
 *   linkSaleToOwner()   step 1 (mi_owner_link@1): latest sale, no later transfer, owner
 *                       snapshot observed ≥ 30 days after the sale
 *   classifyOwner()     the owner's inferred-investor tier, with its evidence
 *   saleBuyerOfRecord() the display buyer: the recorded buyer when the deed names one, else
 *                       "<owner> · current owner of record" when linked, else "Buyer not on record"
 *
 * Privacy (Buyer Match rules): companies are named only through displayableCompanyName() and
 * never when they are lenders; a person is never named ("Individual (…)"). Owner names exist
 * for < 1% of the sales corpus (public.properties); most linked company owners therefore read
 * "Company (name not on record) · current owner of record". Nothing is guessed.
 *
 * Every surface that shows a sale's buyer uses this: MI recent sales (op=recent_sales rows carry
 * buyer_of_record), the Map comp card (op=sale_owner&ids=<comp_id>,…) and Comp Intelligence
 * evidence (op=sale_owner&props=<property_id>@<YYYY-MM-DD>,…).
 */
import { queryWithTimeout } from '@/lib/postgres/client.js'
import { displayableCompanyName } from '@/lib/domain/entity-graph/buyer-name-privacy.js'
import { lenderClass } from '@/lib/domain/buyer-match/buyer-identity-rules.js'
import { linkSaleToOwner, classifyOwner, saleBuyerOfRecord, LINK_RULE, TIER_RULE, TIER_LABEL, LINK_REASONS } from './mi-inferred-investor.js'

export const SALE_OWNER_MAX_IDS = 100
const STACK_COUNT_CAP = 5000

/**
 * Indexed per row: mv_map_market_sales (comp_id unique; property_id), comp_canonical_transactions
 * (primary_property_id, event_date), comp_properties (property_id unique; mailing key), contacts
 * (property_id). The mailing-stack count is capped so a registered-agent address cannot run long.
 */
const OWNER_COLUMNS = (pid, sold) => `
       (select max(t.event_date)::text from comp_private.comp_canonical_transactions t where t.primary_property_id = ${pid} and t.event_date > ${sold}) as later_transfer_on,
       cp.last_observed_at::date::text as owner_observed_on,
       cp.is_corporate_owner, cp.is_trust, cp.out_of_state_owner,
       case when cp.owner_mailing_identity_key_v1 is null then null
            else (select count(*) from (select 1 from comp_private.comp_properties c2
                   where c2.owner_mailing_identity_key_v1 = cp.owner_mailing_identity_key_v1 limit ${STACK_COUNT_CAP}) s)::int end as mail_stack,
       exists (select 1 from comp_private.comp_property_contacts pc where pc.property_id = ${pid} and pc.resident and pc.likely_owner) as resident_owner,
       (select p.owner_name from public.properties p where p.property_id = ${pid} and p.owner_name is not null limit 1) as owner_name`

/** By sales-MV comp id (MI recent sales, the Map comp card: comp ids from mv_map_market_sales). */
export const SALE_OWNER_SQL = `
select m.comp_id, m.property_id, m.sold_on::text as sold_on, m.buyer, m.buyer_kind,
       (m.property_id is not null and m.sold_on = (select max(m2.sold_on) from public.mv_map_market_sales m2 where m2.property_id = m.property_id)) as is_latest_sale,
       ${OWNER_COLUMNS('m.property_id', 'm.sold_on')}
  from public.mv_map_market_sales m
  left join comp_private.comp_properties cp on cp.property_id = m.property_id
 where m.comp_id = any($1::text[])`

/**
 * By (property id, sale date) for surfaces whose rows are not MV comp ids (Comp Intelligence
 * evidence). "Most recent" = no canonical market sale of the property more than 10 days after the
 * given date (closing vs recording dates differ by days); the recorded buyer, if any, comes from
 * the market sale within 10 days of that date.
 */
export const SALE_OWNER_BY_PROPERTY_SQL = `
select q.property_id || '@' || q.sold_on::text as comp_id, q.property_id, q.sold_on::text as sold_on, ms.buyer, ms.buyer_kind,
       not exists (select 1 from public.mv_map_market_sales m2 where m2.property_id = q.property_id and m2.sold_on > q.sold_on + 10) as is_latest_sale,
       ${OWNER_COLUMNS('q.property_id', 'q.sold_on')}
  from unnest($1::text[], $2::date[]) as q(property_id, sold_on)
  left join lateral (select m.buyer, m.buyer_kind from public.mv_map_market_sales m
                      where m.property_id = q.property_id and m.sold_on between q.sold_on - 10 and q.sold_on + 10
                      order by abs(m.sold_on - q.sold_on), m.comp_id limit 1) ms on true
  left join comp_private.comp_properties cp on cp.property_id = q.property_id`

const companyName = (name) => (name && !lenderClass(name) ? displayableCompanyName(name) : null)

/** Pure: one SALE_OWNER_SQL row → the resolver payload for that sale. */
export function resolveSaleOwnerRow(r) {
  const link = linkSaleToOwner({ propertyId: r.property_id, soldOn: r.sold_on, isLatestSale: r.is_latest_sale === true, laterTransferOn: r.later_transfer_on, ownerObservedOn: r.owner_observed_on })
  const signals = { corporate: r.is_corporate_owner === true, trust: r.is_trust === true, outOfState: r.out_of_state_owner === true, mailStack: r.mail_stack, residentOwner: r.resident_owner === true }
  const tier = link.linked ? classifyOwner(signals) : null
  // An owner NAME is used only for an entity owner (a person is never named).
  const ownerName = link.linked && (signals.corporate || signals.trust) ? r.owner_name : null
  const buyer = saleBuyerOfRecord({ buyer: r.buyer, buyer_kind: r.buyer_kind }, { ...link, ...signals, ownerName }, companyName)
  return {
    comp_id: r.comp_id,
    buyer_of_record: buyer,
    owner_link: { linked: link.linked, reason: link.reason, explanation: LINK_REASONS[link.reason], rule: LINK_RULE.id, owner_observed_on: r.owner_observed_on ?? null, later_transfer_on: r.later_transfer_on ?? null },
    inferred: tier ? { tier: tier.tier, label: TIER_LABEL[tier.tier], investor: tier.investor, evidence: tier.evidence, rule: TIER_RULE.id,
      mailing_stack: Number.isFinite(Number(r.mail_stack)) ? Math.min(Number(r.mail_stack), STACK_COUNT_CAP) : null } : null,
  }
}

/** Pure: normalise the requested ids (comma string or array) to ≤ SALE_OWNER_MAX_IDS comp ids. */
export function saleOwnerIds(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',')
  return [...new Set(list.map((s) => String(s).trim()).filter((s) => /^[a-z]:[A-Za-z0-9_.:-]{1,80}$/.test(s)))].slice(0, SALE_OWNER_MAX_IDS)
}

/** Pure: "propertyId@YYYY-MM-DD" keys (comma string or array) → { ids, dates }, ≤ SALE_OWNER_MAX_IDS. */
export function salePropertyKeys(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',')
  const keys = [...new Set(list.map((s) => String(s).trim()).filter((s) => /^[A-Za-z0-9_.:-]{1,80}@\d{4}-\d{2}-\d{2}$/.test(s)))].slice(0, SALE_OWNER_MAX_IDS)
  return { keys, ids: keys.map((k) => k.slice(0, k.lastIndexOf('@'))), dates: keys.map((k) => k.slice(k.lastIndexOf('@') + 1)) }
}

export function createSaleOwnerReader(deps = {}) {
  const query = deps.query || queryWithTimeout
  /** Map(comp_id → resolver payload). Unknown ids are absent. */
  async function readSaleOwners(ids) {
    const list = saleOwnerIds(ids)
    if (!list.length) return new Map()
    const res = await query(SALE_OWNER_SQL, [list], 8_000)
    return new Map((res?.rows || []).map((r) => [r.comp_id, resolveSaleOwnerRow(r)]))
  }
  /** Map("propertyId@date" → resolver payload). */
  readSaleOwners.byProperty = async function readByProperty(raw) {
    const { ids, dates } = salePropertyKeys(raw)
    if (!ids.length) return new Map()
    const res = await query(SALE_OWNER_BY_PROPERTY_SQL, [ids, dates], 8_000)
    return new Map((res?.rows || []).map((r) => [r.comp_id, resolveSaleOwnerRow(r)]))
  }
  return readSaleOwners
}
