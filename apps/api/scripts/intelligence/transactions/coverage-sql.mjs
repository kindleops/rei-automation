#!/usr/bin/env node
/**
 * IC8.1 source coverage + Texas data quality: SQL generated FROM the JS
 * taxonomy (transactions/price-taxonomy.js) and market map
 * (transactions/markets.js), so the reports and the pure modules can never
 * disagree on a class. Read-only SELECTs; run them with statement_timeout via
 * the Supabase MCP execute_sql (project lcppdrmrdfblstpcbgpf). Direct Postgres
 * from apps/api is unavailable (stale password), and comp_private is not
 * exposed to REST.
 *
 *   node scripts/intelligence/transactions/coverage-sql.mjs --out=<dir>
 * writes canonical-coverage.sql, pool-coverage.sql, texas-quality.sql.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NONDISCLOSURE_SIGNATURE_STATES, NONDISCLOSURE_STATUTORY_UNMEASURED, PRICE_CODE_MAP } from "../../../src/lib/domain/intelligence/transactions/price-taxonomy.js";
import { COVERAGE_MARKETS } from "../../../src/lib/domain/intelligence/transactions/markets.js";
import { INVESTOR_ARCHETYPES } from "../../../src/lib/domain/intelligence/features/sale-type.js";

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const list = (xs) => xs.map(q).join(", ");

export function marketCaseSql(stateExpr, zipExpr) {
  const z = `left(lpad(${zipExpr}::text, 5, '0'), 3)`;
  const whens = COVERAGE_MARKETS.map((m) => `when ${stateExpr} = ${q(m.state)} and ${z} in (${list(m.zip3)}) then ${q(m.market)}`);
  return `(case ${whens.join(" ")} else coalesce(${stateExpr}, '??') || '-other' end)`;
}

const sqlBool = (v) => (v === null || v === undefined ? "null::boolean" : String(v));

/** VALUES table of every mapped vendor price code (generated from PRICE_CODE_MAP). */
export function priceCodesValuesSql() {
  const rows = Object.entries(PRICE_CODE_MAP).map(([c, e]) => {
    const nd = e.nd ?? e;
    return `(${q(c)}, ${q(e.source)}, ${q(e.confidence)}, ${sqlBool(e.verified)}, ${sqlBool(e.is_estimated)}, ${q(nd.confidence)}, ${sqlBool(nd.verified)}, ${sqlBool(nd.is_estimated)})`;
  });
  return `codes(code, source, conf, verified, est, nd_conf, nd_verified, nd_est) as (values ${rows.join(",\n  ")})`;
}

/**
 * Two CTEs (<name>0 base classes, <name> final classes) mirroring
 * normalizeTransactionPrice({kind:'deed'}) over `fromSql` rows that expose
 * price, price_code, price_source, st, loan, conflict_flags.
 */
export function deedClassCtes(name, fromSql) {
  const ND = list(NONDISCLOSURE_SIGNATURE_STATES);
  const STAT = list(NONDISCLOSURE_STATUTORY_UNMEASURED);
  return `${name}0 as (
  select r.*, (r.st in (${ND})) nd, (r.st in (${STAT})) stat,
    ((r.price is null or r.price <= 0) or (r.price <= 1000 and not (coalesce(r.st, '') ~ '^[A-Z]{2}$' and r.st not in (${ND}) and r.st not in (${STAT})))) none,
    k.code k_code, k.source k_source, k.conf k_conf, k.verified k_verified, k.est k_est, k.nd_conf, k.nd_verified, k.nd_est
  from (${fromSql}) r left join codes k on k.code = r.price_code
),
${name} as (
  select b.*,
    (case when none then 'UNKNOWN' when price_code is null then (case when price_source = 'unknown' then 'UNKNOWN' when nd then 'PROVIDER_UNCODED_NONDISCLOSURE' else 'RECORDED_PUBLIC' end)
          when k_code is not null then k_source else 'UNKNOWN' end) src,
    (case when none then 'UNKNOWN'
          when nd and k_source = 'DEED_CONSIDERATION' and loan = price then 'LOW'
          when price_code is null and (price_source = 'unknown' or nd) then 'LOW'
          when price_code is null then (case when stat or coalesce(exists (select 1 from unnest(conflict_flags) f where f ~* 'price'), false) then 'MEDIUM' else 'HIGH' end)
          when k_code is null then 'LOW'
          when (case when nd then nd_conf else k_conf end) = 'HIGH' and (stat or coalesce(exists (select 1 from unnest(conflict_flags) f where f ~* 'price'), false)) then 'MEDIUM'
          else (case when nd then nd_conf else k_conf end) end) conf,
    (case when none then false when price_code is null then not (price_source = 'unknown' or nd) when k_code is not null then (case when nd then nd_verified else k_verified end) else false end) verified,
    (case when none then null::boolean
          when price_code is null then (case when price_source = 'unknown' then null::boolean when nd then (case when price % 100 = 0 then null::boolean else true end) else false end)
          when k_code is not null then (case when nd then nd_est else k_est end) else null::boolean end) est
  from ${name}0 b
)`;
}

