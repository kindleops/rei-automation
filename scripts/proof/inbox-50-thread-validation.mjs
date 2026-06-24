#!/usr/bin/env node
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, "../../apps/api");
process.chdir(apiRoot);

register(
  pathToFileURL(resolve(apiRoot, "tests/alias-loader.mjs")).href,
  pathToFileURL(`${apiRoot}/`),
);

const [{ supabase, hasSupabaseConfig }, liveRoute, threadMessagesRoute] = await Promise.all([
  import("../../apps/api/src/lib/supabase/client.js"),
  import("../../apps/api/src/app/api/cockpit/inbox/live/route.js"),
  import("../../apps/api/src/app/api/cockpit/inbox/thread-messages/route.js"),
  import("../../apps/api/src/lib/domain/inbox/inbox-bucket-predicates.js"),
]);

const { threadMatchesBucketFilter } = await import("../../apps/api/src/lib/domain/inbox/inbox-bucket-predicates.js");

function authHeaders() {
  const headers = new Headers({ origin: "http://localhost:5173" });
  if (process.env.OPS_DASHBOARD_SECRET) headers.set("x-ops-dashboard-secret", process.env.OPS_DASHBOARD_SECRET);
  return headers;
}

async function fetchLive(filter, limit = 50) {
  const url = `http://localhost:3000/api/cockpit/inbox/live?filter=${filter}&limit=${limit}&timeout_mode=initial_boot`;
  const started = Date.now();
  const response = await liveRoute.GET(new Request(url, { headers: authHeaders() }));
  const json = await response.json();
  return { response, json, ms: Date.now() - started };
}

async function main() {
  assert.equal(hasSupabaseConfig(), true, "Missing Supabase credentials");

  const all = await fetchLive("all", 50);
  assert.equal(all.response.ok, true);
  assert.equal(all.json.ok, true);
  assert.notEqual(all.json.degraded, true);

  const threads = Array.isArray(all.json.threads) ? all.json.threads : [];
  assert.ok(threads.length >= 50, `expected >=50 threads, got ${threads.length}`);

  const sample = threads.filter((row) => row.thread_key !== "+16127433952" && row.canonical_e164 !== "+16127433952").slice(0, 50);
  const results = [];

  for (const thread of sample) {
    const params = new URLSearchParams({ thread_key: thread.thread_key, limit: "100" });
    if (thread.canonical_e164) params.set("canonical_e164", thread.canonical_e164);
    const started = Date.now();
    const response = await threadMessagesRoute.GET(new Request(`http://localhost:3000/api/cockpit/inbox/thread-messages?${params}`, { headers: authHeaders() }));
    const json = await response.json();
    const messages = Array.isArray(json.messages) ? json.messages : [];
    const latest = messages[messages.length - 1] || null;

    results.push({
      thread_key: thread.thread_key,
      inbox_bucket: thread.inbox_bucket,
      latest_direction: thread.latest_message_direction,
      latest_at: thread.latest_message_at,
      delivery_status: thread.delivery_status || thread.latest_delivery_status || null,
      message_count: messages.length,
      messages_ms: Date.now() - started,
      latest_message_direction: latest?.direction || null,
      classification: thread.detected_intent || thread.reply_intent || null,
      action_state: thread.next_action || thread.automation_lane || null,
      waiting_predicate: threadMatchesBucketFilter(thread, "waiting"),
      new_replies_predicate: threadMatchesBucketFilter(thread, "new_replies"),
    });

    assert.ok(response.ok, `thread-messages 2xx for ${thread.thread_key}`);
    if (messages.length === 0) {
      console.warn(`[proof] skip empty history for ${thread.thread_key}`);
      continue;
    }
    assert.equal(
      String(latest?.direction || ""),
      String(thread.latest_message_direction || ""),
      `latest direction agreement for ${thread.thread_key}`,
    );
    if (thread.latest_message_direction === "inbound" && latest) {
      const latestDelivery = String(latest.delivery_status || latest.latest_delivery_status || "").toLowerCase();
      assert.ok(!latestDelivery.includes("deliver"), `inbound-last message must not show delivered for ${thread.thread_key}`);
    }
  }

  for (const bucket of ["waiting", "new_replies", "active", "all"]) {
    const listed = await fetchLive(bucket, 50);
    const rows = Array.isArray(listed.json.threads) ? listed.json.threads : [];
    const mismatches = rows.filter((row) => !threadMatchesBucketFilter(row, bucket));
    assert.equal(mismatches.length, 0, `${bucket} list predicate mismatches=${mismatches.length}`);
    assert.equal(
      Number(listed.json.counts?.[bucket] ?? -1) >= rows.length || rows.length === 0,
      true,
      `${bucket} count/list agreement`,
    );
  }

  console.log("[proof] inbox 50-thread validation passed");
  console.log(JSON.stringify({
    live_ms: all.ms,
    thread_count: sample.length,
    counts: all.json.counts,
    sample: results.slice(0, 3),
  }, null, 2));
}

main().catch((error) => {
  console.error("[proof] inbox 50-thread validation failed", error?.stack || error?.message || error);
  process.exitCode = 1;
});