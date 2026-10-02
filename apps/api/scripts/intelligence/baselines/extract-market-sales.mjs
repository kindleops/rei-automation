#!/usr/bin/env node
/**
 * IC8 Phase 4 -- production extract of market sales for the
 * market_investor_activity feature group (seller_first_touch@2 / _all@2).
 *
 * READ-ONLY, gentle, checkpointed (rerun to resume):
 *   1. properties.latitude/longitude for the first-touch properties (`in`
 *      batches of 150);
 *   2. public.v_recent_sold_comps sold since 2025-03-01 (keyset pages of
 *      1000; explicit columns; corpus "engine_pool");
 *   3. comp_private.mv_comp_market_evidence through the STABLE service-role
 *      RPC public.comps_market_evidence, tiled by an adaptive quadtree over
 *      only the areas within 2.5 miles of a first-touch property
 *      (lib/geo-tiles.mjs). Large tiles are count-probed with p_limit=1 and
 *      split when the circle holds more than 400 rows, so no call is ever
 *      truncated. p_months=19 covers 2025-03 onward (12 trailing months of
 *      the earliest send plus margin).
 * The RPC returns whole rows; only sale date, zip, coordinates, buyer
 * kind/archetype, nominal flag, corpus and ids are kept. Names, buyer
 * companies and addresses are dropped in memory and never written.
 *
 * Coverage caveat: ZIP-level features see only sales inside the fetched
 * tiles (>= 2.5 miles around each property), so for ZIPs that extend further
 * the ZIP count is a lower bound.
 *
 * Run from apps/api (after extract-first-touch.mjs):
 *   node --env-file=.env.local --no-warnings --loader ./tests/alias-loader.mjs \
 *     scripts/intelligence/baselines/extract-market-sales.mjs
 */

import fs from "node:fs";
import path from "node:path";

import { DEFAULT_WORK_DIR } from "./extract-first-touch.mjs";
import { createRestReader } from "./lib/rest-reader.mjs";
import { inTile, rootTiles, splitTile, tileCircle, tileKey, tileNearPoints } from "./lib/geo-tiles.mjs";
import { annotateMarketSale } from "../../../src/lib/domain/intelligence/transactions/market-sales-provenance.js";

export const MARKET_SALES_FROM = "2025-03-01";
const RPC_CAP = 400;
const PROBE_ABOVE_DEG = 0.03;
const MIN_TILE_DEG = 0.002;
const BUFFER_MILES = 2.5;

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// IC8.1: nominal_price is true only when the price itself is reliable (annotateMarketSale);
// a weak (estimated / placeholder) price never removes a transaction from activity counts.
export function mvRowToSale(r) {
  const saleDate = r.event_date ? String(r.event_date).slice(0, 10) : null;
  return {
    sale_id: `mv:${r.txn_id}`,
    property_id: r.property_id ?? null,
    sale_date: r.event_date ? String(r.event_date).slice(0, 10) : null,
    corpus: r.corpus ?? null,
    zip: r.zip ? String(r.zip).slice(0, 5) : null,
    latitude: num(r.lat),
    longitude: num(r.lng),
    buyer_kind: r.buyer_kind ?? null,
    buyer_archetype: r.buyer_archetype ?? null,
    engine_source: null,
    raw_source: null,
    mls: null,
    ...annotateMarketSale(r, { corpus: r.corpus ?? null, saleDate }),
  };
}

export function poolRowToSale(r) {
  const date = r.sale_date || r.mls_sold_date;
  return {
    sale_id: `pool:${r.id}`,
    property_id: r.property_id ?? null,
    sale_date: date ? String(date).slice(0, 10) : null,
    corpus: "engine_pool",
    zip: r.property_address_zip ? String(r.property_address_zip).slice(0, 5) : null,
    latitude: num(r.latitude),
    longitude: num(r.longitude),
    buyer_kind: null,
    buyer_archetype: null,
    engine_source: r.sale_source ?? null,
    raw_source: null,
    mls: r.mls_sold_date ? true : null,
    ...annotateMarketSale(r, { corpus: "engine_pool", saleDate: date ? String(date).slice(0, 10) : null }),
  };
}

