import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { classifyInboxMessage, findMatchedKeywords, KEYWORD_GROUPS } from "@/lib/domain/inbox/keywords.js";

const PRIMARY_THREAD_SOURCE = "v_inbox_threads_live_v2";
const PRIMARY_COUNT_SOURCE = "v_inbox_thread_counts_live_v2";
const FALLBACK_THREAD_SOURCE = "v_inbox_enriched";
const DEFAULT_LIMIT = 100;
const INITIAL_BOOT_DEFAULT_LIMIT = 25;
const MAX_LIMIT = 500;
const LIVE_THREAD_INITIAL_BOOT_FIELDS = [
  "thread_key",
  "best_phone",
  "direction",
  "conversation_stage",
  "latest_message_at",
  "latest_message_body",
  "latest_message_direction",
  "delivery_status",
  "latest_delivery_status",
  "provider_delivery_status",
  "latest_provider_delivery_status",
  "latest_delivered_at",
  "latest_failed_at",
  "latest_failure_reason",
  "queue_status",
  "inbox_bucket",
  "universal_status",
  "universal_stage",
  "property_id",
  "master_owner_id",
  "last_message_at",
  "lead_temperature",
  "reply_intent",
  "suppression_status",
  "unread_count",
  "wrong_number",
  "opt_out",
  "not_interested",
  "needs_review",
  "created_at",
  "updated_at",
].join(",");
const ENRICHED_THREAD_INITIAL_BOOT_FIELDS = [
  "thread_key",
  "best_phone",
  "seller_phone",
  "display_phone",
  "latest_direction",
  "latest_message_at",
  "latest_message_body",
  "preview",
  "inbox_category",
  "stage",
  "property_id",
  "final_property_id",
  "master_owner_id",
  "final_master_owner_id",
  "final_prospect_id",
  "owner_display_name",
  "event_seller_display_name",
  "display_name",
  "property_address_full",
  "display_address",
  "market",
  "display_market",
  "property_type",
  "filter_property_type",
  "show_in_priority_inbox",
  "is_suppressed",
  "detected_intent",
  "ui_intent",
  "is_read",
  "latitude",
  "longitude",
].join(",");
const PRIMARY_COUNT_FALLBACK_FIELDS = [
  "thread_key",
  "inbox_bucket",
  "latest_message_direction",
  "property_id",
  "wrong_number",
  "not_interested",
  "opt_out",
  "suppression_status",
  "needs_review",
].join(",");
const ENRICHED_COUNT_FALLBACK_FIELDS = [
  "thread_key",
  "inbox_category",
  "latest_direction",
  "property_id",
  "is_suppressed",
  "show_in_priority_inbox",
  "stage",
  "detected_intent",
].join(",");
const CANONICAL_COUNT_KEYS = [
  "priority",
  "new_replies",
  "needs_review",
  "follow_up",
  "cold",
  "dead",
  "suppressed",
  "active",
  "waiting",
  "unlinked",
  "all",
  "all_messages",
  "hot_leads",
  "new_inbound",
  "needs_reply",
  "manual_review",
  "outbound_active",
  "cold_no_response",
  "dnc_opt_out",
  "waiting_on_seller",
  "automated",
];
const THREAD_SOURCE_CONFIGS = [
  {
    key: "primary",
    name: PRIMARY_THREAD_SOURCE,
    countSource: PRIMARY_COUNT_SOURCE,
    directionColumn: "latest_message_direction",
    countFallbackFields: PRIMARY_COUNT_FALLBACK_FIELDS,
    getSelectColumns(selectMode) {
      return selectMode === "initial_boot_safe" ? LIVE_THREAD_INITIAL_BOOT_FIELDS : "*";
    },
    searchColumns: [
      "thread_key",
      "canonical_e164",
      "seller_phone",
      "owner_name",
      "property_address_full",
      "latest_message_body",
    ],
  },
  {
    key: "enriched",
    name: FALLBACK_THREAD_SOURCE,
    countSource: null,
    directionColumn: "latest_direction",
    countFallbackFields: ENRICHED_COUNT_FALLBACK_FIELDS,
    getSelectColumns(selectMode) {
      return selectMode === "initial_boot_safe" ? ENRICHED_THREAD_INITIAL_BOOT_FIELDS : "*";
    },
    searchColumns: [
      "thread_key",
      "best_phone",
      "seller_phone",
      "owner_display_name",
      "event_seller_display_name",
      "display_name",
      "property_address_full",
      "display_address",
      "latest_message_body",
    ],
  },
];

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function int(value, fallback, max = MAX_LIMIT) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.trunc(n), max) : fallback;
}

