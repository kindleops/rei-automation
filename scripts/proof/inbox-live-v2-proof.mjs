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

function asTime(value) {
  const ts = new Date(value || 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function authHeaders() {
  const headers = new Headers({
    origin: "http://localhost:5173",
  });

  if (process.env.OPS_DASHBOARD_SECRET) {
    headers.set("x-ops-dashboard-secret", process.env.OPS_DASHBOARD_SECRET);
  }

  return headers;
}

async function expectOk(result, label) {
  assert.equal(result?.ok, true, `${label} must return ok=true`);
  assert.notEqual(result?.degraded, true, `${label} must not degrade to timeout-preserved mode`);
  assert.notEqual(result?.dataMode, "timeout_preserved", `${label} must not return timeout-preserved rows`);
}

async function getJson(response, label) {
  assert.equal(response.ok, true, `${label} HTTP status must be 2xx`);
  return response.json();
}

async function countThreads(applyFilter = (query) => query) {
  const { count, error } = await applyFilter(
    supabase
      .from("canonical_inbox_threads")
      .select("thread_key", { count: "exact", head: true }),
  );

  if (error) throw error;
  return Number(count || 0);
}

async function main() {
  assert.equal(
    hasSupabaseConfig(),
    true,
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run with `node --env-file=.env.local ...`.",
  );

  console.log("[proof] querying v_inbox_threads_live_v2 limit 20");

  const { data: threadRows, error: threadRowsError } = await supabase
    .from("v_inbox_threads_live_v2")
    .select([
      "canonical_thread_key",
      "thread_key",
      "canonical_e164",
      "seller_phone",
      "latest_message_event_id",
      "latest_message_at",
      "latest_message_body",
      "latest_message_direction",
      "inbox_bucket",
    ].join(","))
    .order("latest_message_at", { ascending: false, nullsFirst: false })
    .order("thread_key", { ascending: false })
    .limit(20);

  if (threadRowsError?.code === "PGRST205") {
    throw new Error(
      "Linked Supabase project is missing public.v_inbox_threads_live_v2. Apply the inbox live v2 migration before rerunning this proof.",
    );
  }
  if (threadRowsError) throw threadRowsError;

  assert.ok(Array.isArray(threadRows), "v_inbox_threads_live_v2 must return rows");
  assert.ok(threadRows.length > 0, "v_inbox_threads_live_v2 must return at least one row");

  for (let index = 0; index < threadRows.length - 1; index += 1) {
    const left = asTime(threadRows[index].latest_message_at);
    const right = asTime(threadRows[index + 1].latest_message_at);
    assert.ok(
      left >= right,
      `threadRows[${index}] must be ordered by latest_message_at DESC`,
    );
  }

  const canonicalKeys = threadRows.map((row) => row.canonical_thread_key);
  assert.equal(
    new Set(canonicalKeys).size,
    canonicalKeys.length,
    "Top 20 live threads must not contain duplicate canonical_thread_key values",
  );

  console.log("[proof] calling /api/cockpit/inbox/live");

  const liveRequest = new Request(
    "http://localhost:3000/api/cockpit/inbox/live?filter=all&limit=20&map=0&timeout_mode=manual_bucket_switch",
    { headers: authHeaders() },
  );
  const liveResponse = await liveRoute.GET(liveRequest);
  const liveJson = await getJson(liveResponse, "live inbox route");
  await expectOk(liveJson, "live inbox route");

  const liveThreads = Array.isArray(liveJson.threads) ? liveJson.threads : [];
  assert.ok(liveThreads.length > 0, "live inbox route must return threads");

  for (let index = 0; index < liveThreads.length - 1; index += 1) {
    const left = asTime(liveThreads[index].latest_message_at || liveThreads[index].latest_activity_at);
    const right = asTime(liveThreads[index + 1].latest_message_at || liveThreads[index + 1].latest_activity_at);
    assert.ok(left >= right, `liveThreads[${index}] must be ordered by latest_message_at DESC`);
  }

  const sampleThread = liveThreads[0];
  assert.ok(sampleThread?.thread_key, "sample live thread must include thread_key");

  console.log("[proof] calling /api/cockpit/inbox/thread-messages for sample thread", {
    thread_key: sampleThread.thread_key,
    canonical_e164: sampleThread.canonical_e164 || null,
  });

  const threadUrl = new URL("http://localhost:3000/api/cockpit/inbox/thread-messages");
  threadUrl.searchParams.set("thread_key", sampleThread.thread_key);
  if (sampleThread.canonical_e164) threadUrl.searchParams.set("canonical_e164", sampleThread.canonical_e164);
  if (sampleThread.phone) threadUrl.searchParams.set("phone", sampleThread.phone);
  if (sampleThread.best_phone) threadUrl.searchParams.set("best_phone", sampleThread.best_phone);
  if (sampleThread.seller_phone) threadUrl.searchParams.set("seller_phone", sampleThread.seller_phone);
  threadUrl.searchParams.set("limit", "200");

  const threadResponse = await threadMessagesRoute.GET(new Request(threadUrl, { headers: authHeaders() }));
  const threadJson = await getJson(threadResponse, "thread messages route");
  await expectOk(threadJson, "thread messages route");

  const messages = Array.isArray(threadJson.messages) ? threadJson.messages : [];
  assert.ok(messages.length > 0, "thread messages route must return at least one message");

  for (let index = 0; index < messages.length - 1; index += 1) {
    const left = asTime(messages[index].event_timestamp || messages[index].message_created_at || messages[index].created_at);
    const right = asTime(messages[index + 1].event_timestamp || messages[index + 1].message_created_at || messages[index + 1].created_at);
    assert.ok(left <= right, `messages[${index}] must be chronological ASC`);
  }

  const newestMessage = messages[messages.length - 1];
  assert.equal(
    String(newestMessage.message_event_id || newestMessage.id || ""),
    String(sampleThread.latest_message_event_id || ""),
    "newest message_event must match the live inbox thread's latest_message_event_id",
  );
  assert.equal(
    newestMessage.message_body || null,
    sampleThread.latest_message_body || null,
    "newest thread message body must match the live inbox latest_message_body",
  );
  assert.equal(
    newestMessage.direction || null,
    sampleThread.latest_message_direction || null,
    "newest thread message direction must match the live inbox latest_message_direction",
  );
  const newestAt = asTime(newestMessage.event_timestamp || newestMessage.message_created_at || newestMessage.created_at);
  const sampleAt = asTime(sampleThread.latest_message_at || sampleThread.latest_activity_at);
  assert.ok(
    Math.abs(newestAt - sampleAt) <= 2_000,
    `newest message timestamp must be within 2s of live inbox latest_message_at (delta=${Math.abs(newestAt - sampleAt)}ms)`,
  );

  console.log("[proof] verifying count consistency");

  const { data: countRows, error: countError } = await supabase
    .from("v_inbox_thread_counts_live_v2")
    .select("*")
    .limit(1);

  if (countError) throw countError;

  const countRow = Array.isArray(countRows) ? countRows[0] : null;
  assert.ok(countRow, "v_inbox_thread_counts_live_v2 must return a count row");

  const expectedCounts = {
    all: await countThreads(),
    priority: await countThreads((query) => query.eq("inbox_bucket", "priority")),
    new_replies: await countThreads((query) => query.eq("inbox_bucket", "new_replies")),
    needs_review: await countThreads((query) => query.eq("inbox_bucket", "needs_review")),
    follow_up: await countThreads((query) => query.eq("inbox_bucket", "follow_up")),
    cold: await countThreads((query) => query.eq("inbox_bucket", "cold")),
    dead: await countThreads((query) => query.eq("inbox_bucket", "dead")),
    suppressed: await countThreads((query) => query.eq("inbox_bucket", "suppressed")),
    active: await countThreads((query) => query.in("inbox_bucket", ["priority", "new_replies", "needs_review", "follow_up"])),
    waiting: await countThreads((query) => query.or("inbox_bucket.eq.waiting,and(latest_message_direction.eq.outbound,inbox_bucket.not.in.(dead,suppressed))")),
    unlinked: await countThreads((query) => query.is("property_id", null)),
  };

  for (const [key, expectedValue] of Object.entries(expectedCounts)) {
    assert.equal(
      Number(countRow[key] || 0),
      Number(expectedValue || 0),
      `v_inbox_thread_counts_live_v2.${key} must match filtered canonical_inbox_threads rows`,
    );
    assert.equal(
      Number(liveJson.counts?.[key] || 0),
      Number(expectedValue || 0),
      `/api/cockpit/inbox/live counts.${key} must match filtered canonical_inbox_threads rows`,
    );
  }

  console.log("[proof] inbox live v2 passed");
  console.log(JSON.stringify({
    sample_thread_key: sampleThread.thread_key,
    sample_latest_message_event_id: sampleThread.latest_message_event_id || null,
    top_thread_count: threadRows.length,
    verified_counts: expectedCounts,
  }, null, 2));
}

main().catch((error) => {
  console.error("[proof] inbox live v2 failed");
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
