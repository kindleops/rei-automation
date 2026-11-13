/**
 * THE CONTACT WINDOW IS A REAL DECISION, AND SCOPED CANARY DOES NOT BYPASS IT
 * (§10, §11).
 *
 * A scoped-canary authorization lifts the GLOBAL EXECUTION POSTURE — that is
 * its entire job, and it is what lets the downstream gates be tested at all
 * instead of every attempt dying on `queue_execution_mode_scoped_canary_only`.
 *
 * It must not lift anything else. In particular it must not lift the contact
 * window: a canary handset belongs to a person, and "it is a proof" is not a
 * reason to text them at 2 AM. The window is evaluated on its own, after
 * authority, from the row's own timezone.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateContactWindow } from "@/lib/supabase/sms-engine.js";
import { evaluateCanonicalSendAuthority } from "@/lib/domain/queue/canonical-send-authority.js";

/** The real certification row shape. */
const canaryRow = {
  to_phone_number: "+13059807795",
  timezone: "America/Chicago",
  contact_window_start: "08:00",
  contact_window_end: "21:00",
};

test("the contact window REFUSES outside local hours", () => {
  // 07:15Z = 02:15 America/Chicago.
  const verdict = evaluateContactWindow(canaryRow, { now: new Date("2026-09-19T07:15:00Z") });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "outside_local_send_window");
  // rc-8.5.21 S3: the recipient's area code (305, Eastern) is the basis; the stored Central zone narrows
  assert.equal(verdict.timezone, "America/New_York");
  assert.deepEqual([...verdict.zones].sort(), ["America/Chicago", "America/New_York"]);
});

test("the contact window ALLOWS inside local hours", () => {
  // 14:00Z = 09:00 America/Chicago. Same row, same code, different clock —
  // which is what makes the refusal above a decision rather than a constant.
  const verdict = evaluateContactWindow(canaryRow, { now: new Date("2026-09-19T14:00:00Z") });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.reason, "inside_local_send_window");
});

test("SCOPED CANARY LIFTS THE POSTURE, AND ONLY THE POSTURE", async () => {
  // With the scoped-canary authority the global execution mode no longer
  // refuses — that is the point.
  const scoped = await evaluateCanonicalSendAuthority({ scopedCanary: true });
  assert.equal(scoped.ok, true);
  assert.equal(scoped.authority, "scoped_canary_authorization");

  // ...and the SAME row is still refused by the contact window, which the
  // authority never consults. Two independent gates, not one.
  const window = evaluateContactWindow(canaryRow, { now: new Date("2026-09-19T07:15:00Z") });
  assert.equal(window.allowed, false);
});

test("without scoped canary, the posture refuses on its own", async () => {
  const verdict = await evaluateCanonicalSendAuthority({
    getSystemValue: async (key) =>
      key === "queue_execution_mode" ? "scoped_canary_only" : "live",
  });
  assert.equal(verdict.ok, false);
});

test("THE CONTACT WINDOW IS EVALUATED FIRST, SO IT CANNOT BE MASKED", async () => {
  /**
   * The dispatcher evaluates the contact window EARLY — before the canonical
   * send authority, not after it. That ordering is deliberate and it is the
   * stronger arrangement: the window cannot be skipped by anything the
   * authority decides, including a scoped-canary authorization.
   *
   * It also means a closed window is the FIRST refusal a canary meets, which
   * is why an out-of-hours proof cannot demonstrate the later gates — they are
   * never reached. That is the gates working, not a defect.
   */
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/queue/process-send-queue.js", import.meta.url), "utf8");

  const authorityAt = source.indexOf("evaluateCanonicalSendAuthority(");
  // rc-8.5.21 S3: the window runs inside the ONE dispatch decision (sms-engine#evaluateDispatchWindow)
  const windowAt = source.indexOf("evaluateDispatchWindow(queue_row");
  assert.ok(authorityAt > 0 && windowAt > 0);
  assert.ok(windowAt < authorityAt, "the contact window must not sit behind the send authority");

  // A campaign row is not manual_inbox, so it cannot inherit that path's
  // quiet-hours exemption.
  assert.match(source, /fresh_manual_inbox_send/);
});
