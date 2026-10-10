// OWNER 2026-10-10: the wired resume drain (apply-resume-drain.js) must not
// re-plan an in-session reply to the morning — the exact incident path
// (Dallas 9:36pm CT auto-reply, template 1009, re-planned to 08:22 local).
import test from "node:test";
import assert from "node:assert/strict";

import { applyResumeDrain } from "@/lib/domain/queue/apply-resume-drain.js";

const EVT = "0a7fa9fc-f92d-4f6c-8d0c-78a2f1dc53d2";
const NOW = "2026-10-10T02:37:23.294Z"; // 9:37pm CDT

function recordingSupabase(rows) {
  const updates = [];
  const selects = [];
  return {
    updates,
    selects,
    from() {
      const q = { filters: [], patch: null };
      const chain = {
        select(cols) { selects.push(cols); return chain; },
        in(col, vals) { q.filters.push(["in", col, vals]); return chain; },
        lt(col, v) { q.filters.push(["lt", col, v]); return chain; },
        eq(col, v) { q.filters.push(["eq", col, v]); return chain; },
        order() { return chain; },
        limit() { return Promise.resolve({ data: rows, error: null }); },
        update(patch) { q.patch = patch; updates.push(q); return chain; },
        then(resolve) { return Promise.resolve({ data: null, error: null }).then(resolve); },
      };
      return chain;
    },
  };
}

const reply = {
  id: "r1",
  queue_key: `inbound_auto_reply:${EVT}:1009:+15005550006`,
  queue_status: "queued",
  type: "auto_reply",
  message_type: "Follow-Up",
  timezone: "America/Chicago",
  created_at: "2026-10-10T02:36:17.838Z",
  scheduled_for_utc: "2026-10-10T02:37:17.433Z",
  to_phone_number: "+15005550006",
  thread_key: "+15005550006",
  source_event_id: EVT,
  metadata: { source: "auto_reply", inbound_message_event_id: EVT, inbound_received_at: "2026-10-10T02:36:00.000Z" },
};
const followup = {
  id: "f1",
  queue_key: `acq-followup:${EVT}:s2`,
  queue_status: "queued",
  type: "followup",
  timezone: "America/Chicago",
  created_at: "2026-10-10T02:30:00.000Z",
  scheduled_for_utc: "2026-10-10T02:37:00.000Z",
  to_phone_number: "+15005550007",
  thread_key: "+15005550007",
  metadata: { source: "seller_followup_scheduler", followup_reason: "s2_no_answer_24h" },
};

test("wired resume drain: the in-session 9:36pm reply is left to send; a follow-up is re-planned", async () => {
  const supabase = recordingSupabase([reply, followup]);
  const out = await applyResumeDrain({ supabase, now: NOW, getSystemValue: async () => null });
  assert.equal(out.ok, true);
  assert.equal(out.counts.send, 1);
  assert.equal(out.counts.replan, 1);
  const ids = supabase.updates.map((u) => u.filters.find((f) => f[1] === "id")?.[2]);
  assert.deepEqual(ids, ["f1"], "only the follow-up is moved");
  assert.match(supabase.selects[0], /queue_key/);
});

test("wired resume drain: a 10-minute window (system_control) makes the same reply re-plan", async () => {
  const late = { ...reply, created_at: "2026-10-10T02:50:00.000Z", scheduled_for_utc: "2026-10-10T02:50:10.000Z" };
  const supabase = recordingSupabase([late]);
  const out = await applyResumeDrain({
    supabase,
    now: "2026-10-10T02:50:30.000Z",
    getSystemValue: async (k) => (k === "conversational_reply_window_minutes" ? "10" : null),
  });
  assert.equal(out.counts.replan, 1);
});
