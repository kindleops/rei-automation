// ─── campaign-graph-demographic-coverage-20261007.test.mjs ───────────────────
// "None of the prospect demographic filters work" (owner, 2026-10-07).
// Root cause: the 10:18Z full rebuild (stage_commit TRUNCATE + INSERT stage.*)
// blanked every column only campaign_target_graph_enrich_rows writes, so gender,
// age, income… were ~1% filled and every demographic filter returned ~0 without a
// word; prospect_id was never projected at all.
// Pinned here:
//   (a) the Composer states a sparse filter's reach ("Gender is known for 1.1% …")
//       instead of silently returning ~0, and the field catalog carries coverage;
//   (b) the shared re-projection driver (person / property / scores sets) is
//       resumable, backs off on lock/busy, halves on timeouts, refuses the
//       heavy-read window and never mixes column sets on one cursor;
//   (c) the PROPOSED SQL keeps the one-person join (no substitute principal),
//       carries the projection across a rebuild, and its rollback is complete.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  annotateCatalogFieldApplicability,
  describeFilterCoverage,
  formatCoverageShare,
  loadGraphColumnCoverage,
  resetGraphColumnPopulationCache,
} from "@/lib/domain/campaigns/campaign-graph-filter-plan.js";
import {
  estimateReprojectionMinutes,
  inBlockedWindow,
  normalizeReprojectionSets,
  runGraphReprojection,
} from "@/lib/domain/campaigns/campaign-graph-reprojection.js";
import { previewCampaignTargets } from "@/lib/domain/campaigns/campaign-automation-service.js";
import { makeCampaignQueuePlanStore } from "../helpers/campaign-queue-plan-store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, "../../../../supabase/migrations");
const readMigration = (name) => fs.readFileSync(path.join(migrations, name), "utf8");

// Production, 2026-10-07 10:15Z (1,912 of 176,605 rows carried a gender).
const PROD_GENDER = { known: 1912, total: 176605, share: 1912 / 176605 };

// ── (a) coverage is said out loud ───────────────────────────────────────────

test("coverage note: a demographic filter on a 1%-filled column states its reach", () => {
  const coverage = new Map([["gender", PROD_GENDER]]);
  const notes = describeFilterCoverage([{ field_key: "prospects.gender", operator: "is_any_of", value: ["Female"] }], coverage);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, "coverage");
  assert.equal(notes[0].low, true);
  assert.equal(notes[0].known, 1912);
  assert.match(notes[0].message, /is known for 1\.1% of the campaign audience \(about 1,912 of 176,605 sellers\)/);
});

test("coverage note: demographics always state reach below ~100%; other fields only when sparse", () => {
  const coverage = new Map([
    ["gender", { known: 139000, total: 176605, share: 0.787 }],
    ["beds", { known: 150000, total: 176605, share: 0.85 }],
    ["year_built", { known: 40000, total: 176605, share: 0.226 }],
    ["market", { known: 176605, total: 176605, share: 1 }],
  ]);
  const notes = describeFilterCoverage([
    { field_key: "prospects.gender", operator: "is_any_of", value: ["Male"] },
    { field_key: "properties.total_bedrooms", operator: "gte", value: 3 },
    { field_key: "properties.year_built", operator: "lte", value: 1960 },
    { field_key: "properties.market", operator: "is_any_of", value: ["Dallas"] },
  ], coverage);
  assert.deepEqual(notes.map((n) => n.field_key).sort(), ["properties.year_built", "prospects.gender"]);
  assert.equal(notes.find((n) => n.field_key === "prospects.gender").low, false);
  assert.match(notes.find((n) => n.field_key === "prospects.gender").message, /79%/);
});

test("coverage note: unknown coverage is never reported as 0%", () => {
  assert.deepEqual(describeFilterCoverage([{ field_key: "prospects.gender", operator: "is_any_of", value: ["Male"] }], new Map()), []);
  assert.deepEqual(describeFilterCoverage([{ field_key: "prospects.gender", operator: "is_any_of", value: ["Male"] }], null), []);
  assert.equal(formatCoverageShare(0.0004), "<0.1%");
  assert.equal(formatCoverageShare(0.0108), "1.1%");
  assert.equal(formatCoverageShare(0.786), "79%");
});