export async function runMarketSalesExtract({ workDir = DEFAULT_WORK_DIR, log = console.log } = {}) {
  const { supabase, hasSupabaseConfig } = await import("@/lib/supabase/client.js");
  if (!hasSupabaseConfig()) throw new Error("supabase_config_missing");
  const reader = createRestReader({ supabase, workDir, paceMs: 250, log });
  const sends = reader.readTable("sends");
  if (!sends.length) throw new Error("run extract-first-touch.mjs first");
  const propertyIds = sends.filter((s) => s.use_case_template === "ownership_check" && s.sent_at).map((s) => s.property_id);

  log("property coordinates");
  const coords = await reader.lookup("property_coords", {
    ids: propertyIds,
    column: "property_id",
    query: () => supabase.from("properties").select("property_id,latitude,longitude"),
  });

  log("v_recent_sold_comps (engine pool) since 2025-03-01");
  await reader.scan("engine_pool_sales", {
    query: () =>
      supabase
        .from("v_recent_sold_comps")
        .select("id,property_id,property_address_state,property_address_zip,latitude,longitude,sale_date,mls_sold_date,sale_source,sale_price,mls_sold_price")
        .or(`sale_date.gte.${MARKET_SALES_FROM},mls_sold_date.gte.${MARKET_SALES_FROM}`),
    transform: (rows) => rows.map(poolRowToSale),
  });

  log("comps_market_evidence tiles");
  const points = coords.map((c) => ({ lat: num(c.latitude), lng: num(c.longitude) })).filter((p) => p.lat !== null && p.lng !== null);
  const { tiles, index } = rootTiles(points, { size: 0.12, bufferMiles: BUFFER_MILES });
  const statePath = path.join(workDir, "mv_tiles_state.json");
  const rowsPath = path.join(workDir, "mv_sales.ndjson");
  let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
  if (!state) {
    state = { queue: tiles, done: 0, calls: 0, probes: 0, splits: 0, truncated_tiles: 0, rows: 0, bytes: 0, roots: tiles.length, finished: false };
    fs.writeFileSync(rowsPath, "");
  }
  fs.truncateSync(rowsPath, state.bytes);
  const seen = new Set();
  const save = () => {
    fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
    fs.renameSync(`${statePath}.tmp`, statePath);
  };
  const months = Math.ceil((Date.now() - Date.parse(`${MARKET_SALES_FROM}T00:00:00Z`)) / (30.4375 * 86400e3)) + 1;
  while (state.queue.length) {
    const tile = state.queue[0];
    const circle = tileCircle(tile);
    const rpc = (limit) =>
      reader.call(
        () => supabase.rpc("comps_market_evidence", { p_lat: circle.lat, p_lng: circle.lng, p_radius_miles: Number(circle.radius.toFixed(4)), p_months: months, p_family: null, p_limit: limit }),
        `tile ${tileKey(tile)}`,
      );
    let children = null;
    let kept = [];
    if (tile.size > PROBE_ABOVE_DEG) {
      const probe = await rpc(1);
      state.calls += 1;
      state.probes += 1;
      const total = Number(probe?.total_in_radius ?? 0);
      if (total > RPC_CAP) children = splitTile(tile);
      else if (total > 0) {
        const full = await rpc(RPC_CAP);
        state.calls += 1;
        kept = full?.rows || [];
      }
    } else {
      const full = await rpc(RPC_CAP);
      state.calls += 1;
      const total = Number(full?.total_in_radius ?? 0);
      const returned = Number(full?.returned ?? 0);
      if (total > returned && tile.size / 2 >= MIN_TILE_DEG) children = splitTile(tile);
      else {
        if (total > returned) state.truncated_tiles += 1;
        kept = full?.rows || [];
      }
    }
    state.queue.shift();
    if (children) {
      const near = children.filter((c) => tileNearPoints(c, index, BUFFER_MILES));
      state.splits += 1;
      state.queue.unshift(...near);
    } else {
      const sales = kept.filter((r) => inTile(tile, Number(r.lat), Number(r.lng)) && !seen.has(String(r.txn_id))).map(mvRowToSale);
      for (const s of sales) seen.add(s.sale_id.slice(3));
      if (sales.length) fs.appendFileSync(rowsPath, sales.map((s) => `${JSON.stringify(s)}\n`).join(""));
      state.rows += sales.length;
      state.bytes = fs.statSync(rowsPath).size;
      state.done += 1;
    }
    save();
    if (state.calls % 50 === 0) log(`  tiles done ${state.done}, queue ${state.queue.length}, calls ${state.calls}, rows ${state.rows}`);
  }
  state.finished = true;
  save();
  const manifestPath = path.join(workDir, "market-sales-manifest.json");
  const manifest = {
    from: MARKET_SALES_FROM,
    p_months: months,
    buffer_miles: BUFFER_MILES,
    root_tiles: state.roots,
    tile_state: { done: state.done, calls: state.calls, probes: state.probes, splits: state.splits, truncated_tiles: state.truncated_tiles, rows: state.rows },
    engine_pool_rows: reader.readTable("engine_pool_sales").length,
    property_coords: coords.length,
    properties_with_coords: points.length,
    pii: "names, buyer companies and addresses dropped in memory; only ids, dates, zip, coordinates, buyer kind/archetype, nominal flag, corpus kept",
    rest_calls_total: reader.stats().calls,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`market sales extract complete: ${JSON.stringify(manifest.tile_state)}`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMarketSalesExtract().catch((error) => {
    console.error(`market sales extract failed: ${String(error?.message || error).slice(0, 300)}`);
    process.exit(1);
  });
}
