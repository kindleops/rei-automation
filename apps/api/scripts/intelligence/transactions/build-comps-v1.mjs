#!/usr/bin/env node
/**
 * IC8.1 comps-v1 snapshot: the comp-snapshot-v1 record format (same regions,
 * same pool/deed record mapping, imported from ../comps/build-comp-snapshot.mjs)
 * plus transaction price provenance, canonical dedupe and the two valuation
 * truth sets. Sealed for the backtest v1 agent.
 *
 *   1. read   public.v_recent_sold_comps (+ buyer_comp_raw_v2) keyset pages and
 *             public.comps_market_evidence (STABLE RPC over
 *             comp_private.mv_comp_market_evidence) quadtree tiles, exactly as
 *             the v0 builder does, but KEEPING the deed price_code
 *   2. price  normalizeTransactionPrice() on every record (transactions/price-taxonomy.js)
 *   3. dedupe canonicalizeTransactions() per region (transactions/dedupe.js)
 *   4. truth  truthSetOf() per canonical transaction (transactions/truth-sets.js)
 *   5. seal   NDJSON.gz per region + manifest.json (sha256 of every file) +
 *             dataset-card.md; files chmod 0444; SEAL = sha256(manifest.json)
 *
 * READ-ONLY. Service-role REST client (direct Postgres unavailable: stale
 * password, 28P01). Paced, bounded, resumable (<out>/_work/checkpoint.json).
 * Names and street addresses are dropped in memory (v0 mapping).
 *
 * Run from apps/api:
 *   node --env-file=.env.local --no-warnings --loader ./tests/alias-loader.mjs \
 *     scripts/intelligence/transactions/build-comps-v1.mjs [--regions=MSP,DFW] [--out=...]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { DEED_IMPORT_BATCHES, POOL_COLUMNS, QUERY_SPEC, REGIONS, deedRecord, gitInfo, poolRecord } from "../comps/build-comp-snapshot.mjs";
import { PRICE_TAXONOMY_VERSION, normalizeTransactionPrice } from "../../../src/lib/domain/intelligence/transactions/price-taxonomy.js";
import { DEDUPE_VERSION, canonicalizeTransactions } from "../../../src/lib/domain/intelligence/transactions/dedupe.js";
import { LABEL_WEIGHTS, TRUTH_SETS_VERSION, truthSetOf } from "../../../src/lib/domain/intelligence/transactions/truth-sets.js";

export const SPEC_VERSION = "comps-v1";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_OUT = "/Users/ryankindle/.claude/jobs/c39b0175/tmp/ic8/datasets/comps-v1";
const DEFAULT_WORK = "/Users/ryankindle/.claude/jobs/c39b0175/tmp/ic8/datasets/_work/comps-v1-extract";
const RAW_COLUMNS = ["id", "is_corporate_owner", "last_sale_doc_type", "recording_date", "apn_parcel_id"];
const RPC_ROW_CAP = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, d) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);
const sha256File = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Price record input for a v0 record (pool or deed). */
export function priceInputOf(r) {
  if (r.src === "pool") {
    return { kind: r.sale_type === "mls" ? "pool_mls" : "pool_public_record", price: r.price, state: r.state, source_record_id: r.id, source_provider: "public.buyer_comp_raw_v2", source_observed_at: r.ingested_at };
  }
  return {
    kind: "deed",
    price: r.price,
    price_code: r.price_code ?? null,
    // the MV only holds price > 0 rows; the importer writes 'recorded_full' for a NULL code
    price_source: r.price_code ? null : "recorded_full",
    state: r.state,
    concurrent_loan_amount: null,
    source_record_id: r.id,
    source_provider: `comp_private.comp_canonical_transactions (${r.corpus ?? "?"}, import ${r.ingested_at})`,
    source_observed_at: r.ingested_at,
  };
}

/**
 * Attach price provenance, canonical transaction and truth set to v0 records (in place).
 * Pure apart from mutation of `records`; exported for tests.
 */
