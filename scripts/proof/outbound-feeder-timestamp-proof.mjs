#!/usr/bin/env node

import { createFakeSupabase, registerApiAliases } from "./email-proof-utils.mjs";
import { callJson, isHttpUnavailable, routeSummary } from "./campaign-proof-utils.mjs";

process.env.PODIO_CLIENT_ID ||= "outbound-feeder-timestamp-proof";
process.env.PODIO_CLIENT_SECRET ||= "outbound-feeder-timestamp-proof";
process.env.PODIO_USERNAME ||= "outbound-feeder-timestamp-proof";
process.env.PODIO_PASSWORD ||= "outbound-feeder-timestamp-proof";
process.env.INTERNAL_API_SECRET ||= "outbound-feeder-timestamp-proof";
process.env.BUYER_WEBHOOK_SECRET ||= "outbound-feeder-timestamp-proof";
process.env.OPS_DASHBOARD_SECRET ||= "outbound-feeder-timestamp-proof";

registerApiAliases();

const {
  runSupabaseCandidateFeeder,
  toTimestamp,
} = await import("@/lib/domain/outbound/supabase-candidate-feeder.js");
const { handleFeedCandidatesRequest } = await import("@/lib/domain/outbound/feed-candidates-request.js");

const label = "outbound feeder timestamp proof";
const marker = {
  failures: 0,
  warnings: 0,
  mark(name, condition, detail = "", warnOnly = false) {
    const prefix = condition ? "PASS" : warnOnly ? "WARN" : "FAIL";
    const line = `${prefix} ${name}${detail ? ` ${detail}` : ""}`;
    if (condition) {
      console.log(line);
      return true;
    }
    if (warnOnly) {
      this.warnings += 1;
      console.warn(line);
      return false;
    }
    this.failures += 1;
    console.error(line);
    return false;
  },
  finish() {
    if (this.failures > 0) {
      console.error(`FAIL ${label} failures=${this.failures} warnings=${this.warnings}`);
      process.exit(1);
    }
    console.log(`PASS ${label} warnings=${this.warnings}`);
  },
};

function futureBusinessIso() {
  const date = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  date.setUTCHours(16, 0, 0, 0);
  return date.toISOString();
}

function candidateRow(id = "proof") {
  return {
    master_owner_id: `mo_${id}`,
    property_id: `prop_${id}`,
    best_phone_id: `phone_${id}`,
    phone_id: `phone_${id}`,
    normalized_phone_e164: "+12145550101",
    owner_display_name: "Alice Smith",
    seller_first_name: "Alice",
    seller_full_name: "Alice Smith",
    prospect_full_name: "Alice Smith",
    primary_prospect_id: `prospect_${id}`,
    canonical_prospect_id: `prospect_${id}`,
    likely_owner: true,
    sms_eligible: true,
    matching_flags: "Likely Owner",
    property_address_full: "123 Proof St, Dallas, TX 75201",
    property_address_city: "Dallas",
    property_address_state: "TX",
    property_address_zip: "75201",
    market: "Dallas, TX",
    state: "TX",
    timezone: "America/Chicago",
    contact_window: "",
    property_type: "sfr",
    never_contacted: true,
    final_acquisition_score: 91,
    best_phone_score: 92,
  };
}

function fakeSupabaseWithCandidate(row) {
  return createFakeSupabase({
    outbound_feeder_candidates: [row],
    contact_outreach_state: [],
    send_queue: [],
    message_events: [],
  });
}

