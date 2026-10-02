/**
 * §211 GUARDRAIL MATRIX for the campaign controller v0 (shadow).
 *
 * The controller's only outputs are lifecycle/caps PROPOSALS. So "cannot
 * contact DNC numbers", "cannot send outside a window" etc. are proven by:
 *   (1) the action space excludes everything except hold / lifecycle pause /
 *       PATCH daily_cap / PATCH contact-window narrowing;
 *   (2) every proposal is clamped by the envelope AND by the deterministic
 *       limits (injected fixture mirroring audit §1.4);
 *   (3) a status change is only ever the lifecycle route, never PATCH;
 * and a seeded sweep of hostile states checks (1)-(3) on every proposal.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mulberry32 } from "../../src/lib/domain/intelligence/util/rng.js";
import { ACTIONS, actionSpaceViolations, buildApiCall } from "../../src/lib/domain/intelligence/campaign-controller/action-space.js";
import { DEFAULT_DETERMINISTIC_LIMITS, lifecycleAuthority, validateGuardrails } from "../../src/lib/domain/intelligence/campaign-controller/guardrails.js";
import { DEFAULT_ENVELOPE, validateEnvelope } from "../../src/lib/domain/intelligence/campaign-controller/envelope.js";
import { proposeCampaignActions } from "../../src/lib/domain/intelligence/campaign-controller/controller.js";
import { NOW, OPTIONS, burstCampaign, envelope, healthyCampaign, randomCampaign, state } from "./helpers/campaign-controller-fixtures.mjs";

const ALLOWED_BODY_KEYS = new Set(["action", "reason", "daily_cap", "contact_window_start", "contact_window_end"]);
const run = (campaigns, opts = {}) => proposeCampaignActions(state(campaigns, opts), { ...OPTIONS, envelope: opts.envelope ?? DEFAULT_ENVELOPE });
const primary = (res, id) => res.proposals.find((p) => p.campaign_id === id && p.action !== "narrow_contact_window");

function sweep(seed = 7, rounds = 200) {
  const rand = mulberry32(seed);
  const out = [];
  for (let r = 0; r < rounds; r += 1) {
    const campaigns = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, i) => randomCampaign(rand, `${r}-${i}`));
    const senders = { "Dallas, TX": { sendable: Math.floor(rand() * 3), degraded: Math.floor(rand() * 3) }, "Minneapolis, MN": { sendable: 3, degraded: 0 } };
    const res = proposeCampaignActions(state(campaigns, { senders }), { ...OPTIONS, envelope: DEFAULT_ENVELOPE });
    out.push({ campaigns, res });
  }
  return out;
}
const SWEEP = sweep();

test("action space is exactly hold / pause / set_daily_cap / narrow_contact_window", () => {
  assert.deepEqual([...ACTIONS], ["hold", "pause", "set_daily_cap", "narrow_contact_window"]);
  for (const forbidden of ["send", "offer", "present_offer", "activate", "resume", "schedule", "complete", "archive", "set_batch_max", "set_total_cap", "suppress", "unsuppress", "set_template", "set_sender"]) {
    assert.throws(() => buildApiCall(forbidden, "c1", {}), /outside the controller action space/);
  }
  assert.deepEqual([...DEFAULT_DETERMINISTIC_LIMITS.lifecycle_actions_allowed], ["pause"]);
  assert.deepEqual([...DEFAULT_DETERMINISTIC_LIMITS.patch_fields_allowed], ["daily_cap", "contact_window_start", "contact_window_end"]);
});

test("DNC / opted-out / wrong-person: no proposal can name or reach a recipient", () => {
  for (const { res } of SWEEP) {
    for (const p of res.proposals) {
      if (!p.api_call) continue;
      for (const key of Object.keys(p.api_call.body)) assert.ok(ALLOWED_BODY_KEYS.has(key), `body key ${key}`);
      assert.match(p.api_call.path, /^\/api\/cockpit\/campaigns\/[^/]+(\/lifecycle)?$/);
      assert.doesNotMatch(JSON.stringify({ path: p.api_call.path, keys: Object.keys(p.api_call.body) }), /phone|recipient|thread|suppress|dnc|opt_out|to_number/i);
    }
  }
  // identity fields are not accepted inputs: the campaign is held, never acted on
  const res = run([healthyCampaign({ owner_name: "x", to_phone_number: "+15555550100" })]);
  const p = primary(res, "camp-healthy");
  assert.equal(p.action, "hold");
  assert.ok(p.why.includes("INPUT_OUT_OF_RANGE"));
});

test("an opt-out or wrong-person rise can only pause or throttle, never scale", () => {
  const oo = healthyCampaign({ metrics: { rolling: { opt_outs: 40, reply_threads: 70 }, recent: { opt_outs: 10, reply_threads: 10 } } });
  const p = primary(run([oo]), "camp-healthy");
  assert.ok(["pause", "set_daily_cap"].includes(p.action));
  if (p.action === "set_daily_cap") assert.ok(p.to.daily_cap < p.from.daily_cap);
  assert.ok(p.why.some((c) => /OPT_OUT/.test(c)));
  const wp = healthyCampaign({ metrics: { rolling: { wrong_person: 60, reply_threads: 70, opt_outs: 2 } } });
  const q = primary(run([wp]), "camp-healthy");
  assert.ok(q.why.some((c) => /REPLY_QUALITY/.test(c)));
  assert.notEqual(q.kind, "scale");
});

test("daily caps: never above the envelope, sender capacity or total; never written as 0 (= send nothing) or null (= no cap)", () => {
  for (const { res } of SWEEP) {
    let total = 0;
    for (const p of res.proposals) {
      if (p.action !== "set_daily_cap") continue;
      const cap = p.api_call.body.daily_cap;
      assert.ok(Number.isInteger(cap) && cap >= DEFAULT_DETERMINISTIC_LIMITS.min_daily_cap, `cap ${cap}`);
      assert.ok(cap <= DEFAULT_ENVELOPE.volume.max_daily_per_campaign);
      if (Number.isFinite(p.limits.capacity) && p.limits.capacity >= 1) assert.ok(cap <= p.limits.capacity);
      total += cap;
    }
    assert.ok(total <= DEFAULT_ENVELOPE.volume.max_daily_total + 0);
  }
  // an uncapped (null) live campaign is clamped to the envelope, never left unlimited and never set to 0
  const uncapped = primary(run([healthyCampaign({ caps: { daily_cap: null } })]), "camp-healthy");
  assert.equal(uncapped.action, "set_daily_cap");
  assert.equal(uncapped.to.daily_cap, Math.min(DEFAULT_ENVELOPE.volume.max_daily_per_campaign, 1280));
  assert.ok(uncapped.why.includes("POLICY_DAILY_VOLUME_LIMIT"));
  // rc-7.1 D9b: daily_cap 0 is the operator's "send nothing"; the controller
  // holds and never raises it (it used to read 0 as uncapped and propose the envelope max)
  const zero = primary(run([healthyCampaign({ caps: { daily_cap: 0 } })]), "camp-healthy");
  assert.equal(zero.action, "hold");
  assert.ok(zero.why.includes("OPERATOR_CAP_ZERO"));
  // a throttle that would go below 1 becomes a lifecycle pause instead
  const tiny = primary(run([healthyCampaign({ caps: { daily_cap: 1 }, metrics: { rolling: { filtered: 200 } } })]), "camp-healthy");
  assert.equal(tiny.action, "pause");
});

test("the 50 clamp: the controller can never touch run size or the shared queue rails", () => {
  for (const { res } of SWEEP) {
    for (const p of res.proposals) {
      const text = JSON.stringify(p.api_call ?? {});
      assert.doesNotMatch(text, /batch_max|queue_run_limit|queue_hard_cap|max_batch|per_sender_cap|market_cap|per_number_cap|total_cap/);
    }
  }
  assert.equal(validateGuardrails({ ...DEFAULT_DETERMINISTIC_LIMITS, run_size_clamp: 51 }).ok, false);
  assert.equal(validateEnvelope({ ...DEFAULT_ENVELOPE, batch_max: 100 }).ok, false);
  const violations = actionSpaceViolations(
    { action: "set_daily_cap", api_call: { method: "PATCH", path: "/api/cockpit/campaigns/c1", body: { daily_cap: 10, batch_max: 100 } }, limits: {} },
    { guardrails: DEFAULT_DETERMINISTIC_LIMITS, envelope: DEFAULT_ENVELOPE, lifecycle: lifecycleAuthority, campaign: { campaign_id: "c1", status: "active" } },
  );
  assert.ok(violations.some((v) => /batch_max/.test(v)));
});

test("contact windows: only ever narrowed, inside 08:00-21:00 and the envelope; never widened", () => {
  const wide = run([healthyCampaign({ caps: { contact_window_start: "07:00", contact_window_end: "22:30" } })]);
  const w = wide.proposals.find((p) => p.action === "narrow_contact_window");
  assert.deepEqual(w.api_call.body, { contact_window_start: "08:00", contact_window_end: "21:00" });
  const tightEnv = envelope({ contact_window: { start: "09:00", end: "20:00" } });
  const t = run([healthyCampaign()], { envelope: tightEnv }).proposals.find((p) => p.action === "narrow_contact_window");
  assert.deepEqual(t.api_call.body, { contact_window_start: "09:00", contact_window_end: "20:00" });
  const narrow = run([healthyCampaign({ caps: { contact_window_start: "10:00", contact_window_end: "19:00" } })]);
  assert.equal(narrow.proposals.find((p) => p.action === "narrow_contact_window"), undefined);
  assert.equal(validateEnvelope(envelope({ contact_window: { start: "07:30", end: "21:00" } })).ok, false);
  assert.equal(validateEnvelope(envelope({ contact_window: { start: "08:00", end: "21:30" } })).ok, false);
  for (const { res } of SWEEP) {
    for (const p of res.proposals.filter((x) => x.action === "narrow_contact_window")) {
      assert.ok(p.api_call.body.contact_window_start >= "08:00" && p.api_call.body.contact_window_end <= "21:00");
    }
  }
});

test("blank or invalid time zone: hold, never defaulted (no Chicago fallback)", () => {
  for (const tz of ["", null, "Chicago", "Not/AZone"]) {
    const res = run([healthyCampaign({ timezone: tz })]);
    const ps = res.proposals.filter((p) => p.campaign_id === "camp-healthy");
    assert.equal(ps.length, 1);
    assert.equal(ps[0].action, "hold");
    assert.ok(ps[0].why.includes("TIMEZONE_UNRESOLVED"));
  }
});

test("unhealthy sender: no sender -> pause; degraded fleet -> throttle; unknown fleet -> never scale", () => {
  const none = primary(run([healthyCampaign()], { senders: { "Dallas, TX": { sendable: 0, degraded: 2 } } }), "camp-healthy");
  assert.equal(none.action, "pause");
  assert.ok(none.why.includes("STOP_SENDER_DEGRADATION"));
  const half = primary(run([healthyCampaign()], { senders: { "Dallas, TX": { sendable: 1, degraded: 1 } } }), "camp-healthy");
  assert.equal(half.action, "set_daily_cap");
  assert.ok(half.to.daily_cap < half.from.daily_cap);
  const unknown = primary(run([healthyCampaign()], { senders: null }), "camp-healthy");
  assert.equal(unknown.action, "hold");
  assert.ok(unknown.why.includes("SCALE_BLOCKED_CAPACITY"));
  const scaled = primary(run([healthyCampaign()]), "camp-healthy");
  assert.ok(scaled.to.daily_cap <= 2 * 800 * DEFAULT_ENVELOPE.senders.max_utilisation);
});

test("unapproved market, cohort or strategy: pause, never scale", () => {
  for (const [patch, code] of [
    [{ market: "Miami, FL" }, "POLICY_MARKET_NOT_ALLOWED"],
    [{ cohort: "zip_blast" }, "POLICY_COHORT_NOT_ALLOWED"],
    [{ strategy: "offer_present" }, "POLICY_STRATEGY_NOT_APPROVED"],
  ]) {
    const p = primary(run([healthyCampaign(patch)], { senders: { "Dallas, TX": { sendable: 2, degraded: 0 }, "Miami, FL": { sendable: 2, degraded: 0 } } }), "camp-healthy");
    assert.equal(p.action, "pause");
    assert.ok(p.why.includes(code));
  }
});

test("paused or blocked template: template failure stops/throttles, never scales", () => {
  const all = primary(run([healthyCampaign({ templates: [{ template_id: "t1", sends: 700, filtered: 20, governance_paused: true, blocked: false }] })]), "camp-healthy");
  assert.equal(all.action, "pause");
  assert.ok(all.why.includes("STOP_TEMPLATE_FAILURE"));
  const some = primary(run([healthyCampaign({ templates: [
    { template_id: "t1", sends: 400, filtered: 10, governance_paused: false, blocked: false },
    { template_id: "t2", sends: 300, filtered: 10, governance_paused: false, blocked: true },
  ] })]), "camp-healthy");
  assert.equal(some.action, "set_daily_cap");
  assert.ok(some.why.includes("THROTTLE_TEMPLATE_FAILURE"));
  assert.ok(some.to.daily_cap < some.from.daily_cap);
});

test("unauthorised offers: impossible -- no action, route or body can carry an offer", () => {
  for (const { res } of SWEEP) for (const p of res.proposals) assert.doesNotMatch(JSON.stringify({ path: p.api_call?.path ?? null, body: { ...(p.api_call?.body ?? {}), reason: undefined } }), /offer|price|amount/i);
});

test("blocked / paused / draft campaigns are never activated or resumed", () => {
  for (const status of ["paused", "draft", "built", "scheduled", "completed", "failed", "archived", "queued"]) {
    const ps = run([healthyCampaign({ status })]).proposals.filter((p) => p.campaign_id === "camp-healthy");
    assert.equal(ps.length, 1, status);
    assert.equal(ps[0].action, "hold", status);
    assert.ok(ps[0].why.includes("NOT_LIVE_NO_ACTION"), status);
  }
  for (const { res } of SWEEP) {
    for (const p of res.proposals) {
      if (p.api_call?.body?.action) assert.equal(p.api_call.body.action, "pause");
    }
  }
});

test("lifecycle gates: status only via the lifecycle route, only on legal edges; PATCH never carries status", () => {
  for (const { campaigns, res } of SWEEP) {
    for (const p of res.proposals) {
      if (p.action === "pause") {
        assert.equal(p.api_call.method, "POST");
        assert.match(p.api_call.path, /\/lifecycle$/);
        const c = campaigns.find((x) => x.campaign_id === p.campaign_id);
        assert.ok(lifecycleAuthority.canPause(c.status), `pause from ${c.status}`);
      }
      if (p.api_call?.method === "PATCH") assert.equal("status" in p.api_call.body, false);
    }
  }
  const ctx = { guardrails: DEFAULT_DETERMINISTIC_LIMITS, envelope: DEFAULT_ENVELOPE, lifecycle: lifecycleAuthority };
  const patchStatus = { action: "set_daily_cap", api_call: { method: "PATCH", path: "/api/cockpit/campaigns/c1", body: { daily_cap: 10, status: "paused" } }, limits: {} };
  assert.ok(actionSpaceViolations(patchStatus, { ...ctx, campaign: { campaign_id: "c1", status: "active" } }).some((v) => /status/.test(v)));
  const pauseCompleted = { action: "pause", api_call: buildApiCall("pause", "c1", {}, "STOP_OPT_OUT_RISE"), limits: {} };
  assert.ok(actionSpaceViolations(pauseCompleted, { ...ctx, campaign: { campaign_id: "c1", status: "completed" } }).some((v) => /illegal lifecycle edge/.test(v)));
  assert.deepEqual(actionSpaceViolations(pauseCompleted, { ...ctx, campaign: { campaign_id: "c1", status: "activating" } }), []);
});

test("every proposal in the sweep is admissible and nothing is ever executed", () => {
  for (const { campaigns, res } of SWEEP) {
    for (const p of res.proposals) {
      assert.equal(p.executed, false);
      assert.equal(p.execution_path, null);
      assert.ok(p.execution_blocked_by.includes("SHADOW_PHASE_NO_ACTION_PATH"));
      if (p.action === "hold") continue;
      const c = campaigns.find((x) => x.campaign_id === p.campaign_id);
      assert.deepEqual(actionSpaceViolations(p, { guardrails: DEFAULT_DETERMINISTIC_LIMITS, envelope: DEFAULT_ENVELOPE, lifecycle: lifecycleAuthority, campaign: c }), []);
    }
  }
  assert.ok(SWEEP.some(({ res }) => res.proposals.some((p) => p.action === "pause")));
  assert.ok(SWEEP.some(({ res }) => res.proposals.some((p) => p.action === "set_daily_cap")));
  assert.equal(NOW, OPTIONS.now);
});

test("a 09-28-style burst is stopped through the lifecycle route", () => {
  const p = primary(run([burstCampaign()]), "camp-burst");
  assert.equal(p.action, "pause");
  assert.deepEqual(p.api_call, { method: "POST", path: "/api/cockpit/campaigns/camp-burst/lifecycle", body: { action: "pause", reason: `ic8_controller_shadow:${p.why[0]}` } });
  assert.ok(p.why.includes("STOP_CARRIER_FILTERING_SPIKE"));
  assert.ok(p.why.includes("STOP_DELIVERY_COLLAPSE"));
});