export function annotateRecords(records) {
  for (const r of records) {
    r.price_norm = normalizeTransactionPrice(priceInputOf(r));
    r.price_source_class = r.price_norm.source;
    r.price_confidence = r.price_norm.confidence;
    r.price_verified = r.price_norm.verified;
    r.price_is_estimated = r.price_norm.is_estimated;
    r.price_estimated = r.price_norm.is_estimated === true; // v0 field, now from the taxonomy
  }
  const { transactions, ambiguous, stats } = canonicalizeTransactions(records);
  const byId = new Map(records.map((r) => [r.id, r]));
  const truthCounts = {};
  for (const t of transactions) {
    const group = t.members.map((m) => byId.get(m.id));
    const winner = group[0];
    const truth = truthSetOf({
      price: t.price,
      price_conflict: t.price_conflict,
      package_n: t.package_n,
      doc_type: winner.doc_type ?? group.find((r) => r.doc_type)?.doc_type ?? null,
      arms_length: group.some((r) => r.arms_length === false) ? false : winner.arms_length ?? null,
      nominal_flag: winner.src === "pool" ? (t.price.transaction_price ?? 0) < 10000 : winner.nominal_flag === true,
      usable: winner.usable_comp === true,
    });
    const key = `${t.market ?? "(buffer)"}|${truth.truth_set}${truth.primary_strict ? "_strict" : ""}`;
    truthCounts[key] = (truthCounts[key] ?? 0) + 1;
    group.forEach((r, i) => {
      r.txn_id = t.canonical_id;
      r.txn_role = i === 0 ? "price_source" : "provenance";
      r.txn_price_conflict = t.price_conflict;
      r.package_n = t.package_n;
      r.dedup = group.length === 1 ? null : i === 0
        ? { role: "winner", merged: group.slice(1).map((x) => x.id).sort(), basis: t.merge_basis.join(",") }
        : { role: "loser", winner: winner.id, basis: t.merge_basis.join(",") };
      r.truth_set = i === 0 ? truth.truth_set : "duplicate";
      r.truth_primary_strict = i === 0 ? truth.primary_strict : false;
      r.truth_reasons = i === 0 ? truth.reasons : ["provenance_record_of_" + winner.id];
      r.label_weight = i === 0 ? truth.label_weight : 0;
    });
  }
  return { transactions, ambiguous, stats, truthCounts };
}

class Checkpoint {
  constructor(file) {
    this.file = file;
    this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { parts: {} };
  }
  part(name) {
    this.state.parts[name] ??= { cursor: null, rows: 0, bytes: 0, calls: 0, done: false, done_tiles: [], truncated: [] };
    return this.state.parts[name];
  }
  save() {
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}

async function withRetry(label, fn) {
  let last;
  for (let i = 1; i <= 3; i += 1) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.log(`  ${label}: attempt ${i} failed (${String(e?.code ?? "")} ${String(e?.message ?? e).slice(0, 120)})`);
      await sleep(1500 * i);
    }
  }
  throw last;
}

function prepare(file, part) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  fs.truncateSync(file, part.bytes);
}
function append(file, part, recs) {
  if (recs.length) fs.appendFileSync(file, recs.map((r) => `${JSON.stringify(r)}\n`).join(""));
  part.bytes = fs.statSync(file).size;
  part.rows += recs.length;
}

async function fetchPool(supabase, region, file, part, cp, opts) {
  prepare(file, part);
  const box = region.box;
  while (!part.done) {
    const cursor = part.cursor ?? "00000000-0000-0000-0000-000000000000";
    const rows = await withRetry(`${region.region}.pool`, async () => {
      const res = await supabase.from("v_recent_sold_comps").select(POOL_COLUMNS.join(","))
        .gte("latitude", box.latMin).lte("latitude", box.latMax).gte("longitude", box.lngMin).lte("longitude", box.lngMax)
        .or(`sale_date.gte.${opts.dateFrom},mls_sold_date.gte.${opts.dateFrom}`)
        .gt("id", cursor).order("id", { ascending: true }).limit(1000);
      if (res.error) throw res.error;
      return res.data ?? [];
    });
    const rawById = new Map();
    for (let i = 0; i < rows.length; i += 150) {
      const ids = rows.slice(i, i + 150).map((r) => r.id);
      const raws = await withRetry(`${region.region}.raw`, async () => {
        const res = await supabase.from("buyer_comp_raw_v2").select(RAW_COLUMNS.join(",")).in("id", ids);
        if (res.error) throw res.error;
        return res.data ?? [];
      });
      for (const raw of raws) rawById.set(raw.id, raw);
      part.calls += 1;
    }
    append(file, part, rows.map((row) => poolRecord(row, rawById.get(row.id), region)));
    part.calls += 1;
    if (rows.length) part.cursor = rows[rows.length - 1].id;
    if (rows.length < 1000) part.done = true;
    cp.save();
    await sleep(opts.pauseMs);
  }
  console.log(`  ${region.region}.pool rows=${part.rows}`);
}

