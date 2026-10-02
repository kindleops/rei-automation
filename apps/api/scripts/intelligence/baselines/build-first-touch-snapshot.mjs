#!/usr/bin/env node
/**
 * IC8 Phase 4 -- sealed dataset snapshot of first-touch sends, built with the
 * foundation builder (datasets/snapshot-builder.js) over the local extract.
 *
 * Population (rows fed to the builder): every SENT ownership_check send
 * (sent_at set), placed by coalesce(sent_at, created_at) in
 * [2026-04-20, 2026-09-29). Exclusions (datasets/exclusions.js) are applied
 * and counted by the builder. Per-family sub-populations are strata, not
 * filters, so one snapshot serves every family:
 *   - reply / opt-out families: episode leads whose lead send was delivered
 *     (delivered@1 = true);
 *   - carrier filtering: every sent send (a filtered send is never delivered:
 *     0 of 10,684 sent first touches carry both delivered_at and a Spam
 *     failure, measured 2026-10-02).
 *
 * Features: seller_first_touch_all@1 (owner decision 2026-10-01, counsel
 * approved: all prospect fields are inputs; foundation fb5682ba). The base
 * arm (seller_first_touch@1) is a strict subset of the same rows' features.
 *
 * Message bodies: the ~1.5K inbound rows are read into MEMORY ONLY for the
 * reply_meaningful@1 / opt_out_keyword@1 rules; the snapshot stores derived
 * label values only.
 *
 * Run from apps/api (after extract-first-touch.mjs):
 *   node --env-file=.env.local --no-warnings --loader ./tests/alias-loader.mjs \
 *     scripts/intelligence/baselines/build-first-touch-snapshot.mjs
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { campaignIntegrity } from "../../../src/lib/domain/analytics/lab/fact-classifiers.js";
import { buildDatasetSnapshot } from "../../../src/lib/domain/intelligence/datasets/snapshot-builder.js";
import { dedupeByProviderSid } from "../../../src/lib/domain/intelligence/datasets/exclusions.js";
import { createV1Registry } from "../../../src/lib/domain/intelligence/features/v1-features.js";
import { DEFAULT_WORK_DIR, deriveSecret } from "./extract-first-touch.mjs";
import { assignEpisodes, firstTouchKind, pseudonymizeKey } from "./lib/first-touch.mjs";
import { createRestReader } from "./lib/rest-reader.mjs";
import { haversineMiles, pointIndex } from "./lib/geo-tiles.mjs";
import { writeDatasetCard } from "./lib/dataset-card.mjs";

export const DATASETS_ROOT = "/Users/ryankindle/.claude/jobs/c39b0175/tmp/ic8/datasets";
export const DATASET_NAME = "first_touch_sends_v3";
export const LABEL_NOW = "2026-10-02T00:00:00.000Z";
export const WINDOW = Object.freeze({ from: "2026-04-20T00:00:00.000Z", to: "2026-09-29T00:00:00.000Z" });

export const SNAPSHOT_FEATURE_SET = "seller_first_touch_all@3";

export function resolveAllFieldsSet(registry) {
  if (!registry.hasSet(SNAPSHOT_FEATURE_SET)) throw new Error(`${SNAPSHOT_FEATURE_SET} missing: needs foundation commit 254fc90e or later`);
  return {
    id: SNAPSHOT_FEATURE_SET,
    note: "seller_first_touch@1 + the eight personal_attribute fields (fb5682ba) + the 40 market_investor_activity features (fddd8b0f) + school district and the two modeled-wealth bands (254fc90e); every @1/@2/@3 arm and variant B-E is a subset of these columns",
  };
}

const SALE_RADIUS_MILES = 2.05;

/** Per-property candidate market sales: within the largest radius (2 mi) or in the same ZIP. */
export function marketSalesIndex(sales) {
  const index = pointIndex(
    sales.filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude)).map((s) => ({ lat: s.latitude, lng: s.longitude, s })),
    0.05,
  );
  const byZip = groupBy(sales, (s) => (s.zip ? String(s.zip).slice(0, 5) : null));
  const cache = new Map();
  return (property) => {
    if (!property) return [];
    const key = String(property.property_id);
    if (cache.has(key)) return cache.get(key);
    const out = new Map();
    const zip = String(property.property_address_zip ?? "").trim().slice(0, 5);
    for (const s of byZip.get(zip) || []) out.set(s.sale_id, s);
    const lat = Number(property.latitude);
    const lng = Number(property.longitude);
    if (property.latitude !== null && property.longitude !== null && Number.isFinite(lat) && Number.isFinite(lng)) {
      const dLat = SALE_RADIUS_MILES / 68.5;
      const dLng = SALE_RADIUS_MILES / (68.5 * Math.max(Math.cos((lat * Math.PI) / 180), 0.05));
      for (const p of index.query(lat - dLat, lat + dLat, lng - dLng, lng + dLng)) {
        if (haversineMiles(lat, lng, p.lat, p.lng) <= SALE_RADIUS_MILES) out.set(p.s.sale_id, p.s);
      }
    }
    const list = [...out.values()].sort((a, b) => a.sale_id.localeCompare(b.sale_id));
    cache.set(key, list);
    return list;
  };
}

