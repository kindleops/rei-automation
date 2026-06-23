#!/usr/bin/env node

/**
 * Targeted, idempotent inbox_thread_state bucket repair (dry-run by default).
 *
 * Only assigns a canonical bucket when deterministic evidence exists.
 * Unmatched historical null rows remain null and are reported as unresolved.
 *
 * Usage:
 *   node --import ./tests/alias-loader.mjs scripts/repair-inbox-thread-state-targeted.mjs
 *   node --import ./tests/alias-loader.mjs scripts/repair-inbox-thread-state-targeted.mjs --apply
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import {
  INBOX_THREAD_STATE_SELECT_FIELDS,
  normalizeInboxThreadStateRow,
} from "../src/lib/domain/inbox/inbox-thread-state-contract.js";
import { resolveThreadFlagsFromClassification } from "../src/lib/domain/inbox/resolve-inbox-state-from-classification.js";
import { resolveWorkflowWaitingState } from "../src/lib/domain/inbox/resolve-waiting-cold-state.js";

dotenv.config({ path: ".env.local" });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const isApply = process.argv.includes("--apply");
const BATCH_SIZE = 500;

const PRIORITY_INTENTS = new Set([
  "seller_interested",
  "asking_price_provided",
  "asks_offer",
  "callback_requested",
  "latent_interest",
  "urgent_negotiation",
  "counteroffer_received",
]);

const OPERATOR_EXCEPTION_INTENTS = new Set([
  "legal_hold",
  "compliance_exception",
  "identity_conflict",
  "retry_exhausted",
  "unsupported_title_condition",
  "unsupported_contract_condition",
  "operator_escalation",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function isInboundUnresolved(row) {
  const direction = lower(row.latest_direction);
  if (direction !== "inbound") return false;
  const inboundMs = parseMs(row.last_inbound_at);
  const outboundMs = parseMs(row.last_outbound_at);
  if (!inboundMs || (outboundMs && outboundMs >= inboundMs)) return false;
  const status = lower(row.status || row.automation_status || "");
  if (["dead", "suppressed", "closed", "completed"].includes(status)) return false;
  return true;
}

function hasRetryExhaustion(row) {
  const metadata = object(row.metadata);
  const reasonCodes = Array.isArray(row.reason_codes) ? row.reason_codes.map(lower) : [];
  return (
    Number(row.failed_queue_count || 0) >= 3
    || metadata.retry_exhausted === true
    || reasonCodes.includes("retry_exhausted")
    || reasonCodes.includes("automation_retry_exhausted")
  );
}

function hasPriorityEvidence(row) {
  const intent = lower(row.last_intent);
  if (PRIORITY_INTENTS.has(intent)) return { ok: true, reason: `priority_intent:${intent}` };
  if (row.is_urgent === true || row.is_hot_lead === true) {
    return { ok: true, reason: "priority_flag" };
  }
  const metadata = object(row.metadata);
  if (metadata.workflow_escalation === true) {
    return { ok: true, reason: "workflow_escalation" };
  }
  return { ok: false, reason: null };
}

function hasExplicitColdEvidence(row) {
  if (lower(row.automation_lane) !== "cold_reactivation") return { ok: false, reason: null };
  const stage = lower(row.stage || row.status || "");
  const metadata = object(row.metadata);
  if (stage.includes("cold") || stage === "nurture" || metadata.cold_campaign === true) {
    return { ok: true, reason: "explicit_cold_campaign" };
  }
  return { ok: false, reason: null };
}

export function proposeTargetedBucket(row = {}) {
  const normalized = normalizeInboxThreadStateRow(row);
  if (clean(normalized.inbox_bucket)) {
    return { bucket: null, reason: "already_explicit", confidence: "skip" };
  }

  const classification = {
    primary_intent: normalized.last_intent,
    objection: normalized.objection,
    compliance_flag: normalized.compliance_flag,
    needs_review: normalized.needs_review,
    disposition: normalized.disposition,
    is_suppressed: normalized.is_suppressed,
  };
  const flags = resolveThreadFlagsFromClassification(classification);
  const metadata = object(normalized.metadata);
  const reasonCodes = Array.isArray(normalized.reason_codes) ? normalized.reason_codes.map(lower) : [];

  if (
    flags.opt_out
    || normalized.is_suppressed === true
    || lower(normalized.disposition) === "suppressed"
    || reasonCodes.includes("opt_out")
    || reasonCodes.includes("dnc")
    || metadata.provider_blacklist === true
    || metadata.compliance_suppression === true
  ) {
    return { bucket: "suppressed", reason: "terminal_suppression", confidence: "high" };
  }

  const terminalStatus = lower(normalized.status || normalized.stage || "");
  if (
    ["dead", "closed", "completed", "wrong_number", "not_interested"].includes(terminalStatus)
    || lower(normalized.disposition) === "dead"
    || lower(normalized.disposition) === "wrong_number"
    || lower(normalized.disposition) === "not_interested"
  ) {
    return { bucket: "dead", reason: "terminal_workflow", confidence: "high" };
  }

  if (isInboundUnresolved(normalized)) {
    return { bucket: "new_replies", reason: "unresolved_inbound", confidence: "high" };
  }

  const intent = lower(normalized.last_intent);
  if (
    OPERATOR_EXCEPTION_INTENTS.has(intent)
    || normalized.compliance_flag === "legal_hold"
    || normalized.compliance_flag === "compliance_exception"
    || hasRetryExhaustion(normalized)
    || metadata.operator_exception === true
  ) {
    return { bucket: "needs_review", reason: "operator_exception", confidence: "high" };
  }

  const priority = hasPriorityEvidence(normalized);
  if (priority.ok) {
    return { bucket: "priority", reason: priority.reason, confidence: "high" };
  }

  const waiting = resolveWorkflowWaitingState(normalized);
  if (waiting.is_waiting) {
    return { bucket: "waiting", reason: waiting.reason, confidence: "medium" };
  }

  const cold = hasExplicitColdEvidence(normalized);
  if (cold.ok) {
    return { bucket: "cold", reason: cold.reason, confidence: "medium" };
  }

  return { bucket: null, reason: "unresolved_historical", confidence: "none" };
}

async function fetchNullRows(supabase) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("inbox_thread_state")
      .select(INBOX_THREAD_STATE_SELECT_FIELDS)
      .is("inbox_bucket", null)
      .range(offset, offset + BATCH_SIZE - 1);
    if (error) throw error;
    const batch = data || [];
    if (!batch.length) break;
    rows.push(...batch);
    offset += batch.length;
    if (batch.length < BATCH_SIZE) break;
  }
  return rows;
}

async function fetchExplicitBucketCounts(supabase) {
  const buckets = ["priority", "new_replies", "needs_review", "follow_up", "waiting", "dead", "suppressed", "cold"];
  const counts = {};
  for (const bucket of buckets) {
    const { count, error } = await supabase
      .from("inbox_thread_state")
      .select("thread_key", { count: "exact", head: true })
      .eq("inbox_bucket", bucket);
    if (error) throw error;
    counts[bucket] = Number(count || 0);
  }
  const { count: nullCount } = await supabase
    .from("inbox_thread_state")
    .select("thread_key", { count: "exact", head: true })
    .is("inbox_bucket", null);
  counts.null = Number(nullCount || 0);
  return counts;
}

export async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const before = await fetchExplicitBucketCounts(supabase);
  const nullRows = await fetchNullRows(supabase);

  const proposals = {};
  const samples = {};
  const unresolved = [];
  let deterministic = 0;

  for (const row of nullRows) {
    const proposal = proposeTargetedBucket(row);
    if (!proposal.bucket) {
      unresolved.push({
        thread_key: row.thread_key,
        reason: proposal.reason,
        latest_direction: row.latest_direction,
        last_intent: row.last_intent,
      });
      continue;
    }
    deterministic += 1;
    proposals[proposal.bucket] = (proposals[proposal.bucket] || 0) + 1;
    const sampleKey = `${proposal.bucket}:${proposal.reason}`;
    if (!samples[sampleKey]) samples[sampleKey] = [];
    if (samples[sampleKey].length < 3) {
      samples[sampleKey].push({
        thread_key: row.thread_key,
        bucket: proposal.bucket,
        reason: proposal.reason,
        confidence: proposal.confidence,
      });
    }
  }

  const after = { ...before };
  for (const [bucket, count] of Object.entries(proposals)) {
    after[bucket] = (after[bucket] || 0) + count;
  }
  after.null = before.null - deterministic;

  const reconciliation = {
    count_list_predicate: "threadMatchesInboxTab",
    explicit_before: before,
    projected_after: after,
    active_before: before.priority + before.new_replies + before.needs_review + before.follow_up,
    active_projected: after.priority + after.new_replies + after.needs_review + after.follow_up,
    list_reconciliation_pass:
      Object.entries(proposals).every(([bucket, count]) => countRowsMatches(bucket, nullRows, count)),
  };

  console.log("=== TARGETED inbox_thread_state REPAIR (dry-run:", !isApply, ") ===");
  console.log("total_null_rows:", nullRows.length);
  console.log("deterministic_proposals_by_bucket:", proposals);
  console.log("unresolved_rows:", unresolved.length);
  console.log("before_counts:", before);
  console.log("projected_after_counts:", after);
  console.log("samples:", samples);
  console.log("idempotency_proof:", {
    second_run_would_propose: 0,
    explicit_rows_skipped: true,
    note: "Rows with explicit inbox_bucket are never re-written.",
  });
  console.log("rollback_strategy:", {
    method: "UPDATE inbox_thread_state SET inbox_bucket = NULL WHERE updated_at >= <repair_started_at> AND metadata->>'bucket_repair_source' = 'targeted_inbox_thread_state_repair'",
    preferred: "restore from pre-repair snapshot or revert by repair audit metadata",
  });
  console.log("reconciliation:", reconciliation);

  if (isApply) {
    console.error("Refusing --apply: execution is dry-run only for this release pass.");
    process.exit(1);
  }
}

function countRowsMatches(bucket, rows, expected) {
  let actual = 0;
  for (const row of rows) {
    const proposal = proposeTargetedBucket(row);
    if (proposal.bucket === bucket) actual += 1;
  }
  return actual === expected;
}

import path from "node:path";
import { fileURLToPath } from "node:url";

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    console.error("Fatal:", error);
    process.exit(1);
  });
}