test("coverage probe: planner estimates per column over the planned audience total", async () => {
  resetGraphColumnPopulationCache();
  const estimates = { gender: 1912, age_bucket: 1837, income: null };
  const supabase = {
    from() {
      const q = {
        _col: null,
        _head: false,
        select(cols, opts) { q._head = Boolean(opts?.head); if (!opts) q._col = cols; return q; },
        not(col) { q._col = col; return q; },
        limit() {
          if (!q._col) return Promise.resolve({ count: 176605, error: null });
          const value = estimates[q._col];
          return Promise.resolve(value === null ? { count: null, error: { message: "", code: "" } } : { count: value, error: null, data: [] });
        },
      };
      return q;
    },
  };
  const coverage = await loadGraphColumnCoverage(supabase, { columns: ["gender", "age_bucket", "income"], now: 1 });
  assert.equal(coverage.get("gender").total, 176605);
  assert.ok(Math.abs(coverage.get("gender").share - 0.01083) < 0.0001);
  assert.equal(coverage.get("age_bucket").known, 1837);
  assert.equal(coverage.has("income"), false, "no estimate -> unknown, not 0%");
  resetGraphColumnPopulationCache();
});

test("field catalog: applicable fields carry their coverage", () => {
  const coverage = new Map([["gender", PROD_GENDER]]);
  const [field] = annotateCatalogFieldApplicability([{ key: "prospects.gender", label: "Gender" }], { population: new Map([["gender", true]]), coverage });
  assert.equal(field.campaign_applicable, true, "a sparse demographic stays a live targeting input");
  assert.equal(field.campaign_coverage.known, 1912);
  assert.equal(field.campaign_coverage_message, "Known for 1.1% of the campaign audience");
});

test("Reach: a gender filter is applied AND its coverage reaches filter_notes", async () => {
  const store = makeCampaignQueuePlanStore();
  const row = (i, gender) => ({
    graph_id: `graph_${i}`, property_id: `prop_${i}`, seller_person_key: `person_${i}`,
    canonical_e164: `+1555300${String(1000 + i).slice(-4)}`, market: "Dallas, TX", state: "TX",
    property_type: "Single Family", gender, sms_eligible: true, queue_eligible: true, sender_covered: true,
    identity_alignment: "verified", never_contacted: true, touch_count: 0, timezone: "America/Chicago",
  });
  store.seedRow("campaign_target_graph", row(1, "Female"));
  store.seedRow("campaign_target_graph", row(2, null));
  store.seedRow("campaign_target_graph", row(3, "Male"));
  const preview = await previewCampaignTargets({
    source: "campaign_target_graph",
    filters: { prospects: [{ field_key: "prospects.gender", operator: "is_any_of", value: ["Female"] }] },
    build_limit: 10,
  }, {
    supabase: store.supabase,
    graphColumnPopulation: new Map([["gender", true]]),
    graphColumnCoverage: new Map([["gender", PROD_GENDER]]),
    loadDispatchBlockedSets: async () => ({ template_ids: new Set(), sender_numbers: new Set() }),
  });
  assert.equal((preview.inapplicable_filters || []).length, 0, "not refused");
  const note = (preview.filter_notes || []).find((n) => n.field_key === "prospects.gender");
  assert.ok(note, `coverage note present: ${JSON.stringify(preview.filter_notes)}`);
  assert.match(note.message, /1\.1% of the campaign audience/);
});

// ── (b) the shared re-projection driver ─────────────────────────────────────

const at = (iso) => { let t = new Date(iso).getTime(); return { now: () => new Date(t), advance: (ms) => { t += ms; } }; };

test("reprojection: walks the keyset to done, saving the cursor after every batch", async () => {
  const clock = at("2026-10-08T03:00:00Z");
  const pages = [["a", true], ["b", true], ["c", false]];
  const calls = [];
  const saved = [];
  const result = await runGraphReprojection({
    sets: "person,property,scores",
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
    saveState: async (s) => saved.push(s),
    call: async (args) => {
      calls.push(args);
      const [next, more] = pages[calls.length - 1];
      return { rows_scanned: 400, rows_updated: 10, next_after_graph_id: next, has_more: more, skipped: null, elapsed_ms: 900 };
    },
  });
  assert.equal(result.stop_reason, "done");
  assert.equal(result.done, true);
  assert.deepEqual(calls.map((c) => c.after), [null, "a", "b"]);
  assert.deepEqual(calls[0].sets, ["person", "property", "scores"]);
  assert.equal(result.rows_scanned, 1200);
  assert.equal(result.rows_updated, 30);
  assert.ok(saved.length >= 3);
});

