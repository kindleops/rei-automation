/**
 * RC 7.1 owner decision 4 — NO LATE AUTO-ACTIVATION.
 * A scheduled start that passed without activation is MISSED (no 2-hour
 * grace); a start readiness refused is missed at once and not retried; the
 * operator starts it now or reschedules it.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  SCHEDULE_ACTIVATION_TOLERANCE_MS,
  isCampaignStartMissed,
  isScheduleMissed,
} from "@/lib/domain/campaigns/campaign-schedule-missed.js";
import {
  findDueScheduledCampaigns,
  runDueScheduledCampaignActivations,
} from "@/lib/domain/campaigns/campaign-activation-orchestrator.js";

function fakeDb(rows) {
  const updates = [];
  const inserts = [];
  const from = (table) => {
    const filters = [];
    const q = {
      select: () => q,
      eq: (k, v) => (filters.push((r) => r[k] === v), q),
      lte: (k, v) => (filters.push((r) => Date.parse(r[k]) <= Date.parse(v)), q),
      gte: (k, v) => (filters.push((r) => Date.parse(r[k]) >= Date.parse(v)), q),
      lt: (k, v) => (filters.push((r) => Date.parse(r[k]) < Date.parse(v)), q),
      order: () => q,
      limit: () => q,
      insert: async (row) => (inserts.push({ table, row }), { error: null }),
      update: (patch) => ({
        eq: (k, v) => {
          updates.push({ id: v, patch });
          const row = rows.find((r) => r[k] === v);
          if (row) Object.assign(row, patch);
          return Promise.resolve({ error: null });
        },
      }),
      then: (res, rej) => Promise.resolve({ data: table === "campaigns" ? rows.filter((r) => filters.every((f) => f(r))) : [], error: null }).then(res, rej),
    };
    return q;
  };
  return { db: { from }, updates, inserts };
}

const NOW = Date.parse("2026-10-01T15:00:00Z");

test("the 2-hour grace is gone: 30 minutes late is missed, one activation tick is not", () => {
  assert.equal(SCHEDULE_ACTIVATION_TOLERANCE_MS, 10 * 60 * 1000);
  assert.equal(isScheduleMissed({ scheduled_for: "2026-10-01T14:30:00Z" }, NOW), true);
  assert.equal(isScheduleMissed({ scheduled_for: "2026-10-01T13:01:00Z" }, NOW), true, "was 'starting' under the old 2h grace");
  assert.equal(isScheduleMissed({ scheduled_for: "2026-10-01T14:56:00Z" }, NOW), false);
});

test("a start already marked missed for THIS schedule is missed even inside the tick; a reschedule clears it", () => {
  const at = "2026-10-01T14:58:00Z";
  const marked = { status: "scheduled", scheduled_for: at, metadata: { schedule_missed_for: at } };
  assert.equal(isCampaignStartMissed(marked, NOW), true);
  assert.equal(isCampaignStartMissed({ ...marked, scheduled_for: "2026-10-02T13:00:00Z" }, NOW), false);
  assert.equal(isCampaignStartMissed({ ...marked, status: "active" }, NOW), false);
});

test("40 minutes late: marked missed, never activated", async () => {
  const at = new Date(NOW - 40 * 60_000).toISOString();
  const { db, updates } = fakeDb([{ id: "late", name: "75+ ACQ SCORE", status: "scheduled", scheduled_for: at, metadata: {} }]);
  let activations = 0;
  const result = await runDueScheduledCampaignActivations({ supabase: db, now: NOW, runCanonicalCampaignActivation: async () => { activations += 1; return { ok: true }; } });
  assert.equal(activations, 0);
  assert.equal(result.results[0].error, "schedule_missed");
  assert.equal(updates[0].patch.metadata.schedule_missed_for, at);
});

test("a refused start is missed at once and NOT retried on the next tick (no late start when the blocker clears)", async () => {
  const at = new Date(NOW - 2 * 60_000).toISOString();
  const rows = [{ id: "c", name: "Due", status: "scheduled", scheduled_for: at, metadata: {} }];
  const { db } = fakeDb(rows);
  let activations = 0;
  const refuse = async () => { activations += 1; return { ok: false, error: "launch_blocked", blockers: ["No sender can text this market"] }; };
  const first = await runDueScheduledCampaignActivations({ supabase: db, now: NOW, runCanonicalCampaignActivation: refuse });
  assert.equal(first.results[0].schedule_missed_marked, true);
  assert.equal(rows[0].metadata.schedule_missed_for, at);
  assert.equal(rows[0].metadata.schedule_missed_reason, "activation_refused");
  assert.equal(isCampaignStartMissed(rows[0], NOW), true);

  const next = await runDueScheduledCampaignActivations({ supabase: db, now: NOW + 5 * 60_000, runCanonicalCampaignActivation: async () => { activations += 1; return { ok: true }; } });
  assert.equal(activations, 1, "the blocker clearing does not fire the start late");
  assert.equal(next.processed, 0);
});

test("a transient failure (no named blockers) may retry inside the tick, not beyond it", async () => {
  const at = new Date(NOW - 2 * 60_000).toISOString();
  const rows = [{ id: "c", name: "Due", status: "scheduled", scheduled_for: at, metadata: {} }];
  const { db } = fakeDb(rows);
  const first = await runDueScheduledCampaignActivations({ supabase: db, now: NOW, runCanonicalCampaignActivation: async () => ({ ok: false, error: "activation_exception", blockers: [] }) });
  assert.equal(first.results[0].schedule_missed_marked, false);
  const due = await findDueScheduledCampaigns({ supabase: db, now: NOW + 5 * 60_000 });
  assert.deepEqual(due.map((c) => c.id), ["c"]);
  // Past the tick it is the time rule's: missed, not activated.
  let activations = 0;
  const late = await runDueScheduledCampaignActivations({ supabase: db, now: NOW + 15 * 60_000, runCanonicalCampaignActivation: async () => { activations += 1; return { ok: true }; } });
  assert.equal(activations, 0);
  assert.equal(late.results[0].error, "schedule_missed");
});

test("the activation-held event no longer promises a two-hour retry", async () => {
  const at = new Date(NOW - 2 * 60_000).toISOString();
  const { db, inserts } = fakeDb([{ id: "c", name: "Due", status: "scheduled", scheduled_for: at, metadata: {} }]);
  await runDueScheduledCampaignActivations({ supabase: db, now: NOW, runCanonicalCampaignActivation: async () => ({ ok: false, error: "launch_blocked", blockers: ["x"] }) });
  const event = inserts.find((i) => i.table === "campaign_events");
  assert.ok(event);
  assert.doesNotMatch(event.row.description, /two hours/);
  assert.match(event.row.description, /start it now or reschedule/);
});
