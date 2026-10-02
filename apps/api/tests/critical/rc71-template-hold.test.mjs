/**
 * RC 7.1 owner decision 2 — targets that fail the template check are HELD
 * (blocked with the reason), not left `ready` and re-rendered every 5 minutes.
 * They return to ready only when the template catalogue changes, and a
 * campaign whose remaining audience is held can complete.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  TEMPLATE_HOLD_PREFIX,
  holdTemplateFailedTargets,
  isTemplateHoldReason,
  loadTemplateCatalogFingerprint,
  releaseTemplateHoldsOnCatalogChange,
} from "@/lib/domain/campaigns/campaign-template-hold.js";
import { feedCampaignBatch } from "@/lib/domain/campaigns/run-campaign-outbound-feeder.js";

function makeStore(targets, templates = []) {
  return {
    now: Date.parse("2026-10-01T18:00:00Z"),
    targets,
    templates,
    queue: [],
    transitions: [],
    campaign: {
      id: "camp", name: "Map area · Dallas", status: "active", auto_queue_enabled: true,
      daily_cap: 750, total_cap: 1000, contact_window_start: "08:00", contact_window_end: "21:00",
      metadata: { timezone: "America/Chicago" },
    },
  };
}

/** PostgREST-shaped builder over the store (eq/in/not/like/gte/order/limit/update/select). */
function fakeSupabase(store) {
  return {
    from(table) {
      const filters = [];
      let head = false;
      let patch = null;
      let limitN = null;
      const rows = () => ({ campaign_targets: store.targets, send_queue: store.queue, sms_templates: store.templates }[table] || [store.campaign]);
      const run = () => {
        let out = rows().filter((r) => filters.every((f) => f(r)));
        if (limitN != null) out = out.slice(0, limitN);
        if (patch) {
          for (const r of out) Object.assign(r, patch);
          return { data: out.map((r) => ({ id: r.id })), error: null };
        }
        return head ? { count: out.length, data: null, error: null } : { data: out, count: out.length, error: null };
      };
      const b = {
        select(_c, opts = {}) { head = Boolean(opts.head); return b; },
        update(p) { patch = p; return b; },
        eq(col, v) { filters.push((r) => (col === "campaign_id" ? (r.campaign_id ?? "camp") === v : r[col] === v)); return b; },
        in(col, vals) { filters.push((r) => vals.includes(r[col])); return b; },
        not(col, op, v) {
          if (op === "is") filters.push((r) => r[col] != null);
          else { const vals = String(v).replace(/[()]/g, "").split(","); filters.push((r) => !vals.includes(r[col])); }
          return b;
        },
        like(col, pattern) { const prefix = pattern.replace(/%$/, ""); filters.push((r) => String(r[col] || "").startsWith(prefix)); return b; },
        gte(col, v) { filters.push((r) => String(r[col]) >= v); return b; },
        order() { return b; },
        limit(n) { limitN = n; return b; },
        maybeSingle: async () => ({ data: run().data?.[0] || null, error: null }),
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return b;
    },
  };
}

/** Plan double: targets listed in `failing` fail the template check; the rest queue. */
function planWithFailures(store, failing) {
  let renders = 0;
  const plan = async (_id, input) => {
    const ready = store.targets.filter((t) => t.target_status === "ready").slice(0, input.limit);
    const holds = [];
    const skipped = {};
    let created = 0;
    for (const t of ready) {
      renders += 1;
      const reason = failing.get(t.id);
      if (reason) {
        holds.push({ target: { ...t }, reason, detail: "blank_greeting_rendered", template_id: null });
        skipped[reason] = (skipped[reason] || 0) + 1;
        continue;
      }
      t.target_status = "planned";
      store.queue.push({ id: `q${store.queue.length}`, campaign_id: "camp", queue_status: "sent", updated_at: new Date(store.now).toISOString(), metadata: {} });
      created += 1;
    }
    return { ok: true, send_queue_rows_created: created, skipped_counts_by_reason: skipped, blockers: [], template_hold_targets: holds };
  };
  plan.renders = () => renders;
  return plan;
}

const deps = (store, plan, extra = {}) => ({
  supabase: fakeSupabase(store),
  now: store.now,
  createCampaignQueuePlan: plan,
  recomputeCampaignProgress: async () => ({}),
  recycleFilteredSends: async () => ({ recycled: 0 }),
  transitionCampaignStatus: async (_s, _id, to) => { store.transitions.push(to); store.campaign.status = to; return { ok: true }; },
  ...extra,
});

test("only template-check failures are hold reasons (capacity/routing/suppression are not)", () => {
  assert.equal(isTemplateHoldReason("TEMPLATE_RENDER_LINT_FAILURE"), true);
  assert.equal(isTemplateHoldReason("NO_TEMPLATE"), true);
  for (const r of ["schedule_window_full", "per_sender_cap_reached", "ROUTING_BLOCKED", "prior_contacted_suppression", "template_blocked_by_operator"]) {
    assert.equal(isTemplateHoldReason(r), false, r);
  }
});

test("a hold is conditional on ready and records the reason + catalogue fingerprint", async () => {
  const store = makeStore([
    { id: "a", target_status: "ready", metadata: { keep: 1 } },
    { id: "b", target_status: "planned", metadata: {} }, // never overwritten
  ]);
  const out = await holdTemplateFailedTargets(fakeSupabase(store), [
    { target: store.targets[0], reason: "NO_TEMPLATE" },
    { target: store.targets[1], reason: "NO_TEMPLATE" },
    { target: { id: "c" }, reason: "per_sender_cap_reached" },
  ], { fingerprint: "fp1", now: new Date(store.now) });
  assert.equal(out.held, 1);
  assert.equal(store.targets[0].target_status, "blocked");
  assert.equal(store.targets[0].block_reason, `${TEMPLATE_HOLD_PREFIX}NO_TEMPLATE`);
  assert.equal(store.targets[0].metadata.keep, 1);
  assert.equal(store.targets[0].metadata.template_hold.catalog_fingerprint, "fp1");
  assert.match(store.targets[0].metadata.template_hold.words, /No approved message/);
  assert.equal(store.targets[1].target_status, "planned");
});

test("release only on a catalogue change, and never for other block reasons", async () => {
  const held = (id, fp) => ({ id, target_status: "blocked", block_reason: `${TEMPLATE_HOLD_PREFIX}NO_TEMPLATE`, metadata: { template_hold: { reason_code: "NO_TEMPLATE", catalog_fingerprint: fp } } });
  const store = makeStore([held("a", "fp1"), { id: "dnc", target_status: "blocked", block_reason: "opted_out", metadata: {} }]);
  const same = await releaseTemplateHoldsOnCatalogChange(fakeSupabase(store), "camp", { fingerprint: "fp1" });
  assert.equal(same.released, 0);
  assert.equal(store.targets[0].target_status, "blocked");
  const changed = await releaseTemplateHoldsOnCatalogChange(fakeSupabase(store), "camp", { fingerprint: "fp2" });
  assert.equal(changed.released, 1);
  assert.equal(store.targets[0].target_status, "ready");
  assert.equal(store.targets[0].block_reason, null);
  assert.equal(store.targets[0].metadata.template_hold_released.released_because, "template_catalogue_changed");
  assert.equal(store.targets[1].target_status, "blocked", "a DNC/suppression block is never revived");
});

test("the catalogue fingerprint changes when a template is added or edited", async () => {
  const store = makeStore([], [{ id: "t1", is_active: true, quarantined_at: null, updated_at: "2026-09-28T00:00:00Z" }]);
  const fp1 = await loadTemplateCatalogFingerprint(fakeSupabase(store));
  assert.equal(await loadTemplateCatalogFingerprint(fakeSupabase(store)), fp1, "stable when nothing changed");
  store.templates.push({ id: "t2", is_active: true, quarantined_at: null, updated_at: "2026-10-01T00:00:00Z" });
  assert.notEqual(await loadTemplateCatalogFingerprint(fakeSupabase(store)), fp1);
});

test("feeder: template failures are held once (not retried every cycle) and the campaign completes", async () => {
  const store = makeStore([
    { id: "ok1", target_status: "ready", metadata: {} },
    { id: "ok2", target_status: "ready", metadata: {} },
    { id: "lint", target_status: "ready", metadata: {} },
    { id: "none", target_status: "ready", metadata: {} },
  ]);
  const plan = planWithFailures(store, new Map([["lint", "TEMPLATE_RENDER_LINT_FAILURE"], ["none", "NO_TEMPLATE"]]));
  const first = await feedCampaignBatch(store.campaign, deps(store, plan, { templateCatalogFingerprint: "fp1" }));
  assert.equal(first.inserted, 2);
  assert.equal(first.template_holds_held, 2);
  assert.equal(store.targets.find((t) => t.id === "lint").target_status, "blocked");
  assert.equal(store.targets.find((t) => t.id === "none").block_reason, `${TEMPLATE_HOLD_PREFIX}NO_TEMPLATE`);
  assert.equal(first.ready_remaining, 0);
  assert.equal(first.completed, false, "rows placed this cycle are still in flight");

  // Next cycle, unchanged catalogue: nothing re-rendered, and the cohort resolves.
  const rendersBefore = plan.renders();
  const second = await feedCampaignBatch(store.campaign, deps(store, plan, { templateCatalogFingerprint: "fp1" }));
  assert.equal(second.completed, true, "completion is reachable once the remainder is held");
  assert.deepEqual(store.transitions, ["completed"]);
  store.campaign.status = "active";
  await feedCampaignBatch(store.campaign, deps(store, plan, { templateCatalogFingerprint: "fp1" }));
  assert.equal(plan.renders(), rendersBefore, "held targets are not retried every 5 minutes");
});

test("feeder: a template approved for that case re-checks the held targets in the same cycle", async () => {
  const store = makeStore([
    { id: "none", target_status: "blocked", block_reason: `${TEMPLATE_HOLD_PREFIX}NO_TEMPLATE`, metadata: { template_hold: { reason_code: "NO_TEMPLATE", catalog_fingerprint: "fp1" } } },
  ]);
  const plan = planWithFailures(store, new Map()); // the new template renders
  const r = await feedCampaignBatch(store.campaign, deps(store, plan, { templateCatalogFingerprint: "fp2" }));
  assert.equal(r.template_holds_released, 1);
  assert.equal(r.inserted, 1);
  assert.equal(store.targets[0].target_status, "planned");
});

test("feeder: still failing after a catalogue change → re-held under the new fingerprint (one retry per change)", async () => {
  const store = makeStore([
    { id: "lint", target_status: "blocked", block_reason: `${TEMPLATE_HOLD_PREFIX}TEMPLATE_RENDER_LINT_FAILURE`, metadata: { template_hold: { reason_code: "TEMPLATE_RENDER_LINT_FAILURE", catalog_fingerprint: "fp1" } } },
  ]);
  const plan = planWithFailures(store, new Map([["lint", "TEMPLATE_RENDER_LINT_FAILURE"]]));
  const r = await feedCampaignBatch(store.campaign, deps(store, plan, { templateCatalogFingerprint: "fp2" }));
  assert.equal(r.template_holds_released, 1);
  assert.equal(r.template_holds_held, 1);
  assert.equal(store.targets[0].metadata.template_hold.catalog_fingerprint, "fp2");
  assert.equal(plan.renders(), 1);
});
