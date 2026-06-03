#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  normalizeTextGridFailure,
  textGridFailureMetadata,
} from "../../apps/api/src/lib/domain/messaging/textgrid-failure-normalization.js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WINDOW_HOURS = Number(process.env.TEXTGRID_FAILURE_BACKFILL_HOURS || 72);
const APPLY = String(process.env.RUN_BACKFILL_TEXTGRID_FAILURE_CLASS || "").toLowerCase() === "true";

function clean(value) {
  return String(value ?? "").trim();
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
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
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

async function updateMetadata(table, row, metadata) {
  const { error } = await supabase
    .from(table)
    .update({ metadata: { ...(row.metadata || {}), ...metadata } })
    .eq("id", row.id);
  if (error) throw new Error(`${table}:${row.id}: ${error.message}`);
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

const candidates = [];
for (const item of [
  ...messageEvents.map((row) => ({ table: "message_events", row })),
  ...sendQueue.map((row) => ({ table: "send_queue", row })),
]) {
  const normalized = normalizeTextGridFailure(item.row);
  const metadata = textGridFailureMetadata(normalized);
  if (
    !normalized.failure_class ||
    normalized.failure_class === "unknown_failure" ||
    Object.keys(metadata).length === 0
  ) {
    continue;
  }
  if (clean(item.row.metadata?.failure_class) === normalized.failure_class) continue;
  candidates.push({ ...item, normalized, metadata });
}

let updated = 0;
const errors = [];
if (APPLY) {
  for (const candidate of candidates) {
    try {
      await updateMetadata(candidate.table, candidate.row, candidate.metadata);
      updated += 1;
    } catch (error) {
      errors.push(error.message);
    }
  }
}

console.log(JSON.stringify({
  ok: errors.length === 0,
  dry_run: !APPLY,
  apply_env_required: "RUN_BACKFILL_TEXTGRID_FAILURE_CLASS=true",
  window_hours: WINDOW_HOURS,
  cutoff_utc: cutoffIso,
  scanned: {
    message_events: messageEvents.length,
    send_queue: sendQueue.length,
  },
  candidate_count: candidates.length,
  updated_count: updated,
  candidates: candidates.map((candidate) => ({
    table: candidate.table,
    id: candidate.row.id,
    failure_class: candidate.normalized.failure_class,
    provider_failure_reason: candidate.normalized.provider_failure_reason,
  })),
  errors,
}, null, 2));

if (errors.length > 0) process.exit(1);