/** Pool (buyer_comp_raw_v2) price class, mirroring normalizeTransactionPrice({kind:'pool_*'}). */
export function poolPriceClassSql({ mls = "b.mls_sold_price", sale = "coalesce(b.sale_price, b.saleprice)", state = "b.property_address_state" } = {}) {
  const nd = `${state} in (${list(NONDISCLOSURE_SIGNATURE_STATES)})`;
  const stat = `${state} in (${list(NONDISCLOSURE_STATUTORY_UNMEASURED)})`;
  const disclosure = `(${state} ~ '^[A-Z]{2}$' and not ${nd} and not ${stat})`;
  const price = `(case when ${mls} > 0 then ${mls} else ${sale} end)`;
  const none = `(${price} is null or ${price} <= 0 or (${price} <= 1000 and not ${disclosure}))`;
  return {
    price,
    source: `(case when ${none} then 'UNKNOWN' when ${mls} > 0 then 'MLS' when ${nd} then 'PROVIDER_UNCODED_NONDISCLOSURE' else 'RECORDED_PUBLIC' end)`,
    confidence: `(case when ${none} then 'UNKNOWN' when ${nd} then 'LOW' when ${stat} then 'MEDIUM' else 'HIGH' end)`,
    verified: `(case when ${none} or ${nd} then false else true end)`,
    is_estimated: `(case when ${none} then null::boolean when ${nd} then (case when ${price} % 100 = 0 then null::boolean else true end) else false end)`,
  };
}

const DISTRESS_RE = "(quit\\s*claim|trustee|sheriff|foreclos|tax deed|executor|personal representative|affidavit|gift|interfamily|intrafamily|redemption|public action)";
const COMPANY_RE = "\\m(llc|l\\.l\\.c|inc|corp|co|company|trust|holdings?|propert(y|ies)|invest(ment)?s?|capital|partners|lp|ltd|group|realty|homes?|rentals?|ventures?|enterprises?|management|fund|bank|associates|development|builders?|construction|housing|equity|assets?|solutions)\\M";

/** Per-canonical-transaction classified rows (CTE text: codes, canon0, canon). */
export function canonicalRowsCte({ investor = true, stateFilter = null } = {}) {
  const investorSql = investor
    ? `(coalesce(bl.archetype = any(array[${list(INVESTOR_ARCHETYPES)}]), false) or coalesce(bl.entity_type, case when t.buyer_1_name ~* ${q(COMPANY_RE)} then 'company' when t.buyer_1_name is not null then 'person' end) = 'company') investor`
    : "null::boolean investor";
  const buyerJoin = investor
    ? `left join lateral (select b.entity_type, b.archetype from comp_private.w8c_transaction_buyer_links l join public.eg_buyer_index b on b.entity_key = l.buyer_entity_id
                     where l.canonical_transaction_id = t.id order by l.confidence desc nulls last limit 1) bl on true`
    : "";
  const where = stateFilter ? `where upper(coalesce(cp.state::text, p.property_address_state)) = ${q(stateFilter)}` : "";
  const from = `select t.id, t.primary_property_id pid, t.event_date, t.price, t.price_code, t.price_source, t.doc_type, t.is_arms_length, t.corpus_membership,
    t.concurrent_loan_amount loan, t.conflict_flags, (t.id >= 1787765) batch_0930, g.st, ${marketCaseSql("g.st", "g.zip")} market, g.zip, g.lat, g.lng, g.value,
    coalesce(t.doc_type ~* ${q(DISTRESS_RE)}, false) distress,
    (t.price > 0 and (t.price < 10000 or (g.value > 0 and t.price < 0.25 * g.value))) nominal,
    ${investorSql}
  from comp_private.comp_canonical_transactions t
  left join comp_private.comp_properties cp on cp.property_id = t.primary_property_id
  left join public.properties p on p.property_id = t.primary_property_id and cp.property_id is null
  ${buyerJoin}
  cross join lateral (select upper(coalesce(cp.state::text, p.property_address_state)) st, coalesce(cp.zip5::text, p.property_address_zip) zip,
                             coalesce(cp.latitude, p.latitude) lat, coalesce(cp.longitude, p.longitude) lng, cp.estimated_value::numeric value) g
  ${where}`;
  return `${priceCodesValuesSql()},
${deedClassCtes("canon", from)}`;
}

