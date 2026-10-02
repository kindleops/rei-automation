#!/usr/bin/env node
/**
 * IC8.1 source coverage renderer: county / state / market tables from the
 * read-only query results saved under reports/_data (county-coverage-*.json from
 * countyCoverageSql(), pool-county-*.json from poolCountySql()).
 *
 * Geography (geography.js): fips, else the property join, else ZIP5. County
 * names are unified with normalizeCountyName(). Market = properties
 * canonical_market_id, else the ZIP membership, else (renderer step) the
 * county-majority market of the same state+county; anything left is reported
 * as "(no canonical market)" with its county, never dropped.
 *
 *   node scripts/intelligence/transactions/render-coverage.mjs --data=<reports/_data> --markets=<json> > coverage-tables.md
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeCountyName } from "../../../src/lib/domain/intelligence/transactions/geography.js";

const fmt = (n) => Number(n).toLocaleString("en-US");
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");

/** Pure: aggregate canonical + pool rows into county, state and market tables. */
export function buildCoverage({ canonical, pool, marketNames = {} }) {
  const key = (st, county) => `${st}|${normalizeCountyName(county === "(none)" ? null : county) ?? "(no county)"}`;
  const counties = new Map();
  const blank = (st, county) => ({ st, county, n: 0, eligible: 0, deduped_eligible: 0, investor: 0, h: 0, m: 0, l: 0, u: 0, est_code: 0, fips_n: 0, prop_n: 0, zip_n: 0, unattr_n: 0, pool_n: 0, pool_usable: 0, pool_only_eligible: 0, markets: new Map(), unmarketed: 0, pool_unmarketed_eligible: 0 });
  const get = (st, county) => {
    const k = key(st, county);
    if (!counties.has(k)) counties.set(k, blank(st, k.split("|")[1]));
    return counties.get(k);
  };
  for (const r of canonical) {
    const [st, county, market, n, eligible, dedupedEligible, investor, h, m, l, u, est, fipsN, propN, zipN, unattrN] = r;
    const c = get(st, county);
    Object.assign(c, { n: c.n + n, eligible: c.eligible + eligible, deduped_eligible: c.deduped_eligible + dedupedEligible, investor: c.investor + investor, h: c.h + h, m: c.m + m, l: c.l + l, u: c.u + u, est_code: c.est_code + est, fips_n: c.fips_n + fipsN, prop_n: c.prop_n + propN, zip_n: c.zip_n + zipN, unattr_n: c.unattr_n + unattrN });
    if (market === "(none)") c.unmarketed += n;
    else c.markets.set(market, (c.markets.get(market) ?? { n: 0, deduped: 0 })), (c.markets.get(market).n += n), (c.markets.get(market).deduped += dedupedEligible);
  }
  for (const r of pool) {
    const [st, county, market, n, usable, poolOnlyEligible] = r;
    const c = get(st, county);
    c.pool_n += n;
    c.pool_usable += usable;
    c.pool_only_eligible += poolOnlyEligible;
    c.deduped_eligible += poolOnlyEligible;
    if (market !== "(none)") {
      const e = c.markets.get(market) ?? { n: 0, deduped: 0 };
      e.poolOnly = (e.poolOnly ?? 0) + poolOnlyEligible;
      c.markets.set(market, e);
    } else c.pool_unmarketed_eligible += poolOnlyEligible;
  }
  // market rollup (exact, row by row): a row's own market (properties.canonical_market_id, else
  // ZIP membership); an unmarketed row goes to its county-majority market (by canonical rows);
  // a county with no market at all is reported as "(no canonical market) <ST>".
  const markets = new Map();
  const mk = (id) => {
    if (!markets.has(id)) markets.set(id, { id, name: marketNames[id] ?? id, n: 0, deduped_eligible: 0, eligible: 0, investor: 0, h: 0, m: 0, l: 0, u: 0, pool_n: 0, counties: new Map(), county_majority_rows: 0 });
    return markets.get(id);
  };
  const majorityOf = (c) => [...c.markets.entries()].filter(([, v]) => v.n > 0).sort((x, y) => y[1].n - x[1].n)[0]?.[0] ?? null;
  let unmarketedAfter = 0;
  const unmarketedCounties = new Map();
  const target = (st, county, market, n) => {
    const c = get(st, county);
    if (market !== "(none)") return market;
    const maj = majorityOf(c);
    if (maj) {
      mk(maj).county_majority_rows += n;
      return maj;
    }
    unmarketedAfter += n;
    unmarketedCounties.set(`${c.county}, ${c.st}`, (unmarketedCounties.get(`${c.county}, ${c.st}`) ?? 0) + n);
    return `(no canonical market) ${c.st}`;
  };
  for (const r of canonical) {
    const [st, county, market, n, eligible, dedupedEligible, investor, h, m, l, u] = r;
    const x = mk(target(st, county, market, n));
    Object.assign(x, { n: x.n + n, eligible: x.eligible + eligible, deduped_eligible: x.deduped_eligible + dedupedEligible, investor: x.investor + investor, h: x.h + h, m: x.m + m, l: x.l + l, u: x.u + u });
    const ck = `${get(st, county).county} ${st}`;
    x.counties.set(ck, (x.counties.get(ck) ?? 0) + n);
  }
  for (const r of pool) {
    const [st, county, market, n, , poolOnlyEligible] = r;
    const x = mk(target(st, county, market, 0));
    x.pool_n += n;
    x.deduped_eligible += poolOnlyEligible;
    const ck = `${get(st, county).county} ${st}`;
    x.counties.set(ck, (x.counties.get(ck) ?? 0) + n);
  }
  const round = (o) => {
    for (const f of ["n", "eligible", "deduped_eligible", "investor", "h", "m", "l", "u", "pool_n"]) o[f] = Math.round(o[f]);
    return o;
  };
  const states = new Map();
  for (const c of counties.values()) {
    const s = states.get(c.st) ?? { st: c.st, counties: 0, n: 0, eligible: 0, deduped_eligible: 0, investor: 0, h: 0, m: 0, l: 0, u: 0, pool_n: 0, pool_usable: 0, fips_n: 0, prop_n: 0, zip_n: 0, unattr_n: 0 };
    s.counties += c.n ? 1 : 0;
    for (const f of ["n", "eligible", "deduped_eligible", "investor", "h", "m", "l", "u", "pool_n", "pool_usable", "fips_n", "prop_n", "zip_n", "unattr_n"]) s[f] += c[f];
    states.set(c.st, s);
  }
  const totals = [...states.values()].reduce((t, s) => {
    for (const f of Object.keys(s)) if (typeof s[f] === "number") t[f] = (t[f] ?? 0) + s[f];
    return t;
  }, {});
  return {
    counties: [...counties.values()].sort((a, b) => b.n + b.pool_n - (a.n + a.pool_n)),
    states: [...states.values()].sort((a, b) => b.n + b.pool_n - (a.n + a.pool_n)),
    markets: [...markets.values()].map(round).sort((a, b) => b.n + b.pool_n - (a.n + a.pool_n)),
    totals,
    unmarketed_after_fallback: unmarketedAfter,
    unmarketed_counties: [...unmarketedCounties.entries()].map(([k, v]) => `${k} (${fmt(v)})`),
  };
}

