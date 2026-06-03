#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { normalizeTextGridFailure } from "../../apps/api/src/lib/domain/messaging/textgrid-failure-normalization.js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WINDOW_HOURS = Number(process.env.TEXTGRID_FAILURE_AUDIT_HOURS || 72);

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

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.warn("WARN Supabase service role env missing; audit skipped");
  process.exit(0);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function fetchAll(table, select, timestampColumn, cutoffIso) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0;; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .gte(timestampColumn, cutoffIso)
      .order(timestampColumn, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

function stringifyFailure(row = {}) {
  try {
    return JSON.stringify({
      status: row.status,
      delivery_status: row.delivery_status,
      provider_delivery_status: row.provider_delivery_status,
      raw_carrier_status: row.raw_carrier_status,
      failure_class: row.failure_class,
      failure_reason: row.failure_reason,
      failed_reason: row.failed_reason,
      blocked_reason: row.blocked_reason,
      guard_reason: row.guard_reason,
      error_message: row.error_message,
      metadata: row.metadata,
    });
  } catch {
    return "";
  }
}

function senderFor(row = {}) {
  return clean(row.from_phone_number) ||
    clean(row.textgrid_number) ||
    clean(row.metadata?.from_phone_number) ||
    clean(row.metadata?.textgrid_number) ||
    clean(row.textgrid_number_id) ||
    "unknown";
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

const cutoffIso = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
const [messageEvents, sendQueue] = await Promise.all([
  fetchAll(
    "message_events",
    "*",
    "created_at",
    cutoffIso
  ),
  fetchAll(
    "send_queue",
    "*",
    "created_at",
    cutoffIso
  ),
]);

const allRows = [
  ...messageEvents.map((row) => ({ table: "message_events", row })),
  ...sendQueue.map((row) => ({ table: "send_queue", row })),
];

const currentFailureClasses = {};
const senderBreakdown = {};
const contentFilterRows = [];
const missingFailureClass = [];
const candidateRows = [];

for (const item of allRows) {
  const currentClass = clean(item.row.failure_class || item.row.metadata?.failure_class) || "(missing)";
  increment(currentFailureClasses, currentClass);

  const normalized = normalizeTextGridFailure(item.row);
  const isKnownProviderClass = Boolean(normalized.failure_class && normalized.failure_class !== "unknown_failure");
  if (isKnownProviderClass) {
    const sender = senderFor(item.row);
    senderBreakdown[sender] ||= {};
    increment(senderBreakdown[sender], normalized.failure_class);
  }

  const rawText = lower(stringifyFailure(item.row));
  if (rawText.includes("content filter")) {
    contentFilterRows.push({
      table: item.table,
      id: item.row.id,
      sender_number: senderFor(item.row),
      current_failure_class: currentClass,
      normalized_failure_class: normalized.failure_class,
      reason: clean(item.row.failure_reason || item.row.failed_reason || item.row.error_message || item.row.metadata?.provider_failure_reason),
    });
  }

  if (isKnownProviderClass && currentClass === "(missing)") {
    missingFailureClass.push({ table: item.table, id: item.row.id, normalized_failure_class: normalized.failure_class });
    candidateRows.push({
      table: item.table,
      id: item.row.id,
      sender_number: senderFor(item.row),
      normalized_failure_class: normalized.failure_class,
      provider_failure_reason: normalized.provider_failure_reason,
    });
  }
}

console.log(JSON.stringify({
  ok: true,
  mode: "read_only",
  window_hours: WINDOW_HOURS,
  cutoff_utc: cutoffIso,
  scanned: {
    message_events: messageEvents.length,
    send_queue: sendQueue.length,
  },
  raw_failures_containing_content_filter: contentFilterRows,
  current_failure_class_values: currentFailureClasses,
  rows_missing_failure_class: missingFailureClass.length,
  sender_number_breakdown: senderBreakdown,
  candidate_rows_for_backfill: candidateRows,
}, null, 2));