const PRIMARY_SQL = (c) => `${c}.conf in ('HIGH','MEDIUM') and ${c}.est is not true and ${c}.verified and ${c}.price >= 10000 and ${c}.src <> 'NON_MARKET_AMOUNT'
    and not ${c}.distress and ${c}.is_arms_length is not false and not ${c}.nominal and ${c}.lat is not null`;

// mirrors flagPackageDeeds (minus the ~1 mi proximity test): same date+price+ZIP on >= 2 parcels,
// or >= 3 parcels anywhere when the price is not a round $1,000.
const PACKAGE_CTES = `pkg as (select event_date, price, count(distinct pid) parcels from canon where price > 0 and price % 1000 <> 0 and event_date is not null and pid is not null group by 1, 2 having count(distinct pid) >= 3),
pkgz as (select event_date, price, zip, count(distinct pid) parcels from canon where price > 0 and event_date is not null and pid is not null group by 1, 2, 3 having count(distinct pid) >= 2),
canonp as (select c.*, (coalesce(pk.parcels, 0) >= 3 or coalesce(pz.parcels, 0) >= 2) package from canon c
  left join pkg pk on pk.event_date = c.event_date and pk.price = c.price
  left join pkgz pz on pz.event_date = c.event_date and pz.price = c.price and pz.zip = c.zip)`;

export function canonicalCoverageSql() {
  return `set local statement_timeout = '300s';
with ${canonicalRowsCte({ investor: false })},
${PACKAGE_CTES}
select c.market,
  count(*) canon_rows, count(*) filter (where c.price > 0) canon_priced, count(*) filter (where c.batch_0930) canon_0930,
  count(*) filter (where 'comp' = any(c.corpus_membership)) canon_comp_corpus, count(*) filter (where c.event_date >= '2023-01-01') canon_since_2023,
  count(*) filter (where c.conf = 'HIGH') conf_high, count(*) filter (where c.conf = 'MEDIUM') conf_medium,
  count(*) filter (where c.conf = 'LOW') conf_low, count(*) filter (where c.conf = 'UNKNOWN') conf_unknown,
  count(*) filter (where c.verified) verified, count(*) filter (where c.est is true) estimated,
  count(*) filter (where c.package) package_members,
  count(*) filter (where ${PRIMARY_SQL("c")} and not c.package) primary_n,
  count(*) filter (where ${PRIMARY_SQL("c")} and not c.package and c.conf = 'HIGH') primary_strict_n,
  count(*) filter (where ${PRIMARY_SQL("c")} and not c.package and c.event_date >= '2023-01-01') primary_since_2023
from canonp c group by c.market order by 2 desc;`;
}

export function canonicalSourceMixSql() {
  return `set local statement_timeout = '300s';
with ${canonicalRowsCte({ investor: false })}
select market, src, conf, count(*) n from canon group by 1, 2, 3 order by 1, 4 desc;`;
}

