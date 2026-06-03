#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const DEFAULT_TOP = 12;
const DEFAULT_MAX_ROWS_PER_QUERY = 50000;
const FETCH_PAGE_SIZE = 1000;
const PHONE_ENRICHMENT_TABLES = [
  "v_sms_ready_contacts_expanded",
  "v_sms_ready_contacts",
  "phones",
  "phone_numbers",
];
const PHONE_LOOKUP_COLUMNS = [
  "canonical_e164",
  "canonical_phone",
  "phone_number",
  "phone",
  "e164",
  "normalized_phone",
  "best_phone",
  "canonical_phone_number",
];

const SENT_QUEUE_STATUSES = new Set([
  "sent",
  "delivered",
  "failed",
  "blocked",
  "carrier_blocked",
  "failed_transport",
  "invalid_number",
  "opted_out",
  "delivery_failed",
]);
const DELIVERED_STATUSES = new Set(["delivered", "delivery_confirmed", "confirmed"]);
const FAILED_STATUSES = new Set([
  "failed",
  "undelivered",
  "rejected",
  "error",
  "delivery_failed",
  "carrier_blocked",
  "failed_transport",
  "invalid_number",
  "opted_out",
  "blocked",
]);
const PENDING_STATUSES = new Set([
  "sent",
  "queued",
  "accepted",
  "pending",
  "sending",
  "sending_to_carrier",
  "pending_delivered_to_carrier",
  "awaiting_response",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
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
  path.join(ROOT, "apps/dashboard/.env.local"),
  path.join(ROOT, "apps/dashboard/.env"),
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env"),
]) {
  loadEnvFile(file);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const withoutPrefix = arg.slice(2);
    if (withoutPrefix.includes("=")) {
      const [key, ...rest] = withoutPrefix.split("=");
      args[key] = rest.join("=");
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[withoutPrefix] = true;
      continue;
    }
    args[withoutPrefix] = next;
    index += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

function argValue(names, envNames = []) {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== true && clean(value)) return clean(value);
  }
  for (const name of envNames) {
    const value = process.env[name];
    if (clean(value)) return clean(value);
  }
  return "";
}

function usage() {
  return `
SMS Delivery Variance Diagnosis

Read-only Supabase diagnosis. It does not call TextGrid, run queues, insert rows, update rows, or send SMS.

Required:
  --good-start <iso-or-date>   Good window start, inclusive
  --good-end <iso-or-date>     Good window end, exclusive. Date-only values are UTC midnights.
  --bad-start <iso-or-date>    Bad window start, inclusive
  --bad-end <iso-or-date>      Bad window end, exclusive. Date-only values are UTC midnights.

Optional:
  --top <n>                    Top distribution rows to print. Default: ${DEFAULT_TOP}
  --timezone <iana-zone>       Local hour bucket timezone. Default: America/Chicago
  --json                       Print JSON instead of Markdown
  --max-rows <n>               Per-query row cap before failing. Default: ${DEFAULT_MAX_ROWS_PER_QUERY}
  --skip-phone-enrichment      Do not look up phone facts from Supabase views/tables

Env aliases:
  GOOD_WINDOW_START GOOD_WINDOW_END BAD_WINDOW_START BAD_WINDOW_END
  SMS_DIAG_GOOD_START SMS_DIAG_GOOD_END SMS_DIAG_BAD_START SMS_DIAG_BAD_END

Example:
  node scripts/proof/sms-delivery-variance-diagnosis.mjs \\
    --good-start 2026-05-29 --good-end 2026-05-30 \\
    --bad-start 2026-05-30 --bad-end 2026-05-31
`.trim();
}

if (args.help || args.h) {
  console.log(usage());
  process.exit(0);
}