function tilesOf(box, step) {
  const mid = (box.latMin + box.latMax) / 2;
  const stepLng = step / Math.cos((mid * Math.PI) / 180);
  const out = [];
  for (let lat = box.latMin; lat < box.latMax - 1e-9; lat += step) {
    for (let lng = box.lngMin; lng < box.lngMax - 1e-9; lng += stepLng) {
      out.push({ latMin: round(lat, 6), latMax: round(Math.min(lat + step, box.latMax), 6), lngMin: round(lng, 6), lngMax: round(Math.min(lng + stepLng, box.lngMax), 6) });
    }
  }
  return out;
}
const tileKey = (t) => `${t.latMin},${t.latMax},${t.lngMin},${t.lngMax}`;
function halfDiagMi(t) {
  const mid = ((t.latMin + t.latMax) / 2) * (Math.PI / 180);
  const dy = (t.latMax - t.latMin) * 69.05;
  const dx = (t.lngMax - t.lngMin) * 69.17 * Math.cos(mid);
  return Math.sqrt(dx * dx + dy * dy) / 2;
}
function split(t, n) {
  const out = [];
  const dLat = (t.latMax - t.latMin) / n;
  const dLng = (t.lngMax - t.lngMin) / n;
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) {
    out.push({ latMin: round(t.latMin + i * dLat, 6), latMax: i === n - 1 ? t.latMax : round(t.latMin + (i + 1) * dLat, 6), lngMin: round(t.lngMin + j * dLng, 6), lngMax: j === n - 1 ? t.lngMax : round(t.lngMin + (j + 1) * dLng, 6) });
  }
  return out;
}
function inside(t, lat, lng, box) {
  const latHi = t.latMax >= box.latMax ? lat <= t.latMax : lat < t.latMax;
  const lngHi = t.lngMax >= box.lngMax ? lng <= t.lngMax : lng < t.lngMax;
  return lat >= t.latMin && latHi && lng >= t.lngMin && lngHi;
}

async function fetchDeeds(supabase, region, file, part, cp, opts) {
  prepare(file, part);
  if (part.done) return;
  const box = region.box;
  const from = new Date(`${opts.dateFrom}T00:00:00Z`);
  const now = new Date();
  const months = (now.getUTCFullYear() - from.getUTCFullYear()) * 12 + (now.getUTCMonth() - from.getUTCMonth()) + 2;
  const done = new Set(part.done_tiles);
  const stack = tilesOf(box, 0.08).reverse();
  while (stack.length) {
    const tile = stack.pop();
    const key = tileKey(tile);
    if (done.has(key)) continue;
    const radius = round(halfDiagMi(tile) * 1.02 + 0.01, 3);
    const payload = await withRetry(`${region.region}.deeds`, async () => {
      const res = await supabase.rpc("comps_market_evidence", { p_lat: (tile.latMin + tile.latMax) / 2, p_lng: (tile.lngMin + tile.lngMax) / 2, p_radius_miles: radius, p_months: months, p_family: null, p_limit: RPC_ROW_CAP });
      if (res.error) throw res.error;
      return res.data ?? { total_in_radius: 0, returned: 0, rows: [] };
    });
    part.calls += 1;
    const total = Number(payload.total_in_radius ?? 0);
    const returned = Number(payload.returned ?? 0);
    if (total > returned && tile.latMax - tile.latMin >= 0.002) {
      const n = Math.min(6, Math.max(2, Math.ceil(Math.sqrt(total / 250))));
      for (const c of split(tile, n).reverse()) stack.push(c);
    } else {
      if (total > returned) part.truncated.push({ tile: key, total, returned });
      const recs = [];
      for (const row of payload.rows ?? []) {
        const lat = Number(row.lat);
        const lng = Number(row.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inside(tile, lat, lng, box)) continue;
        const d = row.event_date ? String(row.event_date).slice(0, 10) : null;
        if (!d || d < opts.dateFrom) continue;
        const rec = deedRecord(row, region);
        rec.price_code = row.price_code ?? null;
        rec.financing_kind = row.financing_kind ?? null;
        recs.push(rec);
      }
      append(file, part, recs);
      part.done_tiles.push(key);
      done.add(key);
    }
    cp.save();
    if (part.calls % 25 === 0) console.log(`  ${region.region}.deeds calls=${part.calls} rows=${part.rows} pending=${stack.length}`);
    await sleep(opts.pauseMs);
  }
  part.done = true;
  cp.save();
  console.log(`  ${region.region}.deeds rows=${part.rows} truncated=${part.truncated.length}`);
}