function bool(value) {
  return ["1", "true", "yes", "on"].includes(lower(value));
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asTime(value) {
  const ts = new Date(value || 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function elapsedMs(startMs) {
  return Math.max(0, Math.round(nowMs() - startMs));
}

function latestAt(row = {}) {
  return (
    row.latest_message_at ||
    row.last_message_iso ||
    row.latest_activity_at ||
    row.last_message_at ||
    row.event_timestamp ||
    row.received_at ||
    row.sent_at ||
    row.delivered_at ||
    row.created_at ||
    row.updated_at ||
    null
  );
}

function normalizeDirection(value) {
  const direction = lower(value);
  if (direction.startsWith("in")) return "inbound";
  if (direction.startsWith("out")) return "outbound";
  return direction || null;
}

function msgId(row = {}) {
  return row.id || row.thread_key || row.canonical_thread_key || null;
}

function displayName(row = {}) {
  const metadata = object(row.metadata);
  return (
    row.seller_display_name ||
    row.owner_name ||
    row.owner_display_name ||
    row.display_name ||
    row.event_seller_display_name ||
    row.seller_first_name ||
    metadata.seller_display_name ||
    metadata.owner_name ||
    null
  );
}

function normalizePhone(value) {
  const raw = clean(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.startsWith("+") ? raw : `+${digits}`;
}

function buildPhoneVariants(...values) {
  const variants = new Set();
  for (const value of values) {
    const raw = clean(value);
    const normalized = normalizePhone(value);
    const digits = raw.replace(/\D/g, "");
    if (raw) variants.add(raw);
    if (normalized) variants.add(normalized);
    if (digits) variants.add(digits);
    if (digits.length === 11 && digits.startsWith("1")) variants.add(digits.slice(1));
  }
  return Array.from(variants).filter(Boolean);
}

function quoteSupabaseValue(value) {
  return `"${clean(value).replaceAll('"', '""')}"`;
}

function buildOrEqualsClause(items = []) {
  return items
    .filter(({ column, value }) => clean(column) && clean(value))
    .map(({ column, value }) => `${column}.eq.${quoteSupabaseValue(value)}`)
    .join(",");
}

function normalizeThreadLookupInput(input) {
  if (typeof input === "string") {
    return {
      selectedThreadKey: clean(input) || null,
      canonicalE164: null,
      phone: null,
      bestPhone: null,
      sellerPhone: null,
    };
  }

  const lookup = object(input);
  return {
    selectedThreadKey: clean(
      lookup.selected_thread_key ||
      lookup.selectedThreadKey ||
      lookup.thread_key ||
      lookup.threadKey ||
      lookup.id
    ) || null,
    canonicalE164: normalizePhone(lookup.canonical_e164 || lookup.canonicalE164),
    phone: normalizePhone(lookup.phone),
    bestPhone: normalizePhone(lookup.best_phone || lookup.bestPhone),
    sellerPhone: normalizePhone(lookup.seller_phone || lookup.sellerPhone),
  };
}

function normalizeLiveFilter(rawFilter) {
  const normalized = lower(rawFilter || "all");
  const aliases = {
    all_messages: "all",
    all_conversations: "all",
    positive_hot: "priority",
    hot_leads: "priority",
    needs_reply: "new_replies",
    new_inbounds: "new_replies",
    new_inbound: "new_replies",
    manual_review: "needs_review",
    outbound_active: "follow_up",
    waiting_on_seller: "waiting",
    cold_no_response: "cold",
    wrong_number: "dead",
    dnc_opt_out: "suppressed",
    opt_out: "suppressed",
  };
  return aliases[normalized] || normalized;
}

function splitOptionsAndDeps(optionsOrDeps = {}, maybeDeps = {}) {
  const first = object(optionsOrDeps);
  const second = object(maybeDeps);
  if (Object.keys(second).length > 0) {
    return { options: first, deps: second };
  }
  if ("supabase" in first || "skipCounts" in first) {
    return { options: {}, deps: first };
  }
  return { options: first, deps: {} };
}

function buildEmptyCounts() {
  return {
    priority: 0,
    new_replies: 0,
    needs_review: 0,
    follow_up: 0,
    cold: 0,
    dead: 0,
    suppressed: 0,
    active: 0,
    waiting: 0,
    unlinked: 0,
    all: 0,
    all_messages: 0,
    hot_leads: 0,
    new_inbound: 0,
    needs_reply: 0,
    manual_review: 0,
    outbound_active: 0,
    cold_no_response: 0,
    dnc_opt_out: 0,
    waiting_on_seller: 0,
    automated: 0,
  };
}

function buildNullCounts() {
  return Object.fromEntries(CANONICAL_COUNT_KEYS.map((key) => [key, null]));
}

function removeZeroApproximateCounts(counts = {}) {
  return Object.fromEntries(
    Object.entries(counts).filter(([, value]) => Number(value) > 0)
  );
}

function hasConcreteCountRow(row = {}) {
  return [
    "all",
    "priority",
    "new_replies",
    "needs_review",
    "follow_up",
    "cold",
    "dead",
    "suppressed",
    "active",
    "waiting",
    "unlinked",
  ].some((key) => Number.isFinite(Number(row?.[key])));
}

function countFromRow(row = {}) {
  const counts = buildEmptyCounts();
  counts.priority = Number(row.priority ?? 0);
  counts.new_replies = Number(row.new_replies ?? 0);
  counts.needs_review = Number(row.needs_review ?? 0);
  counts.follow_up = Number(row.follow_up ?? 0);
  counts.cold = Number(row.cold ?? 0);
  counts.dead = Number(row.dead ?? 0);
  counts.suppressed = Number(row.suppressed ?? 0);
  counts.active = Number(row.active ?? 0);
  counts.waiting = Number(row.waiting ?? 0);
  counts.unlinked = Number(row.unlinked ?? 0);
  counts.all = Number(row.all ?? 0);
  counts.all_messages = counts.all;
  counts.hot_leads = counts.priority;
  counts.new_inbound = counts.new_replies;
  counts.needs_reply = counts.new_replies;
  counts.manual_review = counts.needs_review;
  counts.automated = Number(row.automated ?? counts.needs_review);
  counts.outbound_active = counts.follow_up;
  counts.cold_no_response = counts.cold;
  counts.dnc_opt_out = counts.suppressed;
  counts.waiting_on_seller = counts.waiting;
  return counts;
}

function computeCountsFromThreads(rows = []) {
  const counts = buildEmptyCounts();
  for (const row of rows) {
    const bucket = lower(row.inbox_bucket);
    counts.all += 1;
    if (bucket === "priority") counts.priority += 1;
    if (bucket === "new_replies") counts.new_replies += 1;
    if (bucket === "needs_review") counts.needs_review += 1;
    if (bucket === "follow_up") counts.follow_up += 1;
    if (bucket === "cold") counts.cold += 1;
    if (bucket === "dead") counts.dead += 1;
    if (bucket === "suppressed") counts.suppressed += 1;
    if (["priority", "new_replies", "needs_review", "follow_up"].includes(bucket)) counts.active += 1;
    if (normalizeDirection(row.latest_message_direction || row.direction) === "outbound" && !["dead", "suppressed"].includes(bucket)) counts.waiting += 1;
    if (!row.property_id) counts.unlinked += 1;
  }
  counts.all_messages = counts.all;
  counts.hot_leads = counts.priority;
  counts.new_inbound = counts.new_replies;
  counts.needs_reply = counts.new_replies;
  counts.manual_review = counts.needs_review;
  counts.outbound_active = counts.follow_up;
  counts.cold_no_response = counts.cold;
  counts.dnc_opt_out = counts.suppressed;
  counts.waiting_on_seller = counts.waiting;
  return counts;
}

function computeApproximateCountsFromVisibleRows(rows = [], filter = "all") {
  const counts = computeCountsFromThreads(rows);
  const approximate = removeZeroApproximateCounts(counts);
  const normalizedFilter = normalizeLiveFilter(filter);
  if (rows.length > 0 && normalizedFilter !== "all" && approximate[normalizedFilter] == null) {
    approximate[normalizedFilter] = rows.length;
  }
  if (rows.length > 0 && approximate.all == null && normalizedFilter === "all") {
    approximate.all = rows.length;
    approximate.all_messages = rows.length;
  }
  return approximate;
}

function applyVisibleRowsCountFloor(counts = {}, rows = [], filter = "all") {
  const approximate = computeApproximateCountsFromVisibleRows(rows, filter);
  if (Object.keys(approximate).length === 0) return { counts, applied: false, approximate };

  let applied = false;
  const next = { ...counts };
  for (const [key, value] of Object.entries(approximate)) {
    const numericValue = Number(value);
    const currentValue = Number(next[key]);
    if (!Number.isFinite(numericValue) || numericValue <= 0) continue;
    if (!Number.isFinite(currentValue) || currentValue <= 0) {
      next[key] = numericValue;
      applied = true;
    }
  }

  return { counts: next, applied, approximate };
}

function threadMatchesFilter(thread = {}, filter = "all") {
  const bucket = lower(thread.inbox_bucket);
  const direction = normalizeDirection(thread.latest_message_direction || thread.direction);
  switch (filter) {
    case "all":
      return true;
    case "priority":
      return bucket === "priority";
    case "new_replies":
      return bucket === "new_replies";
    case "needs_review":
      return bucket === "needs_review" || thread.needs_review === true;
    case "follow_up":
      return bucket === "follow_up";
    case "cold":
      return bucket === "cold";
    case "dead":
      return bucket === "dead" || thread.wrong_number === true || thread.not_interested === true;
    case "suppressed":
      return bucket === "suppressed" || thread.opt_out === true || lower(thread.suppression_status) === "suppressed";
    case "active":
      return ["priority", "new_replies", "needs_review", "follow_up"].includes(bucket);
    case "waiting":
      return direction === "outbound" && !["dead", "suppressed"].includes(bucket);
    case "unlinked":
      return !thread.property_id;
    default:
      return true;
  }
}

function threadMatchesSearch(thread = {}, query = "") {
  const q = lower(query);
  if (!q) return true;
  return [
    thread.thread_key,
    thread.canonical_thread_key,
    thread.canonical_e164,
    thread.seller_phone,
    thread.best_phone,
    thread.owner_name,
    thread.seller_display_name,
    thread.property_address_full,
    thread.market,
    thread.latest_message_body,
    thread.detected_intent,
    thread.current_stage,
  ].some((value) => lower(value).includes(q));
}

function sortThreads(rows = []) {
  return [...rows].sort((left, right) => (
    asTime(latestAt(right)) - asTime(latestAt(left)) ||
    clean(right.thread_key || right.canonical_thread_key).localeCompare(clean(left.thread_key || left.canonical_thread_key))
  ));
}

function normalizeCanonicalThreadKey(row = {}) {
  return (
    clean(row.canonical_thread_key) ||
    clean(row.thread_key) ||
    clean(row.canonical_e164) ||
    clean(row.phone) ||
    clean(row.best_phone) ||
    clean(row.seller_phone) ||
    clean(row.display_phone) ||
    clean(row.to_phone_number) ||
    clean(row.from_phone_number) ||
    null
  );
}

function isMissingSourceError(error) {
  const message = lower(error?.message || error);
  return (
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    message.includes("does not exist")
  );
}

function getThreadSourceConfig(name) {
  return THREAD_SOURCE_CONFIGS.find((config) => config.name === name) || THREAD_SOURCE_CONFIGS[0];
}

function getThreadSourceCandidates(preferredName = null) {
  if (!preferredName) return THREAD_SOURCE_CONFIGS;
  const preferred = getThreadSourceConfig(preferredName);
  return [
    preferred,
    ...THREAD_SOURCE_CONFIGS.filter((config) => config.name !== preferred.name),
  ];
}

function bucketFromEnrichedRow(row = {}) {
  const category = lower(row.inbox_category);
  const stage = lower(row.stage || row.queue_stage);
  const detectedIntent = lower(row.detected_intent);

  if (row.is_suppressed === true || category === "dnc_opt_out") return "suppressed";
  if (category === "hot_leads" || row.show_in_priority_inbox === true) return "priority";
  if (category === "new_inbound") return "new_replies";
  if (category === "automated") return "needs_review";
  if (category === "outbound_active") return "follow_up";
  if (category === "cold_no_response") return "cold";
  if (stage === "dead" || ["wrong_number", "not_interested"].includes(detectedIntent)) return "dead";
  return "cold";
}

function normalizeThreadRow(row = {}, query = {}) {
  const normalizedDirection = normalizeDirection(row.latest_message_direction || row.latest_direction || row.direction);
  const latestMessageAt = latestAt(row);
  const canonicalThreadKey = normalizeCanonicalThreadKey(row);
  const computedBucket = lower(row.inbox_bucket) || bucketFromEnrichedRow(row);
  const detectedIntent = lower(row.detected_intent || row.reply_intent || row.ui_intent);
  const latestDeliveryStatus =
    clean(row.latest_delivery_status) ||
    clean(row.delivery_status) ||
    clean(row.provider_delivery_status) ||
    clean(row.latest_provider_delivery_status) ||
    clean(row.queue_status) ||
    null;
  const latestProviderDeliveryStatus =
    clean(row.latest_provider_delivery_status) ||
    clean(row.provider_delivery_status) ||
    latestDeliveryStatus;
  const ownerName =
    row.owner_name ||
    row.owner_display_name ||
    row.event_seller_display_name ||
    displayName(row);
  const propertyAddress =
    row.property_address ||
    row.property_address_full ||
    row.display_address ||
    row.event_property_address ||
    null;
  const normalized = {
    ...row,
    id: msgId(row) || canonicalThreadKey,
    thread_key: row.thread_key || canonicalThreadKey,
    canonical_thread_key: canonicalThreadKey,
    canonical_e164: row.canonical_e164 || row.best_phone || row.seller_phone || row.display_phone || null,
    latest_message_at: latestMessageAt,
    latest_activity_at: latestMessageAt,
    last_message_at: row.last_message_at || latestMessageAt,
    latest_message_body: row.latest_message_body ?? row.preview ?? row.message_body ?? null,
    message_body: row.latest_message_body ?? row.preview ?? row.message_body ?? null,
    latest_message_direction: normalizedDirection,
    direction: normalizedDirection,
    delivery_status: row.delivery_status || latestDeliveryStatus,
    latest_delivery_status: latestDeliveryStatus,
    provider_delivery_status: row.provider_delivery_status || latestProviderDeliveryStatus,
    latest_provider_delivery_status: latestProviderDeliveryStatus,
    latest_delivered_at: row.latest_delivered_at || row.delivered_at || null,
    latest_failed_at: row.latest_failed_at || row.failed_at || null,
    latest_failure_reason: row.latest_failure_reason || row.failure_reason || row.error_message || null,
    queue_status: row.queue_status || row.automation_status || null,
    inbox_bucket: computedBucket || "cold",
    inbox_category: row.inbox_category || computedBucket || "cold",
    inbox_status: row.inbox_status || row.universal_status || row.display_status || row.status || computedBucket || "cold",
    conversation_stage: row.conversation_stage || row.current_stage || row.universal_stage || row.stage || row.queue_stage || null,
    current_stage: row.current_stage || row.conversation_stage || row.universal_stage || row.stage || row.queue_stage || null,
    universal_status: row.universal_status || row.display_status || row.status || null,
    universal_stage: row.universal_stage || row.stage || row.queue_stage || null,
    detected_intent: row.detected_intent || row.reply_intent || row.ui_intent || null,
    reply_intent: row.reply_intent || row.detected_intent || row.ui_intent || null,
    best_phone: row.best_phone || row.canonical_e164 || row.seller_phone || row.display_phone || null,
    phone: row.phone || row.canonical_e164 || row.best_phone || row.seller_phone || row.display_phone || null,
    seller_phone: row.seller_phone || row.canonical_e164 || row.best_phone || row.display_phone || null,
    display_phone: row.display_phone || row.canonical_e164 || row.seller_phone || row.best_phone || null,
    seller_display_name: row.seller_display_name || row.owner_display_name || row.event_seller_display_name || displayName(row),
    owner_name: ownerName,
    owner_display_name: row.owner_display_name || ownerName,
    property_address: propertyAddress,
    property_address_full: row.property_address_full || row.display_address || row.event_property_address || null,
    market: row.market || row.display_market || row.market_region || null,
    property_type: row.property_type || row.filter_property_type || null,
    suppression_status: row.suppression_status || (row.is_suppressed === true ? "suppressed" : null),
    wrong_number: row.wrong_number ?? (detectedIntent === "wrong_number"),
    not_interested: row.not_interested ?? (detectedIntent === "not_interested"),
    opt_out: row.opt_out ?? (detectedIntent === "opt_out" || row.is_suppressed === true),
    needs_review: row.needs_review ?? (lower(row.inbox_category) === "automated"),
    unread_count: Number.isFinite(Number(row.unread_count))
      ? Number(row.unread_count)
      : row.is_read === false || normalizedDirection === "inbound"
        ? 1
        : 0,
    thread_row_number: Number(row.thread_row_number ?? 1),
    latest_message_source: row.latest_message_source || "message_events",
    duplicate_property_count: Number(row.duplicate_property_count ?? 0),
    master_owner_id: row.master_owner_id || row.final_master_owner_id || null,
    prospect_id: row.prospect_id || row.final_prospect_id || null,
    property_id: row.property_id || row.final_property_id || null,
    latitude: row.latitude,
    longitude: row.longitude,
  };
  return applyInboxRowComputedFields(normalized, query);
}

function firstClean(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

function deliveryEventTime(row = {}) {
  return Math.max(
    asTime(row.event_timestamp),
    asTime(row.sent_at),
    asTime(row.delivered_at),
    asTime(row.failed_at),
    asTime(row.updated_at),
    asTime(row.created_at),
  );
}

function queueEventTime(row = {}) {
  return Math.max(
    asTime(row.updated_at),
    asTime(row.delivered_at),
    asTime(row.sent_at),
    asTime(row.scheduled_for_utc),
    asTime(row.scheduled_for),
    asTime(row.created_at),
  );
}

function deliveryFailureReason(row = {}) {
  const metadata = object(row.metadata);
  return firstClean(
    row.failure_reason,
    row.error_message,
    metadata.failure_reason,
    metadata.error_message,
    metadata.error,
  ) || null;
}

function queueFailureReason(row = {}) {
  return firstClean(
    row.failed_reason,
    row.guard_reason,
    row.blocked_reason,
    row.paused_reason,
  ) || null;
}

function applyDeliverySnapshot(row = {}, delivery = null, queue = null) {
  const latestDeliveryStatus = firstClean(
    delivery?.delivery_status,
    delivery?.raw_carrier_status,
    delivery?.provider_delivery_status,
    queue?.queue_status,
    row.latest_delivery_status,
    row.delivery_status,
    row.provider_delivery_status,
    row.latest_provider_delivery_status,
  ) || null;
  const latestProviderDeliveryStatus = firstClean(
    delivery?.provider_delivery_status,
    delivery?.delivery_status,
    delivery?.raw_carrier_status,
    latestDeliveryStatus,
  ) || null;
  const latestDeliveredAt = firstClean(
    delivery?.delivered_at,
    queue?.delivered_at,
    row.latest_delivered_at,
    row.delivered_at,
  ) || null;
  const latestFailedAt = firstClean(delivery?.failed_at, row.latest_failed_at, row.failed_at) || null;
  const latestFailureReason = firstClean(
    deliveryFailureReason(delivery || {}),
    queueFailureReason(queue || {}),
    row.latest_failure_reason,
    row.failure_reason,
    row.error_message,
  ) || null;
  const queueStatus = firstClean(queue?.queue_status, row.queue_status, row.automation_status) || null;

  return {
    ...row,
    delivery_status: latestDeliveryStatus,
    latest_delivery_status: latestDeliveryStatus,
    provider_delivery_status: latestProviderDeliveryStatus,
    latest_provider_delivery_status: latestProviderDeliveryStatus,
    latest_delivered_at: latestDeliveredAt,
    latest_failed_at: latestFailedAt,
    latest_failure_reason: latestFailureReason,
    queue_status: queueStatus,
    queue_data: {
      ...object(row.queue_data),
      queue_status: queueStatus,
      queue_id: firstClean(queue?.id, delivery?.queue_id, object(row.queue_data).queue_id) || undefined,
      delivered_at: latestDeliveredAt || undefined,
      failure_reason: latestFailureReason || undefined,
    },
    latest_message_event_data: {
      ...object(row.latest_message_event_data),
      message_event_id: firstClean(delivery?.id, object(row.latest_message_event_data).message_event_id) || undefined,
      latest_delivery_status: latestDeliveryStatus,
      latest_provider_delivery_status: latestProviderDeliveryStatus,
      latest_delivered_at: latestDeliveredAt,
      latest_failed_at: latestFailedAt,
      latest_failure_reason: latestFailureReason,
    },
  };
}

async function hydrateVisibleThreadDelivery(rows = [], supabase = defaultSupabase) {
  if (!Array.isArray(rows) || rows.length === 0 || !supabase?.from) return rows;

  const threadKeys = [...new Set(
    rows
      .map((row) => clean(row.thread_key || row.canonical_thread_key))
      .filter(Boolean)
  )];
  if (!threadKeys.length) return rows;

  const messageLimit = Math.min(Math.max(threadKeys.length * 10, 25), 1000);
  let messageQuery = supabase
    .from("message_events")
    .select([
      "id",
      "thread_key",
      "queue_id",
      "direction",
      "delivery_status",
      "provider_delivery_status",
      "raw_carrier_status",
      "delivered_at",
      "failed_at",
      "failure_reason",
      "error_message",
      "metadata",
      "event_timestamp",
      "sent_at",
      "created_at",
      "updated_at",
    ].join(","))
    .in("thread_key", threadKeys);
  if (typeof messageQuery.ilike === "function") {
    messageQuery = messageQuery.ilike("direction", "out%");
  }
  if (typeof messageQuery.order === "function") {
    messageQuery = messageQuery
      .order("event_timestamp", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false, nullsFirst: false });
  }
  if (typeof messageQuery.limit === "function") {
    messageQuery = messageQuery.limit(messageLimit);
  }
  const { data: messageRows, error: messageError } = await messageQuery;

  if (messageError) {
    console.warn("[INBOX_DELIVERY_HYDRATION_SKIPPED]", {
      source: "message_events",
      message: messageError.message,
    });
    return rows;
  }

  const latestDeliveryByThread = new Map();
  for (const row of [...(messageRows || [])].sort((a, b) => deliveryEventTime(b) - deliveryEventTime(a))) {
    const threadKey = clean(row.thread_key);
    if (threadKey && !latestDeliveryByThread.has(threadKey)) {
      latestDeliveryByThread.set(threadKey, row);
    }
  }

  const queueIds = [...new Set(
    [...latestDeliveryByThread.values()]
      .map((row) => clean(row.queue_id))
      .filter(Boolean)
  )];
  const queueById = new Map();
  const latestQueueByThread = new Map();

  if (queueIds.length) {
    const { data: queueRowsById, error: queueByIdError } = await supabase
      .from("send_queue")
      .select("id,thread_key,queue_status,delivered_at,failed_reason,guard_reason,blocked_reason,paused_reason,updated_at,sent_at,scheduled_for_utc,scheduled_for,created_at")
      .in("id", queueIds)
      .limit(queueIds.length);
    if (queueByIdError) {
      console.warn("[INBOX_DELIVERY_HYDRATION_SKIPPED]", {
        source: "send_queue:id",
        message: queueByIdError.message,
      });
    } else {
      for (const row of queueRowsById || []) {
        const id = clean(row.id);
        if (id) queueById.set(id, row);
      }
    }
  }

  const { data: queueRowsByThread, error: queueByThreadError } = await supabase
    .from("send_queue")
    .select("id,thread_key,queue_status,delivered_at,failed_reason,guard_reason,blocked_reason,paused_reason,updated_at,sent_at,scheduled_for_utc,scheduled_for,created_at")
    .in("thread_key", threadKeys)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(Math.min(Math.max(threadKeys.length * 5, 25), 500));

  if (queueByThreadError) {
    console.warn("[INBOX_DELIVERY_HYDRATION_SKIPPED]", {
      source: "send_queue:thread_key",
      message: queueByThreadError.message,
    });
  } else {
    for (const row of [...(queueRowsByThread || [])].sort((a, b) => queueEventTime(b) - queueEventTime(a))) {
      const threadKey = clean(row.thread_key);
      if (threadKey && !latestQueueByThread.has(threadKey)) {
        latestQueueByThread.set(threadKey, row);
      }
    }
  }

  return rows.map((row) => {
    const threadKey = clean(row.thread_key || row.canonical_thread_key);
    const delivery = latestDeliveryByThread.get(threadKey) || null;
    const queue = queueById.get(clean(delivery?.queue_id)) || latestQueueByThread.get(threadKey) || null;
    if (!delivery && !queue) return row;
    return applyDeliverySnapshot(row, delivery, queue);
  });
}

function toMessageAt(row = {}) {
  return (
    row.event_timestamp ||
    row.message_created_at ||
    row.received_at ||
    row.sent_at ||
    row.delivered_at ||
    row.created_at ||
    null
  );
}

function normalizeMessageRow(row = {}) {
  const canonicalThreadKey = normalizeCanonicalThreadKey(row);
  const messageAt = toMessageAt(row);
  return {
    ...row,
    id: row.id || row.message_event_id || null,
    message_event_id: row.message_event_id || row.id || null,
    thread_key: row.thread_key || canonicalThreadKey,
    canonical_thread_key: canonicalThreadKey,
    direction: normalizeDirection(row.direction),
    message_created_at: row.message_created_at || row.created_at || messageAt,
    event_timestamp: row.event_timestamp || messageAt,
    current_stage: row.current_stage || row.stage_after || object(row.metadata).current_stage || object(row.metadata).stage_after || null,
    detected_intent: row.detected_intent || object(row.metadata).detected_intent || null,
    auto_reply_status: row.auto_reply_status || object(row.metadata).auto_reply_status || null,
    provider_delivery_status: row.provider_delivery_status || row.delivery_status || row.raw_carrier_status || null,
    source_table: "message_events",
    source_app: "message_events",
    latest_message_source: "message_events",
  };
}

function messageBelongsToLookup(row = {}, lookup = {}) {
  const candidateThreadKeys = new Set(
    [
      lookup.selectedThreadKey,
      lookup.canonicalE164,
      lookup.phone,
      lookup.bestPhone,
      lookup.sellerPhone,
    ].map(clean).filter(Boolean)
  );
  const phoneVariants = new Set(buildPhoneVariants(
    lookup.canonicalE164,
    lookup.phone,
    lookup.bestPhone,
    lookup.sellerPhone,
    lookup.selectedThreadKey,
  ));
  const rowCanonical = normalizeCanonicalThreadKey(row);
  const rowThreadKey = clean(row.thread_key);
  const rowCanonicalE164 = normalizePhone(row.canonical_e164);
  const rowFrom = normalizePhone(row.from_phone_number);
  const rowTo = normalizePhone(row.to_phone_number);

  if (rowCanonical && candidateThreadKeys.has(rowCanonical)) return true;
  if (rowThreadKey && candidateThreadKeys.has(rowThreadKey)) return true;
  if (rowCanonicalE164 && phoneVariants.has(rowCanonicalE164)) return true;
  if (rowFrom && phoneVariants.has(rowFrom)) return true;
  if (rowTo && phoneVariants.has(rowTo)) return true;

  return false;
}

function toSupabaseBoolean(value) {
  return value ? "true" : "false";
}

function applyQueryFilter(query, filter, sourceConfig = THREAD_SOURCE_CONFIGS[0]) {
  if (sourceConfig.key === "enriched") {
    switch (filter) {
      case "priority":
        return typeof query.or === "function"
          ? query.or("inbox_category.eq.hot_leads,show_in_priority_inbox.eq.true")
          : query.eq("inbox_category", "hot_leads");
      case "new_replies":
        return query.eq("inbox_category", "new_inbound");
      case "needs_review":
        return query.eq("inbox_category", "automated");
      case "follow_up":
        return query.eq("inbox_category", "outbound_active");
      case "cold":
        return query.eq("inbox_category", "cold_no_response");
      case "dead":
        return typeof query.or === "function"
          ? query.or("stage.eq.dead,detected_intent.eq.wrong_number,detected_intent.eq.not_interested")
          : query.eq("stage", "dead");
      case "suppressed":
        return typeof query.or === "function"
          ? query.or("inbox_category.eq.dnc_opt_out,is_suppressed.eq.true")
          : query.eq("inbox_category", "dnc_opt_out");
      case "active":
        return typeof query.in === "function"
          ? query.in("inbox_category", ["hot_leads", "new_inbound", "automated", "outbound_active"])
          : query;
      case "waiting":
        return query.eq("latest_direction", "outbound");
      case "unlinked":
        return typeof query.is === "function" ? query.is("property_id", null) : query;
      default:
        return query;
    }
  }

  switch (filter) {
    case "priority":
      return query.eq("inbox_bucket", "priority");
    case "new_replies":
      return query.eq("inbox_bucket", "new_replies");
    case "needs_review":
      return typeof query.or === "function"
        ? query.or(`inbox_bucket.eq.needs_review,needs_review.eq.${toSupabaseBoolean(true)}`)
        : query.eq("inbox_bucket", "needs_review");
    case "follow_up":
      return query.eq("inbox_bucket", "follow_up");
    case "cold":
      return query.eq("inbox_bucket", "cold");
    case "dead":
      return typeof query.or === "function"
        ? query.or(`inbox_bucket.eq.dead,wrong_number.eq.${toSupabaseBoolean(true)},not_interested.eq.${toSupabaseBoolean(true)}`)
        : query.eq("inbox_bucket", "dead");
    case "suppressed":
      return typeof query.or === "function"
        ? query.or(`inbox_bucket.eq.suppressed,opt_out.eq.${toSupabaseBoolean(true)},suppression_status.eq.suppressed`)
        : query.eq("inbox_bucket", "suppressed");
    case "active":
      if (typeof query.in === "function") {
        return query.in("inbox_bucket", ["priority", "new_replies", "needs_review", "follow_up"]);
      }
      return typeof query.or === "function"
        ? query.or("inbox_bucket.eq.priority,inbox_bucket.eq.new_replies,inbox_bucket.eq.needs_review,inbox_bucket.eq.follow_up")
        : query;
    case "waiting":
      return query.eq("latest_message_direction", "outbound");
    case "unlinked":
      return typeof query.is === "function" ? query.is("property_id", null) : query;
    default:
      return query;
  }
}

export function applyInboxRowComputedFields(row = {}, query = {}) {
  const messageBody = row.latest_message_body || row.message_body || "";
  const keywordGroups = [];
  if (query.keyword_group && KEYWORD_GROUPS[lower(query.keyword_group)]) keywordGroups.push(lower(query.keyword_group));
  const searchTerms = clean(query.q) ? clean(query.q).split(/\s+/).filter(Boolean) : [];
  const groupMatches = keywordGroups.length ? findMatchedKeywords(messageBody, keywordGroups) : [];
  const searchMatches = searchTerms.length ? findMatchedKeywords(messageBody, searchTerms) : [];
  const flags = classifyInboxMessage({ ...row, message_body: messageBody });
  return {
    ...row,
    id: msgId(row),
    direction: normalizeDirection(row.direction || row.latest_message_direction),
    latest_activity_at: latestAt(row),
    seller_display_name: displayName(row),
    property_address: row.property_address || row.property_address_full || row.display_address || row.event_property_address || object(row.metadata)?.enrichment?.property_address || null,
    market: row.market || row.display_market || row.market_region || object(row.metadata)?.enrichment?.market || null,
    flags,
    matched_keywords: [...new Set([
      ...flags.matched_keywords,
      ...groupMatches.map((match) => match.term),
      ...searchMatches.map((match) => match.term),
    ])],
    highlight_ranges: [...groupMatches, ...searchMatches].map(({ start, end, term }) => ({ start, end, term })),
  };
}

async function queryThreadSource(params = {}, { supabase = defaultSupabase, limit, filter, selectMode, cursorKeyset, offset, preferredThreadSource } = {}) {
  const sourceCandidates = getThreadSourceCandidates(preferredThreadSource);
  let lastError = null;

  for (const sourceConfig of sourceCandidates) {
    const shouldRequestExactCount =
      bool(params.include_total || params.exact_total) &&
      selectMode !== "initial_boot_safe" &&
      sourceConfig.key === "primary";
    let query = supabase.from(sourceConfig.name);
    query = shouldRequestExactCount
      ? query.select(sourceConfig.getSelectColumns(selectMode), { count: "exact" })
      : query.select(sourceConfig.getSelectColumns(selectMode));

    if (params.direction && params.direction !== "all") {
      query = query.eq(sourceConfig.directionColumn, normalizeDirection(params.direction));
    }

    query = applyQueryFilter(query, filter, sourceConfig);

    if (params.q && typeof query.or === "function") {
      const qStr = `%${clean(params.q)}%`;
      query = query.or(
        sourceConfig.searchColumns
          .map((column) => `${column}.ilike.${qStr}`)
          .join(",")
      );
    }

    if (typeof query.order === "function") {
      query = query.order("latest_message_at", { ascending: false, nullsFirst: false });
      query = query.order("thread_key", { ascending: false });
    }

    if (cursorKeyset && typeof query.or === "function") {
      query = query.or(
        `latest_message_at.lt.${cursorKeyset.latest_message_at},and(latest_message_at.eq.${cursorKeyset.latest_message_at},thread_key.lt.${quoteSupabaseValue(cursorKeyset.thread_key)})`
      );
      if (typeof query.limit === "function") {
        query = query.limit(limit + 1);
      }
    } else if (offset > 0 && typeof query.range === "function") {
      query = query.range(offset, offset + limit);
    } else if (typeof query.range === "function") {
      query = query.range(0, limit);
    } else if (typeof query.limit === "function") {
      query = query.limit(limit + 1);
    }

    const result = await query;
    if (!result.error) return { ...result, sourceConfig };
    if (!isMissingSourceError(result.error)) throw result.error;

    lastError = result.error;
    console.warn("[INBOX_SOURCE_FALLBACK]", {
      missing_source: sourceConfig.name,
      message: result.error.message,
    });
  }

  throw lastError || new Error("live_inbox_source_unavailable");
}

export async function getLiveCounts(params = {}, deps = {}) {
  const result = await getLiveCountsWithMeta(params, deps);
  return result.counts;
}

async function getLiveCountsWithMeta(params = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const disableCountFullScan = deps.disableCountFullScan === true;

  for (const sourceConfig of getThreadSourceCandidates(deps.preferredThreadSource)) {
    if (sourceConfig.countSource) {
      try {
        const { data, error } = await supabase
          .from(sourceConfig.countSource)
          .select("*")
          .limit(1);

        if (error) throw error;

        const row = Array.isArray(data) ? data[0] : null;
        if (row && hasConcreteCountRow(row)) {
          const counts = countFromRow(row);
          console.log("[INBOX_COUNTS_UPDATED]", counts);
          return {
            counts,
            source: sourceConfig.countSource,
            approximate: false,
            degraded: false,
          };
        }
      } catch (error) {
        if (!isMissingSourceError(error)) {
          console.warn("[INBOX_COUNTS_FALLBACK]", error?.message || error);
        }
      }
    }

    if (disableCountFullScan) {
      continue;
    }

    const { data: fallbackRows, error: fallbackError } = await supabase
      .from(sourceConfig.name)
      .select(sourceConfig.countFallbackFields);

    if (fallbackError) {
      if (isMissingSourceError(fallbackError)) continue;
      throw fallbackError;
    }

    const counts = computeCountsFromThreads((fallbackRows || []).map((row) => normalizeThreadRow(row, params)));
    console.log("[INBOX_COUNTS_UPDATED]", counts);
    return {
      counts,
      source: `${sourceConfig.name}:full_scan`,
      approximate: false,
      degraded: false,
    };
  }

  throw new Error("live_inbox_counts_unavailable");
}

export async function getLiveInbox(params = {}, optionsOrDeps = {}, maybeDeps = {}) {
  const startedAt = nowMs();
  const { options, deps } = splitOptionsAndDeps(optionsOrDeps, maybeDeps);
  const supabase = deps.supabase || defaultSupabase;
  const timeoutMode = lower(params.timeout_mode || params.timeoutMode);
  const initialBootMode = timeoutMode === "initial_boot" || options.selectMode === "initial_boot_safe";
  const limit = int(params.limit, initialBootMode ? INITIAL_BOOT_DEFAULT_LIMIT : DEFAULT_LIMIT);
  const filter = normalizeLiveFilter(params.inbox_bucket || params.filter || "all");
  const wantsMap = bool(params.map);
  const skipCounts = bool(params.skip_counts) || deps.skipCounts === true || options.skipCounts === true;

  let cursor = params.cursor || null;
  let offset = int(params.offset || params.skip, 0, Number.MAX_SAFE_INTEGER);
  let cursorKeyset = null;

  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);
      if (parsed && parsed.latest_message_at && parsed.thread_key) {
        cursorKeyset = parsed;
      }
    } catch {
      const numericCursor = Number(cursor);
      if (Number.isFinite(numericCursor) && numericCursor >= 0) {
        offset = Math.trunc(numericCursor);
      }
    }
  }

  const threadQueryStartedAt = nowMs();
  const { data: rawRows, count, sourceConfig } = await queryThreadSource(params, {
    supabase,
    limit,
    filter,
    selectMode: options.selectMode,
    cursorKeyset,
    offset,
    preferredThreadSource: deps.preferredThreadSource,
  });
  const threadQueryMs = elapsedMs(threadQueryStartedAt);

  const rows = (rawRows || []).map((row) => normalizeThreadRow(row, params));
  const postFiltered = sortThreads(rows)
    .filter((row) => threadMatchesFilter(row, filter))
    .filter((row) => threadMatchesSearch(row, params.q));

  const hasMore = postFiltered.length > limit;
  let finalRows = hasMore ? postFiltered.slice(0, limit) : postFiltered;
  let liveCounts = buildNullCounts();
  let countQueryMs = 0;
  let countsDegraded = false;
  let countsApproximate = false;
  let countsSource = skipCounts ? "skipped" : null;
  let countPreservedReason = null;

  if (!skipCounts) {
    if (sourceConfig.key === "primary") {
      const countQueryStartedAt = nowMs();
      try {
        const countResult = await getLiveCountsWithMeta({}, {
          ...deps,
          preferredThreadSource: sourceConfig.name,
          disableCountFullScan: true,
        });
        liveCounts = countResult.counts;
        countsSource = countResult.source;
        countsApproximate = countResult.approximate === true;
        countsDegraded = countResult.degraded === true;
      } catch (error) {
        countsDegraded = true;
        countsApproximate = true;
        countsSource = "visible_rows_approximate";
        liveCounts = computeApproximateCountsFromVisibleRows(finalRows, filter);
        countPreservedReason = Object.keys(liveCounts).length > 0
          ? "count_views_failed_visible_rows_approximate"
          : "count_views_failed_preserve_client_counts";
        console.warn("[INBOX_COUNTS_DEGRADED]", {
          source: sourceConfig.name,
          message: error?.message || String(error),
          derived_visible_counts: liveCounts,
        });
      } finally {
        countQueryMs = elapsedMs(countQueryStartedAt);
      }
    } else {
      countsDegraded = true;
      countsApproximate = true;
      countsSource = "visible_rows_approximate";
      liveCounts = computeApproximateCountsFromVisibleRows(finalRows, filter);
      countPreservedReason = Object.keys(liveCounts).length > 0
        ? "fallback_thread_source_visible_rows_approximate"
        : "fallback_thread_source_preserve_client_counts";
    }
  } else {
    countPreservedReason = "counts_skipped_by_request";
  }

  if (!skipCounts) {
    const countFloor = applyVisibleRowsCountFloor(liveCounts, finalRows, filter);
    if (countFloor.applied) {
      liveCounts = countFloor.counts;
      countsDegraded = true;
      countsApproximate = true;
      countsSource = countsSource ? `${countsSource}:visible_rows_floor` : "visible_rows_floor";
      countPreservedReason = countPreservedReason || "count_view_zero_visible_rows_floor";
      console.warn("[INBOX_COUNTS_VISIBLE_ROWS_FLOOR]", {
        source: sourceConfig.name,
        bucket: filter,
        rows: finalRows.length,
        derived_visible_counts: countFloor.approximate,
      });
    }
  }

  const deliveryHydrationStartedAt = nowMs();
  finalRows = await hydrateVisibleThreadDelivery(finalRows, supabase);
  const deliveryHydrationMs = elapsedMs(deliveryHydrationStartedAt);

  console.log("[INBOX_BUCKET_ROWS]", {
    source: sourceConfig.name,
    bucket: filter,
    count: finalRows.length,
    firstThreadKey: finalRows[0]?.thread_key || null,
    firstLatestAt: finalRows[0]?.latest_activity_at || finalRows[0]?.latest_message_at || null,
  });

  const lastRow = finalRows[finalRows.length - 1];
  let nextCursor = null;
  if (hasMore && lastRow) {
    const cursorObj = {
      latest_message_at: lastRow.latest_message_at || lastRow.latest_activity_at,
      thread_key: lastRow.thread_key,
    };
    nextCursor = Buffer.from(JSON.stringify(cursorObj)).toString("base64");
  }

  const diagnostics = {
    source: sourceConfig.name,
    live_source: sourceConfig.name,
    fallback_used: sourceConfig.key !== "primary",
    countsSource,
    countsDegraded,
    countsApproximate,
    count_preserved_reason: countPreservedReason,
    queryMs: elapsedMs(startedAt),
    threadQueryMs,
    countQueryMs,
    deliveryHydrationMs,
  };

  const mapPins = wantsMap
    ? finalRows
      .filter((row) => Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude)))
      .map((row) => ({
        id: row.thread_key,
        thread_key: row.thread_key || null,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        status: row.universal_status || null,
        stage: row.universal_stage || null,
        owner_name: row.owner_name || null,
        property_address: row.property_address_full || null,
        latest_message_body: row.latest_message_body || null,
      }))
    : [];

  return {
    threads: finalRows,
    messages: finalRows,
    counts: liveCounts,
    diagnostics,
    source: sourceConfig.name,
    fallback_used: sourceConfig.key !== "primary",
    countsDegraded,
    countsApproximate,
    countsSource,
    count_preserved_reason: countPreservedReason,
    mapPins,
    pagination: {
      limit,
      returned: finalRows.length,
      has_more: hasMore,
      next_cursor: nextCursor,
      total: Number.isFinite(Number(count)) ? Number(count) : null,
    },
  };
}

