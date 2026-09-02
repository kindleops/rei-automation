import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CANARY_WINDOW_EXEMPTION_PIN,
  CANARY_WINDOW_EXEMPTION_REASON,
  EXEMPTION_DENIED,
  canaryLanePinMatches,
  evaluateCanaryEnqueueWindowExemption,
} from "@/lib/domain/campaigns/canary-enqueue-window-exemption.js";
import { ENQUEUE_SCOPE, DISPATCH_SCOPE } from "@/lib/domain/campaigns/canary-enqueue-authorization.js";
import { isInternalTestPhone } from "@/lib/config/internal-phones.js";
import { isWithinContactWindow } from "@/lib/domain/campaigns/contact-window-timezone.js";

// PINNED INTERNAL-CANARY ENQUEUE CONTACT-WINDOW EXEMPTION
//
// The contract under test is a CONJUNCTION in which no single condition is
// sufficient. Each test below removes exactly ONE condition from an otherwise
// fully-valid request and asserts the exemption is denied -- which is the only
// way to prove that no condition is decorative.
//
// "Denied" always means the caller keeps the NORMAL contact-window result. The
// enqueue call site turns every { allowed: false } into the same
// OUTSIDE_WINDOW failure it produced before this module existed.

const PIN = CANARY_WINDOW_EXEMPTION_PIN;
const SRC = path.resolve(process.cwd(), "src");

