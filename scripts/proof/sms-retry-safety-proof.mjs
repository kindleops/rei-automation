#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { resolveCanonicalDeliveryState } from "../../apps/api/src/lib/domain/delivery/canonical-delivery-state.js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const JSON_MODE = process.argv.includes("--json");

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function parseEnvValue(value) {
  const trimmed = clean(value);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    if (!process.env[key]) process.env[key] = parseEnvValue(normalized.slice(equalsIndex + 1));
  }
}

for (const file of [
  path.join(ROOT, "apps/api/.env.local"),
  path.join(ROOT, "apps/api/.env.production.local"),
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env"),
]) {
  loadEnvFile(file);
}

function increment(target, key) {
  const normalized = clean(key) || "unknown";
  target[normalized] = Number(target[normalized] || 0) + 1;
}

async function loadFailedRows() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return { rows: fixtureRows(), source: "fixtures", warning: "missing_supabase_env" };

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await supabase
    .from("send_queue")
    .select("id,queue_status,delivery_status,provider_delivery_status,raw_carrier_status,failed_reason,retry_count,max_retries,metadata,updated_at")
    .in("queue_status", ["failed", "Failed"])
    .order("updated_at", { ascending: false })
    .limit(250);

  if (error) return { rows: fixtureRows(), source: "fixtures", warning: `supabase_read_failed:${error.message}` };
  return { rows: data || [], source: "supabase", warning: null };
}

function fixtureRows() {
  return [
    {
      id: "fixture-21610",
      queue_status: "failed",
      failed_reason: "TextGrid HTTP failure 21610 blacklist rule",
      retry_count: 0,
      max_retries: 2,
      metadata: {},
    },
    {
      id: "fixture-timeout",
      queue_status: "failed",
      failed_reason: "network timeout",
      retry_count: 0,
      max_retries: 2,
      metadata: {},
    },
    {
      id: "fixture-unknown",
      queue_status: "failed",
      failed_reason: "delivery_failed",
      retry_count: 0,
      max_retries: 2,
      metadata: {},
    },
  ];
}

const loaded = await loadFailedRows();
const reason_counts = {};
const failure_classes = {};
const samples = [];
let terminal_skipped = 0;
let retryable = 0;
let unknown = 0;
let would_retry = 0;
let would_never_retry = 0;
let blacklist_never_retryable = true;

for (const row of loaded.rows) {
  const state = resolveCanonicalDeliveryState({
    queue_status: row.queue_status,
    provider_status: row.provider_delivery_status,
    delivery_status: row.delivery_status,
    raw_carrier_status: row.raw_carrier_status,
    provider_failure_reason: row.metadata?.provider_failure_reason || row.failed_reason,
    failed_reason: row.failed_reason,
    error_code: row.metadata?.error_code || row.metadata?.provider_error?.status,
    retry_count: row.retry_count,
    max_retry_count: Math.min(Number(row.max_retries || 2), 2),
    metadata: row.metadata || {},
    raw: row,
  });
  increment(reason_counts, state.reason);
  increment(failure_classes, state.failure_class || "none");

  if (state.terminal || state.suppression_required) terminal_skipped += 1;
  if (state.retryable) retryable += 1;
  if (state.failure_class === "unknown_delivery_failed" || state.canonical_status === "unknown") unknown += 1;
  if (state.retryable) would_retry += 1;
  if (!state.retryable || state.suppression_required || state.terminal) would_never_retry += 1;
  if (/21610|blacklist/i.test(`${row.failed_reason || ""} ${JSON.stringify(row.metadata || {})}`)) {
    blacklist_never_retryable = blacklist_never_retryable && !state.retryable && state.suppression_required;
  }
  if (samples.length < 12) {
    samples.push({
      id: row.id,
      failed_reason: row.failed_reason || null,
      canonical_status: state.canonical_status,
      failure_class: state.failure_class,
      retryable: state.retryable,
      terminal: state.terminal,
      suppression_required: state.suppression_required,
      reason: state.reason,
    });
  }
}

const result = {
  ok: blacklist_never_retryable,
  source: loaded.source,
  warning: loaded.warning,
  total_failed_checked: loaded.rows.length,
  terminal_skipped,
  retryable,
  unknown,
  would_retry,
  would_never_retry,
  reason_counts,
  failure_classes,
  blacklist_21610_never_retryable: blacklist_never_retryable,
  samples,
};

if (JSON_MODE) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`# SMS Retry Safety Proof

- source: ${result.source}${result.warning ? ` (${result.warning})` : ""}
- total_failed_checked: ${result.total_failed_checked}
- terminal_skipped: ${result.terminal_skipped}
- retryable: ${result.retryable}
- unknown: ${result.unknown}
- would_retry: ${result.would_retry}
- would_never_retry: ${result.would_never_retry}
- blacklist_21610_never_retryable: ${result.blacklist_21610_never_retryable}
`);
}

if (!result.ok) process.exit(1);