export async function getThreadMessages(threadLookupInput, { offset = 0, limit = 200 } = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const lookup = normalizeThreadLookupInput(threadLookupInput);
  const phoneVariants = buildPhoneVariants(
    lookup.selectedThreadKey,
    lookup.canonicalE164,
    lookup.phone,
    lookup.bestPhone,
    lookup.sellerPhone,
  );
  const orClause = buildOrEqualsClause([
    lookup.selectedThreadKey ? { column: "thread_key", value: lookup.selectedThreadKey } : null,
    lookup.selectedThreadKey ? { column: "to_phone_number", value: lookup.selectedThreadKey } : null,
    lookup.selectedThreadKey ? { column: "from_phone_number", value: lookup.selectedThreadKey } : null,
    ...phoneVariants.flatMap((value) => ([
      { column: "thread_key", value },
      { column: "to_phone_number", value },
      { column: "from_phone_number", value },
    ])),
  ].filter(Boolean));

  let query = supabase
    .from("message_events")
    .select("*", { count: "exact" });

  if (orClause && typeof query.or === "function") {
    query = query.or(orClause);
  }

  if (typeof query.order === "function") {
    query = query.order("event_timestamp", { ascending: true, nullsFirst: false });
    query = query.order("created_at", { ascending: true });
  }

  if (typeof query.range === "function") {
    query = query.range(offset, offset + limit - 1);
  } else if (typeof query.limit === "function") {
    query = query.limit(limit);
  }

  const { data, error, count } = await query;
  if (error) throw error;

  const rows = sortThreads(
    (data || [])
      .filter((row) => messageBelongsToLookup(row, lookup))
      .map((row) => normalizeMessageRow(row))
  ).sort((left, right) => (
    asTime(left.event_timestamp || left.message_created_at || left.created_at) -
    asTime(right.event_timestamp || right.message_created_at || right.created_at) ||
    clean(left.id).localeCompare(clean(right.id))
  ));

  const total = rows.length;
  const diagnostics = {
    selected_thread_key: lookup.selectedThreadKey,
    canonical_thread_key: lookup.selectedThreadKey || lookup.canonicalE164 || lookup.phone || lookup.bestPhone || lookup.sellerPhone || null,
    canonical_e164: lookup.canonicalE164,
    lookup_strategy_used: "message_events_canonical_thread_key",
    message_count: rows.length,
    fallback_used: false,
    strategies_tried: ["message_events_canonical_thread_key"],
  };

  console.log("[INBOX_THREAD_MESSAGE_LOOKUP]", diagnostics);

  return {
    rows,
    total,
    diagnostics,
  };
}