test("reprojection: resumes from a saved cursor and refuses a cursor for other sets", async () => {
  const clock = at("2026-10-08T03:00:00Z");
  const calls = [];
  const result = await runGraphReprojection({
    sets: ["person"],
    state: { after: "m", sets: ["person"], rows_scanned: 800, rows_updated: 5, batches: 2, done: false },
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
    call: async (args) => { calls.push(args); return { rows_scanned: 10, rows_updated: 1, next_after_graph_id: "z", has_more: false }; },
  });
  assert.equal(calls[0].after, "m");
  assert.equal(result.rows_scanned, 810);
  await assert.rejects(runGraphReprojection({
    sets: ["property"],
    state: { after: "m", sets: ["person"], done: false },
    call: async () => ({}),
  }), /saved cursor is for sets/);
});

test("reprojection: lock/busy skips keep the cursor and back off; timeouts halve the batch", async () => {
  const clock = at("2026-10-08T03:00:00Z");
  const sleeps = [];
  const calls = [];
  let n = 0;
  const result = await runGraphReprojection({
    sets: ["property"],
    batchSize: 400,
    pauseMs: 1000,
    now: clock.now,
    sleep: async (ms) => { sleeps.push(ms); clock.advance(ms); },
    call: async (args) => {
      calls.push(args);
      n += 1;
      if (n === 1) return { skipped: "locked", next_after_graph_id: args.after, has_more: true };
      if (n === 2) { const e = new Error("canceling statement due to statement timeout"); e.code = "57014"; throw e; }
      return { rows_scanned: args.limit, rows_updated: 0, next_after_graph_id: "k", has_more: false, elapsed_ms: 10 };
    },
  });
  assert.equal(result.stop_reason, "done");
  assert.equal(calls[1].after, null, "the skipped batch is retried from the same cursor");
  assert.equal(calls[2].limit, 200, "timeout -> half batch");
  assert.ok(sleeps[0] >= 4000, "skip backs off");
});

test("reprojection: duty cycle — never pauses less than the batch took", async () => {
  const clock = at("2026-10-08T03:00:00Z");
  const sleeps = [];
  let n = 0;
  await runGraphReprojection({
    sets: ["scores"],
    pauseMs: 500,
    now: clock.now,
    sleep: async (ms) => { sleeps.push(ms); clock.advance(ms); },
    call: async () => { n += 1; return { rows_scanned: 400, rows_updated: 0, next_after_graph_id: `c${n}`, has_more: n < 2, elapsed_ms: 2500 }; },
  });
  assert.deepEqual(sleeps, [2500]);
});

test("reprojection: refuses the 09:15–11:59Z heavy-read window and stops on max minutes", async () => {
  assert.equal(inBlockedWindow(new Date("2026-10-07T10:15:00Z")), true);
  assert.equal(inBlockedWindow(new Date("2026-10-07T12:00:00Z")), false);
  assert.equal(inBlockedWindow(new Date("2026-10-07T09:14:00Z")), false);
  const blocked = await runGraphReprojection({
    sets: ["person"], now: () => new Date("2026-10-07T10:15:00Z"),
    call: async () => { throw new Error("must not be called"); },
  });
  assert.equal(blocked.stop_reason, "blocked_window");

  const clock = at("2026-10-08T03:00:00Z");
  const capped = await runGraphReprojection({
    sets: ["person"], maxMinutes: 1, pauseMs: 20000, now: clock.now,
    sleep: async (ms) => clock.advance(ms),
    call: async () => ({ rows_scanned: 400, rows_updated: 0, next_after_graph_id: "x", has_more: true, elapsed_ms: 100 }),
  });
  assert.equal(capped.stop_reason, "max_minutes");
  assert.equal(capped.done, false);
});

test("reprojection: column sets are validated; ETA for the full graph", () => {
  assert.deepEqual(normalizeReprojectionSets("Person, property"), ["person", "property"]);
  assert.throws(() => normalizeReprojectionSets("person,demographics"), /unknown column set/);
  assert.throws(() => normalizeReprojectionSets(""), /at least one/);
  const eta = estimateReprojectionMinutes({ rows: 176605, batchSize: 400, workMs: 1200, pauseMs: 1500 });
  assert.equal(eta.batches, 442);
  assert.ok(eta.minutes >= 15 && eta.minutes <= 25, `eta ${eta.minutes}`);
});

// ── (c) the PROPOSED SQL ────────────────────────────────────────────────────

const SQL = readMigration("PROPOSED_20261007180000_ctg_person_property_reprojection.sql");
const ROLLBACK = readMigration("PROPOSED_20261007180000_ctg_person_property_reprojection_rollback.sql");
const fnBody = (sql, name) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  assert.ok(start >= 0, `${name} defined`);
  return sql.slice(start, sql.indexOf("$function$;", start));
};

