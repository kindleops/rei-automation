#!/usr/bin/env node
/**
 * IC8 comp micro-market challenger: OFFLINE BACKTEST (no network, no writes
 * outside the report directory).
 *
 * Subjects: valid market sales 2025-07-01 .. 2026-09-30 in each market
 * (deterministic hash sample per market when larger than the cap).
 * Comps: strictly earlier evidence (known_date < subject sale date), never
 * any record of the subject property. The micro-market layer for a subject
 * is built as of the first day of its sale month (only earlier sales).
 *
 * Arms (owner/coordinator, 2026-10-01):
 *   (a) champion_pool   production engine on the 48K engine pool (what production searches)
 *   (b) champion_union  production engine on pool + recorded deeds (combined corpus)
 *   (c) challenger      micro-market challenger on the combined corpus
 *   (d) baseline        median PPSF within 1 mi x sqft on the combined corpus
 *   plus (a)/(b) under a pinned engine version when --pinned-engine is given.
 * The champion arms re-implement only the candidate SEARCH; scoring,
 * recency, selection and valuation are the imported production functions.
 *
 * Run from apps/api:
 *   node --no-warnings --loader ./tests/alias-loader.mjs scripts/intelligence/comps/backtest.mjs \
 *     --snapshot=<dir> [--out=<dir>] [--max-subjects-per-market=800] [--regions=MSP,JAX] \
 *     [--pinned-engine=<abs path to an extracted acquisitionDecisionEngine.js> --pinned-label=<label> --pinned-commit=<sha>]
 *   Re-render only (after writing findings): --render-only --out=<dir> --notes=<findings.md>
 *   Sensitivity runs: --subject-from / --subject-to / --challenger-params='{...}' / --layer-params='{...}'
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as productionEngine from '../../../src/lib/acquisition/acquisitionDecisionEngine.js';
import { toSale, subtractMonths, sameProperty } from '../../../src/lib/domain/intelligence/comps/comp-records.js';
import { PointIndex, haversineMiles, makeGrid } from '../../../src/lib/domain/intelligence/comps/geo.js';
import { buildMicroMarketModel, MICRO_MARKET_PARAMS, MICRO_MARKET_VERSION } from '../../../src/lib/domain/intelligence/comps/micro-market.js';
import { MARKET_CONTEXT_PARAMS } from '../../../src/lib/domain/intelligence/comps/market-index.js';
import { valueSubjectChallenger, microMarketTier, CHALLENGER_PARAMS, CHALLENGER_VERSION, layerAsOfFor } from '../../../src/lib/domain/intelligence/comps/challenger.js';
import { valueSubjectChampion, probeEngineWindows, CHAMPION_REPLICA_VERSION } from '../../../src/lib/domain/intelligence/comps/champion-replica.js';
import { valueSubjectBaseline, BASELINE_VERSION } from '../../../src/lib/domain/intelligence/comps/baseline.js';
import { summarize, pitCalibration, pairedApeDifference, priceBand, densityClassFromCount, LOW_SUPPORT_N } from '../../../src/lib/domain/intelligence/comps/backtest-metrics.js';
import { hashString, median, round } from '../../../src/lib/domain/intelligence/comps/stats.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const API_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../../..');
const REPO_ROOT = path.resolve(API_ROOT, '../..');
const ENGINE_PATH = path.join(API_ROOT, 'src/lib/acquisition/acquisitionDecisionEngine.js');
const DEFAULT_OUT = '/Users/ryankindle/.claude/jobs/c39b0175/tmp/ic8/models/comp-micromarket-v0';
const DEFAULT_SUBJECT_WINDOW = ['2025-07-01', '2026-09-30'];
let SUBJECT_WINDOW = DEFAULT_SUBJECT_WINDOW;
let CHALLENGER_RUN_PARAMS = CHALLENGER_PARAMS;
let LAYER_RUN_PARAMS = MICRO_MARKET_PARAMS;
const SUBJECT_FAMILIES = new Set(['sfr', 'mf_2_4']);
const CASE_PROPERTY_ID = '273312064';
const CASE_PRODUCTION = { '2026-09-30': 362500, '2026-10-01': 327900 };
const NORTH_ZIPS = new Set(['55411', '55412', '55430']);
const EAST_BANK_ZIPS = new Set(['55418', '55413', '55414']);
const CODE_FILES = [
  'apps/api/scripts/intelligence/comps/backtest.mjs',
  'apps/api/scripts/intelligence/comps/build-comp-snapshot.mjs',
  'apps/api/scripts/intelligence/comps/build-north-minneapolis-fixture.mjs',
  'apps/api/src/lib/domain/intelligence/comps/backtest-metrics.js',
  'apps/api/src/lib/domain/intelligence/comps/baseline.js',
  'apps/api/src/lib/domain/intelligence/comps/challenger.js',
  'apps/api/src/lib/domain/intelligence/comps/champion-replica.js',
  'apps/api/src/lib/domain/intelligence/comps/comp-records.js',
  'apps/api/src/lib/domain/intelligence/comps/geo.js',
  'apps/api/src/lib/domain/intelligence/comps/market-index.js',
  'apps/api/src/lib/domain/intelligence/comps/micro-market.js',
  'apps/api/src/lib/domain/intelligence/comps/reason-codes.js',
  'apps/api/src/lib/domain/intelligence/comps/stats.js',
];

function parseArgs(argv) {
  const args = {};
  for (const token of argv.slice(2)) {
    const match = token.match(/^--([a-z0-9-]+)(?:=(.*))?$/i);
    if (match) args[match[1]] = match[2] ?? 'true';
  }
  return args;
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function codeIdentity() {
  const files = {};
  for (const rel of CODE_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const status = git(['status', '--porcelain', '--', rel]);
    files[rel] = { sha256: sha256File(abs), git_status: status ? status.slice(0, 2).trim() : 'clean' };
  }
  return { commit: git(['rev-parse', 'HEAD']), dirty: Object.values(files).some((f) => f.git_status !== 'clean'), files };
}

function engineIdentity(enginePath, label, pinnedCommit = null) {
  const rel = path.relative(REPO_ROOT, enginePath);
  const insideRepo = !rel.startsWith('..');
  return {
    label,
    path: insideRepo ? rel : pinnedCommit ? `git:${pinnedCommit}:apps/api/src/lib/acquisition/acquisitionDecisionEngine.js (extracted copy)` : enginePath,
    sha256: sha256File(enginePath),
    last_commit: insideRepo ? git(['log', '-1', '--format=%H %cI %s', '--', rel]) : null,
    working_tree_status: insideRepo ? (git(['status', '--porcelain', '--', rel]) || 'clean') : pinnedCommit ? `pinned_commit_${pinnedCommit}` : 'external_extract',
  };
}

function loadRegion(snapshotDir, file) {
  return zlib.gunzipSync(fs.readFileSync(path.join(snapshotDir, file.name))).toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function weightShare(selected, predicate) {
  const total = selected.reduce((s, c) => s + (c.weight ?? 0), 0);
  if (!total) return null;
  return selected.filter(predicate).reduce((s, c) => s + (c.weight ?? 0), 0) / total;
}

/** Geography of a champion selection, read through the challenger's as-of layer. */
function championGeography(selected, subject, layer, dist, assignment) {
  if (!selected.length) return { other_zip_w: null, cross_barrier_w: null, median_dist_mi: null };
  const tiers = new Map();
  for (const c of selected) {
    if (!Number.isFinite(c.lat)) continue;
    const rel = dist.to(c.lat, c.lng);
    tiers.set(c.id, microMarketTier(assignment.micro_market_id, rel, layer, CHALLENGER_RUN_PARAMS).tier);
  }
  return {
    other_zip_w: round(weightShare(selected, (c) => c.zip !== subject.zip), 3),
    cross_barrier_w: round(weightShare(selected, (c) => tiers.get(c.id) === 'T4'), 3),
    median_dist_mi: round(median(selected.map((c) => c.distance_miles).filter(Number.isFinite)), 2),
  };
}

/**
 * Transaction density as of 2026-10-01: valid single-family sales in the prior
 * 12 months per occupied ~1 km cell and per ZIP, with and without the
 * 2026-09-30 comp_canonical_transactions import.
 */