function proofDeps(extra = {}) {
  return {
    hasDuplicateQueueItem: async () => ({ duplicate: false, scanned_duplicate_rows_count: 0 }),
    chooseTextgridNumber: async () => ({
      ok: true,
      reason_code: "OK",
      routing_allowed: true,
      routing_tier: "proof",
      selection_reason: "proof_no_textgrid_call",
      routing_rule_name: "proof",
      selected_textgrid_market: "Dallas, TX",
      selected_textgrid_number: "+12145550199",
      seller_market: "Dallas, TX",
      seller_state: "TX",
      routing_block_reason: null,
      selected: {
        id: "textgrid_number_proof",
        phone_number: "+12145550199",
        market: "Dallas, TX",
      },
    }),
    renderOutboundTemplate: async () => ({
      ok: true,
      reason_code: "OK",
      template: {
        id: "template_proof",
        template_id: "template_proof",
        source: "proof",
        template_name: "Proof Template",
      },
      template_use_case: "ownership_check",
      selected_template_use_case: "ownership_check",
      rendered_message_body: "Hi Alice, proof only.",
      missing_variables: [],
      prospect_matching_flags: [],
      stage_code: "S1",
      stage_label: "Ownership Confirmation",
      language: "English",
      template_rotation: { enabled: false, rotation_pool_size: 0 },
    }),
    ...extra,
  };
}

function feederHeaders() {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    origin: "http://localhost:5173",
  };
  if (process.env.CRON_SECRET) headers.authorization = `Bearer ${process.env.CRON_SECRET}`;
  if (process.env.QUEUE_ENGINE_SHARED_SECRET) {
    headers["x-queue-engine-secret"] = process.env.QUEUE_ENGINE_SHARED_SECRET;
  }
  return headers;
}

const iso = "2026-06-01T12:34:56.789Z";
marker.mark("toTimestamp handles ISO string", toTimestamp(iso) === Date.parse(iso));
const date = new Date(iso);
marker.mark("toTimestamp handles Date", toTimestamp(date) === date.getTime());
marker.mark("toTimestamp handles null", toTimestamp(null) === null);
let invalidResult = "not-run";
try {
  invalidResult = toTimestamp("definitely-not-a-date");
  marker.mark("toTimestamp handles invalid string without throw", invalidResult === null);
} catch (error) {
  marker.mark("toTimestamp handles invalid string without throw", false, error?.message || String(error));
}

let textgridSendCalls = 0;
let queueRunnerCalls = 0;
const futureNow = futureBusinessIso();
const futureDb = fakeSupabaseWithCandidate(candidateRow("future"));
const futureResult = await runSupabaseCandidateFeeder(
  {
    dry_run: true,
    now: futureNow,
    limit: 1,
    scan_limit: 1,
    campaign_session_id: `timestamp-proof-future-${Date.now()}`,
    schedule_spread: true,
    schedule_start_local: "00:00",
    schedule_end_local: "23:59",
    schedule_interval_seconds_min: 60,
    schedule_interval_seconds_max: 60,
    within_contact_window_now: true,
  },
  proofDeps({
    supabase: futureDb,
    sendTextGridMessage: async () => {
      textgridSendCalls += 1;
      throw new Error("TextGrid send must not be called by feeder proof");
    },
    runSendQueue: async () => {
      queueRunnerCalls += 1;
      throw new Error("queue runner must not be called by feeder proof");
    },
  })
);

marker.mark(
  "runSupabaseCandidateFeeder dry-run future scheduled_for increments scheduled_count",
  futureResult.ok === true && futureResult.scheduled_count === 1 && futureResult.queued_count === 0,
  `scheduled=${futureResult.scheduled_count} queued=${futureResult.queued_count}`
);
marker.mark("future dry-run inserted no send_queue rows", futureDb.rows.send_queue.length === 0, `rows=${futureDb.rows.send_queue.length}`);

const invalidDb = fakeSupabaseWithCandidate(candidateRow("invalid"));
let invalidFeederResult = null;
try {
  invalidFeederResult = await runSupabaseCandidateFeeder(
    {
      dry_run: true,
      now: futureNow,
      limit: 1,
      scan_limit: 1,
      campaign_session_id: `timestamp-proof-invalid-${Date.now()}`,
      within_contact_window_now: true,
    },
    proofDeps({
      supabase: invalidDb,
      evaluateCandidateEligibility: async () => ({
        ok: true,
        reason_code: "OK",
        reason: "eligible",
        scheduled_for: "not-a-real-timestamp",
      }),
    })
  );
  marker.mark("invalid scheduled_for dry-run does not throw", invalidFeederResult?.ok === true);
} catch (error) {
  marker.mark("invalid scheduled_for dry-run does not throw", false, error?.stack || error?.message || String(error));
}