const future = () => new Date(Date.now() + 20 * 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

const target = (over = {}) => ({
  id: PIN.campaign_target_id,
  campaign_id: PIN.campaign_id,
  market: "DALLAS",
  ...over,
});

const campaign = (over = {}) => ({
  id: PIN.campaign_id,
  status: "draft",
  metadata: { internal_canary: true, do_not_activate: true },
  ...over,
});

const authorization = (over = {}) => ({
  id: "auth-window-1",
  canary_run_id: "canary_run_window_test",
  campaign_id: PIN.campaign_id,
  queue_row_ids: [],
  expires_at: future(),
  consumed_at: null,
  metadata: {
    scope: ENQUEUE_SCOPE,
    campaign_target_id: PIN.campaign_target_id,
    recipient: PIN.recipient,
  },
  ...over,
});

/** A request in which EVERY condition holds. Each test spoils exactly one. */
const valid = (over = {}) => ({
  target: target(),
  campaign: campaign(),
  recipient: PIN.recipient,
  sender: PIN.sender,
  authorization: authorization(),
  campaignMode: "paused",
  executionMode: "scoped_canary_only",
  emergencyStopAt: "2026-08-18T03:18:33.928Z",
  now: new Date().toISOString(),
  ...over,
});

const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

// ── 0. the baseline must actually pass, or every deny test below is vacuous ──

test("15. exact pinned canary outside the window is ALLOWED", () => {
  const verdict = evaluateCanaryEnqueueWindowExemption(valid());
  assert.equal(verdict.allowed, true, JSON.stringify(verdict));
  assert.equal(verdict.reason, CANARY_WINDOW_EXEMPTION_REASON);
  assert.equal(verdict.authorization_id, "auth-window-1");
  assert.equal(verdict.canary_run_id, "canary_run_window_test");
});

// ── 1-4. lane pin: campaign, target, recipient, sender ──────────────────────

test("1. an ordinary seller target is blocked (no pin match at all)", () => {
  const seller = evaluateCanaryEnqueueWindowExemption(
    valid({
      target: target({ id: "11111111-1111-1111-1111-111111111111", campaign_id: "22222222-2222-2222-2222-222222222222" }),
      recipient: "+12145550123",
      campaign: campaign({ metadata: {} }),
    }),
  );
  assert.equal(seller.allowed, false);
  assert.equal(seller.reason, EXEMPTION_DENIED.NOT_PINNED_CAMPAIGN);

  // and the cheap predicate that guards all I/O also refuses
  assert.equal(canaryLanePinMatches({ target: target({ id: "other" }), recipient: "+12145550123" }), false);
});

test("2. wrong campaign_target_id is blocked", () => {
  const v = evaluateCanaryEnqueueWindowExemption(
    valid({ target: target({ id: "618dc4d9-08e3-42b5-8c21-4d2aa9d586d8" }) }),
  );
  assert.equal(v.allowed, false);
  assert.equal(v.reason, EXEMPTION_DENIED.NOT_PINNED_TARGET);
});

test("3. wrong recipient is blocked", () => {
  const v = evaluateCanaryEnqueueWindowExemption(valid({ recipient: "+13059807796" }));
  assert.equal(v.allowed, false);
  assert.equal(v.reason, EXEMPTION_DENIED.NOT_PINNED_RECIPIENT);
});

test("4. wrong sender is blocked", () => {
  const v = evaluateCanaryEnqueueWindowExemption(valid({ sender: "+14693131601" }));
  assert.equal(v.allowed, false);
  assert.equal(v.reason, EXEMPTION_DENIED.NOT_PINNED_SENDER);
});

// ── 5. registry membership is necessary but NOT sufficient ──────────────────

test("5. another registered internal test phone cannot inherit the exemption", () => {
  // These ARE in the canonical registry. Registry membership alone must grant
  // nothing: each fails the recipient pin.
  for (const other of ["+16127433952", "+16124515970", "+16128072000"]) {
    assert.equal(isInternalTestPhone(other), true, `${other} should be registered`);
    const v = evaluateCanaryEnqueueWindowExemption(valid({ recipient: other }));
    assert.equal(v.allowed, false, `${other} must not be exempted`);
    assert.equal(v.reason, EXEMPTION_DENIED.NOT_PINNED_RECIPIENT);
  }
  // The pinned recipient IS registered -- registration is still required.
  assert.equal(isInternalTestPhone(PIN.recipient), true);
});

// ── 6-8. campaign posture ───────────────────────────────────────────────────

test("6. non-canary campaign is blocked", () => {
  const v = evaluateCanaryEnqueueWindowExemption(
    valid({ campaign: campaign({ metadata: { do_not_activate: true } }) }),
  );
  assert.equal(v.allowed, false);
  assert.equal(v.reason, EXEMPTION_DENIED.NOT_CANARY_CAMPAIGN);
});

test("7. missing do_not_activate is blocked", () => {
  const v = evaluateCanaryEnqueueWindowExemption(
    valid({ campaign: campaign({ metadata: { internal_canary: true } }) }),
  );
  assert.equal(v.allowed, false);
  assert.equal(v.reason, EXEMPTION_DENIED.CAMPAIGN_ACTIVATABLE);
});

test("8. a live campaign is blocked in every live status", () => {
  for (const status of ["active", "running", "live", "sending", "launched", "ACTIVE"]) {
    const v = evaluateCanaryEnqueueWindowExemption(valid({ campaign: campaign({ status }) }));
    assert.equal(v.allowed, false, status);
    assert.equal(v.reason, EXEMPTION_DENIED.CAMPAIGN_LIVE, status);
  }
});

// ── 9. control-plane containment must still hold ────────────────────────────

test("9. wrong queue_execution_mode is blocked", () => {
  for (const mode of ["normal", "stopped", "paused", "unrestricted", ""]) {
    const v = evaluateCanaryEnqueueWindowExemption(valid({ executionMode: mode }));
    assert.equal(v.allowed, false, mode);
    assert.equal(v.reason, EXEMPTION_DENIED.EXECUTION_MODE_NOT_SCOPED, mode);
  }
});

test("9b. campaign_mode other than paused is blocked, and ABSENCE is not a pass", () => {
  for (const mode of ["live", "live_limited", "dry_run"]) {
    const v = evaluateCanaryEnqueueWindowExemption(valid({ campaignMode: mode }));
    assert.equal(v.allowed, false, mode);
    assert.equal(v.reason, EXEMPTION_DENIED.CAMPAIGN_MODE_NOT_PAUSED, mode);
  }
  // normalizeCampaignMode("") returns "paused". Reading the ABSENCE of the value
  // as proof of containment would be a fail-open, so presence is required.
  for (const missing of ["", "   ", null, undefined]) {
    const v = evaluateCanaryEnqueueWindowExemption(valid({ campaignMode: missing }));
    assert.equal(v.allowed, false, String(missing));
    assert.equal(v.reason, EXEMPTION_DENIED.CAMPAIGN_MODE_NOT_PAUSED, String(missing));
  }
});

test("9c. an inactive or unparseable emergency brake is blocked", () => {
  for (const brake of ["", null, undefined, "not-a-date", "   "]) {
    const v = evaluateCanaryEnqueueWindowExemption(valid({ emergencyStopAt: brake }));
    assert.equal(v.allowed, false, String(brake));
    assert.equal(v.reason, EXEMPTION_DENIED.EMERGENCY_BRAKE_INACTIVE, String(brake));
  }
});

// ── 10-13. authorization ────────────────────────────────────────────────────

test("10. an invalid-scope or identity-mismatched authorization is blocked", () => {
  const wrongScope = evaluateCanaryEnqueueWindowExemption(
    valid({ authorization: authorization({ metadata: { scope: DISPATCH_SCOPE, campaign_target_id: PIN.campaign_target_id, recipient: PIN.recipient } }) }),
  );
  assert.equal(wrongScope.allowed, false);
  assert.equal(wrongScope.reason, EXEMPTION_DENIED.AUTHORIZATION_WRONG_SCOPE);

  const wrongTarget = evaluateCanaryEnqueueWindowExemption(
    valid({ authorization: authorization({ metadata: { scope: ENQUEUE_SCOPE, campaign_target_id: "someone-else", recipient: PIN.recipient } }) }),
  );
  assert.equal(wrongTarget.allowed, false);
  assert.equal(wrongTarget.reason, EXEMPTION_DENIED.AUTHORIZATION_MISMATCH);

  const wrongRecipient = evaluateCanaryEnqueueWindowExemption(
    valid({ authorization: authorization({ metadata: { scope: ENQUEUE_SCOPE, campaign_target_id: PIN.campaign_target_id, recipient: "+16128072000" } }) }),
  );
  assert.equal(wrongRecipient.allowed, false);
  assert.equal(wrongRecipient.reason, EXEMPTION_DENIED.AUTHORIZATION_MISMATCH);

  const wrongCampaign = evaluateCanaryEnqueueWindowExemption(
    valid({ authorization: authorization({ campaign_id: "33333333-3333-3333-3333-333333333333" }) }),
  );
  assert.equal(wrongCampaign.allowed, false);
  assert.equal(wrongCampaign.reason, EXEMPTION_DENIED.AUTHORIZATION_MISMATCH);
});

test("11. an expired or unbounded authorization is blocked", () => {
  const expired = evaluateCanaryEnqueueWindowExemption(
    valid({ authorization: authorization({ expires_at: past() }) }),
  );
  assert.equal(expired.allowed, false);
  assert.equal(expired.reason, EXEMPTION_DENIED.AUTHORIZATION_EXPIRED);

  for (const bad of [null, "", "never", undefined]) {
    const v = evaluateCanaryEnqueueWindowExemption(
      valid({ authorization: authorization({ expires_at: bad }) }),
    );
    assert.equal(v.allowed, false, String(bad));
    assert.equal(v.reason, EXEMPTION_DENIED.AUTHORIZATION_EXPIRED, String(bad));
  }
});

test("12. an already-consumed authorization is blocked (no replay)", () => {
  const v = evaluateCanaryEnqueueWindowExemption(
    valid({ authorization: authorization({ consumed_at: new Date().toISOString() }) }),
  );
  assert.equal(v.allowed, false);
  assert.equal(v.reason, EXEMPTION_DENIED.AUTHORIZATION_CONSUMED);
});

test("13. a missing authorization is blocked", () => {
  for (const absent of [null, undefined, {}, { id: "" }]) {
    const v = evaluateCanaryEnqueueWindowExemption(valid({ authorization: absent }));
    assert.equal(v.allowed, false, JSON.stringify(absent));
    assert.equal(v.reason, EXEMPTION_DENIED.NO_AUTHORIZATION, JSON.stringify(absent));
  }
});

// ── 14. malformed input fails CLOSED, never throws ──────────────────────────

test("14. malformed / hostile input fails closed instead of throwing", () => {
  const hostile = [
    {},
    { target: null, campaign: null },
    { target: "not-an-object", campaign: 42, recipient: {}, sender: [] },
    valid({ campaign: { metadata: "not-an-object" } }),
    valid({ authorization: { id: "x", metadata: null } }),
    valid({ target: Object.create(null) }),
  ];
  for (const input of hostile) {
    const v = evaluateCanaryEnqueueWindowExemption(input);
    assert.equal(v.allowed, false, JSON.stringify(input));
    assert.ok(typeof v.reason === "string" && v.reason.length > 0);
  }
  // no-argument call must also deny rather than throw
  assert.equal(evaluateCanaryEnqueueWindowExemption().allowed, false);
  assert.equal(canaryLanePinMatches(), false);
});

// ── 16. inside the window the exemption is never even consulted ─────────────

test("16. the exemption is consulted ONLY when the window is closed", () => {
  const src = readSrc("lib/domain/campaigns/enqueue-campaign-target-one.js");

  // The one call site must sit inside the `if (!window.ok)` branch, and the
  // cheap pure predicate must guard it so no ordinary target does extra I/O.
  const gate = src.indexOf("if (!window.ok) {");
  const pinCheck = src.indexOf("canaryLanePinMatches({ target, recipient })");
  const resolve = src.indexOf("await resolveCanaryWindowExemption(");
  assert.ok(gate > 0, "window gate not found");
  assert.ok(pinCheck > gate, "pin predicate must be inside the closed-window branch");
  assert.ok(resolve > pinCheck, "I/O must be guarded by the cheap pin predicate");

  // Exactly one resolution site, so there is no second, unguarded path.
  assert.equal(src.split("await resolveCanaryWindowExemption(").length - 1, 1);
});

// ── 17. the dispatch-time mechanism is untouched and stays separate ─────────

test("17. dispatch authorization semantics are unchanged by this module", () => {
  // The dispatch bypass is a DIFFERENT lane, pinned to different numbers.
  const proof = readSrc("lib/domain/queue/internal-proof-session.js");
  assert.ok(proof.includes("+16128072000"), "dispatch lane recipient changed");
  assert.ok(proof.includes("+16128060495"), "dispatch lane sender changed");
  assert.ok(!proof.includes(PIN.recipient), "enqueue canary leaked into the dispatch bypass");

  // Nothing on the dispatch path may import the enqueue-time exemption.
  for (const rel of [
    "lib/domain/queue/internal-proof-session.js",
    "lib/domain/queue/process-send-queue.js",
    "lib/domain/queue/queue-canary-authorization.js",
  ]) {
    assert.ok(
      !readSrc(rel).includes("canary-enqueue-window-exemption"),
      `${rel} must not import the enqueue-time window exemption`,
    );
  }
});

// ── 18. the global contact window is untouched ──────────────────────────────

test("18. the global contact window is still exactly 08:00-21:00", () => {
  const src = readSrc("lib/domain/campaigns/enqueue-campaign-target-one.js");
  assert.ok(/const WINDOW_START_HOUR = 8\b/.test(src), "WINDOW_START_HOUR changed");
  assert.ok(/const WINDOW_END_HOUR = 21\b/.test(src), "WINDOW_END_HOUR changed");

  // isWithinContactWindow is still called with those exact constants.
  assert.ok(
    src.includes("isWithinContactWindow(new Date(nowIso), tz.iana, WINDOW_START_HOUR, WINDOW_END_HOUR)"),
    "the window call no longer uses the global constants",
  );

  // BEHAVIOURAL proof, not a grep: the shared window function still rejects
  // 07:59 and 21:00 and accepts 08:00 and 20:59 in America/Chicago. If anything
  // had widened the global window, these boundaries would move.
  const TZ = "America/Chicago";
  const at = (h, m) => isWithinContactWindow(new Date(`2026-09-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-05:00`), TZ, 8, 21);
  assert.equal(at(7, 59).ok, false, "07:59 must be outside the window");
  assert.equal(at(8, 0).ok, true, "08:00 must be inside the window");
  assert.equal(at(20, 59).ok, true, "20:59 must be inside the window");
  assert.equal(at(21, 0).ok, false, "21:00 must be outside the window");

  // And the shared module carries no knowledge of the pinned canary lane.
  const tzSrc = readSrc("lib/domain/campaigns/contact-window-timezone.js");
  assert.ok(!tzSrc.includes(PIN.recipient), "pinned recipient leaked into the shared window module");
  assert.ok(!tzSrc.includes("canary-enqueue-window-exemption"), "shared window module imports the exemption");
});

// ── the raw token is never recorded ─────────────────────────────────────────

test("19. the raw authorization token is never logged or persisted", () => {
  const src = readSrc("lib/domain/campaigns/enqueue-campaign-target-one.js");
  const exemptionBlock = src.slice(
    src.indexOf("contact_window_internal_canary_exemption"),
    src.indexOf("// ── 9. Identity + render"),
  );
  assert.ok(exemptionBlock.length > 0);
  for (const f of ["canaryAuthorizationToken", "authorization_token", "provided_token"]) {
    assert.ok(!exemptionBlock.includes(f), `token field ${f} appears in the exemption log`);
  }
  // The provenance stamped on the queue row carries the id, never the token.
  const provenance = src.slice(src.indexOf("contact_window_exemption: {"), src.indexOf("evaluated_at: nowIso,\n            },"));
  assert.ok(provenance.includes("authorization_id"));
  assert.ok(!provenance.includes("token"));
});