function readNdjson(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const countBy = (xs, fn) => {
  const out = {};
  for (const x of xs) {
    const k = fn(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

async function main() {
  const args = parseArgs(process.argv);
  const opts = { dateFrom: args["date-from"] ?? "2023-01-01", pauseMs: Number(args["pause-ms"] ?? 200), regions: (args.regions ?? REGIONS.map((r) => r.region).join(",")).split(","), out: args.out ?? DEFAULT_OUT, work: args.work ?? DEFAULT_WORK };
  fs.mkdirSync(opts.work, { recursive: true });
  const { supabase, hasSupabaseConfig } = await import("@/lib/supabase/client.js");
  if (!hasSupabaseConfig()) throw new Error("supabase_config_missing");
  const cp = new Checkpoint(path.join(opts.work, "checkpoint.json"));
  const fetchStartedAt = cp.state.fetch_started_at ?? new Date().toISOString();
  cp.state.fetch_started_at = fetchStartedAt;
  const regions = REGIONS.filter((r) => opts.regions.includes(r.region));
  for (const region of regions) {
    console.log(`region ${region.region}`);
    await fetchPool(supabase, region, path.join(opts.work, `${region.region}.pool.ndjson`), cp.part(`${region.region}.pool`), cp, opts);
    await fetchDeeds(supabase, region, path.join(opts.work, `${region.region}.deeds.ndjson`), cp.part(`${region.region}.deeds`), cp, opts);
  }

  if (fs.existsSync(opts.out) && fs.existsSync(path.join(opts.out, "SEAL"))) throw new Error(`${opts.out} is already sealed; refusing to overwrite`);
  fs.mkdirSync(opts.out, { recursive: true });
  const counts = {};
  const files = {};
  const ambiguousSample = {};
  for (const region of regions) {
    const pool = readNdjson(path.join(opts.work, `${region.region}.pool.ndjson`));
    const deedsAll = readNdjson(path.join(opts.work, `${region.region}.deeds.ndjson`));
    const seen = new Set();
    const deeds = deedsAll.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
    const records = [...pool, ...deeds];
    const { transactions, ambiguous, stats, truthCounts } = annotateRecords(records);
    records.sort((a, b) => (a.sale_date ?? "").localeCompare(b.sale_date ?? "") || a.id.localeCompare(b.id, "en", { numeric: true }));
    const file = path.join(opts.out, `${region.region}.ndjson.gz`);
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from(records.map((r) => `${JSON.stringify(r)}\n`).join("")), { level: 9 }));
    files[`${region.region}.ndjson.gz`] = { sha256: sha256File(file), records: records.length };
    const priceSource = records.filter((r) => r.txn_role === "price_source");
    counts[region.region] = {
      raw: { pool: pool.length, deeds: deedsAll.length, deeds_seen_twice: deedsAll.length - deeds.length },
      truncated_deed_tiles: cp.part(`${region.region}.deeds`).truncated,
      records: records.length,
      canonical_transactions: transactions.length,
      dedupe: stats,
      ambiguous_total: ambiguous.length,
      truth_by_market: truthCounts,
      price_by_market_confidence: countBy(priceSource, (r) => `${r.market ?? "(buffer)"}|${r.src}|${r.price_source_class}|${r.price_confidence}`),
      deeds_by_import_batch_confidence: countBy(records.filter((r) => r.src === "deeds"), (r) => `${r.ingested_at}|${r.price_confidence}`),
    };
    ambiguousSample[region.region] = ambiguous.slice(0, 25);
    console.log(`  ${region.region}: records=${records.length} txns=${transactions.length} dedupe_rate=${stats.dedupe_rate} ambiguous=${ambiguous.length}`);
  }
  const codeFiles = [
    "scripts/intelligence/transactions/build-comps-v1.mjs",
    "scripts/intelligence/comps/build-comp-snapshot.mjs",
    "src/lib/domain/intelligence/transactions/price-taxonomy.js",
    "src/lib/domain/intelligence/transactions/dedupe.js",
    "src/lib/domain/intelligence/transactions/truth-sets.js",
  ];
  const manifest = {
    snapshot_id: `comps-v1-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
    spec_version: SPEC_VERSION,
    base_format: "comp-snapshot-v1 records (scripts/intelligence/comps/build-comp-snapshot.mjs poolRecord/deedRecord) + IC8.1 fields",
    built_at: new Date().toISOString(),
    fetch_started_at: fetchStartedAt,
    uri: opts.out,
    versions: { price_taxonomy: PRICE_TAXONOMY_VERSION, dedupe: DEDUPE_VERSION, truth_sets: TRUTH_SETS_VERSION },
    code: gitInfo(codeFiles),
    source: {
      supabase_project: "lcppdrmrdfblstpcbgpf",
      access: "service-role REST: GET v_recent_sold_comps + buyer_comp_raw_v2, STABLE RPC comps_market_evidence; read only",
      queries: QUERY_SPEC,
      deed_import_batches: DEED_IMPORT_BATCHES,
      limits: "the evidence MV holds price > 0 transactions only: unpriced canonical transactions (e.g. 18,140 in TX) are not in this valuation snapshot; deed price_source is not exposed by the RPC and is reconstructed from price_code (NULL code => 'recorded_full', the importer's rule)",
    },
    date_from: opts.dateFrom,
    regions: regions.map((r) => ({ region: r.region, markets: r.markets.map((m) => ({ market: m.market, zip3: m.zip3, core: m.core })) })),
    files,
    counts,
    ambiguous_sample: ambiguousSample,
    label_weights: LABEL_WEIGHTS,
    record_schema_additions: {
      price_code: "deeds: vendor price code (verbatim)",
      price_norm: "normalizeTransactionPrice() output: {transaction_price, source, confidence, verified, is_estimated, source_record_id, source_provider, source_observed_at, price_code, canonical_price_source, jurisdiction, reasons}",
      "price_source_class / price_confidence / price_verified / price_is_estimated": "flattened from price_norm",
      price_estimated: "v0 field, now = price_norm.is_estimated === true (v0 used only the 'Estimated Sales Price' code)",
      txn_id: "canonical transaction id (T:<lowest member id>)",
      txn_role: "price_source (the record whose price is canonical) | provenance (another observation of the same transaction)",
      txn_price_conflict: "reliable member prices disagree by > 5%",
      dedup: "v0-compatible: {role:'winner', merged, basis} | {role:'loser', winner, basis} | null (single-record transaction)",
      package_n: "parcels in the package deed (same date + price); 0 = none",
      truth_set: "primary | secondary | excluded (on the price_source record) | duplicate (provenance records)",
      truth_primary_strict: "primary AND confidence HIGH",
      truth_reasons: "why secondary/excluded",
      label_weight: "default confidence weight (HIGH 1, MEDIUM 0.75, LOW 0.25, UNKNOWN 0) for weighted-training experiments",
    },
    usage: {
      primary_labels: "records with txn_role='price_source' AND truth_set='primary' (strict: truth_primary_strict)",
      weak_labels: "txn_role='price_source' AND truth_set='secondary' - never mixed into primary metrics without a flag",
      comps_pool: "any txn_role='price_source' record may serve as comp evidence; weight it by price_confidence; never use provenance duplicates as extra comps",
      as_of: "unchanged from v0: sale_date/known_date; ingested_at gives the corpus import date",
    },
  };
  const cardPath = path.join(opts.out, "dataset-card.md");
  fs.writeFileSync(cardPath, datasetCard(manifest));
  manifest.files["dataset-card.md"] = { sha256: sha256File(cardPath) };
  const manifestPath = path.join(opts.out, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (args.seal === "true") {
    const seal = sha256File(manifestPath);
    fs.writeFileSync(path.join(opts.out, "SEAL"), `${seal}  manifest.json\nsealed_at ${new Date().toISOString()}\n`);
    for (const f of fs.readdirSync(opts.out)) if (!fs.statSync(path.join(opts.out, f)).isDirectory()) fs.chmodSync(path.join(opts.out, f), 0o444);
    manifest.seal_sha256 = seal;
    console.log(`SEALED ${opts.out} manifest sha256 ${seal}`);
  }
  return manifest;
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");

/** Human dataset card (markdown) generated from the manifest counts. */
export function datasetCard(m) {
  const rows = [];
  for (const [region, c] of Object.entries(m.counts)) {
    const markets = new Set(Object.keys(c.truth_by_market).map((k) => k.split("|")[0]));
    for (const market of [...markets].sort()) {
      const get = (k) => c.truth_by_market[`${market}|${k}`] ?? 0;
      const strict = get("primary_strict");
      const primary = strict + get("primary");
      const secondary = get("secondary");
      const excluded = get("excluded");
      const dm = c.dedupe.by_market[market === "(buffer)" ? "(none)" : market] ?? {};
      rows.push(`| ${region} | ${market} | ${dm.records ?? "-"} | ${dm.transactions ?? "-"} | ${dm.dedupe_rate ?? "-"} | ${primary} | ${strict} | ${secondary} | ${excluded} | ${pct(primary, primary + secondary)} |`);
    }
  }
  return `# Dataset card: ${m.snapshot_id} (IC8.1 comps-v1)

Built ${m.built_at} from production (read-only), project ${m.source.supabase_project}. Code commit ${m.code.commit}.
Versions: ${Object.entries(m.versions).map(([k, v]) => `${k} \`${v}\``).join(", ")}.

## What it is
The comp-snapshot-v1 records (same five export regions, same pool/deed mapping as
\`comps-20261002-1b1cf609\`) with, on every record, the price provenance of
\`normalizeTransactionPrice()\`, the canonical transaction it belongs to, and the
valuation truth set of that transaction. One economic transaction = one
\`txn_id\`; its best-priced record is \`txn_role = 'price_source'\`, every other
observation is kept as \`provenance\` (truth_set \`duplicate\`).

## Truth sets (never mix without a flag)
- **primary**: HIGH/MEDIUM, verified actual consideration, not an estimate, market sale
  (no package, distress/transfer deed, nominal, non-arm's-length, cross-source price
  conflict). \`truth_primary_strict\` = HIGH only. Use for MAE / MdAPE, calibration,
  promotion decisions.
- **secondary**: market-looking sale with a weak price (Texas 'Estimated Sales Price'
  = concurrent loan x 1.33/1.25/1.01/0.98; uncoded provider prices in non-disclosure
  states TX/IN/MO/KS/UT/NM/ID; pool MLS prices there). Weak labels only:
  supplementary learning, coverage, sensitivity. \`label_weight\` gives the default
  HIGH 1 / MEDIUM 0.75 / LOW 0.25 / UNKNOWN 0 for weighted-training experiments.
- **excluded**: no valuation label (no price, non-market amount, package, distress
  deed, nominal, missing geo/date). Still a transaction: keep it for activity.

## Counts (canonical transactions, price_source records)
| Region | Market | Records | Transactions | Dedupe rate | Primary | of which strict | Secondary | Excluded | Primary share of labelled |
|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

(buffer) = inside the export box but outside every subject market core (comp evidence only).

## Known limits
- ${m.source.limits}.
- Indiana: the 2026-09-30 Marion County import has NO price code and the importer
  labelled it 'recorded_full'; its prices carry the non-disclosure signature (29%
  divisible by $100 vs 90-97% in disclosure states), so IND has 0 primary labels.
  The IC8 v0 "IND improved 27% -> 18% MdAPE" was measured against these labels.
- Texas: 0 HIGH-confidence prices. Doc-stated amounts (MEDIUM, unverified) are
  secondary with reason \`nondisclosure_stated_amount\`: the best Texas price
  evidence available, still not verified consideration.
- Package detection is heuristic (same date + price within a ZIP / ~1 mi, or a
  non-round price on >= 3 parcels); a deed document number is not available.
- \`nominal_flag\` on deeds is the evidence MV flag (price < 25% of the import-time
  vendor value): time-inconsistent for old sales (v0 audit).
- Knowledge time = event time (as in v0); LeadCommand ingested these corpora later.

## Files
${Object.entries(m.files).map(([f, v]) => `- \`${f}\` sha256 \`${v.sha256}\`${v.records ? `, ${v.records} records` : ""}`).join("\n")}
`;
}

export { main as buildCompsV1 };

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().then((m) => console.log(`manifest written: ${m.uri}/manifest.json`)).catch((e) => {
    console.error(`comps-v1 failed: ${String(e?.message ?? e).slice(0, 300)}`);
    process.exitCode = 1;
  });
}