export function renderCoverageTables(cov) {
  const mix = (o) => `${fmt(o.h)} / ${fmt(o.m)} / ${fmt(o.l)} / ${fmt(o.u)}`;
  const out = [];
  out.push("### Market rollup (canonical market names = `properties.market` / `canonical_markets`)", "");
  out.push("| # | Market | Canonical transactions | Eligible (price > 0) | Deduped eligible (+ pool-only) | Investor-classified | Confidence H / M / L / U (info) | HIGH share | Old 48K pool rows | Counties |");
  out.push("|---|---|---|---|---|---|---|---|---|---|");
  cov.markets.forEach((m, i) => out.push(`| ${i + 1} | ${m.name} | ${fmt(m.n)} | ${fmt(m.eligible)} | ${fmt(m.deduped_eligible)} | ${fmt(m.investor)} | ${mix(m)} | ${pct(m.h, m.n)} | ${fmt(m.pool_n)} | ${[...m.counties.entries()].sort((a, b) => b[1] - a[1]).filter(([, v]) => v >= 50).map(([k]) => k).join("; ")}${[...m.counties.values()].some((v) => v < 50) ? "; + stray <50" : ""} |`));
  out.push("", "### State rollup", "");
  out.push("| State | Counties | Canonical transactions | Eligible (price > 0) | Deduped eligible | Investor-classified | Confidence H / M / L / U (info) | Old 48K pool rows | Geo by fips / property / zip5 / unattributed |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const s of cov.states) out.push(`| ${s.st} | ${s.counties} | ${fmt(s.n)} | ${fmt(s.eligible)} | ${fmt(s.deduped_eligible)} | ${fmt(s.investor)} | ${mix(s)} | ${fmt(s.pool_n)} | ${fmt(s.fips_n)} / ${fmt(s.prop_n)} / ${fmt(s.zip_n)} / ${fmt(s.unattr_n)} |`);
  out.push("", "### All counties, ranked", "");
  out.push("| # | County | State | Market(s) | Canonical transactions | Eligible (price > 0) | Deduped eligible | Investor-classified | Confidence H / M / L / U (info) | Vendor 'Estimated Sales Price' | Old 48K pool rows (usable) |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|");
  cov.counties.forEach((c, i) => {
    const ms = [...c.markets.keys()].join(", ") || "(none)";
    out.push(`| ${i + 1} | ${c.county} | ${c.st} | ${ms}${c.unmarketed ? ` (+${fmt(c.unmarketed)} unmarketed)` : ""} | ${fmt(c.n)} | ${fmt(c.eligible)} | ${fmt(c.deduped_eligible)} | ${fmt(c.investor)} | ${mix(c)} | ${fmt(c.est_code)} | ${fmt(c.pool_n)} (${fmt(c.pool_usable)}) |`);
  });
  return out.join("\n");
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const dir = arg("data");
  const canonical = JSON.parse(fs.readFileSync(path.join(dir, arg("county") ?? "county-coverage-20261002.json"), "utf8")).rows;
  const pool = JSON.parse(fs.readFileSync(path.join(dir, arg("pool") ?? "pool-county-20261002.json"), "utf8")).rows;
  const marketNames = arg("markets") ? JSON.parse(fs.readFileSync(arg("markets"), "utf8")) : {};
  const cov = buildCoverage({ canonical, pool, marketNames });
  if (process.argv.includes("--json")) console.log(JSON.stringify({ totals: cov.totals, unmarketed_after_fallback: cov.unmarketed_after_fallback, unmarketed_counties: cov.unmarketed_counties, markets: cov.markets.map((m) => ({ ...m, counties: Object.fromEntries(m.counties) })) }, null, 1));
  else console.log(renderCoverageTables(cov));
}