const lower = (v) => String(v ?? "").trim().toLowerCase();

function byKey(rows, key) {
  const map = new Map();
  for (const row of rows) map.set(String(row[key]), row);
  return map;
}

function groupBy(rows, keyOf) {
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === undefined) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

export async function loadInboundInMemory({ supabase, secret, log }) {
  const reader = createRestReader({ supabase, workDir: path.join(DEFAULT_WORK_DIR, "_memory_reads"), paceMs: 300, log });
  const raw = await reader.scanInMemory("inbound message_events", {
    query: () =>
      supabase
        .from("message_events")
        .select("id,thread_key,created_at,direction,event_type,message_body,provider_message_sid")
        .eq("direction", "inbound")
        .not("thread_key", "is", null),
  });
  const { kept, duplicates } = dedupeByProviderSid(raw);
  const rows = kept.map((r) => ({
    id: r.id,
    hk: pseudonymizeKey(r.thread_key, secret),
    created_at: r.created_at,
    direction: r.direction,
    event_type: r.event_type,
    message_body: r.message_body,
  }));
  return { rows, duplicates: duplicates.length, read: raw.length };
}

export function prepareSource({ work, inbound }) {
  const sends = work.sends;
  const coords = byKey(work.property_coords, "property_id");
  const schools = byKey(work.property_school, "property_id");
  const wealth = byKey(work.prospect_wealth, "prospect_id");
  const properties = new Map(
    work.properties.map((p) => {
      const c = coords.get(String(p.property_id));
      const school = schools.get(String(p.property_id));
      return [String(p.property_id), { ...p, latitude: c?.latitude ?? null, longitude: c?.longitude ?? null, school_district_name: school?.school_district_name ?? null }];
    }),
  );
  const salesFor = marketSalesIndex(work.market_sales);
  const owners = byKey(work.owners, "master_owner_id");
  const prospects = byKey(work.prospects, "prospect_id");
  const phonesByOwner = groupBy(work.phones, (p) => p.master_owner_id);
  const campaigns = byKey(work.campaigns, "id");
  const sendsByThread = groupBy(sends, (s) => s.hk);
  const inboundByThread = groupBy(inbound.rows, (r) => r.hk);
  const failuresBySend = groupBy(work.outbound_failures, (e) => e.queue_id);

  const population = sends
    .filter((s) => s.use_case_template === "ownership_check" && s.sent_at)
    .sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at) || String(a.id).localeCompare(String(b.id)));
  const episodes = assignEpisodes(population, { threadOf: (r) => r.internal_phone || r.hk });

  const campaignTest = new Map();
  for (const [id, c] of campaigns) campaignTest.set(id, campaignIntegrity(c).test);

  function prospectFor(send) {
    const candidates = (phonesByOwner.get(send.master_owner_id) || [])
      .filter((p) => p.hk && p.hk === send.hk && p.primary_prospect_id)
      .sort((a, b) => String(a.phone_id).localeCompare(String(b.phone_id)));
    if (!candidates.length) return null;
    const id = String(candidates[0].primary_prospect_id);
    const person = prospects.get(id);
    if (!person) return null;
    const w = wealth.get(id);
    return { ...person, net_asset_value: w?.net_asset_value ?? null, buying_power: w?.buying_power ?? null };
  }

  const rowFor = (send) => {
    const property = properties.get(String(send.property_id)) || null;
    return {
      ...send,
      thread_key: send.internal_phone || send.hk,
      campaign_is_test: send.campaign_id ? campaignTest.get(String(send.campaign_id)) === true : false,
      property_address_state: property?.property_address_state ?? null,
      property_address_zip: property?.property_address_zip ?? null,
    };
  };
  const rows = population.map(rowFor);

  const asSendRow = (s) => ({
    id: s.id,
    thread_key: s.hk,
    property_id: s.property_id,
    campaign_id: s.campaign_id,
    template_id: s.template_id,
    use_case_template: s.use_case_template,
    sent_at: s.sent_at,
    created_at: s.created_at,
    delivered_at: s.delivered_at,
  });

  return {
    rows,
    episodes,
    source: {
      async readPage({ cursor, limit }) {
        const start = cursor ? Number(cursor) : 0;
        const page = rows.slice(start, start + limit);
        return { rows: page, nextCursor: start + limit < rows.length ? String(start + limit) : null };
      },
      subjectOf(row) {
        return {
          id: row.id,
          asOf: row.sent_at || row.created_at,
          threadKey: row.hk,
          entity: {
            id: row.id,
            thread_key: row.hk,
            property_id: row.property_id,
            master_owner_id: row.master_owner_id,
            campaign_id: row.campaign_id,
            template_id: row.template_id,
            use_case_template: row.use_case_template,
            sent_at: row.sent_at,
            created_at: row.created_at,
          },
          labelSubject: {
            id: row.id,
            sent_at: row.sent_at,
            created_at: row.created_at,
            delivered_at: row.delivered_at,
            queue_status: row.queue_status,
          },
        };
      },
      loadFeatureBundle(row) {
        const owner = owners.get(String(row.master_owner_id)) || null;
        const prospect = prospectFor(row);
        const property = properties.get(String(row.property_id)) || null;
        return {
          property,
          market_sales: salesFor(property),
          owner_profile: owner,
          owner_person: owner,
          prospect_person: prospect,
          sends: (sendsByThread.get(row.hk) || []).map(asSendRow),
          // seller.property_sale / property_mortgage: not readable (see extract); left absent.
        };
      },
      loadOutcomeReads(row, def) {
        if (def.key === "carrier_filtered" || def.key === "send_failed") {
          return { outboundEvents: failuresBySend.get(String(row.id)) || [] };
        }
        if (def.key === "delivered") return {};
        return {
          inbound: inboundByThread.get(row.hk) || [],
          laterSends: (sendsByThread.get(row.hk) || []).map(asSendRow),
        };
      },
      strataOf(row) {
        const ep = episodes.get(String(row.id)) || null;
        return {
          kind: firstTouchKind(row),
          template_language: lower(row.template_language) || null,
          episode_lead: ep ? ep.position === 0 : null,
          episode_size: ep ? ep.size : null,
          episode_delivered_any: ep ? ep.delivered_any : null,
          rotation: row.rotation
            ? {
                pool_size: row.rotation.pool_size,
                pool_ids: row.rotation.pool_ids,
                selected_index: row.rotation.selected_index,
                hash_matches_logged_index: row.rotation.hash_matches_logged_index,
                pool_logged_completely: row.rotation.pool_logged_completely,
                chosen_matches_pool_slot: row.rotation.chosen_matches_pool_slot,
                strategy: row.rotation.strategy,
              }
            : null,
        };
      },
    },
  };
}

