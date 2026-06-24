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
]);

const REQUIRED_BUCKETS = [
  "confirmed_owner",
  "not_interested",
  "wrong_person",
  "wrong_number",
  "opt_out",
  "renter_occupant",
  "positive_seller",
  "inbound_only",
  "outbound_inbound",
  "missing_owner",
  "phone_only",
];

function authHeaders() {
  const headers = new Headers({ origin: "http://localhost:5173" });
  if (process.env.OPS_DASHBOARD_SECRET) {
    headers.set("x-ops-dashboard-secret", process.env.OPS_DASHBOARD_SECRET);
  }
  return headers;
}

function classifyThread(row = {}) {
  const identity = String(row.contact_identity_class || "").toLowerCase();
  const intent = String(row.detected_intent || row.reply_intent || "").toLowerCase();
  const direction = String(row.latest_message_direction || row.direction || "").toLowerCase();
  const inbound = Number(row.inbound_count || 0);
  const outbound = Number(row.outbound_count || 0);
  const tags = new Set();

  if (identity === "confirmed_owner" || intent === "ownership_confirmed") tags.add("confirmed_owner");
  if (intent === "not_interested" || row.not_interested === true) tags.add("not_interested");
  if (identity === "wrong_person" || intent === "wrong_person") tags.add("wrong_person");
  if (identity === "wrong_number" || row.wrong_number === true || intent === "wrong_number") tags.add("wrong_number");
  if (row.opt_out === true || row.suppression_status === "suppressed") tags.add("opt_out");
  if (identity === "renter_occupant" || row.likely_renter === true) tags.add("renter_occupant");
  if (["hot", "interested", "positive", "offer_requested"].some((k) => intent.includes(k) || String(row.lead_temperature || "").includes(k))) {
    tags.add("positive_seller");
  }
  if (direction === "inbound" || inbound > 0 && outbound === 0) tags.add("inbound_only");
  if (inbound > 0 && outbound > 0) tags.add("outbound_inbound");
  if (!row.master_owner_id) tags.add("missing_owner");
  if (!row.property_id && !row.master_owner_id && !row.prospect_id) tags.add("phone_only");

  return tags;
}

function isEnriched(row = {}) {
  return Boolean(
    String(row.owner_name || row.seller_display_name || "").trim()
    && String(row.property_address_full || "").trim()
    && String(row.market || "").trim()
    && String(row.property_type || "").trim()
    && String(row.acquisition_stage || row.seller_stage || "").trim(),
  );
}

async function fetchThreadMessages(thread) {
  const url = new URL("http://localhost:3000/api/cockpit/inbox/thread-messages");
  url.searchParams.set("thread_key", thread.thread_key);
  if (thread.canonical_e164) url.searchParams.set("canonical_e164", thread.canonical_e164);
  if (thread.property_id) url.searchParams.set("property_id", thread.property_id);
  if (thread.master_owner_id) url.searchParams.set("master_owner_id", thread.master_owner_id);
  url.searchParams.set("limit", "50");

  const started = Date.now();
  const response = await threadMessagesRoute.GET(new Request(url, { headers: authHeaders() }));
  const elapsed = Date.now() - started;
  const json = await response.json();
  return { elapsed, json, ok: response.ok };
}

async function main() {
  assert.equal(hasSupabaseConfig(), true, "Missing Supabase credentials");

  const started = Date.now();
  const liveRequest = new Request(
    "http://localhost:3000/api/cockpit/inbox/live?filter=all&limit=50&timeout_mode=initial_boot",
    { headers: authHeaders() },
  );
  const liveResponse = await liveRoute.GET(liveRequest);
  const liveElapsed = Date.now() - started;
  const liveJson = await liveResponse.json();

  assert.equal(liveResponse.ok, true, "live inbox must return 2xx");
  assert.equal(liveJson.ok, true, "live inbox payload must be ok");
  assert.notEqual(liveJson.degraded, true, "live inbox must not be degraded");
  assert.equal(liveJson.source || liveJson.sourceUsed, "canonical_inbox_threads");

  const threads = Array.isArray(liveJson.threads) ? liveJson.threads : [];
  assert.ok(threads.length >= 25, `expected at least 25 threads, got ${threads.length}`);

  const bucketHits = Object.fromEntries(REQUIRED_BUCKETS.map((bucket) => [bucket, 0]));
  const results = [];
  const sample = threads.slice(0, 25);

  for (const thread of sample) {
    const tags = classifyThread(thread);
    for (const tag of tags) {
      if (bucketHits[tag] !== undefined) bucketHits[tag] += 1;
    }

    const { elapsed, json, ok } = await fetchThreadMessages(thread);
    const messages = Array.isArray(json.messages) ? json.messages : [];
    const enriched = isEnriched(thread);
    const phoneOnly = !thread.property_id && !thread.master_owner_id && !thread.prospect_id;

    results.push({
      thread_key: thread.thread_key,
      owner_name: thread.owner_name || null,
      property_address_full: thread.property_address_full || null,
      market: thread.market || null,
      property_type: thread.property_type || null,
      acquisition_stage: thread.acquisition_stage || thread.seller_stage || null,
      contact_identity_class: thread.contact_identity_class || null,
      estimated_value: thread.estimated_value ?? null,
      equity_amount: thread.equity_amount ?? null,
      enriched,
      phone_only: phoneOnly,
      message_count: messages.length,
      messages_ms: elapsed,
      messages_ok: ok && json.ok !== false,
      tags: [...tags],
    });

    assert.ok(ok, `thread-messages must return 2xx for ${thread.thread_key}`);
    assert.ok(json.ok !== false, `thread-messages payload must be ok for ${thread.thread_key}`);
    assert.ok(elapsed <= 5_000, `thread-messages must finish under 5s for ${thread.thread_key} (${elapsed}ms)`);
    if (!phoneOnly) {
      assert.ok(enriched || thread.contact_identity_class === "wrong_number", `thread ${thread.thread_key} must be enriched when identity links exist`);
    }
    assert.ok(messages.length > 0, `thread ${thread.thread_key} must return message history`);
  }

  const enrichedCount = results.filter((row) => row.enriched).length;
  const avgMessagesMs = Math.round(results.reduce((sum, row) => sum + row.messages_ms, 0) / results.length);

  console.log("[proof] inbox 25-thread validation passed");
  console.log(JSON.stringify({
    live_ms: liveElapsed,
    thread_count: sample.length,
    enriched_count: enrichedCount,
    avg_messages_ms: avgMessagesMs,
    bucket_hits: bucketHits,
    counts: {
      all: liveJson.counts?.all ?? liveJson.counts?.all_messages ?? null,
      needs_attention: liveJson.counts?.needs_attention ?? null,
      unread: liveJson.counts?.unread ?? null,
    },
    sample: results.slice(0, 5),
  }, null, 2));
}

main().catch((error) => {
  console.error("[proof] inbox 25-thread validation failed");
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});