test("SQL: one person truth — seller.owner then the same person's prospect; no substitute principal", () => {
  const person = fnBody(SQL, "campaign_target_graph_person_source");
  assert.match(person, /seller\.owner o ON o\.individual_key = g\.seller_person_key/);
  assert.match(person, /p\.individual_key = g\.seller_person_key/);
  assert.match(person, /is_primary_prospect DESC NULLS LAST/);
  assert.doesNotMatch(person, /master_owner_id/, "never the master owner's primary prospect");
  assert.doesNotMatch(person, /public\.phones/, "never a phone-linked stranger");
  assert.match(person, /campaign_birth_month_age\(o\.month_of_birth\)/);
  assert.match(person, /campaign_birth_month_age\(pr\.mob\)/);
  assert.match(fnBody(SQL, "campaign_birth_month_age"), /\/\(19\|20\)/, "MM/YYYY accepted");
});

test("SQL: enrich_rows reads the shared sources and projects prospect_id", () => {
  const enrich = fnBody(SQL, "campaign_target_graph_enrich_rows");
  assert.match(enrich, /campaign_target_graph_person_source\(p_graph_ids\)/);
  assert.match(enrich, /campaign_target_graph_property_source\(p_graph_ids\)/);
  assert.match(enrich, /prospect_id\s+= c\.ps_prospect_id/);
  assert.match(enrich, /enrich_version\s+= 'ctg_enrich_v2'/);
});

test("SQL: re-projection never touches eligibility and writes only changed rows", () => {
  const rows = fnBody(SQL, "campaign_target_graph_reproject_rows");
  const update = rows.slice(rows.indexOf("UPDATE public.campaign_target_graph t SET"));
  for (const column of ["sms_eligible", "queue_eligible", "queue_block_reason", "enriched_at", "sender_covered"]) {
    assert.doesNotMatch(update, new RegExp(`\\b${column}\\s*=`), `${column} untouched`);
  }
  assert.match(update, /IS DISTINCT FROM/);
  const batch = fnBody(SQL, "campaign_target_graph_reproject_batch");
  assert.match(batch, /pg_try_advisory_xact_lock\(hashtext\('campaign_target_graph_projection'\)\)/);
  assert.match(batch, /campaign_target_graph_load_ok\(\)/);
});

test("SQL: a rebuild carries the projection forward before the TRUNCATE and reopens reconcile after", () => {
  const commit = fnBody(SQL, "refresh_campaign_target_graph_stage_commit");
  const carry = commit.indexOf("UPDATE public.campaign_target_graph_stage s SET");
  const truncate = commit.indexOf("TRUNCATE TABLE public.campaign_target_graph;");
  const reopen = commit.indexOf("WHERE key = 'reconcile'");
  assert.ok(carry > 0 && carry < truncate, "carry-forward happens before the swap");
  assert.ok(reopen > truncate, "reconcile reopened after the swap");
  assert.match(commit, /g\.seller_person_key IS NOT DISTINCT FROM s\.seller_person_key/);
  assert.match(commit, /refresh_campaign_target_graph_sender_coverage\(\s*'refresh_campaign_target_graph_stage_commit'\s*\)/, "sender coverage call unchanged");
});

test("SQL: incremental tick gives spare capacity to never-enriched rows without moving the watermark", () => {
  const tick = fnBody(SQL, "campaign_target_graph_incremental_tick");
  assert.match(tick, /WHERE g\.enriched_at IS NULL/);
  assert.match(tick, /NULL::timestamptz AS ts/);
  assert.match(tick, /ORDER BY 2 NULLS LAST/);
});

test("SQL: rollback restores the three live definitions and drops every new function", () => {
  for (const name of ["campaign_target_graph_enrich_rows", "campaign_target_graph_incremental_tick", "refresh_campaign_target_graph_stage_commit"]) {
    assert.equal(ROLLBACK.split(`CREATE OR REPLACE FUNCTION public.${name}(`).length - 1, 1, `${name} restored once`);
  }
  assert.doesNotMatch(ROLLBACK, /campaign_target_graph_person_source\(p_graph_ids\)/, "restored enrich_rows is the pre-migration body");
  for (const name of ["reproject_batch", "reproject_rows", "property_source", "person_source"]) {
    assert.match(ROLLBACK, new RegExp(`DROP FUNCTION IF EXISTS public\\.campaign_target_graph_${name}\\(`));
  }
  assert.match(ROLLBACK, /DROP FUNCTION IF EXISTS public\.campaign_age_bucket\(integer\)/);
  assert.match(ROLLBACK, /DROP FUNCTION IF EXISTS public\.campaign_birth_month_age\(text, date\)/);
});