function densityProfile(unionSales, refLat) {
  const asOf = '2026-10-01';
  const start = subtractMonths(asOf, 12);
  const grid = makeGrid({ refLat, cellKm: 1 });
  const profile = (list) => {
    const cells = new Map();
    const zips = new Map();
    for (const s of list) {
      const key = grid.cellOf(s.lat, s.lng).key;
      cells.set(key, (cells.get(key) ?? 0) + 1);
      if (s.zip) zips.set(s.zip, (zips.get(s.zip) ?? 0) + 1);
    }
    const counts = [...cells.values()];
    const inCells = (k) => counts.filter((c) => c >= k).reduce((a, c) => a + c, 0) / Math.max(list.length, 1);
    return {
      sales: list.length,
      occupied_cells: counts.length,
      per_cell_median: median(counts),
      per_cell_p75: quantileOf(counts, 0.75),
      per_cell_p90: quantileOf(counts, 0.9),
      share_sales_in_cells_ge5_pct: round(100 * inCells(5), 1),
      share_sales_in_cells_ge10_pct: round(100 * inCells(10), 1),
      zips: zips.size,
      zips_ge20: [...zips.values()].filter((c) => c >= 20).length,
    };
  };
  const base = unionSales.filter((s) => s.valid && s.family === 'sfr' && s.sqft && s.known_date < asOf && s.sale_date >= start && Number.isFinite(s.lat));
  return {
    window: `${start}..${asOf}`,
    all: profile(base),
    without_2026_09_30_import: profile(base.filter((s) => s.raw.ingested_at !== '2026-09-30')),
    by_market: Object.fromEntries([...new Set(base.map((s) => s.market ?? '(buffer)'))].sort().map((m) => [m, profile(base.filter((s) => (s.market ?? '(buffer)') === m))])),
  };
}

function compactChampion(r, geo) {
  return { v: r.value, lo: r.low, hi: r.high, conf: r.confidence, n: r.selected.length, cands: r.raw_candidate_count, method: r.method, ...geo };
}

function compactChallenger(ch) {
  const h = ch.headline;
  const v = ch.values;
  const pick = (x) => (x ? { v: x.value, p80: x.intervals.p80, p50: x.intervals.p50, lc: x.log_center, sg: x.sigma_pred, n: x.n_comps, sup: x.support, xb: x.cross_discontinuity_weight_share } : null);
  return {
    v: h?.value ?? null,
    basis: h?.basis ?? null,
    sup: h?.support ?? null,
    p50: h?.p50 ?? null,
    p80: h?.p80 ?? null,
    lc: h ? v[h.basis].log_center : null,
    sg: h ? v[h.basis].sigma_pred : null,
    n: h?.n_comps ?? 0,
    xb: h ? v[h.basis].cross_discontinuity_weight_share : null,
    tiers: h ? v[h.basis].tier_weight_share : null,
    rad: ch.adaptive_radius?.radius_mi ?? null,
    dc: ch.adaptive_radius?.density_class ?? null,
    assign: ch.subject_assignment ? `${ch.subject_assignment.tier}:${ch.subject_assignment.confidence}` : null,
    retail: pick(v.retail),
    investor: pick(v.investor),
    unknown: pick(v.unknown_regime),
  };
}

function densityCount(subject, candidates, asOf) {
  const start = subtractMonths(asOf, 12);
  let n = 0;
  for (const c of candidates) {
    if (!(c.known_date < asOf) || c.sale_date < start || !c.valid || c.dedup_role === 'loser' || c.family !== subject.family) continue;
    if (sameProperty(subject, c) || c.id === subject.id) continue;
    if (haversineMiles(subject.lat, subject.lng, c.lat, c.lng) <= 1) n += 1;
  }
  return n;
}