function parseBoundary(value, kind) {
  const text = clean(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return new Date(`${text}T00:00:00.000Z`);
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${kind} boundary: ${text}`);
  }
  return date;
}

function looksUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value));
}

function parseWindow(label) {
  const prefix = label.toUpperCase();
  const startRaw = argValue(
    [`${label}-start`, `${label}_start`],
    [`SMS_DIAG_${prefix}_START`, `${prefix}_WINDOW_START`, `${prefix}_START`]
  );
  const endRaw = argValue(
    [`${label}-end`, `${label}_end`],
    [`SMS_DIAG_${prefix}_END`, `${prefix}_WINDOW_END`, `${prefix}_END`]
  );
  const start = parseBoundary(startRaw, "start");
  const end = parseBoundary(endRaw, "end");
  if (!start || !end) throw new Error(`Missing ${label} window. Pass --${label}-start and --${label}-end.`);
  if (end.getTime() <= start.getTime()) throw new Error(`${label} window end must be after start.`);
  return {
    label,
    start_raw: startRaw,
    end_raw: endRaw,
    start,
    end,
    start_iso: start.toISOString(),
    end_iso: end.toISOString(),
  };
}

function asNumber(value, fallback = 0) {
  if (value === null || value === undefined || clean(value) === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function pct(part, total, digits = 1) {
  if (!total) return 0;
  return round((Number(part || 0) / Number(total || 0)) * 100, digits);
}

function normalizePhone(value) {
  const text = clean(value);
  if (!text) return "";
  const hasPlus = text.startsWith("+");
  const digits = text.replace(/\D+/g, "");
  if (!digits) return text;
  if (hasPlus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function shortHash(value, length = 12) {
  const text = clean(value);
  if (!text) return "missing";
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, length);
}

function normalizeBody(value) {
  return clean(value).replace(/\s+/g, " ");
}

function bodyHash(value) {
  const body = normalizeBody(value);
  if (!body) return "missing";
  return `sha256:${shortHash(body)}`;
}

function safeJson(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function normalizeTextGridFailure(input = {}) {
  const metadata = isPlainObject(input.metadata) ? input.metadata : {};
  const raw = isPlainObject(input.raw) ? input.raw : {};
  const providerReason = clean(coalesce(
    input.provider_failure_reason,
    input.failure_reason,
    input.error_message,
    input.reason,
    input.message,
    input.error?.message,
    input.failed_reason,
    input.blocked_reason,
    input.guard_reason,
    metadata.provider_failure_reason,
    metadata.failure_reason,
    metadata.reason,
    metadata.message,
    metadata.error_message,
    metadata.provider_error?.provider_failure_reason,
    metadata.provider_error?.failure_reason,
    metadata.provider_error?.error_message,
    metadata.provider_error?.message,
    metadata.send_result?.provider_failure_reason,
    metadata.send_result?.failure_reason,
    metadata.send_result?.reason,
    metadata.send_result?.error_message,
    metadata.send_result?.message,
    raw.provider_failure_reason,
    raw.failure_reason,
    raw.reason,
    raw.message,
    raw.error_message,
    raw.ErrorMessage
  ));
  const combined = lower([
    input.status,
    input.delivery_status,
    input.provider_delivery_status,
    input.raw_carrier_status,
    input.failure_class,
    input.normalized_reason,
    providerReason,
    metadata.failure_class,
    metadata.normalized_reason,
    metadata.provider_error,
    metadata.send_result,
    raw,
    safeJson(input),
  ].map(safeJson).filter(Boolean).join(" | "));
  const status = lower(coalesce(
    input.delivery_status,
    input.status,
    input.provider_delivery_status,
    metadata.status,
    raw.status
  ));
  const failedStatus = FAILED_STATUSES.has(status);
  const sentStatus = PENDING_STATUSES.has(status);
  const base = {
    delivery_status: failedStatus ? "failed" : sentStatus ? "sent" : null,
    failure_class: null,
    provider_failure_reason: providerReason || null,
    normalized_reason: null,
    is_terminal: false,
    retry_allowed: true,
  };
  const existingClass = lower(coalesce(
    input.failure_class,
    metadata.failure_class,
    raw.failure_class,
    input.normalized_reason,
    metadata.normalized_reason,
    raw.normalized_reason
  )).replace(/[-\s]+/g, "_");

  function withClass(failureClass, normalizedReason = failureClass, overrides = {}) {
    return {
      ...base,
      delivery_status: "failed",
      failure_class: failureClass,
      normalized_reason: normalizedReason,
      is_terminal: true,
      retry_allowed: false,
      ...overrides,
    };
  }

  if (["content_filter_blocked", "blocked_by_textgrid_content_filter"].includes(existingClass)) {
    return withClass("content_filter_blocked", "blocked_by_textgrid_content_filter");
  }
  if (["recipient_opted_out", "provider_blacklist", "opted_out"].includes(existingClass)) {
    return withClass("recipient_opted_out", existingClass === "provider_blacklist" ? "provider_blacklist" : "recipient_opted_out");
  }
  if (["invalid_to_number", "invalid_number"].includes(existingClass)) {
    return withClass("invalid_to_number", "invalid_to_number");
  }
  if (existingClass === "recipient_out_of_credit") {
    return withClass("recipient_out_of_credit", "recipient_out_of_credit", { is_terminal: false, retry_allowed: true });
  }
  if (existingClass === "unknown_failure") {
    return withClass("unknown_failure", "unknown_failure");
  }
  if (combined.includes("blocked by textgrid content filter") || combined.includes("content filter")) {
    return withClass("content_filter_blocked", "blocked_by_textgrid_content_filter");
  }
  if (
    combined.includes("21610") ||
    combined.includes("recipient opted out") ||
    combined.includes("blacklist") ||
    combined.includes("opted out") ||
    combined.includes("opt out") ||
    combined.includes("opt-out")
  ) {
    return withClass(
      "recipient_opted_out",
      combined.includes("blacklist") || combined.includes("21610") ? "provider_blacklist" : "recipient_opted_out"
    );
  }
  if (
    combined.includes("'to' number invalid") ||
    combined.includes("\"to\" number invalid") ||
    combined.includes("to number invalid") ||
    combined.includes("invalid destination") ||
    combined.includes("invalid number") ||
    combined.includes("not a valid phone") ||
    lower(providerReason) === "invalid"
  ) {
    return withClass("invalid_to_number", "invalid_to_number");
  }
  if (combined.includes("end user out of credit")) {
    return withClass("recipient_out_of_credit", "recipient_out_of_credit", { is_terminal: false, retry_allowed: true });
  }
  if (failedStatus) return withClass("unknown_failure", "unknown_failure");
  if (providerReason || clean(input.failed_reason) || clean(input.blocked_reason) || clean(input.guard_reason)) {
    return withClass("unknown_failure", "unknown_failure", { is_terminal: false, retry_allowed: true });
  }
  return base;
}

function coalesce(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && clean(value)) return value;
  }
  return "";
}

function objectAtPath(source, pathParts) {
  let cursor = source;
  for (const part of pathParts) {
    if (!isPlainObject(cursor) && !Array.isArray(cursor)) return undefined;
    cursor = cursor?.[part];
  }
  return cursor;
}

function valueFromPaths(source, paths) {
  for (const pathText of paths) {
    const value = objectAtPath(source, pathText.split("."));
    if (value !== null && value !== undefined && clean(value)) return value;
  }
  return "";
}

function mergeMetadata(...values) {
  const merged = {};
  for (const value of values) {
    if (isPlainObject(value)) Object.assign(merged, value);
  }
  return merged;
}

function isOutboundEvent(row = {}) {
  const direction = lower(row.direction);
  if (direction) return direction === "outbound";
  const eventType = lower(row.event_type || row.type || row.message_type);
  return eventType.includes("outbound") || eventType.includes("sent") || eventType.includes("sms");
}

function isProofOrNoSend(row = {}) {
  const metadata = isPlainObject(row.metadata) ? row.metadata : {};
  return Boolean(
    metadata.no_send === true ||
      metadata.proof === true ||
      metadata.proof_mode === true ||
      metadata.exclude_from_kpis === true ||
      lower(metadata.source).includes("proof") ||
      lower(metadata.created_from).includes("proof")
  );
}

function isQueueAttempt(row = {}) {
  if (isProofOrNoSend(row)) return false;
  if (row.sent_at || row.provider_message_id || row.textgrid_message_id) return true;
  if (SENT_QUEUE_STATUSES.has(lower(row.queue_status))) return true;
  return false;
}

function rowTimestampCandidatesFromQueue(row = {}) {
  return [row.sent_at, row.scheduled_for, row.created_at, row.updated_at].filter(Boolean);
}

function rowTimestampCandidatesFromEvent(row = {}) {
  return [row.sent_at, row.event_timestamp, row.created_at, row.updated_at].filter(Boolean);
}

function parseTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isWithinWindow(value, window) {
  const date = parseTime(value);
  if (!date) return false;
  return date.getTime() >= window.start.getTime() && date.getTime() < window.end.getTime();
}

function firstTimestampInWindow(candidates, window) {
  for (const candidate of candidates) {
    if (isWithinWindow(candidate, window)) return new Date(candidate).toISOString();
  }
  for (const candidate of candidates) {
    const date = parseTime(candidate);
    if (date) return date.toISOString();
  }
  return null;
}

function hourBucket(value, timezone = "America/Chicago") {
  const date = parseTime(value);
  if (!date) return "unknown";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const hour = parts.find((part) => part.type === "hour")?.value || "00";
    return `${timezone}:${hour}:00`;
  } catch {
    return `${String(date.getUTCHours()).padStart(2, "0")}:00Z`;
  }
}

function attemptKeysFromQueue(row = {}) {
  const keys = [];
  if (row.id) keys.push(`queue:${row.id}`);
  if (row.queue_id) keys.push(`queue:${row.queue_id}`);
  if (row.queue_key) keys.push(`queue_key:${row.queue_key}`);
  if (row.provider_message_id) keys.push(`provider:${row.provider_message_id}`);
  if (row.textgrid_message_id) keys.push(`provider:${row.textgrid_message_id}`);
  return [...new Set(keys.map(clean).filter(Boolean))];
}

function attemptKeysFromEvent(row = {}) {
  const metadata = isPlainObject(row.metadata) ? row.metadata : {};
  const keys = [];
  if (row.queue_id) keys.push(`queue:${row.queue_id}`);
  if (metadata.queue_id) keys.push(`queue:${metadata.queue_id}`);
  if (metadata.outbound_queue_id) keys.push(`queue:${metadata.outbound_queue_id}`);
  if (row.message_event_key) keys.push(`event_key:${row.message_event_key}`);
  if (row.provider_message_sid) keys.push(`provider:${row.provider_message_sid}`);
  if (row.provider_message_id) keys.push(`provider:${row.provider_message_id}`);
  if (row.textgrid_message_id) keys.push(`provider:${row.textgrid_message_id}`);
  if (metadata.provider_message_id) keys.push(`provider:${metadata.provider_message_id}`);
  if (metadata.textgrid_message_id) keys.push(`provider:${metadata.textgrid_message_id}`);
  return [...new Set(keys.map(clean).filter(Boolean))];
}

function fallbackAttemptKeyFromEvent(row = {}) {
  const body = bodyHash(row.message_body || row.message_text || row.rendered_message);
  const to = normalizePhone(row.to_phone_number);
  const from = normalizePhone(row.from_phone_number);
  const minute = clean(row.sent_at || row.event_timestamp || row.created_at).slice(0, 16);
  return `event_fallback:${from}:${to}:${body}:${minute || row.id || crypto.randomUUID()}`;
}

function fallbackAttemptKeyFromQueue(row = {}) {
  const body = bodyHash(row.rendered_message || row.message_body || row.message_text);
  const to = normalizePhone(row.to_phone_number);
  const from = normalizePhone(row.from_phone_number || row.textgrid_number);
  const minute = clean(row.sent_at || row.created_at || row.scheduled_for).slice(0, 16);
  return `queue_fallback:${from}:${to}:${body}:${minute || row.id || crypto.randomUUID()}`;
}

function sortNewestRows(rows = []) {
  return [...rows].sort((a, b) => {
    const bt = new Date(b.updated_at || b.delivered_at || b.failed_at || b.created_at || 0).getTime();
    const at = new Date(a.updated_at || a.delivered_at || a.failed_at || a.created_at || 0).getTime();
    return bt - at;
  });
}

function combinedFailureInput(attempt = {}) {
  const latestEvent = sortNewestRows(attempt.event_rows)[0] || {};
  const queue = attempt.queue_row || {};
  const metadata = mergeMetadata(queue.metadata, latestEvent.metadata);
  return {
    ...queue,
    ...latestEvent,
    metadata,
    raw: {
      queue,
      latest_event: latestEvent,
      events: attempt.event_rows || [],
    },
  };
}

function rawDeliveryStatus(attempt = {}) {
  const latestEvent = sortNewestRows(attempt.event_rows)[0] || {};
  const queue = attempt.queue_row || {};
  return clean(
    latestEvent.provider_delivery_status ||
      latestEvent.delivery_status ||
      latestEvent.raw_carrier_status ||
      queue.provider_delivery_status ||
      queue.delivery_status ||
      queue.raw_carrier_status ||
      queue.queue_status ||
      latestEvent.status
  );
}

function deliveryState(attempt = {}) {
  const input = combinedFailureInput(attempt);
  const normalizedFailure = normalizeTextGridFailure(input);
  const status = lower(rawDeliveryStatus(attempt));
  const queueStatus = lower(attempt.queue_row?.queue_status);

  if (DELIVERED_STATUSES.has(status) || DELIVERED_STATUSES.has(queueStatus)) return "delivered";
  if (
    FAILED_STATUSES.has(status) ||
    FAILED_STATUSES.has(queueStatus) ||
    normalizedFailure.failure_class
  ) {
    return "failed";
  }
  if (PENDING_STATUSES.has(status) || PENDING_STATUSES.has(queueStatus)) return "pending";
  return "unknown";
}

function failureClass(attempt = {}) {
  const input = combinedFailureInput(attempt);
  const normalizedFailure = normalizeTextGridFailure(input);
  if (normalizedFailure.failure_class) return normalizedFailure.failure_class;
  const metadata = input.metadata || {};
  return clean(input.failure_class || metadata.failure_class || metadata.normalized_reason) || "none";
}

function collectFailureText(attempt = {}) {
  const input = combinedFailureInput(attempt);
  const metadata = input.metadata || {};
  const pieces = [
    input.provider_failure_reason,
    input.failure_reason,
    input.error_message,
    input.raw_carrier_status,
    input.failed_reason,
    input.blocked_reason,
    input.guard_reason,
    metadata.provider_failure_reason,
    metadata.failure_reason,
    metadata.normalized_reason,
    metadata.failure_class,
    metadata.provider_error?.message,
    metadata.provider_error?.error_message,
    metadata.provider_error?.reason,
    metadata.send_result?.message,
    metadata.send_result?.error_message,
    metadata.send_result?.reason,
  ].map(clean).filter(Boolean);
  const text = pieces[0] || safeJson({
    provider_delivery_status: input.provider_delivery_status,
    delivery_status: input.delivery_status,
    raw_carrier_status: input.raw_carrier_status,
  });
  return clean(text).replace(/\s+/g, " ").slice(0, 180) || "none";
}

function renderedBody(attempt = {}) {
  const queue = attempt.queue_row || {};
  const latestEvent = sortNewestRows(attempt.event_rows)[0] || {};
  return clean(
    queue.rendered_message ||
      queue.message_body ||
      queue.message_text ||
      latestEvent.message_body ||
      latestEvent.message_text ||
      latestEvent.rendered_message
  );
}

function smsSegments(text) {
  const body = clean(text);
  if (!body) return 0;
  const gsm =
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ" +
    " !\"#¤%&'()*+,-./0123456789:;<=>?" +
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
  const isGsm7 = [...body].every((char) => gsm.includes(char) || "^{}\\[~]|€".includes(char));
  const single = isGsm7 ? 160 : 70;
  const concat = isGsm7 ? 153 : 67;
  if (body.length <= single) return 1;
  return Math.ceil(body.length / concat);
}

function lengthBucket(length) {
  const n = Number(length || 0);
  if (n <= 0) return "missing";
  if (n <= 80) return "001-080";
  if (n <= 120) return "081-120";
  if (n <= 160) return "121-160";
  if (n <= 306) return "161-306";
  return "307+";
}

function senderNumber(attempt = {}) {
  const queue = attempt.queue_row || {};
  const latestEvent = sortNewestRows(attempt.event_rows)[0] || {};
  const metadata = mergeMetadata(queue.metadata, latestEvent.metadata);
  return normalizePhone(coalesce(
    queue.from_phone_number,
    latestEvent.from_phone_number,
    queue.textgrid_number,
    metadata.selected_textgrid_number,
    metadata.selected_sender_diagnostics?.selected_textgrid_number,
    metadata.safety_diagnostics?.routing?.selected_textgrid_number,
    queue.textgrid_number_id,
    latestEvent.textgrid_number_id
  )) || "unknown";
}

function recipientNumber(attempt = {}) {
  const queue = attempt.queue_row || {};
  const latestEvent = sortNewestRows(attempt.event_rows)[0] || {};
  return normalizePhone(coalesce(queue.to_phone_number, latestEvent.to_phone_number, attempt.thread_key)) || "unknown";
}

function templateId(attempt = {}) {
  const queue = attempt.queue_row || {};
  const latestEvent = sortNewestRows(attempt.event_rows)[0] || {};
  const metadata = mergeMetadata(queue.metadata, latestEvent.metadata);
  return clean(coalesce(
    queue.template_id,
    queue.selected_template_id,
    queue.template_selected,
    queue.template_key,
    latestEvent.template_id,
    latestEvent.selected_template_id,
    metadata.template_id,
    metadata.template?.id,
    metadata.safety_diagnostics?.template?.id
  )) || "unknown";
}

function canonicalTemplateFamily(value) {
  const text = lower(value)
    .replace(/^sms[_:-]?/, "")
    .replace(/[_:-]?(v|variant|touch|t)\d+$/i, "")
    .replace(/[_:-]?\d+$/i, "")
    .replace(/[_:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return text || "unknown";
}

function templateFamily(attempt = {}) {
  const queue = attempt.queue_row || {};
  const latestEvent = sortNewestRows(attempt.event_rows)[0] || {};
  const metadata = mergeMetadata(queue.metadata, latestEvent.metadata);
  return canonicalTemplateFamily(coalesce(
    queue.use_case_template,
    queue.current_stage,
    queue.message_type,
    queue.type,
    metadata.template_use_case,
    metadata.template?.use_case,
    metadata.safety_diagnostics?.template?.use_case,
    templateId(attempt)
  ));
}

function marketValue(attempt = {}) {
  const queue = attempt.queue_row || {};
  const latestEvent = sortNewestRows(attempt.event_rows)[0] || {};
  const metadata = mergeMetadata(queue.metadata, latestEvent.metadata);
  return clean(coalesce(
    queue.market,
    latestEvent.market,
    metadata.seller_market,
    metadata.market,
    metadata.route_input_market,
    metadata.safety_diagnostics?.routing?.route_input_market,
    queue.property_address_state,
    metadata.seller_state
  )) || "unknown";
}

function selectedTextgridMarket(attempt = {}) {
  const queue = attempt.queue_row || {};
  const latestEvent = sortNewestRows(attempt.event_rows)[0] || {};
  const metadata = mergeMetadata(queue.metadata, latestEvent.metadata);
  return clean(coalesce(
    queue.selected_textgrid_market,
    latestEvent.selected_textgrid_market,
    metadata.selected_textgrid_market,
    metadata.selected_sender_diagnostics?.selected_textgrid_market,
    metadata.safety_diagnostics?.routing?.selected_textgrid_market,
    metadata.routing?.selected_textgrid_market,
    metadata.route_input_market
  )) || "unknown";
}

function routingTier(attempt = {}) {
  const queue = attempt.queue_row || {};
  const latestEvent = sortNewestRows(attempt.event_rows)[0] || {};
  const metadata = mergeMetadata(queue.metadata, latestEvent.metadata);
  return clean(coalesce(
    queue.routing_tier,
    latestEvent.routing_tier,
    metadata.routing_tier,
    metadata.selected_sender_diagnostics?.routing_tier,
    metadata.safety_diagnostics?.routing?.tier,
    metadata.routing?.tier
  )) || "unknown";
}

function languageValue(attempt = {}) {
  const queue = attempt.queue_row || {};
  const latestEvent = sortNewestRows(attempt.event_rows)[0] || {};
  const metadata = mergeMetadata(queue.metadata, latestEvent.metadata);
  return lower(coalesce(
    queue.language,
    latestEvent.language,
    metadata.language,
    metadata.template_language,
    metadata.selected_template_language,
    metadata.safety_diagnostics?.template?.language,
    metadata.candidate_snapshot?.language,
    metadata.candidate_snapshot?.best_language
  )) || "unknown";
}

function propertyTypeValue(attempt = {}) {
  const queue = attempt.queue_row || {};
  const latestEvent = sortNewestRows(attempt.event_rows)[0] || {};
  const metadata = mergeMetadata(queue.metadata, latestEvent.metadata);
  return clean(coalesce(
    queue.asset_type,
    queue.property_type,
    queue.owner_type,
    latestEvent.asset_type,
    latestEvent.property_type,
    metadata.asset_type,
    metadata.asset_class,
    metadata.property_type,
    metadata.candidate_snapshot?.asset_type,
    metadata.candidate_snapshot?.property_type,
    metadata.raw?.asset_type,
    metadata.raw?.property_type
  )) || "unknown";
}

function fieldFromAttempt(attempt = {}, paths = []) {
  const queue = attempt.queue_row || {};
  const latestEvent = sortNewestRows(attempt.event_rows)[0] || {};
  const metadata = mergeMetadata(queue.metadata, latestEvent.metadata);
  return clean(
    valueFromPaths(queue, paths) ||
      valueFromPaths(latestEvent, paths) ||
      valueFromPaths(metadata, paths) ||
      valueFromPaths(metadata.candidate_snapshot || {}, paths) ||
      valueFromPaths(metadata.raw || {}, paths)
  );
}

function retryBucket(attempt = {}) {
  const queue = attempt.queue_row || {};
  const retryCount = asNumber(queue.retry_count || queue.attempt_count || queue.metadata?.retry_count, 0);
  if (retryCount <= 0) return "retry_count=0";
  if (retryCount === 1) return "retry_count=1";
  if (retryCount === 2) return "retry_count=2";
  return "retry_count=3+";
}

function queueProviderConflict(attempt = {}) {
  const queue = attempt.queue_row || {};
  const provider = lower(rawDeliveryStatus(attempt));
  const queueStatus = lower(queue.queue_status);
  const providerDelivered = DELIVERED_STATUSES.has(provider);
  const providerFailed = FAILED_STATUSES.has(provider) || failureClass(attempt) !== "none";
  const queueDelivered = DELIVERED_STATUSES.has(queueStatus);
  const queueFailed = FAILED_STATUSES.has(queueStatus);
  const queueSent = queueStatus === "sent";

  if ((queueSent || queueDelivered) && providerFailed) return "queue_sent_provider_failed";
  if (queueFailed && providerDelivered) return "queue_failed_provider_delivered";
  if (queueDelivered && providerFailed) return "queue_delivered_provider_failed";
  return "";
}

function rawFailureBlob(attempt = {}) {
  const input = combinedFailureInput(attempt);
  return lower(safeJson({
    status: rawDeliveryStatus(attempt),
    failure_class: failureClass(attempt),
    reason: collectFailureText(attempt),
    metadata: input.metadata,
  }));
}

function isBlacklist21610(attempt = {}) {
  const text = rawFailureBlob(attempt);
  return text.includes("21610") || text.includes("blacklist") || text.includes("opted out") || text.includes("opt-out");
}

function isUnknownDeliveryFailed(attempt = {}) {
  const state = deliveryState(attempt);
  const fClass = failureClass(attempt);
  const status = lower(rawDeliveryStatus(attempt));
  return state === "failed" && (fClass === "none" || fClass === "unknown_failure") && status.includes("fail");
}

async function fetchRange(supabase, table, timestampColumn, startIso, endIso, options = {}) {
  const maxRows = options.maxRows || DEFAULT_MAX_ROWS_PER_QUERY;
  const rows = [];
  for (let from = 0;; from += FETCH_PAGE_SIZE) {
    if (from >= maxRows) {
      throw new Error(`${table}.${timestampColumn} exceeded --max-rows=${maxRows}; narrow the window or raise the cap.`);
    }
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .gte(timestampColumn, startIso)
      .lt(timestampColumn, endIso)
      .order(timestampColumn, { ascending: true })
      .range(from, from + FETCH_PAGE_SIZE - 1);
    if (error) {
      return { rows: [], error: `${table}.${timestampColumn}: ${error.message}` };
    }
    rows.push(...(data || []));
    if (!data || data.length < FETCH_PAGE_SIZE) break;
  }
  return { rows, error: null };
}

function dedupeRows(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = row?.id ? `id:${row.id}` : safeJson(row);
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()];
}

async function fetchUnionRange(supabase, table, timestampColumns, window, options = {}) {
  const results = [];
  const errors = [];
  for (const column of timestampColumns) {
    const result = await fetchRange(supabase, table, column, window.start_iso, window.end_iso, options);
    if (result.error) {
      errors.push(result.error);
    } else {
      results.push(...result.rows);
    }
  }
  return {
    rows: dedupeRows(results),
    errors,
  };
}

function chunks(values, size = 80) {
  const unique = [...new Set(values.map(clean).filter(Boolean))];
  const result = [];
  for (let index = 0; index < unique.length; index += size) {
    result.push(unique.slice(index, index + size));
  }
  return result;
}

async function fetchByIn(supabase, table, column, values, options = {}) {
  const rows = [];
  const errors = [];
  for (const chunk of chunks(values, options.chunkSize || 80)) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .in(column, chunk)
      .limit(options.limit || 10000);
    if (error) {
      errors.push(`${table}.${column}: ${error.message}`);
      break;
    }
    rows.push(...(data || []));
  }
  return { rows: dedupeRows(rows), errors };
}

function addAttemptKeyIndexes(attempt, indexes) {
  for (const key of attempt.keys) indexes.set(key, attempt);
}

function upsertAttemptFromQueue(queueRow, attempts, indexes) {
  const keys = attemptKeysFromQueue(queueRow);
  const lookupKeys = keys.length ? keys : [fallbackAttemptKeyFromQueue(queueRow)];
  let attempt = lookupKeys.map((key) => indexes.get(key)).find(Boolean);
  if (!attempt) {
    attempt = {
      keys: new Set(lookupKeys),
      queue_row: null,
      event_rows: [],
      source_tables: new Set(),
    };
    attempts.push(attempt);
  }
  attempt.queue_row = queueRow;
  attempt.source_tables.add("send_queue");
  for (const key of lookupKeys) attempt.keys.add(key);
  addAttemptKeyIndexes(attempt, indexes);
  return attempt;
}

function upsertAttemptFromEvent(eventRow, attempts, indexes) {
  const keys = attemptKeysFromEvent(eventRow);
  const lookupKeys = keys.length ? keys : [fallbackAttemptKeyFromEvent(eventRow)];
  let attempt = lookupKeys.map((key) => indexes.get(key)).find(Boolean);
  if (!attempt) {
    attempt = {
      keys: new Set(lookupKeys),
      queue_row: null,
      event_rows: [],
      source_tables: new Set(),
    };
    attempts.push(attempt);
  }
  if (!attempt.event_rows.some((row) => row.id === eventRow.id)) attempt.event_rows.push(eventRow);
  attempt.source_tables.add("message_events");
  for (const key of lookupKeys) attempt.keys.add(key);
  addAttemptKeyIndexes(attempt, indexes);
  return attempt;
}

function finalizeAttemptShape(attempt, window, timezone) {
  const queue = attempt.queue_row || {};
  const events = attempt.event_rows || [];
  const timestamp = firstTimestampInWindow([
    ...rowTimestampCandidatesFromQueue(queue),
    ...events.flatMap(rowTimestampCandidatesFromEvent),
  ], window);
  const body = renderedBody(attempt);
  const state = deliveryState(attempt);
  const segments = asNumber(queue.segment_count || queue.message_segments || queue.metadata?.segment_count, smsSegments(body));
  const conflict = queueProviderConflict(attempt);

  return {
    ...attempt,
    keys: [...attempt.keys],
    source_tables: [...attempt.source_tables],
    send_at: timestamp,
    local_hour: hourBucket(timestamp, timezone),
    delivery_state: state,
    delivered: state === "delivered",
    failed: state === "failed",
    pending: state === "pending",
    sender_number: senderNumber(attempt),
    recipient_number: recipientNumber(attempt),
    template_id: templateId(attempt),
    rendered_body_hash: bodyHash(body),
    rendered_body_length: body.length,
    segment_count: segments,
    template_family: templateFamily(attempt),
    market: marketValue(attempt),
    selected_textgrid_market: selectedTextgridMarket(attempt),
    routing_tier: routingTier(attempt),
    language: languageValue(attempt),
    property_type: propertyTypeValue(attempt),
    failure_class: failureClass(attempt),
    provider_failure_reason: collectFailureText(attempt),
    retry_bucket: retryBucket(attempt),
    queue_provider_conflict: conflict || "none",
    blacklist_21610: isBlacklist21610(attempt),
    unknown_delivery_failed: isUnknownDeliveryFailed(attempt),
    duplicate_key: clean(queue.dedupe_key || queue.queue_key || queue.metadata?.idempotency_key) || "",
  };
}

function collectProviderIdsFromQueue(rows = []) {
  return rows.flatMap((row) => [
    row.provider_message_id,
    row.textgrid_message_id,
    row.metadata?.provider_message_id,
    row.metadata?.textgrid_message_id,
  ]).map(clean).filter(Boolean);
}

function collectProviderIdsFromEvents(rows = []) {
  return rows.flatMap((row) => [
    row.provider_message_sid,
    row.provider_message_id,
    row.textgrid_message_id,
    row.metadata?.provider_message_id,
    row.metadata?.textgrid_message_id,
  ]).map(clean).filter(Boolean);
}

async function loadWindowRows(supabase, window, options = {}) {
  const diagnostics = {
    range_errors: [],
    companion_errors: [],
  };

  const [queueRange, eventRange] = await Promise.all([
    fetchUnionRange(supabase, "send_queue", ["sent_at", "created_at"], window, options),
    fetchUnionRange(supabase, "message_events", ["created_at", "sent_at", "event_timestamp"], window, options),
  ]);
  diagnostics.range_errors.push(...queueRange.errors, ...eventRange.errors);

  const baseQueueRows = queueRange.rows;
  const baseEventRows = eventRange.rows;
  const queueIds = [
    ...baseQueueRows.map((row) => row.id),
    ...baseQueueRows.map((row) => row.queue_id),
    ...baseEventRows.map((row) => row.queue_id),
    ...baseEventRows.map((row) => row.metadata?.queue_id),
    ...baseEventRows.map((row) => row.metadata?.outbound_queue_id),
  ].map(clean).filter(Boolean);
  const uuidQueueIds = queueIds.filter(looksUuid);
  const providerIds = [
    ...collectProviderIdsFromQueue(baseQueueRows),
    ...collectProviderIdsFromEvents(baseEventRows),
  ];

  const [queuesById, eventsByQueueId, eventsByProviderSid] = await Promise.all([
    fetchByIn(supabase, "send_queue", "id", uuidQueueIds),
    fetchByIn(supabase, "message_events", "queue_id", uuidQueueIds),
    fetchByIn(supabase, "message_events", "provider_message_sid", providerIds),
  ]);
  diagnostics.companion_errors.push(
    ...queuesById.errors,
    ...eventsByQueueId.errors,
    ...eventsByProviderSid.errors
  );

  return {
    queue_rows: dedupeRows([...baseQueueRows, ...queuesById.rows]),
    event_rows: dedupeRows([...baseEventRows, ...eventsByQueueId.rows, ...eventsByProviderSid.rows]),
    source_counts: {
      send_queue_range: baseQueueRows.length,
      message_events_range: baseEventRows.length,
      send_queue_companion: queuesById.rows.length,
      message_events_companion: eventsByQueueId.rows.length + eventsByProviderSid.rows.length,
    },
    diagnostics,
  };
}

async function loadPhoneFacts(supabase, phoneNumbers, diagnostics) {
  const facts = new Map();
  const normalizedPhones = [...new Set(phoneNumbers.map(normalizePhone).filter(Boolean))];
  if (!normalizedPhones.length) return facts;

  for (const table of PHONE_ENRICHMENT_TABLES) {
    for (const column of PHONE_LOOKUP_COLUMNS) {
      const { rows, errors } = await fetchByIn(supabase, table, column, normalizedPhones, {
        chunkSize: 50,
        limit: 5000,
      });
      if (errors.length) {
        diagnostics.optional_enrichment_errors.push(...errors.slice(0, 1));
        continue;
      }
      for (const row of rows) {
        const phone = normalizePhone(row[column] || row.canonical_e164 || row.phone_number || row.phone);
        if (!phone || facts.has(phone)) continue;
        facts.set(phone, { source_table: table, source_column: column, row });
      }
      if (facts.size >= normalizedPhones.length) return facts;
    }
  }

  return facts;
}

async function loadPropertyFacts(supabase, propertyIds, diagnostics) {
  const ids = [...new Set(propertyIds.map(clean).filter(Boolean))];
  if (!ids.length) return new Map();
  const { rows, errors } = await fetchByIn(supabase, "properties", "id", ids, {
    chunkSize: 80,
    limit: 10000,
  });
  if (errors.length) diagnostics.optional_enrichment_errors.push(...errors);
  return new Map(rows.map((row) => [clean(row.id), row]));
}

async function loadCampaignTargetFacts(supabase, targetIds, diagnostics) {
  const ids = [...new Set(targetIds.map(clean).filter(Boolean))];
  if (!ids.length) return new Map();
  const { rows, errors } = await fetchByIn(supabase, "campaign_targets", "id", ids, {
    chunkSize: 80,
    limit: 10000,
  });
  if (errors.length) diagnostics.optional_enrichment_errors.push(...errors);
  return new Map(rows.map((row) => [clean(row.id), row]));
}

function applyEnrichment(attempts, phoneFacts, propertyFacts, campaignTargetFacts) {
  for (const attempt of attempts) {
    const phoneFact = phoneFacts.get(attempt.recipient_number)?.row || {};
    const propertyId = clean(attempt.queue_row?.property_id || sortNewestRows(attempt.event_rows)[0]?.property_id);
    const propertyFact = propertyFacts.get(propertyId) || {};
    const campaignTargetId = clean(attempt.queue_row?.campaign_target_id || attempt.queue_row?.metadata?.campaign_target_id);
    const campaignTarget = campaignTargetFacts.get(campaignTargetId) || {};

    attempt.recipient_carrier_phone_owner = clean(coalesce(
      fieldFromAttempt(attempt, [
        "phone_owner",
        "phone_carrier",
        "carrier_name",
        "carrier",
        "provider_name",
        "candidate_snapshot.phone_owner",
        "candidate_snapshot.phone_carrier",
      ]),
      phoneFact.phone_owner,
      phoneFact.phone_carrier,
      phoneFact.carrier_name,
      phoneFact.carrier,
      phoneFact.provider_name
    )) || "unknown";

    attempt.phone_activity_status = clean(coalesce(
      fieldFromAttempt(attempt, ["activity_status", "phone_activity_status", "seller_status"]),
      phoneFact.activity_status
    )) || "unknown";

    attempt.phone_usage_12_months = clean(coalesce(
      fieldFromAttempt(attempt, ["usage_12_months", "phone_usage_12_months"]),
      phoneFact.usage_12_months
    )) || "unknown";

    attempt.phone_usage_2_months = clean(coalesce(
      fieldFromAttempt(attempt, ["usage_2_months", "phone_usage_2_months"]),
      phoneFact.usage_2_months
    )) || "unknown";

    attempt.property_type = clean(coalesce(
      attempt.property_type,
      campaignTarget.asset_type,
      campaignTarget.property_type,
      propertyFact.asset_type,
      propertyFact.property_type
    )) || "unknown";
  }
}

function percentile(values, p) {
  const numbers = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const index = Math.min(numbers.length - 1, Math.max(0, Math.ceil((p / 100) * numbers.length) - 1));
  return numbers[index];
}

function emptyStats() {
  return {
    count: 0,
    delivered: 0,
    failed: 0,
    pending: 0,
    unknown: 0,
    blacklist_21610: 0,
    unknown_delivery_failed: 0,
    conflicts: 0,
  };
}

function addStats(stats, attempt) {
  stats.count += 1;
  if (attempt.delivered) stats.delivered += 1;
  else if (attempt.failed) stats.failed += 1;
  else if (attempt.pending) stats.pending += 1;
  else stats.unknown += 1;
  if (attempt.blacklist_21610) stats.blacklist_21610 += 1;
  if (attempt.unknown_delivery_failed) stats.unknown_delivery_failed += 1;
  if (attempt.queue_provider_conflict !== "none") stats.conflicts += 1;
}

function finalizeStats(stats, total) {
  const finalized = stats.delivered + stats.failed;
  return {
    ...stats,
    share_pct: pct(stats.count, total),
    delivery_rate_pct: pct(stats.delivered, stats.count),
    finalized_delivery_rate_pct: pct(stats.delivered, finalized),
    failure_rate_pct: pct(stats.failed, stats.count),
  };
}

function groupAttempts(attempts, keyFn) {
  const map = new Map();
  for (const attempt of attempts) {
    const key = clean(keyFn(attempt)) || "unknown";
    if (!map.has(key)) map.set(key, emptyStats());
    addStats(map.get(key), attempt);
  }
  return map;
}

function topGroups(groupMap, total, topN) {
  return [...groupMap.entries()]
    .map(([value, stats]) => ({ value, ...finalizeStats(stats, total) }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, topN);
}

function buildDuplicateSummary(attempts) {
  const duplicateKeys = new Map();
  const recipientBody = new Map();
  let retryRows = 0;
  let duplicateStatusRows = 0;

  for (const attempt of attempts) {
    if (attempt.retry_bucket !== "retry_count=0") retryRows += 1;
    if (lower(attempt.queue_row?.queue_status).includes("duplicate")) duplicateStatusRows += 1;

    if (attempt.duplicate_key) {
      duplicateKeys.set(attempt.duplicate_key, (duplicateKeys.get(attempt.duplicate_key) || 0) + 1);
    }
    const pairKey = `${attempt.recipient_number}:${attempt.rendered_body_hash}`;
    recipientBody.set(pairKey, (recipientBody.get(pairKey) || 0) + 1);
  }

  const duplicateDedupeKeys = [...duplicateKeys.entries()].filter(([, count]) => count > 1);
  const duplicateRecipientBody = [...recipientBody.entries()].filter(([, count]) => count > 1);
  return {
    retry_rows: retryRows,
    duplicate_status_rows: duplicateStatusRows,
    duplicate_dedupe_keys: duplicateDedupeKeys.length,
    duplicate_recipient_body_pairs: duplicateRecipientBody.length,
    top_duplicate_recipient_body_pairs: duplicateRecipientBody
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, count]) => ({ key, count })),
  };
}

function summarizeWindow(label, window, attempts, sourceCounts, diagnostics, topN) {
  const total = attempts.length;
  const totals = emptyStats();
  for (const attempt of attempts) addStats(totals, attempt);
  const lengths = attempts.map((attempt) => attempt.rendered_body_length).filter((value) => value > 0);
  const segments = attempts.map((attempt) => attempt.segment_count).filter((value) => value > 0);

  const dimensions = {
    sender_number: groupAttempts(attempts, (attempt) => attempt.sender_number),
    sender_number_delivery_rate: groupAttempts(attempts, (attempt) => attempt.sender_number),
    template_id: groupAttempts(attempts, (attempt) => attempt.template_id),
    rendered_body_hash: groupAttempts(attempts, (attempt) => attempt.rendered_body_hash),
    template_family: groupAttempts(attempts, (attempt) => attempt.template_family),
    market: groupAttempts(attempts, (attempt) => attempt.market),
    selected_textgrid_market: groupAttempts(attempts, (attempt) => attempt.selected_textgrid_market),
    routing_tier: groupAttempts(attempts, (attempt) => attempt.routing_tier),
    recipient_carrier_phone_owner: groupAttempts(attempts, (attempt) => attempt.recipient_carrier_phone_owner || "unknown"),
    phone_activity_status: groupAttempts(attempts, (attempt) => attempt.phone_activity_status || "unknown"),
    phone_usage_12_months: groupAttempts(attempts, (attempt) => attempt.phone_usage_12_months || "unknown"),
    phone_usage_2_months: groupAttempts(attempts, (attempt) => attempt.phone_usage_2_months || "unknown"),
    language: groupAttempts(attempts, (attempt) => attempt.language),
    property_type: groupAttempts(attempts, (attempt) => attempt.property_type),
    failure_class: groupAttempts(attempts, (attempt) => attempt.failure_class),
    provider_failure_reason: groupAttempts(attempts, (attempt) => attempt.provider_failure_reason),
    message_length_bucket: groupAttempts(attempts, (attempt) => lengthBucket(attempt.rendered_body_length)),
    segment_count: groupAttempts(attempts, (attempt) => `${attempt.segment_count || 0} segment(s)`),
    send_hour: groupAttempts(attempts, (attempt) => attempt.local_hour),
    retry_bucket: groupAttempts(attempts, (attempt) => attempt.retry_bucket),
    queue_provider_conflict: groupAttempts(attempts, (attempt) => attempt.queue_provider_conflict),
  };

  return {
    label,
    window: {
      start: window.start_iso,
      end: window.end_iso,
      start_raw: window.start_raw,
      end_raw: window.end_raw,
    },
    source_counts: sourceCounts,
    diagnostics,
    totals: {
      ...finalizeStats(totals, total),
      finalized_count: totals.delivered + totals.failed,
      pending_or_unknown: totals.pending + totals.unknown,
      blacklist_21610_count: totals.blacklist_21610,
      unknown_delivery_failed_count: totals.unknown_delivery_failed,
      queue_provider_conflict_count: totals.conflicts,
    },
    message_length: {
      avg_chars: round(lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, lengths.length)),
      p50_chars: percentile(lengths, 50),
      p90_chars: percentile(lengths, 90),
      avg_segments: round(segments.reduce((sum, value) => sum + value, 0) / Math.max(1, segments.length)),
      p90_segments: percentile(segments, 90),
    },
    retry_duplicate_summary: buildDuplicateSummary(attempts),
    distributions: Object.fromEntries(
      Object.entries(dimensions).map(([key, map]) => [key, topGroups(map, total, topN)])
    ),
    _dimensionMaps: dimensions,
  };
}

function buildDeltas(metric, goodMap, badMap, goodTotal, badTotal) {
  const values = [...new Set([...goodMap.keys(), ...badMap.keys()])];
  return values.map((value) => {
    const good = goodMap.get(value) || emptyStats();
    const bad = badMap.get(value) || emptyStats();
    const goodFinal = good.delivered + good.failed;
    const badFinal = bad.delivered + bad.failed;
    const goodDeliveryRate = good.count ? good.delivered / good.count : null;
    const badDeliveryRate = bad.count ? bad.delivered / bad.count : null;
    const goodFinalRate = goodFinal ? good.delivered / goodFinal : null;
    const badFinalRate = badFinal ? bad.delivered / badFinal : null;
    const goodShare = goodTotal ? good.count / goodTotal : 0;
    const badShare = badTotal ? bad.count / badTotal : 0;
    const shareDeltaPp = (badShare - goodShare) * 100;
    const deliveryRateDeltaPp =
      goodDeliveryRate === null || badDeliveryRate === null ? null : (badDeliveryRate - goodDeliveryRate) * 100;
    const finalRateDeltaPp =
      goodFinalRate === null || badFinalRate === null ? null : (badFinalRate - goodFinalRate) * 100;
    const failureContributionPct = badTotal ? (bad.failed / badTotal) * 100 : 0;
    const score =
      Math.abs(shareDeltaPp) +
      Math.max(0, -(deliveryRateDeltaPp ?? 0)) / 2 +
      failureContributionPct * 2 +
      Math.max(0, bad.failed - good.failed);
    return {
      metric,
      value,
      good_count: good.count,
      bad_count: bad.count,
      good_share_pct: round(goodShare * 100, 2),
      bad_share_pct: round(badShare * 100, 2),
      share_delta_pp: round(shareDeltaPp, 2),
      good_delivery_rate_pct: goodDeliveryRate === null ? null : round(goodDeliveryRate * 100, 2),
      bad_delivery_rate_pct: badDeliveryRate === null ? null : round(badDeliveryRate * 100, 2),
      delivery_rate_delta_pp: deliveryRateDeltaPp === null ? null : round(deliveryRateDeltaPp, 2),
      good_finalized_delivery_rate_pct: goodFinalRate === null ? null : round(goodFinalRate * 100, 2),
      bad_finalized_delivery_rate_pct: badFinalRate === null ? null : round(badFinalRate * 100, 2),
      finalized_delivery_rate_delta_pp: finalRateDeltaPp === null ? null : round(finalRateDeltaPp, 2),
      good_failed: good.failed,
      bad_failed: bad.failed,
      bad_failure_contribution_pct: round(failureContributionPct, 2),
      score: round(score, 3),
    };
  }).sort((a, b) => b.score - a.score);
}

function buildAllDeltas(goodSummary, badSummary, topN) {
  const metrics = [
    "sender_number",
    "template_id",
    "rendered_body_hash",
    "template_family",
    "market",
    "selected_textgrid_market",
    "routing_tier",
    "recipient_carrier_phone_owner",
    "phone_activity_status",
    "phone_usage_12_months",
    "phone_usage_2_months",
    "language",
    "property_type",
    "failure_class",
    "provider_failure_reason",
    "message_length_bucket",
    "segment_count",
    "send_hour",
    "retry_bucket",
    "queue_provider_conflict",
  ];
  const rows = [];
  for (const metric of metrics) {
    rows.push(...buildDeltas(
      metric,
      goodSummary._dimensionMaps[metric] || new Map(),
      badSummary._dimensionMaps[metric] || new Map(),
      goodSummary.totals.count,
      badSummary.totals.count
    ));
  }
  return rows
    .filter((row) => row.good_count || row.bad_count)
    .filter((row) => Math.abs(row.share_delta_pp) >= 1 || row.bad_failed > row.good_failed || (row.delivery_rate_delta_pp ?? 0) <= -10)
    .slice(0, topN * 2);
}

function deltaForMetric(deltas, metric) {
  return deltas.filter((row) => row.metric === metric);
}

function addCause(causes, cause) {
  if (!cause || !cause.title) return;
  const key = `${cause.title}:${cause.primary_value || ""}`;
  if (causes.some((item) => `${item.title}:${item.primary_value || ""}` === key)) return;
  causes.push(cause);
}

function buildRootCauses(goodSummary, badSummary, deltas) {
  const causes = [];
  const badDeliveryRate = badSummary.totals.delivery_rate_pct;
  const goodDeliveryRate = goodSummary.totals.delivery_rate_pct;
  const rateDrop = goodDeliveryRate - badDeliveryRate;

  for (const row of deltaForMetric(deltas, "failure_class").slice(0, 6)) {
    if (row.value === "none" || row.bad_count < 2 || row.share_delta_pp < 3) continue;
    addCause(causes, {
      rank_score: 90 + row.bad_failure_contribution_pct + row.share_delta_pp,
      title: `Failure class spike: ${row.value}`,
      primary_value: row.value,
      evidence: [
        `Bad window ${row.bad_count} rows (${row.bad_share_pct}%) vs good ${row.good_count} (${row.good_share_pct}%).`,
        `Bad failed contribution ${row.bad_failure_contribution_pct}%.`,
      ],
      recommended_action: actionForFailureClass(row.value),
    });
  }

  for (const row of deltaForMetric(deltas, "provider_failure_reason").slice(0, 5)) {
    if (row.value === "none" || row.bad_count < 2 || row.share_delta_pp < 2) continue;
    addCause(causes, {
      rank_score: 82 + row.bad_failure_contribution_pct + row.share_delta_pp,
      title: "Provider failure reason concentrated",
      primary_value: row.value,
      evidence: [
        `Bad window ${row.bad_count} rows (${row.bad_share_pct}%) vs good ${row.good_count} (${row.good_share_pct}%).`,
      ],
      recommended_action: "Group the raw TextGrid reasons into normalized failure classes before retrying or changing routing; do not retry terminal opt-out/content-filter failures.",
    });
  }

  for (const row of deltaForMetric(deltas, "sender_number").slice(0, 8)) {
    if (row.bad_count < 3) continue;
    const rateBad = row.bad_delivery_rate_pct ?? 100;
    const rateGood = row.good_delivery_rate_pct ?? 100;
    if (rateBad <= 60 || rateGood - rateBad >= 20 || row.bad_failed >= Math.max(3, row.good_failed * 2)) {
      addCause(causes, {
        rank_score: 78 + Math.max(0, rateGood - rateBad) + row.bad_failure_contribution_pct,
        title: "Sender number underperformed",
        primary_value: row.value,
        evidence: [
          `${row.value}: bad delivery ${rateBad}% on ${row.bad_count} attempts vs good ${rateGood ?? "n/a"}% on ${row.good_count}.`,
          `Bad failed count ${row.bad_failed}.`,
        ],
        recommended_action: `Remove ${row.value} from active sender rotation pending TextGrid/provider health review, then compare its failure reasons before re-enabling.`,
      });
    }
  }

  for (const metric of ["template_id", "rendered_body_hash", "template_family"]) {
    for (const row of deltaForMetric(deltas, metric).slice(0, 6)) {
      if (row.bad_count < 3) continue;
      const rateBad = row.bad_delivery_rate_pct ?? 100;
      const rateGood = row.good_delivery_rate_pct ?? 100;
      if (row.share_delta_pp >= 5 || rateGood - rateBad >= 20 || rateBad <= 50) {
        addCause(causes, {
          rank_score: 70 + row.share_delta_pp + Math.max(0, rateGood - rateBad),
          title: `${metric} shifted into the bad window`,
          primary_value: row.value,
          evidence: [
            `Bad share ${row.bad_share_pct}% vs good ${row.good_share_pct}% (${row.share_delta_pp} pp).`,
            `Bad delivery ${rateBad}% vs good ${rateGood ?? "n/a"}%.`,
          ],
          recommended_action: `Review and hold this ${metric} from future campaigns until content/routing risk is understood; compare body hash and provider failure reasons first.`,
        });
      }
    }
  }

  for (const metric of ["market", "selected_textgrid_market", "routing_tier"]) {
    for (const row of deltaForMetric(deltas, metric).slice(0, 5)) {
      if (row.bad_count < 3) continue;
      const rateBad = row.bad_delivery_rate_pct ?? 100;
      const rateGood = row.good_delivery_rate_pct ?? 100;
      if (row.share_delta_pp >= 8 || rateGood - rateBad >= 20 || rateBad <= 55) {
        addCause(causes, {
          rank_score: 64 + row.share_delta_pp + Math.max(0, rateGood - rateBad),
          title: `${metric} mix changed`,
          primary_value: row.value,
          evidence: [
            `Bad share ${row.bad_share_pct}% vs good ${row.good_share_pct}%.`,
            `Bad delivery ${rateBad}% vs good ${rateGood ?? "n/a"}%.`,
          ],
          recommended_action: "Audit sender-market matching and routing tier fallback for this segment before allowing more volume through it.",
        });
      }
    }
  }

  for (const metric of ["recipient_carrier_phone_owner", "phone_activity_status", "phone_usage_12_months", "phone_usage_2_months"]) {
    for (const row of deltaForMetric(deltas, metric).slice(0, 4)) {
      if (row.value === "unknown" || row.bad_count < 3) continue;
      const rateBad = row.bad_delivery_rate_pct ?? 100;
      const rateGood = row.good_delivery_rate_pct ?? 100;
      if (row.share_delta_pp >= 6 || rateGood - rateBad >= 20 || rateBad <= 55) {
        addCause(causes, {
          rank_score: 58 + row.share_delta_pp + Math.max(0, rateGood - rateBad),
          title: `${metric} recipient mix worsened`,
          primary_value: row.value,
          evidence: [
            `Bad share ${row.bad_share_pct}% vs good ${row.good_share_pct}%.`,
            `Bad delivery ${rateBad}% vs good ${rateGood ?? "n/a"}%.`,
          ],
          recommended_action: "Segment this phone cohort out of the next campaign and verify phone freshness/carrier quality before retry decisions.",
        });
      }
    }
  }

  const badAvgSegments = badSummary.message_length.avg_segments || 0;
  const goodAvgSegments = goodSummary.message_length.avg_segments || 0;
  const badP90Chars = badSummary.message_length.p90_chars || 0;
  const goodP90Chars = goodSummary.message_length.p90_chars || 0;
  if (badAvgSegments - goodAvgSegments >= 0.25 || badP90Chars - goodP90Chars >= 50) {
    addCause(causes, {
      rank_score: 54 + (badAvgSegments - goodAvgSegments) * 20,
      title: "Bad window messages were materially longer",
      primary_value: "message_length",
      evidence: [
        `Average segments bad ${badAvgSegments} vs good ${goodAvgSegments}.`,
        `P90 chars bad ${badP90Chars} vs good ${goodP90Chars}.`,
      ],
      recommended_action: "Shorten the affected templates and keep first-touch SMS under one segment unless testing proves otherwise.",
    });
  }

  if (badSummary.totals.blacklist_21610_count > goodSummary.totals.blacklist_21610_count) {
    addCause(causes, {
      rank_score: 50 + badSummary.totals.blacklist_21610_count,
      title: "Blacklist / 21610 failures increased",
      primary_value: "blacklist_21610",
      evidence: [
        `Bad blacklist/21610 count ${badSummary.totals.blacklist_21610_count} vs good ${goodSummary.totals.blacklist_21610_count}.`,
      ],
      recommended_action: "Treat these as terminal suppressions; confirm opt-out propagation and blacklist handling before any retry.",
    });
  }

  if (badSummary.totals.unknown_delivery_failed_count > goodSummary.totals.unknown_delivery_failed_count) {
    addCause(causes, {
      rank_score: 48 + badSummary.totals.unknown_delivery_failed_count,
      title: "Unknown delivery_failed rows increased",
      primary_value: "unknown_delivery_failed",
      evidence: [
        `Bad unknown delivery_failed count ${badSummary.totals.unknown_delivery_failed_count} vs good ${goodSummary.totals.unknown_delivery_failed_count}.`,
      ],
      recommended_action: "Backfill/normalize TextGrid failure_class from raw webhook text so routing and retry rules can distinguish carrier blocks, invalid numbers, and opt-outs.",
    });
  }

  if (badSummary.totals.queue_provider_conflict_count > goodSummary.totals.queue_provider_conflict_count) {
    addCause(causes, {
      rank_score: 45 + badSummary.totals.queue_provider_conflict_count,
      title: "Queue status conflicts with provider delivery status",
      primary_value: "queue_provider_conflict",
      evidence: [
        `Bad conflicts ${badSummary.totals.queue_provider_conflict_count} vs good ${goodSummary.totals.queue_provider_conflict_count}.`,
      ],
      recommended_action: "Reconcile queue rows from provider webhook state before using queue_status as a delivery-rate denominator.",
    });
  }

  if (!causes.length && rateDrop > 10) {
    addCause(causes, {
      rank_score: 40 + rateDrop,
      title: "Delivery rate dropped, but no single dimension dominates",
      primary_value: "multi_factor",
      evidence: [
        `Overall delivery rate dropped ${round(rateDrop, 2)} pp.`,
        "The top deltas are spread across multiple dimensions.",
      ],
      recommended_action: "Review the biggest deltas table as a multi-factor issue: sender health, template/body hash, routing tier, and provider failure reasons together.",
    });
  }

  return causes
    .sort((a, b) => b.rank_score - a.rank_score)
    .slice(0, 8)
    .map((cause, index) => ({ rank: index + 1, ...cause, rank_score: round(cause.rank_score, 2) }));
}

function actionForFailureClass(value) {
  if (value === "content_filter_blocked") {
    return "Hold the implicated template/body hashes and sender numbers; rewrite content before any future sends and keep this script read-only.";
  }
  if (value === "recipient_opted_out") {
    return "Suppress these recipients permanently and verify opt-out/blacklist propagation; do not retry.";
  }
  if (value === "invalid_to_number") {
    return "Remove invalid phone numbers from active outreach and refresh phone sourcing before retry decisions.";
  }
  if (value === "recipient_out_of_credit") {
    return "Treat as transient only if provider docs confirm it; retry through normal guardrails after queue reconciliation, not from this script.";
  }
  if (value === "unknown_failure") {
    return "Normalize raw provider failure text into failure_class before retry/routing changes.";
  }
  return "Review this failure class with sender, template, and provider reason deltas before changing routing.";
}

function recommendedActions(rootCauses, badSummary) {
  const actions = [];
  for (const cause of rootCauses) {
    if (cause.recommended_action && !actions.includes(cause.recommended_action)) {
      actions.push(cause.recommended_action);
    }
  }
  if (badSummary.totals.pending_or_unknown > 0) {
    actions.push("Separate pending/unknown rows from finalized failures when reporting delivery rate; otherwise the denominator can hide late webhooks.");
  }
  actions.push("Re-run this diagnosis after failure-class backfill/reconciliation using the same windows to confirm the root-cause ranking changed.");
  return [...new Set(actions)].slice(0, 10);
}

function stripPrivateMaps(summary) {
  const clone = { ...summary };
  delete clone._dimensionMaps;
  return clone;
}

function markdownTable(rows, columns) {
  if (!rows.length) return "_No rows._";
  const header = `| ${columns.map((column) => column.label).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => clean(column.value(row)).replace(/\|/g, "\\|") || "0").join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

function formatDistribution(summary, key, topN) {
  return markdownTable((summary.distributions[key] || []).slice(0, topN), [
    { label: key, value: (row) => row.value },
    { label: "count", value: (row) => row.count },
    { label: "share", value: (row) => `${row.share_pct}%` },
    { label: "deliv", value: (row) => `${row.delivery_rate_pct}%` },
    { label: "failed", value: (row) => row.failed },
  ]);
}

function formatSummary(summary, topN) {
  return `
### ${summary.label.toUpperCase()} Window Summary

- Window: ${summary.window.start} to ${summary.window.end} (end exclusive)
- Attempts: ${summary.totals.count}
- Delivered / failed / pending / unknown: ${summary.totals.delivered} / ${summary.totals.failed} / ${summary.totals.pending} / ${summary.totals.unknown}
- Delivery rate: ${summary.totals.delivery_rate_pct}% of attempts (${summary.totals.finalized_delivery_rate_pct}% of finalized rows)
- Blacklist/21610: ${summary.totals.blacklist_21610_count}
- Unknown delivery_failed: ${summary.totals.unknown_delivery_failed_count}
- Queue/provider conflicts: ${summary.totals.queue_provider_conflict_count}
- Message length: avg ${summary.message_length.avg_chars ?? 0} chars, p90 ${summary.message_length.p90_chars ?? 0}; avg ${summary.message_length.avg_segments ?? 0} segments

Top sender numbers:

${formatDistribution(summary, "sender_number", topN)}

Top templates:

${formatDistribution(summary, "template_id", topN)}

Top failure classes:

${formatDistribution(summary, "failure_class", topN)}
`.trim();
}

function formatMarkdown(result, topN) {
  const deltas = result.biggest_deltas.slice(0, topN * 2);
  return `
# SMS Delivery Variance Diagnosis

Mode: read-only Supabase select queries only. TextGrid calls: false. Queue run: false. SMS sends: false.

${formatSummary(result.good_window_summary, topN)}

${formatSummary(result.bad_window_summary, topN)}

## Biggest Deltas

${markdownTable(deltas, [
  { label: "metric", value: (row) => row.metric },
  { label: "value", value: (row) => row.value },
  { label: "good", value: (row) => `${row.good_count} (${row.good_share_pct}%)` },
  { label: "bad", value: (row) => `${row.bad_count} (${row.bad_share_pct}%)` },
  { label: "share delta", value: (row) => `${row.share_delta_pp} pp` },
  { label: "bad deliv", value: (row) => row.bad_delivery_rate_pct === null ? "n/a" : `${row.bad_delivery_rate_pct}%` },
  { label: "bad failed", value: (row) => row.bad_failed },
])}

## Required Comparisons

### Sender Number Delivery Rate

Good:

${formatDistribution(result.good_window_summary, "sender_number_delivery_rate", topN)}

Bad:

${formatDistribution(result.bad_window_summary, "sender_number_delivery_rate", topN)}

### Rendered Body Hash

Good:

${formatDistribution(result.good_window_summary, "rendered_body_hash", topN)}

Bad:

${formatDistribution(result.bad_window_summary, "rendered_body_hash", topN)}

### Template Family

Good:

${formatDistribution(result.good_window_summary, "template_family", topN)}

Bad:

${formatDistribution(result.bad_window_summary, "template_family", topN)}

### Market / Selected TextGrid Market / Routing Tier

Good market:

${formatDistribution(result.good_window_summary, "market", topN)}

Bad market:

${formatDistribution(result.bad_window_summary, "market", topN)}

Good selected TextGrid market:

${formatDistribution(result.good_window_summary, "selected_textgrid_market", topN)}

Bad selected TextGrid market:

${formatDistribution(result.bad_window_summary, "selected_textgrid_market", topN)}

Good routing tier:

${formatDistribution(result.good_window_summary, "routing_tier", topN)}

Bad routing tier:

${formatDistribution(result.bad_window_summary, "routing_tier", topN)}

### Recipient Phone Quality

Good carrier/owner:

${formatDistribution(result.good_window_summary, "recipient_carrier_phone_owner", topN)}

Bad carrier/owner:

${formatDistribution(result.bad_window_summary, "recipient_carrier_phone_owner", topN)}

Good activity:

${formatDistribution(result.good_window_summary, "phone_activity_status", topN)}

Bad activity:

${formatDistribution(result.bad_window_summary, "phone_activity_status", topN)}

Good 12 month usage:

${formatDistribution(result.good_window_summary, "phone_usage_12_months", topN)}

Bad 12 month usage:

${formatDistribution(result.bad_window_summary, "phone_usage_12_months", topN)}

Good 2 month usage:

${formatDistribution(result.good_window_summary, "phone_usage_2_months", topN)}

Bad 2 month usage:

${formatDistribution(result.bad_window_summary, "phone_usage_2_months", topN)}

### Language / Asset Type

Good language:

${formatDistribution(result.good_window_summary, "language", topN)}

Bad language:

${formatDistribution(result.bad_window_summary, "language", topN)}

Good asset/property type:

${formatDistribution(result.good_window_summary, "property_type", topN)}

Bad asset/property type:

${formatDistribution(result.bad_window_summary, "property_type", topN)}

### Provider Failures / Length / Hour / Retries / Conflicts

Good provider reason:

${formatDistribution(result.good_window_summary, "provider_failure_reason", topN)}

Bad provider reason:

${formatDistribution(result.bad_window_summary, "provider_failure_reason", topN)}

Good segment count:

${formatDistribution(result.good_window_summary, "segment_count", topN)}

Bad segment count:

${formatDistribution(result.bad_window_summary, "segment_count", topN)}

Good send hour:

${formatDistribution(result.good_window_summary, "send_hour", topN)}

Bad send hour:

${formatDistribution(result.bad_window_summary, "send_hour", topN)}

Good retry buckets:

${formatDistribution(result.good_window_summary, "retry_bucket", topN)}

Bad retry buckets:

${formatDistribution(result.bad_window_summary, "retry_bucket", topN)}

Good queue/provider conflicts:

${formatDistribution(result.good_window_summary, "queue_provider_conflict", topN)}

Bad queue/provider conflicts:

${formatDistribution(result.bad_window_summary, "queue_provider_conflict", topN)}

## Likely Root Causes Ranked

${result.likely_root_causes_ranked.length ? result.likely_root_causes_ranked.map((cause) => (
  `${cause.rank}. ${cause.title}${cause.primary_value ? `: ${cause.primary_value}` : ""}\n` +
  `   Evidence: ${cause.evidence.join(" ")}\n` +
  `   Action: ${cause.recommended_action}`
)).join("\n\n") : "_No dominant root cause found._"}

## Recommended Actions

${result.recommended_actions.map((action, index) => `${index + 1}. ${action}`).join("\n")}

## Diagnostics

- Good source rows: ${safeJson(result.good_window_summary.source_counts)}
- Bad source rows: ${safeJson(result.bad_window_summary.source_counts)}
- Optional enrichment warnings: ${result.optional_enrichment_warnings.length ? result.optional_enrichment_warnings.join("; ") : "none"}
`.trim();
}

async function buildAttemptsForWindow(supabase, window, options) {
  const loaded = await loadWindowRows(supabase, window, options);
  const attempts = [];
  const indexes = new Map();

  for (const row of loaded.queue_rows) {
    if (isQueueAttempt(row)) upsertAttemptFromQueue(row, attempts, indexes);
  }
  for (const row of loaded.event_rows) {
    if (isProofOrNoSend(row) || !isOutboundEvent(row)) continue;
    upsertAttemptFromEvent(row, attempts, indexes);
  }

  const finalized = attempts
    .map((attempt) => finalizeAttemptShape(attempt, window, options.timezone))
    .filter((attempt) => attempt.send_at && isWithinWindow(attempt.send_at, window));

  return {
    attempts: finalized,
    source_counts: loaded.source_counts,
    diagnostics: loaded.diagnostics,
  };
}

async function main() {
  const goodWindow = parseWindow("good");
  const badWindow = parseWindow("bad");
  const topN = Math.max(1, asNumber(argValue(["top"], ["SMS_DIAG_TOP"]), DEFAULT_TOP));
  const maxRows = Math.max(FETCH_PAGE_SIZE, asNumber(argValue(["max-rows", "max_rows"], ["SMS_DIAG_MAX_ROWS"]), DEFAULT_MAX_ROWS_PER_QUERY));
  const timezone = argValue(["timezone", "tz"], ["SMS_DIAG_TIMEZONE"]) || "America/Chicago";
  const skipPhoneEnrichment = Boolean(args["skip-phone-enrichment"] || args.skip_phone_enrichment);

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_KEY.");
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const options = { maxRows, timezone };
  const [good, bad] = await Promise.all([
    buildAttemptsForWindow(supabase, goodWindow, options),
    buildAttemptsForWindow(supabase, badWindow, options),
  ]);

  const optionalDiagnostics = {
    optional_enrichment_errors: [],
  };

  if (!skipPhoneEnrichment) {
    const allAttempts = [...good.attempts, ...bad.attempts];
    const phoneNumbers = allAttempts.map((attempt) => attempt.recipient_number);
    const propertyIds = allAttempts.flatMap((attempt) => [
      attempt.queue_row?.property_id,
      sortNewestRows(attempt.event_rows)[0]?.property_id,
    ]);
    const campaignTargetIds = allAttempts.map((attempt) => (
      attempt.queue_row?.campaign_target_id || attempt.queue_row?.metadata?.campaign_target_id
    ));

    const [phoneFacts, propertyFacts, campaignTargetFacts] = await Promise.all([
      loadPhoneFacts(supabase, phoneNumbers, optionalDiagnostics),
      loadPropertyFacts(supabase, propertyIds, optionalDiagnostics),
      loadCampaignTargetFacts(supabase, campaignTargetIds, optionalDiagnostics),
    ]);
    applyEnrichment(good.attempts, phoneFacts, propertyFacts, campaignTargetFacts);
    applyEnrichment(bad.attempts, phoneFacts, propertyFacts, campaignTargetFacts);
  } else {
    applyEnrichment(good.attempts, new Map(), new Map(), new Map());
    applyEnrichment(bad.attempts, new Map(), new Map(), new Map());
  }

  const goodSummary = summarizeWindow("good", goodWindow, good.attempts, good.source_counts, good.diagnostics, topN);
  const badSummary = summarizeWindow("bad", badWindow, bad.attempts, bad.source_counts, bad.diagnostics, topN);
  const biggestDeltas = buildAllDeltas(goodSummary, badSummary, topN);
  const rootCauses = buildRootCauses(goodSummary, badSummary, biggestDeltas);
  const actions = recommendedActions(rootCauses, badSummary);
  const optionalWarnings = [
    ...new Set([
      ...optionalDiagnostics.optional_enrichment_errors,
      ...good.diagnostics.range_errors,
      ...bad.diagnostics.range_errors,
      ...good.diagnostics.companion_errors,
      ...bad.diagnostics.companion_errors,
    ]),
  ];

  const result = {
    ok: true,
    mode: "read_only",
    called_textgrid: false,
    ran_queue: false,
    sent_sms: false,
    generated_at: new Date().toISOString(),
    timezone,
    good_window_summary: goodSummary,
    bad_window_summary: badSummary,
    biggest_deltas: biggestDeltas,
    likely_root_causes_ranked: rootCauses,
    recommended_actions: actions,
    optional_enrichment_warnings: optionalWarnings,
  };

  if (args.json) {
    console.log(JSON.stringify({
      ...result,
      good_window_summary: stripPrivateMaps(result.good_window_summary),
      bad_window_summary: stripPrivateMaps(result.bad_window_summary),
    }, null, 2));
    return;
  }

  console.log(formatMarkdown({
    ...result,
    good_window_summary: stripPrivateMaps(result.good_window_summary),
    bad_window_summary: stripPrivateMaps(result.bad_window_summary),
  }, topN));
}

main().catch((error) => {
  console.error("FAIL sms-delivery-variance-diagnosis");
  console.error(error?.stack || error?.message || String(error));
  console.error("");
  console.error(usage());
  process.exit(1);
});
