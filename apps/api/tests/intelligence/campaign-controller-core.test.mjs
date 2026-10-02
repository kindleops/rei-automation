/**
 * Campaign controller v0: envelope validator, determinism, fail-closed inputs,
 * kill switch, §45/§46 behaviour, shrinkage, portfolio limits, and the static
 * proof that no action path exists in this phase.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_ENVELOPE, buildEnvelope, validateEnvelope } from "../../src/lib/domain/intelligence/campaign-controller/envelope.js";
import { DEFAULT_DETERMINISTIC_LIMITS } from "../../src/lib/domain/intelligence/campaign-controller/guardrails.js";
import { CONTROLLER_REASON_CODES, isReasonCode } from "../../src/lib/domain/intelligence/campaign-controller/reason-codes.js";
import { MAX_PRIOR_STRENGTH, shrinkByCampaign } from "../../src/lib/domain/intelligence/campaign-controller/rates.js";
import * as controller from "../../src/lib/domain/intelligence/campaign-controller/controller.js";
import { NOW, OPTIONS, burstCampaign, counts, envelope, healthyCampaign, state } from "./helpers/campaign-controller-fixtures.mjs";

const { PHASE_ALLOWS_EXECUTION, proposeCampaignActions, readAutonomyKillSwitch, runShadowController, toJournalRows } = controller;
const run = (campaigns, opts = {}, extra = {}) => proposeCampaignActions(state(campaigns, opts), { ...OPTIONS, envelope: opts.envelope ?? DEFAULT_ENVELOPE, ...extra });
const primary = (res, id) => res.proposals.find((p) => p.campaign_id === id && p.action !== "narrow_contact_window");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, "../../src/lib/domain/intelligence/campaign-controller");

test("default envelope is valid and every documented threshold is where the model card says", () => {
  const check = validateEnvelope(DEFAULT_ENVELOPE);
  assert.equal(check.ok, true, check.problems.join("; "));
  assert.match(check.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(DEFAULT_ENVELOPE.markets.allowed, ["Dallas, TX", "Minneapolis, MN"]);
  assert.equal(DEFAULT_ENVELOPE.safety.max_opt_out_rate, 0.025);
  assert.equal(DEFAULT_ENVELOPE.safety.min_delivery_rate, 0.75);
  assert.equal(DEFAULT_ENVELOPE.safety.max_carrier_filtering_rate, 0.2);
  assert.equal(DEFAULT_ENVELOPE.safety.max_wrong_person_rate, 0.05);
  assert.equal(DEFAULT_ENVELOPE.exploration_share, 0);
  assert.equal(DEFAULT_ENVELOPE.mode, "manual");
  assert.ok(Object.isFrozen(DEFAULT_ENVELOPE.safety));
});

test("envelope validator: tighten-only, explicit lists, no new knobs", () => {
  const bad = [
    envelope({ contact_window: { start: "07:00", end: "21:00" } }),
    envelope({ senders: { max_utilisation: 1.2 } }),
    envelope({ exploration_share: 0.05 }),
    envelope({ markets: { allowed: ["*"] } }),
    envelope({ markets: { allowed: [] } }),
    envelope({ mode: "yolo" }),
    envelope({ safety: { max_opt_out_rate: 1.5 } }),
    envelope({ volume: { max_daily_per_campaign: 5000, max_daily_total: 1000 } }),
    envelope({ volume: { max_step_up_ratio: 3 } }),
    { ...envelope(), queue_run_limit: 200 },
    { ...envelope(), schema: "campaign_envelope@0" },
    null,
  ];
  for (const e of bad) assert.equal(validateEnvelope(e).ok, false, JSON.stringify(e)?.slice(0, 80));
  assert.equal(validateEnvelope(envelope({ contact_window: { start: "09:00", end: "20:00" }, senders: { max_utilisation: 0.5 } })).ok, true);
});

test("an invalid envelope or guardrail snapshot holds every campaign (fail closed)", () => {
  const e = run([healthyCampaign(), burstCampaign()], { envelope: envelope({ exploration_share: 0.1 }) });
  assert.equal(e.envelope.valid, false);
  assert.ok(e.proposals.every((p) => p.action === "hold" && p.why.includes("ENVELOPE_INVALID")));
  const g = run([healthyCampaign()], {}, { guardrails: { ...DEFAULT_DETERMINISTIC_LIMITS, min_daily_cap: 0 } });
  assert.ok(g.proposals.every((p) => p.action === "hold" && p.why.includes("GUARDRAILS_INVALID")));
});

test("determinism: identical inputs give identical output; input order does not matter", () => {
  const a = run([healthyCampaign(), burstCampaign(), healthyCampaign({ campaign_id: "c3", caps: { daily_cap: 100 } })]);
  const b = run([healthyCampaign(), burstCampaign(), healthyCampaign({ campaign_id: "c3", caps: { daily_cap: 100 } })]);
  const c = run([healthyCampaign({ campaign_id: "c3", caps: { daily_cap: 100 } }), burstCampaign(), healthyCampaign()]);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.ok(a.proposals.every((p, i) => p.rank === i + 1 && /^[0-9a-f-]{36}$/.test(p.proposal_id)));
});

test("fail closed: stale, missing, future or out-of-range inputs produce hold with a reason code", () => {
  const stale = run([healthyCampaign()], { asOf: "2026-09-29T00:00:00Z" });
  assert.ok(stale.proposals.every((p) => p.action === "hold" && p.why.includes("INPUT_STALE")));
  const staleMetrics = primary(run([healthyCampaign({ metrics: { as_of: "2026-09-28T00:00:00Z" } })]), "camp-healthy");
  assert.deepEqual([staleMetrics.action, staleMetrics.why.includes("INPUT_STALE")], ["hold", true]);
  const missing = primary(run([{ ...healthyCampaign(), metrics: null }]), "camp-healthy");
  assert.deepEqual([missing.action, missing.why.includes("INPUT_MISSING")], ["hold", true]);
  const noLifetime = primary(run([healthyCampaign({ metrics: { lifetime: null } })]), "camp-healthy");
  assert.ok(noLifetime.why.includes("INPUT_MISSING"));
  for (const patch of [{ metrics: { rolling: { sends: -1 } } }, { metrics: { rolling: { delivered: 9999 } } }, { metrics: { rolling: { opt_outs: 500 } } }, { caps: { daily_cap: 2.5 } }, { audience: { eligible_remaining: -3 } }, { metrics: { as_of: "2026-10-02T00:00:00Z" } }]) {
    const p = primary(run([healthyCampaign(patch)]), "camp-healthy");
    assert.equal(p.action, "hold", JSON.stringify(patch));
    assert.ok(p.why.includes("INPUT_OUT_OF_RANGE"), JSON.stringify(patch));
  }
  const unknown = primary(run([healthyCampaign({ status: "zombie" })]), "camp-healthy");
  assert.ok(unknown.why.includes("CAMPAIGN_STATUS_UNKNOWN"));
  const noNow = proposeCampaignActions(state([healthyCampaign()]), { ...OPTIONS, now: null });
  assert.ok(noNow.proposals.every((p) => p.action === "hold" && p.why.includes("INPUT_MISSING")));
  const dup = run([healthyCampaign(), healthyCampaign()]);
  assert.ok(dup.proposals.some((p) => p.why.includes("INPUT_OUT_OF_RANGE")));
});

test("kill switch: absent, true, unreadable or slow = paused; only an explicit 'false' unpauses", async () => {
  assert.deepEqual(await readAutonomyKillSwitch(undefined), { paused: true, reason: "reader_unavailable" });
  assert.equal((await readAutonomyKillSwitch(async () => null)).paused, true);
  assert.equal((await readAutonomyKillSwitch(async () => "true")).paused, true);
  assert.equal((await readAutonomyKillSwitch(async () => "maybe")).paused, true);
  assert.equal((await readAutonomyKillSwitch(async () => { throw new Error("db down"); })).paused, true);
  assert.equal((await readAutonomyKillSwitch(() => new Promise(() => {}), { timeoutMs: 20 })).reason, "reader_timeout");
  assert.deepEqual(await readAutonomyKillSwitch(async (key) => (key === "intelligence_autonomy_paused" ? "false" : null)), { paused: false, reason: "explicit_false" });
});

test("kill switch paused: SHADOW proposals are still produced, all would_execute:false; nothing ever executes", async () => {
  const autonomous = envelope({ mode: "autonomous" });
  const paused = await runShadowController(state([healthyCampaign(), burstCampaign()]), { readSystemValue: async () => null, autonomyEnabled: true, envelope: autonomous, now: NOW });
  assert.ok(paused.proposals.some((p) => p.action !== "hold"));
  assert.ok(paused.proposals.every((p) => p.would_execute === false && p.execution_blocked_by.includes("KILL_SWITCH_PAUSED") && p.executed === false));
  const open = await runShadowController(state([healthyCampaign(), burstCampaign()]), { readSystemValue: async () => "false", autonomyEnabled: true, envelope: autonomous, now: NOW });
  const acting = open.proposals.filter((p) => p.action !== "hold");
  assert.ok(acting.length && acting.every((p) => p.would_execute === true));
  assert.ok(open.proposals.every((p) => p.executed === false && p.execution_path === null && p.execution_blocked_by.includes("SHADOW_PHASE_NO_ACTION_PATH")));
  const manual = await runShadowController(state([burstCampaign()]), { readSystemValue: async () => "false", autonomyEnabled: true, now: NOW });
  assert.ok(manual.proposals.every((p) => p.would_execute === false && p.execution_blocked_by.includes("MODE_NOT_AUTONOMOUS")));
  const disabled = await runShadowController(state([burstCampaign()]), { readSystemValue: async () => "false", envelope: autonomous, now: NOW });
  assert.ok(disabled.proposals.every((p) => p.would_execute === false && p.execution_blocked_by.includes("AUTONOMY_DISABLED")));
  assert.equal(PHASE_ALLOWS_EXECUTION, false);
});

test("no action path exists: no executor export, no HTTP/DB client in the controller sources", () => {
  for (const name of Object.keys(controller)) assert.doesNotMatch(name, /^(execute|apply|perform|dispatch|send|commit)/i);
  for (const file of fs.readdirSync(MODULE_DIR)) {
    const src = fs.readFileSync(path.join(MODULE_DIR, file), "utf8");
    assert.doesNotMatch(src, /\bfetch\s*\(|axios|node:https?|supabase|\.from\(\s*['"]|\.rpc\(|createClient|XMLHttpRequest|child_process|writeFile/, file);
  }
});

test("§46 scale needs ALL conditions and moves one clamped step through PATCH daily_cap", () => {
  const p = primary(run([healthyCampaign()]), "camp-healthy");
  assert.equal(p.action, "set_daily_cap");
  assert.deepEqual(p.api_call, { method: "PATCH", path: "/api/cockpit/campaigns/camp-healthy", body: { daily_cap: 500 } });
  assert.deepEqual([p.from.daily_cap, p.to.daily_cap], [400, 500]);
  assert.ok(p.why.includes("SCALE_ALL_CONDITIONS_MET") && p.why.includes("CLAMP_STEP"));
  // §48 record: why / from / to / policy / expected with credible intervals
  assert.ok(p.policy.envelope_hash && p.policy.controller_version);
  for (const k of ["qualified_replies", "opt_outs", "carrier_filtered", "wrong_person"]) {
    const e = p.expected[k];
    assert.ok(e.lower <= e.mean && e.mean <= e.upper, k);
  }
  assert.equal(p.expected.sends_delta, 100);
  assert.equal(p.actual, null);
});

test("never scale on raw reply rate: replies without qualified evidence, or a tiny sample, do not scale", () => {
  const chatty = healthyCampaign({ metrics: { lifetime: { reply_threads: 600, qualified: 0, engaged: 0 }, rolling: { reply_threads: 200, qualified: 0 } } });
  const p = primary(run([chatty]), "camp-healthy");
  assert.equal(p.action, "hold");
  assert.ok(p.why.includes("SCALE_BLOCKED_EVIDENCE"));
  const lucky = healthyCampaign({ metrics: { lifetime: counts({ sends: 60, delivered: 60, reply_threads: 10, qualified: 3 }) } });
  const q = primary(run([lucky]), "camp-healthy");
  assert.equal(q.action, "hold");
  assert.ok(q.why.includes("SCALE_BLOCKED_EVIDENCE"));
  const weak = healthyCampaign({ metrics: { lifetime: { qualified: 5 } } });
  assert.ok(primary(run([weak]), "camp-healthy").why.includes("SCALE_BLOCKED_QUALIFIED_RATE"));
  const noAudience = healthyCampaign({ audience: { as_of: NOW, eligible_remaining: 300 } });
  assert.ok(primary(run([noAudience]), "camp-healthy").why.includes("SCALE_BLOCKED_AUDIENCE"));
});

test("§45 throttles halve daily_cap; no eligible audience holds; telemetry gaps never fake a collapse", () => {
  const t = primary(run([healthyCampaign({ metrics: { rolling: { opt_outs: 22 } } })]), "camp-healthy");
  assert.equal(t.action, "set_daily_cap");
  assert.equal(t.to.daily_cap, 200);
  const empty = primary(run([healthyCampaign({ audience: { as_of: NOW, eligible_remaining: 0 } })]), "camp-healthy");
  assert.deepEqual([empty.action, empty.why], ["hold", ["NO_ELIGIBLE_AUDIENCE"]]);
  const lag = healthyCampaign({ metrics: { recent: null, rolling: { delivered: 300, failed: 40 } } });
  const p = primary(run([lag]), "camp-healthy");
  assert.notEqual(p.action, "pause");
  assert.ok(p.evidence.conditions.some((c) => c.code === "DELIVERY_TELEMETRY_INCOMPLETE"));
  const review = primary(run([healthyCampaign({ review: { open_holds: 30 } })]), "camp-healthy");
  assert.ok(review.why.includes("THROTTLE_HUMAN_REVIEW_BURDEN"));
  assert.equal(primary(run([healthyCampaign({ review: { open_holds: 60 } })]), "camp-healthy").action, "pause");
});

test("shrinkage: prior strength is capped, so one campaign's data cannot 'credibly' condemn another", () => {
  const rows = [
    { market: "Dallas, TX", campaign: "dal", successes: 2, trials: 71 },
    { market: "Minneapolis, MN", campaign: "mpls", successes: 13, trials: 640 },
    { market: "multi", campaign: "eg", successes: 0, trials: 13 },
  ];
  const rates = shrinkByCampaign(rows, { level: 0.9 });
  const dal = rates.get("dal");
  assert.ok(dal.upper - dal.lower > 0.02, `interval too narrow: ${dal.lower}-${dal.upper}`);
  assert.ok(dal.lower < 0.025 && dal.lower <= dal.mean && dal.mean <= dal.upper);
  assert.equal(MAX_PRIOR_STRENGTH, 100);
  // the replayed 10-01 case: Dallas next to a worse Minneapolis day is throttled, not stopped
  const mpls = healthyCampaign({ campaign_id: "mpls", market: "Minneapolis, MN", metrics: { recent: counts({ sends: 162, delivered: 136, failed: 19, filtered: 8, reply_threads: 15, opt_outs: 5, wrong_person: 1 }) } });
  const dallas = healthyCampaign({ campaign_id: "dal", metrics: { recent: counts({ sends: 71, delivered: 48, failed: 18, filtered: 16, reply_threads: 7, opt_outs: 2, wrong_person: 1 }) } });
  const p = primary(run([mpls, dallas]), "dal");
  assert.equal(p.why.includes("STOP_OPT_OUT_RISE"), false);
});

test("portfolio: max concurrent pauses the lowest-ranked; total volume and budget are never exceeded", () => {
  const many = Array.from({ length: 6 }, (_, i) => healthyCampaign({ campaign_id: `c${i}`, metrics: { lifetime: { qualified: 10 + 3 * i } } }));
  const res = run(many);
  const paused = res.proposals.filter((p) => p.action === "pause");
  assert.equal(paused.length, 2);
  assert.ok(paused.every((p) => p.why.includes("POLICY_MAX_CONCURRENT_REACHED")));
  assert.deepEqual(paused.map((p) => p.campaign_id).sort(), ["c0", "c1"]);
  const planned = res.proposals.filter((p) => p.action !== "pause" && p.action !== "narrow_contact_window").reduce((sum, p) => sum + p.to.daily_cap, 0);
  assert.ok(planned <= DEFAULT_ENVELOPE.volume.max_daily_total, `planned ${planned}`);
  const cheap = run([healthyCampaign()], { envelope: buildEnvelope({ budget: { max_daily_spend_usd: 1 } }) });
  assert.ok(primary(cheap, "camp-healthy").to.daily_cap <= Math.floor(1 / DEFAULT_DETERMINISTIC_LIMITS.cost_per_send_usd));
});

test("every emitted reason code is registered; journal rows are shadow, ids-only, with no action_ref", () => {
  const res = run([healthyCampaign(), burstCampaign(), healthyCampaign({ campaign_id: "x", status: "paused" }), healthyCampaign({ campaign_id: "y", timezone: "" })]);
  for (const p of res.proposals) for (const code of [...p.why, ...p.execution_blocked_by]) assert.ok(isReasonCode(code), code);
  assert.ok(Object.keys(CONTROLLER_REASON_CODES).length > 40);
  const rows = toJournalRows(res);
  assert.equal(rows.length, res.proposals.length);
  for (const row of rows) {
    assert.equal(row.mode, "shadow");
    assert.equal(row.action_ref, null);
    assert.deepEqual(Object.keys(row.context), ["campaign_id"]);
    assert.ok(["campaign_scale", "campaign_pause"].includes(row.decision_type));
    assert.equal(row.experiment.exploration_share, 0);
  }
});