function quantileOf(values, q) {
  const sorted = values.slice().sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function fmt(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  return Math.abs(n) >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : String(n);
}

function pct(x) {
  return x === null || x === undefined || !Number.isFinite(x) ? '-' : `${x}%`;
}

function table(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args['render-only']) {
    // Re-render report.md from a finished run (e.g. after writing --notes).
    const outDir = args.out ?? DEFAULT_OUT;
    const results = JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    const engines = results.engines.map((identity, i) => ({ identity, label: identity.label, key: i === 0 ? '' : `@${identity.label}` }));
    const notes = args.notes && fs.existsSync(args.notes) ? fs.readFileSync(args.notes, 'utf8') : null;
    fs.writeFileSync(path.join(outDir, 'report.md'), renderReport({ results, manifest, engines, notes }));
    fs.writeFileSync(path.join(outDir, 'model-card.md'), renderModelCard({ results, manifest }));
    process.stdout.write(`re-rendered ${path.join(outDir, 'report.md')}\n`);
    return;
  }
  if (!args.snapshot) throw new Error('--snapshot=<dir> required');
  const snapshotDir = args.snapshot;
  const outDir = args.out ?? DEFAULT_OUT;
  const cap = Number(args['max-subjects-per-market'] ?? 800);
  SUBJECT_WINDOW = [args['subject-from'] ?? DEFAULT_SUBJECT_WINDOW[0], args['subject-to'] ?? DEFAULT_SUBJECT_WINDOW[1]];
  CHALLENGER_RUN_PARAMS = Object.freeze({ ...CHALLENGER_PARAMS, ...(args['challenger-params'] ? JSON.parse(args['challenger-params']) : {}) });
  LAYER_RUN_PARAMS = Object.freeze({ ...MICRO_MARKET_PARAMS, ...(args['layer-params'] ? JSON.parse(args['layer-params']) : {}) });
  const seed = args.seed ?? 'ic8-comp-v0';
  fs.mkdirSync(outDir, { recursive: true });
  const manifestIn = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'manifest.json'), 'utf8'));

  const engines = [{ key: '', label: 'current', module: productionEngine, identity: engineIdentity(ENGINE_PATH, 'current') }];
  if (args['pinned-engine']) {
    const pinnedPath = path.resolve(args['pinned-engine']);
    const label = args['pinned-label'] ?? 'pinned';
    engines.push({ key: `@${label}`, label, module: await import(pathToFileURL(pinnedPath).href), identity: engineIdentity(pinnedPath, label, args['pinned-commit'] ?? null) });
  }
  for (const e of engines) e.windows = probeEngineWindows(e.module);
  const started = Date.now();
  const rows = [];
  const layerSummaries = {};
  const densityByRegion = {};
  const sampling = {};
  let caseRegion = null;

  const regionFilter = args.regions ? new Set(args.regions.split(',')) : null;
  for (const file of manifestIn.files) {
    if (regionFilter && !regionFilter.has(file.region)) continue;
    const records = loadRegion(snapshotDir, file);
    const sales = records.map(toSale);
    const refLat = median(sales.map((s) => s.lat).filter(Number.isFinite));
    const unionSales = sales.filter((s) => s.dedup_role !== 'loser');
    const unionRecords = records.filter((r) => r.dedup?.role !== 'loser');
    const poolRecords = records.filter((r) => r.src === 'pool');
    const idxUnionSales = new PointIndex(unionSales, { refLat, bucketKm: 2 });
    const idxUnionRecords = new PointIndex(unionRecords, { refLat, bucketKm: 2 });
    const idxPoolRecords = new PointIndex(poolRecords, { refLat, bucketKm: 2 });
    const layers = new Map();
    const layerFor = (asOf) => {
      if (!layers.has(asOf)) layers.set(asOf, buildMicroMarketModel(unionSales, { asOf, refLat, params: LAYER_RUN_PARAMS }));
      return layers.get(asOf);
    };
    densityByRegion[file.region] = densityProfile(unionSales, refLat);
    if (file.region === 'MSP') caseRegion = { records, unionSales, unionRecords, poolRecords, idxUnionSales, idxUnionRecords, idxPoolRecords, layerFor, refLat };

    const eligible = unionSales.filter((s) =>
      s.market && s.sale_date >= SUBJECT_WINDOW[0] && s.sale_date <= SUBJECT_WINDOW[1] && s.valid && SUBJECT_FAMILIES.has(s.family) && s.sqft && Number.isFinite(s.lat));
    const byMarket = new Map();
    for (const s of eligible) {
      if (!byMarket.has(s.market)) byMarket.set(s.market, []);
      byMarket.get(s.market).push(s);
    }
    const subjects = [];
    for (const [market, list] of [...byMarket.entries()].sort()) {
      const ordered = list.slice().sort((a, b) => hashString(`${seed}|${a.id}`) - hashString(`${seed}|${b.id}`) || (a.id < b.id ? -1 : 1));
      const chosen = ordered.slice(0, cap);
      sampling[market] = { eligible: list.length, sampled: chosen.length, sampling_rate: round(chosen.length / list.length, 3) };
      subjects.push(...chosen);
    }
    subjects.sort((a, b) => (a.sale_date < b.sale_date ? -1 : a.sale_date > b.sale_date ? 1 : a.id < b.id ? -1 : 1));
    process.stdout.write(`${file.region}: ${records.length} records, ${subjects.length} subjects\n`);

    for (const [i, s] of subjects.entries()) {
      const T = s.sale_date;
      const layer = layerFor(layerAsOfFor(T));
      const rec = s.raw;
      const maxWindow = Math.max(...engines.map((e) => e.windows.multifamily.radius_miles ?? 7)) + 0.1;
      const nearPool = idxPoolRecords.queryMiles(s.lat, s.lng, maxWindow).map((x) => x.item);
      const nearUnion = idxUnionRecords.queryMiles(s.lat, s.lng, maxWindow).map((x) => x.item);
      const candidates = idxUnionSales.queryMiles(s.lat, s.lng, CHALLENGER_PARAMS.maxRadiusMiles).map((x) => x.item);
      const ch = valueSubjectChallenger({ subject: s, asOf: T, candidates, model: layer, params: CHALLENGER_RUN_PARAMS });
      const dist = layer.distancesFrom(s.lat, s.lng);
      const assignment = ch.subject_assignment ?? layer.assign(s.lat, s.lng, s.zip);
      const champion = {};
      for (const e of engines) {
        const cp = valueSubjectChampion({ subjectRecord: rec, asOf: T, records: nearPool, windows: e.windows, engine: e.module });
        const cu = valueSubjectChampion({ subjectRecord: rec, asOf: T, records: nearUnion, windows: e.windows, engine: e.module });
        champion[`champion_pool${e.key}`] = compactChampion(cp, championGeography(cp.selected, s, layer, dist, assignment));
        champion[`champion_union${e.key}`] = compactChampion(cu, championGeography(cu.selected, s, layer, dist, assignment));
      }
      // Exploratory arm (e): the production engine on the combined corpus with
      // candidates across a learned discontinuity removed from its search.
      const guarded = nearUnion.filter((r) => microMarketTier(assignment.micro_market_id, dist.to(r.lat, r.lng), layer, CHALLENGER_RUN_PARAMS).tier !== 'T4');
      const cg = valueSubjectChampion({ subjectRecord: rec, asOf: T, records: guarded, windows: engines[0].windows, engine: engines[0].module });
      champion.champion_union_guarded = compactChampion(cg, championGeography(cg.selected, s, layer, dist, assignment));
      const base = valueSubjectBaseline({ subject: s, asOf: T, candidates });
      rows.push({
        id: s.id,
        market: s.market,
        region: file.region,
        family: s.family,
        regime: s.regime,
        sale_type: s.sale_type,
        src: s.src,
        batch: s.src === 'deeds' ? rec.ingested_at : 'engine_pool',
        label: s.price,
        zip: s.zip,
        lat2: round(s.lat, 2),
        lng2: round(s.lng, 2),
        date: T,
        month: T.slice(0, 7),
        density: densityCount(s, candidates, T),
        arms: { ...champion, challenger: compactChallenger(ch), baseline: { v: base.value, p80: base.p80 ?? null, n: base.n } },
      });
      if ((i + 1) % 200 === 0) process.stdout.write(`  ${file.region}: ${i + 1}/${subjects.length} (${Math.round((Date.now() - started) / 1000)}s)\n`);
    }
    layerSummaries[file.region] = [...layers.values()].sort((a, b) => (a.asOf < b.asOf ? -1 : 1)).map((l) => ({ ...l.summary, index: undefined }));
  }

  // ---- North Minneapolis case study (as of 2026-09-30 / 2026-10-01) ----
  const caseStudy = runCaseStudy({ snapshotDir, region: caseRegion, engines });

  // ---- online split-conformal calibration of the challenger interval ----
  // Per market, in sale-date order: the multiplier for a subject sold on D is
  // the 80th percentile of |log error| / sigma over subjects sold strictly
  // before D (>= 30 needed), so no label at or after D is ever used.
  const conformal = {};
  for (const market of [...new Set(rows.map((r) => r.market))].sort()) {
    const list = rows.filter((r) => r.market === market).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
    const prior = [];
    let calibrated = 0;
    for (let i = 0; i < list.length;) {
      let j = i;
      while (j < list.length && list[j].date === list[i].date) j += 1;
      const kappa = prior.length >= 30 ? quantileOf(prior, 0.8) / 1.2816 : null;
      for (let k = i; k < j; k += 1) {
        const c = list[k].arms.challenger;
        if (c.v && kappa) {
          c.kappa = round(kappa, 3);
          c.p80c = [Math.round(Math.exp(c.lc - 1.2816 * kappa * c.sg)), Math.round(Math.exp(c.lc + 1.2816 * kappa * c.sg))];
          calibrated += 1;
        }
      }
      for (let k = i; k < j; k += 1) {
        const c = list[k].arms.challenger;
        if (c.v && c.sg > 0) prior.push(Math.abs(Math.log(list[k].label) - c.lc) / c.sg);
      }
      i = j;
    }
    conformal[market] = { calibrated_subjects: calibrated, final_kappa: prior.length >= 30 ? round(quantileOf(prior, 0.8) / 1.2816, 3) : null, residuals: prior.length };
  }

  // ---- metrics ----
  const armNames = ['champion_pool', 'champion_union', 'champion_union_guarded', 'challenger', 'challenger_regime', 'challenger_conformal', 'baseline', ...engines.slice(1).flatMap((e) => [`champion_pool${e.key}`, `champion_union${e.key}`])];
  const regimeKey = (row) => (row.regime === 'retail' ? 'retail' : row.regime === 'investor' ? 'investor' : 'unknown');
  const point = (row, arm) => {
    if (arm === 'challenger_regime') {
      const pick = row.arms.challenger[regimeKey(row)];
      return pick?.v ? { label: row.label, value: pick.v, interval: pick.p80, interval50: pick.p50 } : null;
    }
    if (arm === 'challenger_conformal') {
      const c = row.arms.challenger;
      return c.v && c.p80c ? { label: row.label, value: c.v, interval: c.p80c } : null;
    }
    const a = row.arms[arm];
    if (!a || a.v === null || a.v === undefined) return null;
    if (arm === 'challenger') return { label: row.label, value: a.v, interval: a.p80, interval50: a.p50 };
    if (arm === 'baseline') return { label: row.label, value: a.v, interval: a.p80 };
    return { label: row.label, value: a.v, interval: [a.lo, a.hi] };
  };
  const markets = [...new Set(rows.map((r) => r.market))].sort();
  const marketSummary = {};
  for (const market of [...markets, 'ALL']) {
    const subset = market === 'ALL' ? rows : rows.filter((r) => r.market === market);
    const core = subset.filter((r) => ['champion_union', 'challenger', 'baseline'].every((a) => point(r, a)));
    const poolCore = subset.filter((r) => ['champion_pool', 'champion_union', 'challenger', 'baseline'].every((a) => point(r, a)));
    const entry = { subjects: subset.length, coverage_pct: {}, own_support: {}, core_n: core.length, core: {}, pool_core_n: poolCore.length, pool_core: {}, paired: {} };
    for (const arm of armNames) {
      const pts = subset.map((r) => point(r, arm)).filter(Boolean);
      entry.coverage_pct[arm] = round((100 * pts.length) / Math.max(subset.length, 1), 1);
      entry.own_support[arm] = summarize(pts);
      entry.core[arm] = summarize(core.map((r) => point(r, arm)).filter(Boolean));
      entry.pool_core[arm] = summarize(poolCore.map((r) => point(r, arm)).filter(Boolean));
    }
    const pair = (a, b, set) => pairedApeDifference(set.map((r) => ({ label: r.label, a: r.arms[a]?.v, b: r.arms[b]?.v })), { seed: hashString(`${market}|${a}|${b}`) });
    entry.paired.challenger_vs_champion_union = pair('challenger', 'champion_union', core);
    const regimeCore = core.filter((r) => point(r, 'challenger_regime'));
    entry.paired.challenger_regime_vs_champion_union = pairedApeDifference(regimeCore.map((r) => ({ label: r.label, a: point(r, 'challenger_regime').value, b: r.arms.champion_union.v })), { seed: hashString(`${market}|regime`) });
    const retailCore = core.filter((r) => r.regime === 'retail');
    entry.retail_core_n = retailCore.length;
    entry.retail_core = Object.fromEntries(['champion_pool', 'champion_union', 'challenger', 'baseline'].map((a) => [a, summarize(retailCore.map((r) => point(r, a)).filter(Boolean))]));
    entry.paired.retail_challenger_vs_champion_union = pair('challenger', 'champion_union', retailCore);
    entry.paired.challenger_vs_baseline = pair('challenger', 'baseline', core);
    entry.paired.guarded_vs_champion_union = pair('champion_union_guarded', 'champion_union', core.filter((r) => point(r, 'champion_union_guarded')));
    entry.paired.champion_union_vs_champion_pool = pair('champion_union', 'champion_pool', poolCore);
    entry.paired.challenger_vs_champion_pool = pair('challenger', 'champion_pool', poolCore);
    for (const e of engines.slice(1)) {
      entry.paired[`champion_pool_current_vs_champion_pool${e.key}`] = pair('champion_pool', `champion_pool${e.key}`, subset.filter((r) => point(r, 'champion_pool') && point(r, `champion_pool${e.key}`)));
      entry.paired[`challenger_vs_champion_union${e.key}`] = pair('challenger', `champion_union${e.key}`, subset.filter((r) => point(r, 'challenger') && point(r, `champion_union${e.key}`)));
    }
    entry.challenger_calibration = pitCalibration(subset.filter((r) => r.arms.challenger.v).map((r) => ({ label: r.label, logCenter: r.arms.challenger.lc, sigma: r.arms.challenger.sg })));
    marketSummary[market] = entry;
  }

  // slices on the like-for-like core (champion_union / challenger / baseline all valued)
  const coreRows = rows.filter((r) => ['champion_union', 'challenger', 'baseline'].every((a) => point(r, a)));
  const sliceDefs = {
    family: (r) => r.family,
    price_band: (r) => priceBand(r.label),
    density_1mi_12m: (r) => densityClassFromCount(r.density),
    subject_regime: (r) => r.regime,
    subject_corpus_batch: (r) => r.batch,
    champion_union_cross_barrier_weight: (r) => {
      const x = r.arms.champion_union.cross_barrier_w;
      return x === null ? 'n/a' : x >= 0.25 ? '>=25%' : x > 0 ? '1-24%' : '0%';
    },
  };
  const slices = {};
  for (const [name, fn] of Object.entries(sliceDefs)) {
    const groups = new Map();
    for (const r of coreRows) {
      const key = String(fn(r));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    slices[name] = Object.fromEntries([...groups.entries()].sort().map(([key, list]) => [key, Object.fromEntries(['champion_union', 'challenger', 'baseline'].map((a) => [a, summarize(list.map((r) => point(r, a)))]))]));
  }
  // market x slice for the two most decision-relevant slices
  const marketRegime = {};
  for (const market of markets) {
    const list = coreRows.filter((r) => r.market === market);
    marketRegime[market] = {};
    for (const regime of ['retail', 'investor', 'unknown']) {
      const g = list.filter((r) => r.regime === regime);
      if (g.length) marketRegime[market][regime] = Object.fromEntries(['champion_union', 'challenger', 'baseline'].map((a) => [a, summarize(g.map((r) => point(r, a)))]));
    }
  }
  // regime-matched challenger values (retail value on retail subjects, investor value on investor subjects)
  const regimeMatched = {};
  for (const market of [...markets, 'ALL']) {
    const subset = market === 'ALL' ? rows : rows.filter((r) => r.market === market);
    regimeMatched[market] = {};
    for (const [regime, key] of [['retail', 'retail'], ['investor', 'investor'], ['unknown', 'unknown']]) {
      const g = subset.filter((r) => r.regime === regime);
      if (!g.length) continue;
      regimeMatched[market][regime] = {
        subjects: g.length,
        challenger_regime_value: summarize(g.filter((r) => r.arms.challenger[key]).map((r) => ({ label: r.label, value: r.arms.challenger[key].v, interval: r.arms.challenger[key].p80 }))),
        champion_union: summarize(g.map((r) => point(r, 'champion_union')).filter(Boolean)),
      };
    }
  }
  // largest misses (core set)
  const misses = {};
  for (const arm of ['challenger', 'champion_union']) {
    misses[arm] = coreRows
      .map((r) => ({ r, ape: Math.abs(r.arms[arm].v - r.label) / r.label }))
      .sort((a, b) => b.ape - a.ape)
      .slice(0, 12)
      .map(({ r, ape }) => ({
        market: r.market, zip: r.zip, at: `${r.lat2},${r.lng2}`, month: r.month, family: r.family, regime: r.regime, sale_type: r.sale_type,
        label: r.label, prediction: r.arms[arm].v, ape_pct: round(100 * ape, 1), other_arm: arm === 'challenger' ? r.arms.champion_union.v : r.arms.challenger.v,
        geography: arm === 'challenger'
          ? { basis: r.arms.challenger.basis, support: r.arms.challenger.sup, n: r.arms.challenger.n, radius_mi: r.arms.challenger.rad, density: r.arms.challenger.dc, tiers: r.arms.challenger.tiers, assignment: r.arms.challenger.assign }
          : { n: r.arms.champion_union.n, other_zip_w: r.arms.champion_union.other_zip_w, cross_barrier_w: r.arms.champion_union.cross_barrier_w, median_dist_mi: r.arms.champion_union.median_dist_mi },
      }));
  }

  const runtimeSec = Math.round((Date.now() - started) / 1000);
  const code = codeIdentity();
  const results = { rows: rows.length, runtime_sec: runtimeSec, sampling, conformal, density: densityByRegion, marketSummary, slices, marketRegime, regimeMatched, misses, caseStudy, layerSummaries, engines: engines.map((e) => ({ ...e.identity, windows: e.windows })) };
  fs.writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify(results, null, 1)}\n`);
  writeSubjectsFile(outDir, rows);
  const manifest = buildManifest({ manifestIn, snapshotDir, code, engines, sampling, marketSummary, cap, seed, runtimeSec, rows: rows.length });
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const notes = args.notes && fs.existsSync(args.notes) ? fs.readFileSync(args.notes, 'utf8') : null;
  fs.writeFileSync(path.join(outDir, 'report.md'), renderReport({ results, manifest, engines, notes }));
  fs.writeFileSync(path.join(outDir, 'model-card.md'), renderModelCard({ results, manifest }));
  process.stdout.write(`done in ${runtimeSec}s -> ${outDir}\n`);
}

function writeSubjectsFile(outDir, rows) {
  const gz = zlib.gzipSync(rows.map((r) => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(path.join(outDir, 'subjects.ndjson.gz'), gz);
}

function runCaseStudy({ snapshotDir, region, engines }) {
  const file = path.join(snapshotDir, `case-subject-${CASE_PROPERTY_ID}.json`);
  if (!region || !fs.existsSync(file)) return { available: false };
  const f = JSON.parse(fs.readFileSync(file, 'utf8')).features;
  const eng = {};
  for (const k of ['building_condition', 'building_quality', 'construction_type', 'exterior_walls', 'interior_walls', 'floor_cover', 'roof_cover', 'roof_type', 'basement', 'garage', 'pool', 'porch', 'patio', 'deck', 'driveway', 'stories', 'style', 'air_conditioning', 'heating_type', 'heating_fuel_type', 'sewer', 'water', 'subdivision_name', 'school_district_name', 'zoning', 'flood_zone', 'property_class', 'sum_garage_sqft']) {
    if (f[k] !== null && f[k] !== undefined && f[k] !== '') eng[k] = f[k];
  }
  const record = {
    id: 'case:subject', src: 'subject', pid: CASE_PROPERTY_ID, lat: Number(f.latitude), lng: Number(f.longitude), zip: String(f.property_address_zip).slice(0, 5),
    state: f.property_address_state, property_type: f.property_type, nac: null, units: f.units_count, sqft: f.building_square_feet, beds: f.total_bedrooms,
    baths: f.total_baths, year_built: f.year_built, eff_year_built: f.effective_year_built, lot_sqft: f.lot_square_feet, eng, est_repairs: f.estimated_repair_cost ?? null,
    sale_date: null, known_date: null, price: null, sale_type: null, buyer_type: 'unknown', unit_designator: false,
  };
  const subject = { ...toSale({ ...record, sale_date: '2026-10-01', known_date: '2026-10-01' }), valid: true };
  const share = (sel, set) => round(weightShare(sel, (c) => set.has(c.zip)), 3);
  const out = { available: true, property_id: CASE_PROPERTY_ID, production_stored: CASE_PRODUCTION, arms: {} };
  const nearPool = region.idxPoolRecords.queryMiles(record.lat, record.lng, 7.2).map((x) => x.item);
  const nearUnion = region.idxUnionRecords.queryMiles(record.lat, record.lng, 7.2).map((x) => x.item);
  for (const asOf of ['2026-09-30', '2026-10-01']) {
    for (const e of engines) {
      for (const [arm, recs, fidelity] of [['champion_pool', nearPool, false], ['champion_pool_fidelity', nearPool, true], ['champion_union', nearUnion, false]]) {
        const r = valueSubjectChampion({ subjectRecord: record, asOf, records: recs, windows: e.windows, engine: e.module, fidelity });
        out.arms[`${arm}${e.key} @ ${asOf}`] = {
          value: r.value, low: r.low, high: r.high, confidence: r.confidence, selected: r.selected.length,
          east_bank_weight: share(r.selected, EAST_BANK_ZIPS), non_north_weight: round(1 - (weightShare(r.selected, (c) => NORTH_ZIPS.has(c.zip)) ?? 0), 3),
          rejected: r.rejected_by_reason, outlier: r.outlier_method,
        };
      }
    }
  }
  const layer = region.layerFor('2026-10-01');
  const candidates = region.idxUnionSales.queryMiles(record.lat, record.lng, CHALLENGER_PARAMS.maxRadiusMiles).map((x) => x.item);
  {
    const assignment = layer.assign(record.lat, record.lng, record.zip);
    const dist = layer.distancesFrom(record.lat, record.lng);
    const guarded = nearUnion.filter((r) => microMarketTier(assignment.micro_market_id, dist.to(r.lat, r.lng), layer, CHALLENGER_RUN_PARAMS).tier !== 'T4');
    const r = valueSubjectChampion({ subjectRecord: record, asOf: '2026-10-01', records: guarded, windows: engines[0].windows, engine: engines[0].module });
    out.arms['champion_union_guarded @ 2026-10-01'] = {
      value: r.value, low: r.low, high: r.high, confidence: r.confidence, selected: r.selected.length,
      east_bank_weight: share(r.selected, EAST_BANK_ZIPS), non_north_weight: round(1 - (weightShare(r.selected, (c) => NORTH_ZIPS.has(c.zip)) ?? 0), 3),
      rejected: r.rejected_by_reason, outlier: r.outlier_method,
    };
  }
  const ch = valueSubjectChallenger({ subject, asOf: '2026-10-01', candidates, model: layer, params: CHALLENGER_RUN_PARAMS });
  const forced = valueSubjectChallenger({ subject, asOf: '2026-10-01', candidates, model: layer, params: { ...CHALLENGER_RUN_PARAMS, radiusLadderMiles: [4], maxRadiusMiles: 4, radiusExtension: 1 } });
  const summarizeChallenger = (res) => {
    const codes = {};
    for (const c of res.comps) {
      const key = c.reasons[0]?.code;
      codes[key] = (codes[key] ?? 0) + 1;
    }
    const eastEligible = res.comps.filter((c) => EAST_BANK_ZIPS.has(c.zip) && c.tier);
    const eastCodes = {};
    for (const c of eastEligible) eastCodes[c.reasons[0].code] = (eastCodes[c.reasons[0].code] ?? 0) + 1;
    const inc = res.comps.filter((c) => c.included);
    return {
      headline: res.headline,
      values: Object.fromEntries(Object.entries(res.values).map(([k, v]) => [k, v ? { value: v.value, p80: v.intervals.p80, p50: v.intervals.p50, n: v.n_comps, support: v.support, tiers: v.tier_weight_share } : null])),
      assignment: res.subject_assignment,
      adaptive_radius: res.adaptive_radius,
      first_reason_counts: codes,
      east_bank_in_search_first_reason: eastCodes,
      included_east_bank_weight: round(inc.filter((c) => EAST_BANK_ZIPS.has(c.zip)).reduce((s, c) => s + c.weight, 0) / Math.max(inc.reduce((s, c) => s + c.weight, 0), 1e-9), 3),
      included_zips: [...new Set(inc.map((c) => c.zip))].sort(),
    };
  };
  out.challenger = summarizeChallenger(ch);
  out.challenger_forced_4mi = summarizeChallenger(forced);
  out.baseline = valueSubjectBaseline({ subject, asOf: '2026-10-01', candidates });
  out.layer = { ...layer.summary, index: undefined };
  return out;
}

function buildManifest({ manifestIn, snapshotDir, code, engines, sampling, marketSummary, cap, seed, runtimeSec, rows }) {
  const metric = (m, arm) => {
    const s = marketSummary[m]?.core?.[arm];
    return s?.n ? { n: s.n, mae: s.mae, mdae: s.mdae, mape_pct: s.mape_pct, mdape_pct: s.mdape_pct, within_10_pct: s.within_10_pct, interval_coverage_pct: s.interval_coverage_pct ?? null } : { n: 0 };
  };
  const markets = Object.keys(marketSummary);
  return {
    model_family: 'comp_micromarket',
    version: CHALLENGER_VERSION,
    status: 'BACKTEST',
    layer_version: MICRO_MARKET_VERSION,
    created_at: new Date().toISOString(),
    dataset: {
      snapshot_id: manifestIn.snapshot_id,
      uri: snapshotDir,
      spec_sha256: manifestIn.spec_sha256,
      files: manifestIn.files.map((f) => ({ name: f.name, rows: f.rows, sha256: f.sha256 })),
      sha256: crypto.createHash('sha256').update(manifestIn.files.map((f) => f.sha256).join('|')).digest('hex'),
    },
    feature_set_version: 'comp-mm-features-v0: lat/lng 1km grid cell, sale_date/known_date, price, sqft, beds, baths, year_built, units, asset family, unit designator, sale validity flags, sale regime (MLS / buyer-type category), ZIP (pooling only). No person, demographic or name features.',
    as_of_window: {
      subjects: SUBJECT_WINDOW,
      comps: 'known_date < subject sale date; never any record of the subject property',
      layer: 'micro-market layer built as of the first day of the subject sale month',
      knowledge_time_caveat: manifestIn.as_of_caveat,
    },
    code,
    champion: {
      replica: CHAMPION_REPLICA_VERSION,
      engines: engines.map((e) => ({ ...e.identity, windows_probed: e.windows })),
      note: 'Only the RPC candidate search is re-implemented (with an as-of bound); scoring/recency/valuation are the imported production functions. Vendor estimated_value is used only as the engine\'s comp-side nominal check; subject estimated_value / estimated_repair_cost are withheld (not point-in-time).',
    },
    params: {
      challenger: CHALLENGER_RUN_PARAMS,
      micro_market: LAYER_RUN_PARAMS,
      market_context: MARKET_CONTEXT_PARAMS,
      baseline: { version: BASELINE_VERSION, radius_miles: 1, months_back: 12, min_comps: 3 },
      sampling: { cap_per_market: cap, seed, method: 'lowest FNV-1a hash of seed|record id', per_market: sampling },
      low_support_n: LOW_SUPPORT_N,
    },
    metrics: Object.fromEntries(markets.map((m) => [m, metric(m, 'challenger')])),
    baseline_metrics: Object.fromEntries(markets.map((m) => [m, {
      champion_union: metric(m, 'champion_union'),
      champion_pool_on_pool_core: (() => { const s = marketSummary[m]?.pool_core?.champion_pool; return s?.n ? { n: s.n, mdape_pct: s.mdape_pct, mape_pct: s.mape_pct } : { n: 0 }; })(),
      naive_median_ppsf_1mi: metric(m, 'baseline'),
    }])),
    runtime_sec: runtimeSec,
    subjects: rows,
  };
}

function renderReport({ results, manifest, engines, notes = null }) {
  const ms = results.marketSummary;
  const markets = Object.keys(ms).filter((m) => m !== 'ALL');
  const lines = [];
  const pinned = engines.slice(1);
  lines.push('# IC8 comp micro-market challenger v0: backtest report');
  lines.push('');
  lines.push(`Status: **BACKTEST (offline research prototype)**. Created ${manifest.created_at}. The production engine stays CHAMPION; nothing here is wired to production.`);
  lines.push('');
  lines.push(`Dataset: \`${manifest.dataset.snapshot_id}\` (${manifest.dataset.files.map((f) => `${f.name} ${f.rows}`).join(', ')}). Code commit ${manifest.code.commit}${manifest.code.dirty ? ' (+ uncommitted IC8 files; hashes in manifest)' : ''}.`);
  lines.push(`Champion engine: \`${engines[0].identity.path}\` sha256 ${engines[0].identity.sha256.slice(0, 12)}, last commit ${engines[0].identity.last_commit ?? 'n/a'} (${engines[0].identity.working_tree_status}).${pinned.length ? ` Pinned: ${pinned.map((e) => `${e.label} sha256 ${e.identity.sha256.slice(0, 12)}`).join('; ')}.` : ''}`);
  lines.push('');
  if (notes) {
    lines.push(notes.trim());
    lines.push('');
  }
  lines.push('## 1. Headline: cross-market comparison (like-for-like core)');
  lines.push('');
  lines.push('Core = subjects where the champion on the combined corpus, the challenger and the naive baseline all produced a value (same subjects, same as-of evidence). MdAPE = median absolute % error; lower is better. Paired = median per-subject APE difference challenger minus champion (percentage points) with a 90% bootstrap CI; negative favours the challenger.');
  lines.push('');
  const head = ['Market', 'Subjects', 'Core n', 'Champion pool MdAPE (n)', 'Champion combined MdAPE', 'Challenger MdAPE', 'Paired chall. - champ. combined (pp, 90% CI)', 'Challenger regime-matched MdAPE (n)', 'Paired regime-matched - champ. (pp, 90% CI)', 'Champion + micro-market guard MdAPE (paired vs champ., pp)', 'Baseline MdAPE', 'Challenger 80% coverage raw / conformal'];
  lines.push(table(head, [...markets, 'ALL'].map((m) => {
    const e = ms[m];
    const p = e.paired.challenger_vs_champion_union;
    const pr = e.paired.challenger_regime_vs_champion_union;
    const flag = e.core_n < LOW_SUPPORT_N ? ' LOW SUPPORT' : '';
    return [
      m, e.subjects, `${e.core_n}${flag}`,
      `${pct(e.core.champion_pool.mdape_pct)} (${e.core.champion_pool.n})`,
      pct(e.core.champion_union.mdape_pct), pct(e.core.challenger.mdape_pct),
      p.n ? `${p.median_ape_diff_pp} [${p.ci90_pp.join(', ')}]` : '-',
      `${pct(e.core.challenger_regime.mdape_pct)} (${e.core.challenger_regime.n})`,
      pr.n ? `${pr.median_ape_diff_pp} [${pr.ci90_pp.join(', ')}]` : '-',
      `${pct(e.core.champion_union_guarded.mdape_pct)} (${e.paired.guarded_vs_champion_union.n ? `${e.paired.guarded_vs_champion_union.median_ape_diff_pp} [${e.paired.guarded_vs_champion_union.ci90_pp.join(', ')}]` : '-'})`,
      pct(e.core.baseline.mdape_pct),
      `${pct(e.core.challenger.interval_coverage_pct)} / ${pct(e.core.challenger_conformal.interval_coverage_pct)}`,
    ];
  })));
  lines.push('');
  lines.push('Champion + micro-market guard (exploratory arm e) = the production engine on the combined corpus with every candidate across a learned discontinuity (challenger tier T4) removed from its search; everything else is the champion.');
  lines.push('');
  lines.push('Challenger = its ARV-style headline (retail value when supported, else the regime-unknown value, else an explicitly flagged investor value); it never sees the subject\'s own sale type. Regime-matched = the challenger\'s value for the subject\'s own regime (retail / investor / unknown), i.e. each value judged against labels of the market segment it estimates; the champion has no such split. Conformal coverage = the same interval re-scaled by an online split-conformal multiplier from strictly earlier subjects in the same market.');
  lines.push('');
  lines.push('### Retail subjects only (ARV semantics coincide for both engines)');
  lines.push('');
  lines.push(table(['Market', 'Retail core n', 'Champion pool MdAPE (n)', 'Champion combined MdAPE', 'Challenger MdAPE', 'Paired chall. - champ. (pp, 90% CI)', 'Baseline MdAPE'], [...markets, 'ALL'].map((m) => {
    const e = ms[m];
    const p = e.paired.retail_challenger_vs_champion_union;
    return [m, `${e.retail_core_n}${e.retail_core_n < LOW_SUPPORT_N ? ' LOW SUPPORT' : ''}`, `${pct(e.retail_core.champion_pool.mdape_pct)} (${e.retail_core.champion_pool.n})`, pct(e.retail_core.champion_union.mdape_pct), pct(e.retail_core.challenger.mdape_pct), p.n ? `${p.median_ape_diff_pp} [${p.ci90_pp.join(', ')}]` : '-', pct(e.retail_core.baseline.mdape_pct)];
  })));
  lines.push('');
  lines.push('### Arms (a)-(d): coverage and own-support accuracy');
  lines.push('');
  lines.push('(a) champion on the 48K engine pool (what production searches today); (b) champion on the combined corpus (pool + recorded deeds, incl. the 2026-09-30 import); (c) challenger on the combined corpus; (d) naive baseline. Own support = every subject the arm valued (not like-for-like across arms).');
  lines.push('');
  const armCols = ['champion_pool', 'champion_union', 'challenger', 'baseline'];
  lines.push(table(['Market', ...armCols.flatMap((a) => [`${a} cov`, `${a} MdAPE`])], [...markets, 'ALL'].map((m) => [m, ...armCols.flatMap((a) => [pct(ms[m].coverage_pct[a]), pct(ms[m].own_support[a].mdape_pct)])])));
  lines.push('');
  lines.push('### Does feeding the new comps to today\'s engine help? (champion pool vs champion combined, same subjects)');
  lines.push('');
  lines.push(table(['Market', 'n (both valued)', 'Champion pool MdAPE', 'Champion combined MdAPE', 'Paired combined - pool (pp, 90% CI)', 'Challenger MdAPE (same n)'], [...markets, 'ALL'].map((m) => {
    const e = ms[m];
    const p = e.paired.champion_union_vs_champion_pool;
    return [m, `${e.pool_core_n}${e.pool_core_n < LOW_SUPPORT_N ? ' LOW SUPPORT' : ''}`, pct(e.pool_core.champion_pool.mdape_pct), pct(e.pool_core.champion_union.mdape_pct), p.n ? `${p.median_ape_diff_pp} [${p.ci90_pp.join(', ')}]` : '-', pct(e.pool_core.challenger.mdape_pct)];
  })));
  if (pinned.length) {
    lines.push('');
    lines.push('### Champion before vs after the recency fix');
    lines.push('');
    lines.push(table(['Market', ...pinned.flatMap((e) => [`pool current vs ${e.label} (pp, 90% CI)`, `challenger vs union ${e.label} (pp)`])], [...markets, 'ALL'].map((m) => [m, ...pinned.flatMap((e) => {
      const a = ms[m].paired[`champion_pool_current_vs_champion_pool${e.key}`];
      const b = ms[m].paired[`challenger_vs_champion_union${e.key}`];
      return [a?.n ? `${a.median_ape_diff_pp} [${a.ci90_pp.join(', ')}] n=${a.n}` : '-', b?.n ? `${b.median_ape_diff_pp} n=${b.n}` : '-'];
    })])));
  }
  lines.push('');
  lines.push('### Full metrics on the core (per market)');
  lines.push('');
  lines.push(table(['Market', 'Arm', 'n', 'MAE', 'MdAE', 'MAPE', 'MdAPE', 'Median signed', 'Within 10%', 'Within 20%', 'APE p75', 'APE p90', 'Interval coverage', 'Interval width (median)'], [...markets, 'ALL'].flatMap((m) => ['champion_pool', 'champion_union', 'challenger', 'challenger_regime', 'challenger_conformal', 'baseline'].map((a) => {
    const s = ms[m].core[a];
    return [m, a, s.n, fmt(s.mae), fmt(s.mdae), pct(s.mape_pct), pct(s.mdape_pct), pct(s.median_signed_error_pct), pct(s.within_10_pct), pct(s.within_20_pct), pct(s.ape_pct_quantiles?.p75), pct(s.ape_pct_quantiles?.p90), pct(s.interval_coverage_pct), pct(s.interval_median_width_pct)];
  }))));
  lines.push('');
  lines.push('Interval semantics: champion = the engine\'s [low, high] (weighted q25/q75 with a minimum spread; not a calibrated interval); challenger = nominal 80% predictive interval; challenger_conformal = the same interval re-scaled online from earlier residuals; baseline = 10th-90th percentile PPSF x sqft. Rows for champion_pool and challenger_regime cover only the core subjects those arms valued.');
  lines.push('');
  lines.push(`Conformal multipliers (final, per market): ${Object.entries(results.conformal).map(([m, c]) => `${m} ${c.final_kappa ?? 'n/a'} (${c.calibrated_subjects} calibrated)`).join('; ')}.`);
  lines.push('');
  lines.push('## 2. Calibration (challenger)');
  lines.push('');
  lines.push(table(['Market', 'n', 'Coverage at nominal 50%', 'at 80%', 'at 90%', 'PIT decile shares (%)'], [...markets, 'ALL'].map((m) => {
    const c = ms[m].challenger_calibration;
    return [m, c.n, pct(c.coverage_pct?.nominal_50), pct(c.coverage_pct?.nominal_80), pct(c.coverage_pct?.nominal_90), (c.pit_decile_share_pct ?? []).join(' / ')];
  })));
  lines.push('');
  lines.push('## 3. Slices (core, all markets)');
  for (const [name, groups] of Object.entries(results.slices)) {
    lines.push('');
    lines.push(`### ${name}`);
    lines.push('');
    lines.push(table(['Slice', 'n', 'Champion MdAPE', 'Challenger MdAPE', 'Baseline MdAPE', 'Champion MAPE', 'Challenger MAPE', 'Challenger 80% coverage'], Object.entries(groups).map(([k, g]) => [
      k, `${g.challenger.n}${g.challenger.n < LOW_SUPPORT_N ? ' LOW SUPPORT' : ''}`, pct(g.champion_union.mdape_pct), pct(g.challenger.mdape_pct), pct(g.baseline.mdape_pct), pct(g.champion_union.mape_pct), pct(g.challenger.mape_pct), pct(g.challenger.interval_coverage_pct),
    ])));
  }
  lines.push('');
  lines.push('### Market x subject regime (core)');
  lines.push('');
  lines.push(table(['Market', 'Regime', 'n', 'Champion MdAPE', 'Challenger MdAPE', 'Baseline MdAPE'], Object.entries(results.marketRegime).flatMap(([m, g]) => Object.entries(g).map(([regime, s]) => [m, regime, `${s.challenger.n}${s.challenger.n < LOW_SUPPORT_N ? ' LOW SUPPORT' : ''}`, pct(s.champion_union.mdape_pct), pct(s.challenger.mdape_pct), pct(s.baseline.mdape_pct)]))));
  lines.push('');
  lines.push('### Regime-matched challenger values (retail value on retail subjects, investor value on investor subjects)');
  lines.push('');
  lines.push(table(['Market', 'Subject regime', 'Subjects', 'Challenger regime value n', 'MdAPE', '80% coverage', 'Champion (combined) n', 'Champion MdAPE'], Object.entries(results.regimeMatched).flatMap(([m, g]) => Object.entries(g).map(([regime, s]) => [m, regime, s.subjects, s.challenger_regime_value.n, pct(s.challenger_regime_value.mdape_pct), pct(s.challenger_regime_value.interval_coverage_pct), s.champion_union.n, pct(s.champion_union.mdape_pct)]))));
  lines.push('');
  lines.push('## 4. Largest misses (core) with comp geography');
  for (const [arm, list] of Object.entries(results.misses)) {
    lines.push('');
    lines.push(`### ${arm}`);
    lines.push('');
    lines.push(table(['Market', 'ZIP', 'At (2dp)', 'Month', 'Family', 'Regime/type', 'Sale price', 'Prediction', 'APE', 'Other arm', 'Comp geography'], list.map((x) => [x.market, x.zip, x.at, x.month, x.family, `${x.regime}/${x.sale_type}`, fmt(x.label), fmt(x.prediction), pct(x.ape_pct), fmt(x.other_arm), `\`${JSON.stringify(x.geography)}\``])));
  }
  lines.push('');
  lines.push('## 5. North Minneapolis (property 273312064, ZIP 55412)');
  lines.push('');
  const cs = results.caseStudy;
  if (!cs.available) {
    lines.push('Case-subject features not available in the snapshot directory.');
  } else {
    lines.push(`Production stored: $362,500 (2026-09-30) and $327,900 (2026-10-01). Replica arms below use the same subject features read from \`properties\`; "fidelity" re-enables the import-time vendor repair estimates the production engine reads (not point-in-time; validation only).`);
    lines.push('');
    lines.push(table(['Arm @ as-of', 'Value', 'Low-High', 'Conf', 'Comps', 'East-bank weight', 'Non-North weight', 'Rejected'], Object.entries(cs.arms).map(([k, v]) => [k, fmt(v.value), `${fmt(v.low)}-${fmt(v.high)}`, v.confidence ?? '-', v.selected, pct(round(100 * (v.east_bank_weight ?? 0), 1)), pct(round(100 * (v.non_north_weight ?? 0), 1)), `\`${JSON.stringify(v.rejected)}\``])));
    lines.push('');
    const c = cs.challenger;
    lines.push(`Challenger (combined corpus, as of 2026-10-01): headline ${c.headline ? `${c.headline.basis} ${fmt(c.headline.value)} (50% ${c.headline.p50.map(fmt).join('-')}, 80% ${c.headline.p80.map(fmt).join('-')}, support ${c.headline.support}, ${c.headline.n_comps} comps)` : 'none'}.`);
    lines.push('');
    lines.push(table(['Regime value', 'Value', '50%', '80%', 'n', 'Support', 'Tier weight share'], Object.entries(c.values).map(([k, v]) => (v ? [k, fmt(v.value), v.p50.map(fmt).join('-'), v.p80.map(fmt).join('-'), v.n, v.support, `\`${JSON.stringify(v.tiers)}\``] : [k, '-', '-', '-', 0, 'none', '-']))));
    lines.push('');
    lines.push(`Subject assignment: \`${JSON.stringify(c.assignment)}\`. Adaptive radius ${c.adaptive_radius.radius_mi} mi (search ${c.adaptive_radius.search_radius_mi} mi, ${c.adaptive_radius.density_class}). Included ZIPs: ${c.included_zips.join(', ')}; east-bank weight ${pct(round(100 * c.included_east_bank_weight, 1))}. First-reason counts over the whole universe: \`${JSON.stringify(c.first_reason_counts)}\`.`);
    lines.push('');
    const f = cs.challenger_forced_4mi;
    lines.push(`Stress test: challenger forced to the champion's fixed 4-mile radius. Headline ${f.headline ? `${f.headline.basis} ${fmt(f.headline.value)} (80% ${f.headline.p80.map(fmt).join('-')})` : 'none'}; east-bank weight ${pct(round(100 * f.included_east_bank_weight, 1))}; east-bank eligible comps by first reason \`${JSON.stringify(f.east_bank_in_search_first_reason)}\`.`);
    lines.push('');
    lines.push(`Naive baseline: ${fmt(cs.baseline.value)} (80% ${(cs.baseline.p80 ?? []).map(fmt).join('-')}, n=${cs.baseline.n}).`);
    lines.push('');
    lines.push(`Layer as of 2026-10-01 (MSP region): \`${JSON.stringify(cs.layer)}\`.`);
  }
  lines.push('');
  lines.push('## 6. Transaction density (as of 2026-10-01, valid SFR sales in the prior 12 months)');
  lines.push('');
  lines.push('Computed from this snapshot, which INCLUDES the 2026-09-30 comp_canonical_transactions import (it covers CA, FL, GA, MO, IN, NC: here Jacksonville and Indianapolis; no Minnesota or Texas rows). "Without" drops those rows.');
  lines.push('');
  lines.push(table(['Region', 'Scope', 'Sales', 'Occupied ~1 km cells', 'Sales/cell median / p75 / p90', 'Sales in cells >=5', 'in cells >=10', 'ZIPs (>=20 sales)'], Object.entries(results.density).flatMap(([region, d]) => [['all', d.all], ['without 09-30 import', d.without_2026_09_30_import]].map(([scope, x]) => [region, scope, x.sales, x.occupied_cells, `${x.per_cell_median ?? '-'} / ${x.per_cell_p75 ?? '-'} / ${x.per_cell_p90 ?? '-'}`, pct(x.share_sales_in_cells_ge5_pct), pct(x.share_sales_in_cells_ge10_pct), `${x.zips} (${x.zips_ge20})`]))));
  lines.push('');
  lines.push(renderDefects(results, engines));
  lines.push('');
  lines.push('## 9. Sampling and runtime');
  lines.push('');
  lines.push(`Subjects capped at ${manifest.params.sampling.cap_per_market} per market by a deterministic hash sample (${manifest.params.sampling.method}). Runtime ${results.runtime_sec}s.`);
  lines.push('');
  lines.push(table(['Market', 'Eligible subjects', 'Sampled', 'Rate'], Object.entries(results.sampling).map(([m, s]) => [m, s.eligible, s.sampled, s.sampling_rate])));
  lines.push('');
  lines.push('## 10. Micro-market layer per region (monthly as-of builds)');
  lines.push('');
  lines.push(table(['Region', 'As of', 'Evidence sales', 'Cells', 'Sales/cell (median)', 'Micro-markets', 'Sales/micro-market (median)', 'Boundaries', 'Classes', 'beta', 'rho investor', 'sigma'], Object.entries(results.layerSummaries).flatMap(([region, list]) => list.filter((_, i) => i === 0 || i === list.length - 1 || i % 4 === 0).map((l) => [region, l.as_of, l.evidence_sales, l.cells, l.sales_per_cell_median, l.micro_markets, l.micro_market_sales_median, l.boundaries, `\`${JSON.stringify(l.boundary_classes)}\``, l.beta, round(l.rho.investor, 3), l.sigma_within]))));
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function renderDefects(results, engines) {
  const cs = results.caseStudy;
  const arm = (key) => cs.available ? cs.arms[key] : null;
  const pinned = engines.slice(1);
  const before = pinned[0]?.key ?? null;
  const v = (key) => {
    const a = arm(key);
    return a ? fmt(a.value) : 'n/a';
  };
  const lines = [];
  lines.push('## 7. Champion defects (for the owner; not fixed here, production code untouched)');
  lines.push('');
  lines.push('1. **Month-boundary age-score jump.** Recency was a step table on calendar-month age, so every sale from one month re-weighted at 00:00 UTC on the 1st.');
  if (before) {
    lines.push(`   Replica, before-fix engine (${pinned[0].identity.path} sha256 ${pinned[0].identity.sha256.slice(0, 12)}), fidelity inputs: ${v(`champion_pool_fidelity${before} @ 2026-09-30`)} on 09-30 -> ${v(`champion_pool_fidelity${before} @ 2026-10-01`)} on 10-01 on the identical 100-candidate pool (production stored $362,500 -> $327,900).`);
  }
  lines.push(`   Replica, engine as run (${engines[0].identity.path} sha256 ${engines[0].identity.sha256.slice(0, 12)}, ${engines[0].identity.working_tree_status === 'clean' ? 'committed' : 'working tree: uncommitted change by another agent'}): ${v('champion_pool_fidelity @ 2026-09-30')} -> ${v('champion_pool_fidelity @ 2026-10-01')}. The replica imports the engine, so the continuous-recency fix flows through without any change here.`);
  lines.push('2. **Outlier check centred on the mixed pool.** `removeOutliers` centres on the median adjusted price of every eligible candidate, North and east bank together, with a tolerance of max(3.5 MAD, 28% of median).');
  if (cs.available) lines.push(`   Case replica (10-01): centre ${fmt(arm('champion_pool @ 2026-10-01')?.outlier?.median)}, allowed deviation +/-${fmt(arm('champion_pool @ 2026-10-01')?.outlier?.allowed_deviation)}: wide enough to admit both price regimes. The challenger screens outliers inside each regime's selected set instead.`);
  lines.push(`3. **Linear size scaling.** \`adjustedCompPrice\` blends sale price x (subject sqft / comp sqft) at 55% weight (+35% raw price, +10% bed ratio). The challenger learns a log-size elasticity per market and as-of month from within-cell variation: ${Object.entries(results.layerSummaries).map(([r, l]) => `${r} ${l.length ? l[l.length - 1].beta : 'n/a'}`).join(', ')} (latest layer). The naive baseline, which scales PPSF linearly, overstates large subjects (North Minneapolis: ${cs.available ? fmt(cs.baseline.value) : 'n/a'}).`);
  lines.push('4. **Deal Intelligence\'s comp grid is a separate live re-score**, not the engine\'s stored selected set (`apps/api/src/lib/cockpit/deal-intelligence-dossier.js:740-880`, "usable" = eligible and comp_confidence >= 45 at `:781`); only the value range is the stored ADE range (`:1566-1578`). Operators can see a grid that is not the set that priced the deal. (From the Phase 0 audit; not re-measured here.)');
  const eastW = (key) => (arm(key) ? pct(round(100 * arm(key).east_bank_weight, 1)) : 'n/a');
  const pair5 = (suffix) => `pool ${v(`champion_pool${suffix} @ 2026-10-01`)} (${eastW(`champion_pool${suffix} @ 2026-10-01`)} east-bank weight) -> combined ${v(`champion_union${suffix} @ 2026-10-01`)} (${eastW(`champion_union${suffix} @ 2026-10-01`)})`;
  lines.push(`5. **Feeding the recorded deeds to today\'s search raises the North Minneapolis value further.** Point-in-time replica, 10-01: before-fix engine ${before ? pair5(before) : 'n/a'}; engine as run ${pair5('')}. More structurally similar east-bank sales reach the top 100. With the micro-market guard (exploratory): ${v('champion_union_guarded @ 2026-10-01')} (${eastW('champion_union_guarded @ 2026-10-01')} east-bank weight).`);
  lines.push('6. **No as-of bound in the candidate RPC** (`sale_date >= current_date - interval`, no upper bound; future ages clamp to 0): the production engine cannot be replayed historically. This backtest re-implements only the search.');
  lines.push('7. **No price-provenance check.** The engine would treat Texas deed prices marked "Estimated Sales Price" (vendor estimates; Texas is a non-disclosure state) as transactions if they reached its pool.');
  lines.push('');
  lines.push('## 8. Data truths that bound these results');
  lines.push('');
  lines.push('- **Texas deed prices are estimates.** 93% (DFW) and 91% (HOU) of recorded-deed rows carry price_code "Estimated Sales Price"; real recorded prices exist mainly on trustee/sheriff (distress) deeds. They are excluded as evidence and as labels, so DAL / HOU / TX751 rest on a few hundred pool rows (MLS + public record, all buyer is_corporate_owner = true) and are LOW SUPPORT investor-purchase markets here.');
  lines.push('- **Jacksonville and Indianapolis are the 2026-09-30 import.** 17,810 of 17,886 JAX and 13,079 of 13,110 IND deeds; buyer type unknown (100%), arm\'s-length unknown 97% / 89%, sqft present 88% / 91%. Their values are regime-unknown, not retail.');
  lines.push('- **Outside Minneapolis the engine pool is an investor-purchase list**: is_corporate_owner = true on 100% of DFW/HOU/JAX/IND pool rows, including MLS rows; 60% of DFW/HOU public-record rows are priced under $10K.');
  lines.push('- **Knowledge time.** The backtest uses sale / known dates as knowledge time. LeadCommand ingested the pool on 2026-05-16/17 (never refreshed) and the deeds from 2026-07-26, so a live system at T knew less than this replay assumes, for both champion and challenger.');
  lines.push('- **No genuinely rural market with real prices.** Ellis/Kaufman (TX) has fewer than 10 recorded deeds; rural NE Florida none. TX751 (south/east Dallas County fringe, ZIP3 751) is data-sparse but suburban and estimated-price; MN553 (outer Twin Cities ring) is the data-sparse market with real prices.');
  lines.push('- **comp_private.comp_market_cells** is an administrative-geography aggregate (city / county / state / zip5, windows 30-1095 days) with a single as_of of 2026-08-07, before the 09-30 import: not a ~1 km layer and not replayable as-of, so it was not reused.');
  lines.push('- **Direct Postgres from apps/api/.env.local fails** (28P01, stale password); the snapshot used the service-role REST client and the STABLE RPC comps_market_evidence.');
  return lines.join('\n');
}