marker.mark(
  "invalid scheduled_for increments diagnostic and stays queued",
  invalidFeederResult?.invalid_scheduled_for_count === 1 &&
    invalidFeederResult?.invalid_scheduled_for_examples?.[0]?.scheduled_for === "not-a-real-timestamp" &&
    invalidFeederResult?.queued_count === 1,
  `invalid=${invalidFeederResult?.invalid_scheduled_for_count} queued=${invalidFeederResult?.queued_count}`
);
marker.mark("invalid dry-run inserted no send_queue rows", invalidDb.rows.send_queue.length === 0, `rows=${invalidDb.rows.send_queue.length}`);
marker.mark("no TextGrid send call", textgridSendCalls === 0, `calls=${textgridSendCalls}`);
marker.mark("no queue runner call", queueRunnerCalls === 0, `calls=${queueRunnerCalls}`);

const directRouteDb = fakeSupabaseWithCandidate(candidateRow("route"));
const directRouteResponse = await handleFeedCandidatesRequest(
  new Request(
    `http://proof.local/api/internal/outbound/feed-master-owners?dry_run=true&limit=1&scan_limit=1&campaign_session_id=timestamp-direct-${Date.now()}`,
    { method: "GET", headers: { accept: "application/json" } }
  ),
  "GET",
  {
    route: "internal/outbound/feed-master-owners",
    logger: { warn() {}, error() {} },
    jsonResponse: (payload, init = {}) => Response.json(payload, init),
    requireCronAuth: () => ({
      authorized: true,
      auth: { authenticated: true, required: false, reason: "proof_auth" },
      response: null,
    }),
    getSystemValue: async (key) => (key === "queue_processor_mode" ? "paused" : null),
    deps: proofDeps({ supabase: directRouteDb }),
  }
);
const directRouteRaw = await directRouteResponse.text();
let directRouteJson = null;
try {
  directRouteJson = JSON.parse(directRouteRaw);
} catch {
  directRouteJson = null;
}
marker.mark("feed-master-owners dry_run route response is JSON", Boolean(directRouteJson));
marker.mark(
  "feed-master-owners dry_run route has no ReferenceError",
  !/ReferenceError|toTimestamp is not defined/i.test(`${directRouteRaw} ${JSON.stringify(directRouteJson || {})}`)
);
marker.mark(
  "feed-master-owners route diagnostics include scheduled/queued counters",
  Number.isFinite(Number(directRouteJson?.scheduled_count)) && Number.isFinite(Number(directRouteJson?.queued_count)),
  `scheduled=${directRouteJson?.scheduled_count} queued=${directRouteJson?.queued_count}`
);

const health = await callJson(
  `/api/internal/outbound/feed-master-owners?dry_run=true&limit=1&scan_limit=1&campaign_session_id=timestamp-health-${Date.now()}`,
  {
    method: "GET",
    headers: feederHeaders(),
    timeout_seconds: 30,
  }
);

if (isHttpUnavailable(health)) {
  marker.mark("production health dry-run skipped because API server is not running", true, routeSummary(health), true);
} else {
  const raw = String(health.raw || "");
  const json = health.json;
  const serialized = `${raw} ${JSON.stringify(json || {})}`;
  const frameworkHtml = !json && /<!DOCTYPE html|__NEXT_DATA__|next-head-count/i.test(raw);
  marker.mark("feed-master-owners live dry_run response is JSON", Boolean(json && typeof json === "object"), routeSummary(health), frameworkHtml);
  marker.mark("feed-master-owners live dry_run has no ReferenceError", !/ReferenceError|toTimestamp is not defined/i.test(serialized), routeSummary(health), frameworkHtml);
  if (json && typeof json === "object") {
    marker.mark(
      "feed-master-owners live diagnostics include scheduled/queued counters",
      Number.isFinite(Number(json?.scheduled_count)) && Number.isFinite(Number(json?.queued_count)),
      `scheduled=${json?.scheduled_count} queued=${json?.queued_count} status=${health.status}`
    );
  } else {
    marker.mark("feed-master-owners live diagnostics skipped because framework returned HTML", true, routeSummary(health), true);
  }
}

marker.finish();