export function poolCoverageSql() {
  const cls = poolPriceClassSql();
  return `set local statement_timeout = '120s';
with pool as (
  select b.id, b.property_id, upper(b.property_address_state) st, ${marketCaseSql("upper(b.property_address_state)", "b.property_address_zip")} market,
    ${cls.price} price, coalesce(b.mls_sold_date, b.sale_date) d, b.sale_date, b.mls_sold_date, b.latitude, b.is_corporate_owner,
    ${cls.source} src, ${cls.confidence} conf, ${cls.is_estimated} est,
    (${cls.price} is not null and b.sale_date is not null and b.latitude is not null and b.property_address_full is not null and b.property_address_zip is not null) usable
  from public.buyer_comp_raw_v2 b where b.import_status is distinct from 'rejected'
), matched as (
  select p.id from pool p where p.property_id is not null and exists (
    select 1 from comp_private.comp_canonical_transactions t where t.primary_property_id = p.property_id
      and (abs(t.event_date - p.sale_date) <= 10 or abs(t.event_date - p.mls_sold_date) <= 10))
)
select market, count(*) pool_rows, count(*) filter (where usable) pool_usable,
  count(*) filter (where src = 'MLS') pool_mls,
  count(*) filter (where conf = 'HIGH') conf_high, count(*) filter (where conf = 'MEDIUM') conf_medium,
  count(*) filter (where conf = 'LOW') conf_low, count(*) filter (where conf = 'UNKNOWN') conf_unknown,
  count(*) filter (where est is true) estimated,
  count(*) filter (where id in (select id from matched)) matched_to_canonical,
  count(*) filter (where usable and id in (select id from matched)) usable_matched,
  count(*) filter (where usable and conf = 'HIGH' and price >= 10000 and id not in (select id from matched)) pool_primary_unmatched,
  count(*) filter (where is_corporate_owner) corporate_owner
from pool group by 1 order by 2 desc;`;
}

export function texasQualitySql() {
  return `set local statement_timeout = '300s';
with ${canonicalRowsCte({ investor: true, stateFilter: "TX" })},
${PACKAGE_CTES},
tx as (select * from canonp where st = 'TX'),
props as (select pid, min(market) market from tx where pid is not null group by pid),
cov as (select pr.market,
    count(*) properties,
    count(*) filter (where exists (select 1 from comp_private.comp_mortgages m where m.property_id = pr.pid) or exists (select 1 from seller.property_mortgage m where m.property_id = pr.pid)) props_with_mortgage,
    count(*) filter (where exists (select 1 from comp_private.comp_liens_private l where l.property_id = pr.pid) or exists (select 1 from seller.property_lien l where l.property_id = pr.pid)) props_with_lien,
    count(*) filter (where exists (select 1 from comp_private.comp_property_companies c where c.property_id = pr.pid) or exists (select 1 from seller.property_company c where c.property_id = pr.pid)) props_with_company,
    count(*) filter (where exists (select 1 from comp_private.comp_properties cp where cp.property_id = pr.pid and (cp.mls_status is not null or cp.days_on_market is not null))) props_with_listing
  from props pr group by pr.market)
select tx.market,
  count(*) txns, count(*) filter (where tx.event_date >= '2025-07-01') txns_since_2025_07,
  count(*) filter (where tx.verified) verified_price, count(*) filter (where tx.conf = 'HIGH') high_conf, count(*) filter (where tx.conf = 'MEDIUM') medium_conf,
  count(*) filter (where tx.conf = 'LOW') low_conf, count(*) filter (where tx.est is true or tx.src = 'VENDOR_ESTIMATE') vendor_or_estimated,
  count(*) filter (where tx.src = 'VENDOR_ESTIMATE') vendor_estimate_code, count(*) filter (where tx.conf = 'UNKNOWN') unknown_price,
  count(*) filter (where tx.investor) investor_txns, count(*) filter (where tx.investor and tx.event_date >= '2025-07-01') investor_since_2025_07,
  count(*) filter (where tx.distress) distress_doc, count(*) filter (where tx.loan > 0) with_concurrent_loan,
  count(*) filter (where ${PRIMARY_SQL("tx")} and not tx.package) primary_truth,
  count(*) filter (where ${PRIMARY_SQL("tx")} and not tx.package and tx.conf = 'HIGH') primary_strict,
  max(cov.properties) properties, max(cov.props_with_mortgage) props_with_mortgage, max(cov.props_with_lien) props_with_lien,
  max(cov.props_with_company) props_with_company, max(cov.props_with_listing) props_with_listing
from tx left join cov on cov.market = tx.market group by tx.market order by 2 desc;`;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  const out = (process.argv.find((a) => a.startsWith("--out=")) ?? "--out=.").slice(6);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "canonical-coverage.sql"), `${canonicalCoverageSql()}\n`);
  fs.writeFileSync(path.join(out, "canonical-source-mix.sql"), `${canonicalSourceMixSql()}\n`);
  fs.writeFileSync(path.join(out, "pool-coverage.sql"), `${poolCoverageSql()}\n`);
  fs.writeFileSync(path.join(out, "texas-quality.sql"), `${texasQualitySql()}\n`);
  console.log(`wrote 4 SQL files to ${out}`);
}