/** Per-market paired verdict: challenger wins only where the 90% CI of (challenger - champion) APE lies below 0. */
function crossMarketVerdict(results) {
  const wins = [];
  const losses = [];
  const ties = [];
  for (const [m, e] of Object.entries(results.marketSummary)) {
    if (m === 'ALL') continue;
    const p = e.paired?.challenger_vs_champion_union;
    if (!p?.ci90_pp || e.core_n < LOW_SUPPORT_N) { ties.push(`${m} (low support)`); continue; }
    if (p.ci90_pp[1] < 0) wins.push(m);
    else if (p.ci90_pp[0] > 0) losses.push(m);
    else ties.push(m);
  }
  const beats = wins.length > 0 && losses.length === 0;
  return { beats, wins, losses, ties };
}

function renderModelCard({ results, manifest }) {
  const all = results.marketSummary.ALL;
  const verdict = crossMarketVerdict(results);
  const engines = manifest.champion?.engines ?? [];
  const current = engines[0];
  return `# Model card: comp_micromarket ${manifest.version} (BACKTEST)

- **Family:** comp_micromarket (IC8 phase 6 challenger). **Status:** BACKTEST, offline research prototype. Not wired to production; the production Decision Engine stays CHAMPION.
- **Intended use:** research evidence for whether micro-market-aware comp selection beats the champion. Not for offers, not for operator display.
- **Inputs (property and transaction facts only):** sale price and date (with as-of availability date), coordinates, ZIP (pooling only), asset family, units, sqft, beds, baths, year built, unit designator, sale validity flags, sale regime (MLS sale / buyer-type category company vs individual). No names, phones, emails, demographics or any person attribute. Market geography comes from the property.
- **Method:** hard gates (as-of, same property, sale validity, asset family, unit-count credibility, improved vs vacant, condo vs detached, size) -> adaptive radius from local density -> learned micro-market tiers (same -> adjacent similar -> other without barrier -> across discontinuity, last resort) -> structural similarity, recency, effective distance. Values: time index + log-size elasticity + shrunk micro-market location adjustment; retail / investor / regime-unknown values separately; predictive interval from weighted comp dispersion and a bootstrap SE.
- **Micro-market layer:** ~1 km grid, monthly as-of rebuilds from strictly earlier sales; agglomerative merging under a support-aware z-test; boundary classes from a seeded bootstrap CI of the median level gap; pooling cell -> micro-market -> ZIP -> market; effective market distance by graph shortest path.
- **Data:** snapshot \`${manifest.dataset.snapshot_id}\` (engine pool + recorded deeds incl. the 2026-09-30 import), subjects ${manifest.as_of_window.subjects.join(' .. ')}.
- **Headline result (all markets, like-for-like core n=${all.core_n}):** champion MdAPE ${all.core.champion_union.mdape_pct}%, challenger ${all.core.challenger.mdape_pct}%, naive baseline ${all.core.baseline.mdape_pct}%; challenger 80% interval coverage ${all.core.challenger.interval_coverage_pct ?? '-'}%. Per-market results and LOW SUPPORT flags are in report.md; a national number hides local failures.
- **Cross-market verdict (paired challenger - champion on the combined corpus, 90% CI):** ${verdict.beats ? 'challenger BEATS the champion' : 'challenger does NOT beat the champion'}. Champion better: ${verdict.losses.join(', ') || 'none'}; challenger better: ${verdict.wins.join(', ') || 'none'}; inconclusive: ${verdict.ties.join(', ') || 'none'}.
- **Champion version run:** ${current ? `\`${current.path}\` sha256 ${current.sha256.slice(0, 12)} (${current.working_tree_status === 'clean' ? 'committed HEAD' : `working tree, ${current.working_tree_status}; last commit ${String(current.last_commit ?? 'n/a').slice(0, 8)}`})` : 'n/a'}${engines.slice(1).map((e) => `; also ${e.label} (${e.path}, sha256 ${e.sha256.slice(0, 12)})`).join('')}. The replica imports the production engine's scoring/recency/valuation functions; only the candidate search (RPC) is re-implemented with an as-of bound.
- **Known limitations:** Texas deed prices are vendor estimates (non-disclosure state) and are excluded as evidence and labels, so DAL / HOU / TX751 rest on few MLS sales; Jacksonville and Indianapolis deeds carry no buyer type, so their values are regime-unknown, not retail; the layer is learned from single-family sales only and reused for 2-4 unit subjects; knowledge time is event time (LeadCommand ingested the data later); subject attributes come from vendor records as of import.
- **Fairness:** no protected characteristics or proxies; school district, demographics and income are not read.
- **Promotion:** none. Promotion requires beating the champion across markets with documented gates; this card records evidence only.
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(`backtest failed: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}

