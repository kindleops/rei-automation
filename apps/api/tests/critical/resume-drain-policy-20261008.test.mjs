/**
 * P1 (owner 2026-10-08): no backlog auto-flushes on resume. Pure resume-drain
 * policy: stale replies re-evaluated, stale manual sends held, stale openers /
 * follow-ups re-planned into the recipient-local 08:00–21:00 window with
 * jitter, per-thread order preserved, sender / campaign / template untouched.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { planResumeDrain, rowKind, inLocalWindow, nextWindowOpening } from "@/lib/domain/queue/resume-drain-policy.js";

const NOW = Date.parse("2026-10-08T17:00:00.000Z"); // 12:00 Chicago
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const row = (id, extra = {}) => ({ id, thread_key: "+13145550101", to_phone_number: "+13145550101", from_phone_number: "+13145559999", campaign_id: "camp-1", template_id: "tpl-1", type: "campaign_launch", timezone: "America/Chicago", scheduled_for_utc: ago(5), ...extra });

test("kinds", () => {
  assert.equal(rowKind(row("a")), "opener");
  assert.equal(rowKind(row("a", { type: "auto_reply" })), "reply");
  assert.equal(rowKind(row("a", { type: "followup" })), "followup");
  assert.equal(rowKind(row("a", { message_type: "manual_reply" })), "manual");
});

test("a stale auto-reply is re-evaluated, never sent; a fresh one is sent", () => {
  const [stale, fresh] = planResumeDrain([row("r1", { type: "auto_reply", scheduled_for_utc: ago(16) }), row("r2", { type: "auto_reply", thread_key: "+13145550102", scheduled_for_utc: ago(5) })], { now: NOW });
  assert.equal(stale.action, "reevaluate");
  assert.equal(fresh.action, "send");
});

test("a stale manual send is held for the operator", () => {
  assert.equal(planResumeDrain([row("m", { message_type: "manual_reply", scheduled_for_utc: ago(45) })], { now: NOW })[0].action, "hold_for_operator");
});

test("stale openers (>2h) and follow-ups (>6h) are re-planned, not burst-sent", () => {
  const out = planResumeDrain([
    row("o-fresh", { scheduled_for_utc: ago(60), thread_key: "+1A" }),
    row("o-stale", { scheduled_for_utc: ago(121), thread_key: "+1B" }),
    row("f-fresh", { type: "followup", scheduled_for_utc: ago(300), thread_key: "+1C" }),
    row("f-stale", { type: "followup", scheduled_for_utc: ago(361), thread_key: "+1D" }),
  ], { now: NOW });
  assert.deepEqual(out.map((d) => d.action), ["send", "replan", "send", "replan"]);
  for (const d of out.filter((x) => x.action === "replan")) {
    const at = Date.parse(d.scheduled_for_utc);
    assert.ok(at >= NOW);
    assert.ok(inLocalWindow(at, "America/Chicago"), d.scheduled_for_utc);
  }
});

test("outside the recipient-local 08:00–21:00 window nothing sends: re-planned into the next opening", () => {
  const late = Date.parse("2026-10-09T03:30:00.000Z"); // 22:30 Chicago
  const [d] = planResumeDrain([row("x", { scheduled_for_utc: new Date(late - 5 * 60000).toISOString() })], { now: late });
  assert.equal(d.action, "replan");
  const at = Date.parse(d.scheduled_for_utc);
  assert.ok(inLocalWindow(at, "America/Chicago"));
  assert.ok(at >= nextWindowOpening(late, "America/Chicago"));
  // Recipient-local, not server-local: a Pacific recipient at 07:30 local waits.
  const early = Date.parse("2026-10-08T14:30:00.000Z"); // 07:30 Los Angeles, 09:30 Chicago
  assert.equal(planResumeDrain([row("y", { timezone: "America/Los_Angeles", scheduled_for_utc: new Date(early - 60000).toISOString() })], { now: early })[0].action, "replan");
});

test("per-thread order is preserved across re-plans (the earlier-due row is never planned after the later one)", () => {
  const rows = [3, 2, 1].map((n) => row(`t${n}`, { scheduled_for_utc: ago(200 + n * 10) }));
  const out = planResumeDrain(rows, { now: NOW });
  const byId = Object.fromEntries(out.map((d) => [d.id, Date.parse(d.scheduled_for_utc)]));
  // due order: t3 (oldest) < t2 < t1
  assert.ok(byId.t3 < byId.t2 && byId.t2 < byId.t1, JSON.stringify(byId));
});

test("deterministic jitter, and the decision never carries sender / campaign / template fields", () => {
  const a = planResumeDrain([row("j", { scheduled_for_utc: ago(500) })], { now: NOW });
  const b = planResumeDrain([row("j", { scheduled_for_utc: ago(500) })], { now: NOW });
  assert.deepEqual(a, b);
  for (const k of ["from_phone_number", "campaign_id", "template_id", "to_phone_number", "message_body"]) assert.equal(k in a[0], false, k);
});