export function readWork(workDir = DEFAULT_WORK_DIR) {
  const read = (name) => {
    const file = path.join(workDir, `${name}.ndjson`);
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  return {
    sends: read("sends"),
    outbound_failures: read("outbound_failures"),
    properties: read("properties"),
    owners: read("owners"),
    phones: read("phones"),
    prospects: read("prospects"),
    campaigns: read("campaigns"),
    property_coords: read("property_coords"),
    property_school: read("property_school"),
    prospect_wealth: read("prospect_wealth"),
    market_sales: [...read("mv_sales"), ...read("engine_pool_sales")],
    marketSalesManifest: JSON.parse(fs.readFileSync(path.join(workDir, "market-sales-manifest.json"), "utf8")),
    extractManifest: JSON.parse(fs.readFileSync(path.join(workDir, "extract-manifest.json"), "utf8")),
  };
}

export function gitHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

async function main() {
  const log = console.log;
  const { supabase, hasSupabaseConfig } = await import("@/lib/supabase/client.js");
  if (!hasSupabaseConfig()) throw new Error("supabase_config_missing");
  const registry = createV1Registry();
  const allSet = resolveAllFieldsSet(registry);
  const work = readWork();
  const secret = deriveSecret("pseudonym@1");
  log("inbound messages -> memory only");
  const inbound = await loadInboundInMemory({ supabase, secret, log });
  const prepared = prepareSource({ work, inbound });
  const stagingDir = path.join(DATASETS_ROOT, "_build", DATASET_NAME);
  fs.mkdirSync(stagingDir, { recursive: true });
  let finalDir = null;
  const spec = {
    name: DATASET_NAME,
    description: "Sent ownership_check (first-touch) sends with v1 features as of the send and multi-horizon outcomes.",
    subjectType: "send",
    population: {
      definition:
        "send_queue rows with use_case_template='ownership_check' and sent_at set, placed by coalesce(sent_at, created_at) in the as-of window",
      unit: "send; episode strata group sends on one thread within 10 minutes (lead = first send)",
      reply_and_opt_out_families: "episode leads whose lead send was delivered (delivered@1 true)",
      carrier_filtering_family: "every sent send",
      feature_set_note: allSet.note,
      inbound_reads: { rows: inbound.read, duplicates_by_provider_sid: inbound.duplicates },
      market_sales: { mv_rows: work.marketSalesManifest.tile_state.rows, engine_pool_rows: work.marketSalesManifest.engine_pool_rows, tile_calls: work.marketSalesManifest.tile_state.calls, truncated_tiles: work.marketSalesManifest.tile_state.truncated_tiles, from: work.marketSalesManifest.from },
    },
    asOfWindow: WINDOW,
    featureSetId: allSet.id,
    outcomes: [
      { key: "reply_any", version: 1 },
      { key: "reply_meaningful", version: 1 },
      { key: "opt_out_keyword", version: 1 },
      { key: "carrier_filtered", version: 1 },
      { key: "delivered", version: 1 },
    ],
    primaryOutcome: { key: "reply_any", version: 1, horizon: "72h" },
    labelNow: LABEL_NOW,
    pageSize: 500,
    paceMs: 0,
    strata: ["kind", "template_language", "episode_lead", "episode_size", "episode_delivered_any", "rotation"],
    knownBiases: [
      "properties table bulk-rewritten 2026-08: structural facts carry post-T data-quality corrections",
      "seller.property_sale / property_mortgage unreadable via PostgREST: years_since_last_recorded_sale is missing on every row and recorded_mortgage_count is a false 0 on every row; both are excluded from every model",
      "legacy feeder (Apr-Aug) vs campaign/Map (Jun-Sep) distribution shift: the Jul-Sep test window is a different sending system",
      "prospects/master_owners person attributes are a 2026-04 vendor import (static as_of)",
      "reply attribution is by thread (phone); a later send on the thread inside 72h is not removed in labeler v1",
      "reply_meaningful@1 rules are text rules (rules.js v1), not yet validated against the 7.2 operator-reviewed corpus",
      "market_investor_activity: comps evidence was fetched only within 2.5 miles of each first-touch property, so ZIP-level counts are lower bounds where a ZIP extends further; radius and 1 km cell features are complete within the RPC's corpus",
      "market_investor_activity: the buyer-index archetype is computed over each buyer's full history (post-T purchases included), per the foundation lineage",
    ],
  };
  const manifest = await buildDatasetSnapshot(spec, {
    source: prepared.source,
    registry,
    outDir: stagingDir,
    codeCommit: gitHead(),
    salt: deriveSecret(`dataset-salt@1|${DATASET_NAME}`).slice(0, 32),
    sleep: async () => {},
    upload: async ({ dataPath, manifest: m }) => {
      finalDir = path.join(DATASETS_ROOT, m.dataset_id);
      if (fs.existsSync(path.join(finalDir, "manifest.json"))) throw new Error(`${finalDir} already holds a sealed snapshot`);
      fs.mkdirSync(finalDir, { recursive: true });
      const target = path.join(finalDir, path.basename(dataPath));
      fs.copyFileSync(dataPath, target);
      return `file://${target}`;
    },
  });
  fs.renameSync(path.join(stagingDir, `${DATASET_NAME}.manifest.json`), path.join(finalDir, "manifest.json"));
  fs.rmSync(path.join(stagingDir, `${DATASET_NAME}.ndjson.gz`), { force: true });
  writeDatasetCard({ dir: finalDir, manifest, extractManifest: work.extractManifest, registry });
  log(`sealed ${manifest.dataset_id} rows=${manifest.row_count} sha256=${manifest.sha256}`);
  log(`dir ${finalDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`build failed: ${String(error?.stack || error).slice(0, 800)}`);
    process.exit(1);
  });
}
