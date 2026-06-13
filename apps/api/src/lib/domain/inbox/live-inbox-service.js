import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { classifyInboxMessage, findMatchedKeywords, KEYWORD_GROUPS } from "@/lib/domain/inbox/keywords.js";

const PRIMARY_THREAD_SOURCE = "canonical_inbox_threads";
const PRIMARY_COUNT_SOURCE = "canonical_inbox_counts";
const LEGACY_THREAD_SOURCE = "inbox_threads_view";
const FALLBACK_THREAD_SOURCE = "v_inbox_threads_live_v2";
const DEFAULT_LIMIT = 100;
const INITIAL_BOOT_DEFAULT_LIMIT = 25;
const MAX_LIMIT = 500;
const LIVE_THREAD_INITIAL_BOOT_FIELDS = [
  "thread_key",
  "canonical_thread_key",
  "canonical_e164",
  "seller_phone",
  "display_phone",
  "best_phone",
  "direction",
  "conversation_stage",
  "owner_name",
  "seller_display_name",
  "seller_first_name",
  "property_address_full",
  "property_address_city",
  "property_state",
  "property_zip",
  "market",
  "property_type",
  "latest_message_at",
  "latest_message_event_id",
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
  "prospect_id",
  "master_owner_id",
  "selected_property_id",
  "thread_property_id",
  "thread_master_owner_id",
  "thread_prospect_id",
  "last_message_at",
  "lead_temperature",
  "reply_intent",
  "message_count",
  "inbound_count",
  "outbound_count",
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
  // Legacy fallbacks — used only when canonical_inbox_threads is unavailable.
  // Do not promote these back to primary; they have independent classification
  // CASE expressions that diverge from canonical_inbox_counts.
  {
    key: "legacy_primary",
    name: LEGACY_THREAD_SOURCE,
    countSource: null,
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

function readObjectPath(source = {}, path = "") {
  return path.split(".").reduce((current, key) => object(current)[key], source);
}

function firstCleanValue(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

function normalizedPhoneForIdentity(row = {}) {
  const direction = normalizeDirection(row.direction || row.latest_message_direction || row.latest_direction);
  const inboundCounterparty = direction === "inbound" ? row.from_phone_number : null;
  const outboundCounterparty = direction === "outbound" ? row.to_phone_number : null;
  const threadKey = clean(row.thread_key);
  const canonicalThreadKey = clean(row.canonical_thread_key);
  return normalizePhone(
    row.normalized_phone ||
    row.canonical_e164 ||
    row.phone_e164 ||
    row.seller_phone ||
    row.best_phone ||
    row.display_phone ||
    row.phone ||
    inboundCounterparty ||
    outboundCounterparty ||
    row.to_phone_number ||
    row.from_phone_number ||
    (threadKey.startsWith("ct:") ? null : threadKey) ||
    (canonicalThreadKey.startsWith("ct:") ? null : canonicalThreadKey)
  );
}

function campaignOrSequenceIdentity(row = {}) {
  return firstCleanValue(
    row.campaign_id,
    row.campaignId,
    row.sequence_id,
    row.sequenceId,
    row.campaign_session_id,
    readObjectPath(row, "campaign_data.id"),
    readObjectPath(row, "campaign_data.campaign_id"),
    readObjectPath(row, "queue_data.campaign_id"),
    readObjectPath(row, "queue_data.sequence_id"),
    readObjectPath(row, "metadata.campaign_id"),
    readObjectPath(row, "metadata.sequence_id")
  );
}

export function buildConversationThreadId(row = {}) {
  const prospectId = firstCleanValue(row.prospect_id, row.prospectId, row.final_prospect_id, row.canonical_prospect_id);
  const propertyId = firstCleanValue(row.property_id, row.propertyId, row.final_property_id, row.selected_property_id, row.thread_property_id);
  const masterOwnerId = firstCleanValue(row.master_owner_id, row.masterOwnerId, row.owner_id, row.ownerId, row.final_master_owner_id, row.thread_master_owner_id);
  const normalizedPhone = normalizedPhoneForIdentity(row);
  const campaignOrSequenceId = campaignOrSequenceIdentity(row);
  const parts = [];

  if (prospectId) parts.push(`prospect:${prospectId}`);
  if (propertyId) parts.push(`property:${propertyId}`);
  if (masterOwnerId) parts.push(`owner:${masterOwnerId}`);
  if (normalizedPhone) parts.push(`phone:${normalizedPhone}`);
  if (!prospectId && !propertyId && !masterOwnerId && campaignOrSequenceId) {
    parts.push(`campaign:${campaignOrSequenceId}`);
  }

  return parts.length ? `ct:${parts.join("|")}` : null;
}

function parseConversationThreadId(value) {
  const text = clean(value);
  if (!text.startsWith("ct:")) return {};
  const parsed = {};
  for (const segment of text.slice(3).split("|")) {
    const splitAt = segment.indexOf(":");
    if (splitAt <= 0) continue;
    const key = segment.slice(0, splitAt);
    const rawValue = segment.slice(splitAt + 1);
    if (!rawValue) continue;
    if (key === "prospect") parsed.prospectId = rawValue;
    if (key === "property") parsed.propertyId = rawValue;
    if (key === "owner") parsed.masterOwnerId = rawValue;
    if (key === "phone") parsed.normalizedPhone = normalizePhone(rawValue);
    if (key === "campaign") parsed.campaignId = rawValue;
  }
  return parsed;
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
      conversationThreadId: null,
      legacyThreadKey: null,
      canonicalE164: null,
      normalizedPhone: null,
      phoneE164: null,
      phone: null,
      bestPhone: null,
      sellerPhone: null,
      prospectId: null,
      propertyId: null,
      masterOwnerId: null,
      ownerId: null,
      latestMessageId: null,
    };
  }

  const lookup = object(input);
  return {
    selectedThreadKey: clean(
      lookup.conversation_thread_id ||
      lookup.conversationThreadId ||
      lookup.selected_thread_key ||
      lookup.selectedThreadKey ||
      lookup.thread_key ||
      lookup.threadKey ||
      lookup.id
    ) || null,
    conversationThreadId: clean(lookup.conversation_thread_id || lookup.conversationThreadId || lookup.canonical_thread_id || lookup.canonicalThreadId) || null,
    legacyThreadKey: clean(lookup.legacy_thread_key || lookup.legacyThreadKey || lookup.raw_thread_key || lookup.rawThreadKey) || null,
    normalizedPhone: normalizePhone(lookup.normalized_phone || lookup.normalizedPhone),
    canonicalE164: normalizePhone(lookup.canonical_e164 || lookup.canonicalE164),
    phoneE164: normalizePhone(lookup.phone_e164 || lookup.phoneE164),
    phone: normalizePhone(lookup.phone),
    bestPhone: normalizePhone(lookup.best_phone || lookup.bestPhone),
    sellerPhone: normalizePhone(lookup.seller_phone || lookup.sellerPhone),
    prospectId: clean(lookup.prospect_id || lookup.prospectId) || null,
    propertyId: clean(lookup.property_id || lookup.propertyId) || null,
    masterOwnerId: clean(lookup.master_owner_id || lookup.masterOwnerId || lookup.owner_id || lookup.ownerId) || null,
    ownerId: clean(lookup.owner_id || lookup.ownerId) || null,
    latestMessageId: clean(
      lookup.latest_message_id ||
      lookup.latestMessageId ||
      lookup.latest_message_event_id ||
      lookup.latestMessageEventId ||
      lookup.message_event_id ||
      lookup.messageEventId
    ) || null,
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
  const normalizedPhone = normalizedPhoneForIdentity({
    ...row,
    direction: normalizedDirection,
  });
  const conversationThreadId = buildConversationThreadId({
    ...row,
    direction: normalizedDirection,
    canonical_e164: normalizedPhone || row.canonical_e164,
  }) || canonicalThreadKey;
  const computedBucket = lower(row.inbox_bucket) || bucketFromEnrichedRow(row);
  const detectedIntent = lower(row.detected_intent || row.reply_intent || row.ui_intent);
  const latestDeliveryStatus =
    clean(row.latest_provider_delivery_status) ||
    clean(row.latest_delivery_status) ||
    clean(row.provider_delivery_status) ||
    clean(row.delivery_status) ||
    clean(row.queue_status) ||
    null;
  const latestProviderDeliveryStatus =
    clean(row.latest_provider_delivery_status) ||
    clean(row.provider_delivery_status) ||
    latestDeliveryStatus;
  const latestMessageEventId = firstClean(
    row.latest_message_id,
    row.latestMessageId,
    row.latest_message_event_id,
    row.latestMessageEventId,
    row.message_event_id,
    object(row.latest_message_event_data).message_event_id,
  ) || null;
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
    id: conversationThreadId || row.id || msgId(row) || canonicalThreadKey,
    conversation_thread_id: row.conversation_thread_id || conversationThreadId,
    conversationThreadId: row.conversationThreadId || row.conversation_thread_id || conversationThreadId,
    normalized_phone: normalizedPhone,
    legacy_thread_key: row.legacy_thread_key || row.thread_key || canonicalThreadKey,
    thread_key: row.thread_key || canonicalThreadKey,
    canonical_thread_key: canonicalThreadKey,
    canonical_e164: normalizedPhone || row.canonical_e164 || row.best_phone || row.seller_phone || row.display_phone || null,
    latest_message_at: latestMessageAt,
    latest_message_id: latestMessageEventId,
    latestMessageId: latestMessageEventId,
    latest_message_event_id: latestMessageEventId,
    latestMessageEventId: latestMessageEventId,
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
    best_phone: row.best_phone || normalizedPhone || row.canonical_e164 || row.seller_phone || row.display_phone || null,
    phone: row.phone || normalizedPhone || row.canonical_e164 || row.best_phone || row.seller_phone || row.display_phone || null,
    seller_phone: row.seller_phone || normalizedPhone || row.canonical_e164 || row.best_phone || row.display_phone || null,
    display_phone: row.display_phone || normalizedPhone || row.canonical_e164 || row.seller_phone || row.best_phone || null,
    seller_display_name: row.seller_display_name || row.owner_display_name || row.event_seller_display_name || displayName(row),
    owner_name: ownerName,
    owner_display_name: row.owner_display_name || ownerName,
    property_address: propertyAddress,
    property_address_full: row.property_address_full || propertyAddress || row.display_address || row.event_property_address || null,
    property_address_city: row.property_address_city || row.city || row.filter_city || null,
    property_address_state: row.property_address_state || row.property_state || row.state || row.filter_state || null,
    property_address_zip: row.property_address_zip || row.property_zip || row.zip || row.filter_zip || null,
    city: row.city || row.property_address_city || row.filter_city || null,
    state: row.state || row.property_state || row.property_address_state || row.filter_state || null,
    zip: row.zip || row.property_zip || row.property_address_zip || row.filter_zip || null,
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
  const sortedDeliveryRows = [...(messageRows || [])].sort((a, b) => deliveryEventTime(b) - deliveryEventTime(a));
  for (const row of sortedDeliveryRows) {
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
      .select("id,thread_key,from_phone_number,to_phone_number,property_id,prospect_id,master_owner_id,queue_status,delivered_at,failed_reason,guard_reason,blocked_reason,paused_reason,updated_at,sent_at,scheduled_for_utc,scheduled_for,created_at")
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
    .select("id,thread_key,from_phone_number,to_phone_number,property_id,prospect_id,master_owner_id,queue_status,delivered_at,failed_reason,guard_reason,blocked_reason,paused_reason,updated_at,sent_at,scheduled_for_utc,scheduled_for,created_at")
    .in("thread_key", threadKeys)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(Math.min(Math.max(threadKeys.length * 5, 25), 500));

  if (queueByThreadError) {
    console.warn("[INBOX_DELIVERY_HYDRATION_SKIPPED]", {
      source: "send_queue:thread_key",
      message: queueByThreadError.message,
    });
  }
  const sortedQueueRows = [...(queueRowsByThread || [])].sort((a, b) => queueEventTime(b) - queueEventTime(a));
  if (!queueByThreadError) {
    for (const row of sortedQueueRows) {
      const threadKey = clean(row.thread_key);
      if (threadKey && !latestQueueByThread.has(threadKey)) {
        latestQueueByThread.set(threadKey, row);
      }
    }
  }

  return rows.map((row) => {
    const threadKey = clean(row.thread_key || row.canonical_thread_key);
    const hasStrongIdentity = Boolean(clean(row.prospect_id || row.final_prospect_id || row.property_id || row.final_property_id || row.master_owner_id || row.final_master_owner_id || row.owner_id));
    const delivery = sortedDeliveryRows.find((candidate) => candidateMatchesThreadIdentity(candidate, row)) || (!hasStrongIdentity ? latestDeliveryByThread.get(threadKey) : null) || null;
    const queue = queueById.get(clean(delivery?.queue_id)) || sortedQueueRows.find((candidate) => candidateMatchesThreadIdentity(candidate, row)) || (!hasStrongIdentity ? latestQueueByThread.get(threadKey) : null) || null;
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

function normalizeBody(value) {
  return clean(value).replace(/\s+/g, " ").toLowerCase();
}

function normalizeDeliveryStatusValue(...values) {
  const statuses = values.map(lower).filter(Boolean);
  if (statuses.some((status) => status.includes("deliver") && !status.includes("undeliver"))) return "delivered";
  if (statuses.some((status) => status.includes("fail") || status.includes("undeliv") || status.includes("error"))) return "failed";
  if (statuses.some((status) => status.includes("queue") || status.includes("pending") || status.includes("schedul") || status.includes("approval"))) return "queued";
  if (statuses.some((status) => status.includes("sent") || status === "success" || status === "accepted")) return "sent";
  return statuses[0] || null;
}

function normalizeMessageRow(row = {}) {
  const canonicalThreadKey = normalizeCanonicalThreadKey(row);
  const messageAt = toMessageAt(row);
  const normalizedPhone = normalizedPhoneForIdentity(row);
  const direction = normalizeDirection(row.direction);
  const body = firstCleanValue(row.message_body, row.body, row.normalized_body);
  const providerStatus = firstCleanValue(row.provider_status, row.provider_delivery_status, row.raw_carrier_status, row.delivery_status);
  const lifecycleStatus = normalizeDeliveryStatusValue(
    row.lifecycle_status,
    row.delivery_status,
    row.provider_status,
    row.provider_delivery_status,
    row.raw_carrier_status,
    row.queue_status,
    row.status,
    row.delivered_at ? "delivered" : null,
    row.failed_at ? "failed" : null,
  );
  const hasExplicitConversationFlag = Object.prototype.hasOwnProperty.call(row, "conversation_thread_id_explicit");
  const explicitConversationThreadId = hasExplicitConversationFlag && row.conversation_thread_id_explicit !== true
    ? ""
    : clean(row.conversation_thread_id || row.conversationThreadId);
  const conversationThreadId = buildConversationThreadId({
    ...row,
    canonical_e164: normalizedPhone || row.canonical_e164,
  }) || explicitConversationThreadId || canonicalThreadKey;
  return {
    ...row,
    id: row.id || row.message_event_id || null,
    message_id: firstCleanValue(row.message_id, row.provider_message_sid, row.provider_message_id, row.id, row.message_event_id) || null,
    message_event_id: row.message_event_id || row.id || null,
    conversation_thread_id: explicitConversationThreadId || conversationThreadId,
    conversation_thread_id_explicit: Boolean(explicitConversationThreadId),
    conversationThreadId: explicitConversationThreadId || conversationThreadId,
    normalized_phone: normalizedPhone,
    legacy_thread_key: row.legacy_thread_key || row.thread_key || canonicalThreadKey,
    thread_key: row.thread_key || canonicalThreadKey,
    canonical_thread_key: canonicalThreadKey,
    canonical_e164: normalizedPhone || row.canonical_e164 || null,
    direction,
    body,
    normalized_body: firstCleanValue(row.normalized_body, normalizeBody(body)) || null,
    message_created_at: row.message_created_at || row.created_at || messageAt,
    event_timestamp: row.event_timestamp || messageAt,
    sent_at: row.sent_at || null,
    delivered_at: row.delivered_at || null,
    delivery_status: lifecycleStatus || row.delivery_status || null,
    provider_status: providerStatus || null,
    lifecycle_status: lifecycleStatus || null,
    from_number: row.from_number || row.from_phone_number || null,
    to_number: row.to_number || row.to_phone_number || null,
    phone_number: row.phone_number || normalizedPhone || null,
    campaign_id: firstCleanValue(row.campaign_id, row.campaignId, readObjectPath(row, "metadata.campaign_id")) || null,
    sequence_id: firstCleanValue(row.sequence_id, row.sequenceId, readObjectPath(row, "metadata.sequence_id")) || null,
    is_inbound: direction === "inbound",
    is_outbound: direction === "outbound",
    current_stage: row.current_stage || row.stage_after || object(row.metadata).current_stage || object(row.metadata).stage_after || null,
    detected_intent: row.detected_intent || object(row.metadata).detected_intent || null,
    auto_reply_status: row.auto_reply_status || object(row.metadata).auto_reply_status || null,
    provider_delivery_status: providerStatus || null,
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
      (sourceConfig.key === "primary" || sourceConfig.key === "legacy_primary");
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
    if (sourceConfig.key === "primary" || sourceConfig.key === "legacy_primary") {
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

function emptyIdentitySets() {
  return {
    threadKeys: new Set(),
    phones: new Set(),
    prospectIds: new Set(),
    propertyIds: new Set(),
    masterOwnerIds: new Set(),
  };
}

function identitySnapshot(identities = emptyIdentitySets()) {
  return {
    thread_keys: [...identities.threadKeys].filter(Boolean),
    phones: [...identities.phones].filter(Boolean),
    prospect_ids: [...identities.prospectIds].filter(Boolean),
    property_ids: [...identities.propertyIds].filter(Boolean),
    master_owner_ids: [...identities.masterOwnerIds].filter(Boolean),
  };
}

function addPhoneIdentity(identities, ...values) {
  for (const value of values) {
    for (const variant of buildPhoneVariants(value)) {
      if (variant) identities.phones.add(variant);
    }
  }
}

function addLookupIdentities(identities, lookup = {}) {
  [
    lookup.selectedThreadKey,
  ].map(clean).filter(Boolean).forEach((value) => identities.threadKeys.add(value));

  addPhoneIdentity(
    identities,
    lookup.selectedThreadKey,
    lookup.canonicalE164,
    lookup.phoneE164,
    lookup.phone,
    lookup.bestPhone,
    lookup.sellerPhone,
  );

  if (lookup.prospectId) identities.prospectIds.add(clean(lookup.prospectId));
  if (lookup.propertyId) identities.propertyIds.add(clean(lookup.propertyId));
  if (lookup.masterOwnerId) identities.masterOwnerIds.add(clean(lookup.masterOwnerId));
  if (lookup.ownerId) identities.masterOwnerIds.add(clean(lookup.ownerId));
}

function addRowIdentities(identities, row = {}) {
  [
    row.thread_key,
    row.canonical_thread_key,
  ].map(clean).filter(Boolean).forEach((value) => identities.threadKeys.add(value));

  addPhoneIdentity(
    identities,
    row.canonical_e164,
    row.phone_e164,
    row.phone,
    row.best_phone,
    row.seller_phone,
    row.display_phone,
    row.from_phone_number,
    row.to_phone_number,
    row.recipient_phone,
  );

  [
    row.prospect_id,
    row.final_prospect_id,
    row.canonical_prospect_id,
  ].map(clean).filter(Boolean).forEach((value) => identities.prospectIds.add(value));

  [
    row.property_id,
    row.final_property_id,
  ].map(clean).filter(Boolean).forEach((value) => identities.propertyIds.add(value));

  [
    row.master_owner_id,
    row.final_master_owner_id,
    row.owner_id,
  ].map(clean).filter(Boolean).forEach((value) => identities.masterOwnerIds.add(value));
}

function buildColumnValueFilters(columns = [], values = []) {
  const uniqueValues = [...new Set(values.map(clean).filter(Boolean))];
  return columns.flatMap((column) =>
    uniqueValues.map((value) => ({ column, value }))
  );
}

function identityFiltersForMessageEvents(identities = emptyIdentitySets()) {
  return [
    ...buildColumnValueFilters(["thread_key"], [...identities.threadKeys]),
    ...buildColumnValueFilters(["thread_key", "from_phone_number", "to_phone_number"], [...identities.phones]),
    ...buildColumnValueFilters(["prospect_id"], [...identities.prospectIds]),
    ...buildColumnValueFilters(["property_id"], [...identities.propertyIds]),
    ...buildColumnValueFilters(["master_owner_id"], [...identities.masterOwnerIds]),
  ];
}

function messageBelongsToIdentities(row = {}, identities = emptyIdentitySets()) {
  const rowThreadKey = clean(row.thread_key || row.canonical_thread_key);
  if (rowThreadKey && identities.threadKeys.has(rowThreadKey)) return true;

  const rowPhones = buildPhoneVariants(
    row.canonical_e164,
    row.phone_e164,
    row.phone,
    row.from_phone_number,
    row.to_phone_number,
    row.best_phone,
    row.seller_phone,
  );
  if (rowPhones.some((value) => identities.phones.has(value))) return true;

  const prospectId = clean(row.prospect_id || row.canonical_prospect_id);
  if (prospectId && identities.prospectIds.has(prospectId)) return true;

  const propertyId = clean(row.property_id);
  if (propertyId && identities.propertyIds.has(propertyId)) return true;

  const masterOwnerId = clean(row.master_owner_id || row.owner_id);
  if (masterOwnerId && identities.masterOwnerIds.has(masterOwnerId)) return true;

  return false;
}

async function queryIdentityRows({
  supabase,
  source,
  filters,
  limit = 50,
  orderBy = null,
}) {
  const orClause = buildOrEqualsClause(filters);
  if (!orClause) return { rows: [], error: null };

  try {
    let query = supabase.from(source).select("*");
    if (typeof query.or === "function") query = query.or(orClause);
    if (orderBy && typeof query.order === "function") {
      query = query.order(orderBy, { ascending: false, nullsFirst: false });
    }
    if (typeof query.limit === "function") query = query.limit(limit);
    const { data, error } = await query;
    if (error) return { rows: [], error };
    return { rows: Array.isArray(data) ? data : [], error: null };
  } catch (error) {
    return { rows: [], error };
  }
}

function dedupeRowsByMessageId(rows = []) {
  const byKey = new Map();
  for (const row of rows) {
    const key = clean(row.id || row.message_event_id || row.message_event_key || row.provider_message_sid) ||
      `${clean(row.thread_key)}:${clean(row.direction)}:${clean(row.message_body)}:${clean(toMessageAt(row))}`;
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

async function collectIdentitySource({
  supabase,
  identities,
  source,
  label,
  columns,
  values,
  diagnostics,
  limit = 25,
}) {
  const before = identitySnapshot(identities);
  const { rows, error } = await queryIdentityRows({
    supabase,
    source,
    filters: buildColumnValueFilters(columns, values),
    limit,
  });

  if (error) {
    diagnostics.sourceResults.push({
      source: label || source,
      ok: false,
      rows: 0,
      error: error.message || String(error),
    });
    return [];
  }

  for (const row of rows) addRowIdentities(identities, row);
  const after = identitySnapshot(identities);
  diagnostics.sourceResults.push({
    source: label || source,
    ok: true,
    rows: rows.length,
    expanded: {
      thread_keys: Math.max(0, after.thread_keys.length - before.thread_keys.length),
      phones: Math.max(0, after.phones.length - before.phones.length),
      prospect_ids: Math.max(0, after.prospect_ids.length - before.prospect_ids.length),
      property_ids: Math.max(0, after.property_ids.length - before.property_ids.length),
      master_owner_ids: Math.max(0, after.master_owner_ids.length - before.master_owner_ids.length),
    },
  });
  return rows;
}

async function collectPhoneNumberIdentities({ supabase, identities, diagnostics }) {
  const phoneValues = [...identities.phones];
  if (!phoneValues.length) return [];

  const allRows = [];
  for (const column of ["canonical_e164", "phone_number", "best_phone", "phone"]) {
    const rows = await collectIdentitySource({
      supabase,
      identities,
      source: "phone_numbers",
      label: `phone_numbers:${column}`,
      columns: [column],
      values: phoneValues,
      diagnostics,
      limit: 25,
    });
    allRows.push(...rows);
  }
  return allRows;
}

async function collectProspectIdentities({ supabase, identities, diagnostics }) {
  const filters = [
    ...buildColumnValueFilters(["id", "prospect_id"], [...identities.prospectIds]),
    ...buildColumnValueFilters(["master_owner_id", "owner_id"], [...identities.masterOwnerIds]),
    ...buildColumnValueFilters(["property_id"], [...identities.propertyIds]),
  ];
  if (!filters.length) return [];
  const { rows, error } = await queryIdentityRows({
    supabase,
    source: "prospects",
    filters,
    limit: 25,
  });
  if (error) {
    diagnostics.sourceResults.push({
      source: "prospects",
      ok: false,
      rows: 0,
      error: error.message || String(error),
    });
    return [];
  }
  for (const row of rows) addRowIdentities(identities, row);
  diagnostics.sourceResults.push({ source: "prospects", ok: true, rows: rows.length });
  return rows;
}

async function collectInboxViewIdentities({ supabase, identities, diagnostics }) {
  const snapshot = identitySnapshot(identities);
  const primaryValues = [
    ...snapshot.thread_keys,
    ...snapshot.phones,
  ];

  await collectIdentitySource({
    supabase,
    identities,
    source: PRIMARY_THREAD_SOURCE,
    label: PRIMARY_THREAD_SOURCE,
    columns: ["thread_key", "canonical_thread_key", "canonical_e164", "best_phone", "seller_phone"],
    values: primaryValues,
    diagnostics,
    limit: 10,
  });

  await collectIdentitySource({
    supabase,
    identities,
    source: FALLBACK_THREAD_SOURCE,
    label: FALLBACK_THREAD_SOURCE,
    columns: ["thread_key", "best_phone", "seller_phone", "display_phone"],
    values: primaryValues,
    diagnostics,
    limit: 10,
  });

  const idValues = identitySnapshot(identities);
  await collectIdentitySource({
    supabase,
    identities,
    source: PRIMARY_THREAD_SOURCE,
    label: `${PRIMARY_THREAD_SOURCE}:ids`,
    columns: ["property_id", "prospect_id", "master_owner_id"],
    values: [
      ...idValues.property_ids,
      ...idValues.prospect_ids,
      ...idValues.master_owner_ids,
    ],
    diagnostics,
    limit: 10,
  });

  await collectIdentitySource({
    supabase,
    identities,
    source: FALLBACK_THREAD_SOURCE,
    label: `${FALLBACK_THREAD_SOURCE}:ids`,
    columns: ["property_id", "final_property_id", "final_prospect_id", "master_owner_id", "final_master_owner_id"],
    values: [
      ...idValues.property_ids,
      ...idValues.prospect_ids,
      ...idValues.master_owner_ids,
    ],
    diagnostics,
    limit: 10,
  });
}

async function queryMessageEventsByIdentities({ supabase, identities, fetchLimit, diagnostics }) {
  const filters = identityFiltersForMessageEvents(identities);
  const orClause = buildOrEqualsClause(filters);
  if (!orClause) {
    diagnostics.sourceResults.push({
      source: "message_events",
      ok: true,
      rows: 0,
      skipped: true,
      reason: "no_thread_identity",
    });
    return [];
  }

  let query = supabase
    .from("message_events")
    .select("*");

  if (typeof query.or === "function") query = query.or(orClause);

  if (typeof query.order === "function") {
    query = query.order("event_timestamp", { ascending: false, nullsFirst: false });
    query = query.order("created_at", { ascending: false, nullsFirst: false });
  }

  if (typeof query.limit === "function") {
    query = query.limit(fetchLimit);
  }

  const { data, error } = await query;
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  diagnostics.sourceResults.push({
    source: "message_events",
    ok: true,
    rows: rows.length,
    filter_count: filters.length,
  });
  return rows;
}

function resolveIdentityUsed(row = {}, identities = emptyIdentitySets()) {
  const rowThreadKey = clean(row.thread_key || row.canonical_thread_key);
  if (rowThreadKey && identities.threadKeys.has(rowThreadKey)) return `thread_key:${rowThreadKey}`;

  for (const phone of buildPhoneVariants(row.from_phone_number, row.to_phone_number, row.canonical_e164)) {
    if (identities.phones.has(phone)) return `phone:${phone}`;
  }

  const propertyId = clean(row.property_id);
  if (propertyId && identities.propertyIds.has(propertyId)) return `property_id:${propertyId}`;

  const prospectId = clean(row.prospect_id);
  if (prospectId && identities.prospectIds.has(prospectId)) return `prospect_id:${prospectId}`;

  const masterOwnerId = clean(row.master_owner_id || row.owner_id);
  if (masterOwnerId && identities.masterOwnerIds.has(masterOwnerId)) return `master_owner_id:${masterOwnerId}`;

  return null;
}

function getLookupNormalizedPhone(lookup = {}) {
  const legacyThreadKey = clean(lookup.legacyThreadKey);
  const selectedThreadKey = clean(lookup.selectedThreadKey);
  const safeLegacyThreadKey = legacyThreadKey.startsWith("ct:") ? null : legacyThreadKey;
  const safeSelectedThreadKey = selectedThreadKey.startsWith("ct:") ? null : selectedThreadKey;
  return normalizePhone(
    lookup.normalizedPhone ||
    lookup.canonicalE164 ||
    lookup.phoneE164 ||
    lookup.phone ||
    lookup.bestPhone ||
    lookup.sellerPhone ||
    safeLegacyThreadKey ||
    safeSelectedThreadKey
  );
}

function buildLookupConversationThreadId(lookup = {}) {
  return clean(lookup.conversationThreadId) || buildConversationThreadId({
    prospect_id: lookup.prospectId,
    property_id: lookup.propertyId,
    master_owner_id: lookup.masterOwnerId || lookup.ownerId,
    normalized_phone: getLookupNormalizedPhone(lookup),
    campaign_id: lookup.campaignId,
    sequence_id: lookup.sequenceId,
  });
}

function distinctCleanValues(rows = [], ...keys) {
  const values = new Set();
  for (const row of rows) {
    for (const key of keys) {
      const value = clean(row?.[key]);
      if (value) values.add(value);
    }
  }
  return [...values];
}

function auditThreadIdentity({ lookup = {}, rows = [], conversationThreadId = null }) {
  const normalizedRows = rows.map((row) => ({
    ...row,
    conversation_thread_id: clean(row.conversation_thread_id) || buildConversationThreadId(row),
  }));
  const distinctProspectIds = distinctCleanValues(normalizedRows, "prospect_id", "canonical_prospect_id", "final_prospect_id");
  const distinctPropertyIds = distinctCleanValues(normalizedRows, "property_id", "final_property_id");
  const distinctOwnerIds = distinctCleanValues(normalizedRows, "master_owner_id", "owner_id", "final_master_owner_id");
  const distinctThreadIds = distinctCleanValues(normalizedRows, "conversation_thread_id");
  const explicitThreadIds = distinctCleanValues(rows.filter((row) => row.conversation_thread_id_explicit === true), "conversation_thread_id");
  const audit = {
    thread_key: lookup.legacyThreadKey || lookup.selectedThreadKey || null,
    conversation_thread_id: conversationThreadId || null,
    prospect_id: lookup.prospectId || null,
    property_id: lookup.propertyId || null,
    master_owner_id: lookup.masterOwnerId || lookup.ownerId || null,
    normalized_phone: getLookupNormalizedPhone(lookup) || null,
    messages_returned: rows.length,
    distinct_prospect_ids: distinctProspectIds,
    distinct_property_ids: distinctPropertyIds,
    distinct_owner_ids: distinctOwnerIds,
    distinct_thread_ids: distinctThreadIds,
    explicit_thread_ids: explicitThreadIds,
    distinct_counts: {
      prospect_ids: distinctProspectIds.length,
      property_ids: distinctPropertyIds.length,
      owner_ids: distinctOwnerIds.length,
      thread_ids: distinctThreadIds.length,
      explicit_thread_ids: explicitThreadIds.length,
    },
  };
  audit.integrity_blocked =
    distinctProspectIds.length > 1 ||
    distinctPropertyIds.length > 1 ||
    distinctOwnerIds.length > 1 ||
    explicitThreadIds.length > 1;
  return audit;
}

function applyPhoneAnyFilter(query, normalizedPhone) {
  const { orClause } = buildPhoneAnyFilter(normalizedPhone);
  return orClause && typeof query.or === "function" ? query.or(orClause) : query;
}

function buildPhoneAnyFilter(normalizedPhone) {
  const phoneVariants = buildPhoneVariants(normalizedPhone);
  const filters = buildColumnValueFilters(["from_phone_number", "to_phone_number", "thread_key"], phoneVariants);
  return {
    phoneVariants,
    filters,
    orClause: buildOrEqualsClause(filters),
  };
}

function buildStrictMessageStrategies(lookup = {}) {
  const normalizedPhone = getLookupNormalizedPhone(lookup);
  const conversationThreadId = buildLookupConversationThreadId(lookup);
  const strategies = [];

  if (lookup.latestMessageId) {
    strategies.push({
      name: "latest_message_id_exact",
      filter: {
        table: "message_events",
        eq: { id: lookup.latestMessageId },
      },
      apply(query) {
        return query.eq("id", lookup.latestMessageId);
      },
    });
  }

  if (lookup.propertyId && normalizedPhone) {
    const phoneFilter = buildPhoneAnyFilter(normalizedPhone);
    strategies.push({
      name: "property_id+normalized_phone",
      filter: {
        table: "message_events",
        eq: { property_id: lookup.propertyId },
        phoneVariants: phoneFilter.phoneVariants,
        or: phoneFilter.orClause,
      },
      apply(query) {
        return applyPhoneAnyFilter(query.eq("property_id", lookup.propertyId), normalizedPhone);
      },
    });
  }

  if ((lookup.masterOwnerId || lookup.ownerId) && normalizedPhone) {
    const ownerId = lookup.masterOwnerId || lookup.ownerId;
    const phoneFilter = buildPhoneAnyFilter(normalizedPhone);
    strategies.push({
      name: "master_owner_id+normalized_phone",
      filter: {
        table: "message_events",
        eq: { master_owner_id: ownerId },
        phoneVariants: phoneFilter.phoneVariants,
        or: phoneFilter.orClause,
      },
      apply(query) {
        return applyPhoneAnyFilter(query.eq("master_owner_id", ownerId), normalizedPhone);
      },
    });
  }

  if (lookup.prospectId && normalizedPhone) {
    const phoneFilter = buildPhoneAnyFilter(normalizedPhone);
    strategies.push({
      name: "prospect_id+normalized_phone",
      filter: {
        table: "message_events",
        eq: { prospect_id: lookup.prospectId },
        phoneVariants: phoneFilter.phoneVariants,
        or: phoneFilter.orClause,
      },
      apply(query) {
        return applyPhoneAnyFilter(query.eq("prospect_id", lookup.prospectId), normalizedPhone);
      },
    });
  }

  // Phone-only fallback: catches message_events rows where property_id/master_owner_id
  // aren't populated. rowConflictsWithLookup (applied in messageMatchesStrictLookup)
  // prevents cross-property bleed for rows that do have conflicting IDs.
  if (normalizedPhone) {
    const phoneFilter = buildPhoneAnyFilter(normalizedPhone);
    strategies.push({
      name: "normalized_phone_fallback",
      filter: {
        table: "message_events",
        phoneVariants: phoneFilter.phoneVariants,
        or: phoneFilter.orClause,
        audit: "phone_only_with_identity_audit",
      },
      apply(query) {
        return applyPhoneAnyFilter(query, normalizedPhone);
      },
    });
  }

  return { strategies, normalizedPhone, conversationThreadId };
}

function messageMatchesStrictLookup(row = {}, lookup = {}, strategyName = "") {
  if (strategyName === "latest_message_id_exact") {
    return clean(row.id || row.message_event_id) === clean(lookup.latestMessageId);
  }

  const rowConversationThreadId = clean(row.conversation_thread_id) || buildConversationThreadId(row);
  const lookupConversationThreadId = buildLookupConversationThreadId(lookup);
  if (strategyName === "conversation_thread_id") {
    return Boolean(rowConversationThreadId && lookupConversationThreadId && rowConversationThreadId === lookupConversationThreadId && !rowConflictsWithLookup(row, lookup));
  }

  const normalizedPhone = getLookupNormalizedPhone(lookup);
  const rowPhones = new Set(buildPhoneVariants(
    row.normalized_phone,
    row.canonical_e164,
    row.phone_e164,
    row.seller_phone,
    row.from_phone_number,
    row.to_phone_number,
    row.thread_key,
  ));
  const hasPhone = normalizedPhone && buildPhoneVariants(normalizedPhone).some((phone) => rowPhones.has(phone));
  if (!hasPhone) return false;
  if (rowConflictsWithLookup(row, lookup)) return false;

  if (strategyName === "prospect_id+normalized_phone") {
    return clean(row.prospect_id || row.canonical_prospect_id) === clean(lookup.prospectId);
  }
  if (strategyName === "property_id+normalized_phone") {
    return clean(row.property_id || row.final_property_id) === clean(lookup.propertyId);
  }
  if (strategyName === "master_owner_id+normalized_phone") {
    return clean(row.master_owner_id || row.owner_id || row.final_master_owner_id) === clean(lookup.masterOwnerId || lookup.ownerId);
  }
  if (strategyName === "normalized_phone_unlinked") return true;
  if (strategyName === "normalized_phone_fallback") return true;
  return false;
}

function rowConflictsWithLookup(row = {}, lookup = {}) {
  const rowProspectId = clean(row.prospect_id || row.canonical_prospect_id || row.final_prospect_id);
  const rowPropertyId = clean(row.property_id || row.final_property_id);
  const rowOwnerId = clean(row.master_owner_id || row.owner_id || row.final_master_owner_id);
  const lookupProspectId = clean(lookup.prospectId);
  const lookupPropertyId = clean(lookup.propertyId);
  const lookupOwnerId = clean(lookup.masterOwnerId || lookup.ownerId);

  if (lookupProspectId && rowProspectId && rowProspectId !== lookupProspectId) return true;
  if (lookupPropertyId && rowPropertyId && rowPropertyId !== lookupPropertyId) return true;
  if (lookupOwnerId && rowOwnerId && rowOwnerId !== lookupOwnerId) return true;
  return false;
}

function buildLatestPreviewMessageRow({ lookup = {}, previewRow = {}, previewSource = "latest_preview_source" } = {}) {
  const row = object(previewRow);
  const body = firstClean(row.latest_message_body, row.preview, row.message_body);
  if (!body) return null;

  const normalizedPhone = getLookupNormalizedPhone(lookup) || normalizedPhoneForIdentity(row);
  const direction = normalizeDirection(row.latest_message_direction || row.latest_direction || row.direction) || "unknown";
  const timelineAt = firstClean(
    row.latest_message_at,
    row.latest_activity_at,
    row.last_message_at,
    row.event_timestamp,
    row.message_created_at,
    row.created_at,
    row.updated_at,
  ) || new Date().toISOString();
  const latestMessageId = firstClean(
    row.latest_message_id,
    row.latestMessageId,
    row.latest_message_event_id,
    row.latestMessageEventId,
    row.message_event_id,
    object(row.latest_message_event_data).message_event_id,
  );
  const threadIdentity = clean(row.conversation_thread_id) || buildLookupConversationThreadId(lookup) || clean(row.thread_key) || clean(lookup.selectedThreadKey) || normalizedPhone;
  const previewId = latestMessageId || `preview:${threadIdentity || "thread"}:${timelineAt}`;
  const senderPhone = firstClean(row.sender_phone, row.our_number, row.from_phone_number);
  const fromPhone = direction === "inbound" ? normalizedPhone : senderPhone;
  const toPhone = direction === "inbound" ? senderPhone : normalizedPhone;
  const metadata = {
    ...object(row.metadata),
    preview_fallback: true,
    preview_source: previewSource,
    latest_message_source: row.latest_message_source || previewSource,
  };

  const normalized = normalizeMessageRow({
    ...row,
    id: previewId,
    message_event_id: latestMessageId || previewId,
    message_id: latestMessageId || previewId,
    conversation_thread_id: threadIdentity,
    conversation_thread_id_explicit: Boolean(clean(row.conversation_thread_id)),
    thread_key: clean(row.thread_key) || clean(lookup.legacyThreadKey) || normalizedPhone || clean(lookup.selectedThreadKey),
    canonical_thread_key: clean(row.canonical_thread_key) || clean(row.thread_key) || clean(lookup.legacyThreadKey) || normalizedPhone || clean(lookup.selectedThreadKey),
    canonical_e164: normalizedPhone || row.canonical_e164 || null,
    normalized_phone: normalizedPhone || row.normalized_phone || null,
    direction,
    message_body: body,
    body,
    event_timestamp: timelineAt,
    message_created_at: timelineAt,
    created_at: timelineAt,
    sent_at: direction === "outbound" ? firstClean(row.sent_at, row.latest_message_at, timelineAt) : row.sent_at || null,
    delivered_at: firstClean(row.latest_delivered_at, row.delivered_at) || null,
    failed_at: firstClean(row.latest_failed_at, row.failed_at) || null,
    delivery_status: firstClean(row.latest_delivery_status, row.delivery_status, row.queue_status, direction === "inbound" ? "received" : null) || null,
    provider_delivery_status: firstClean(row.latest_provider_delivery_status, row.provider_delivery_status, row.delivery_status) || null,
    provider_status: firstClean(row.latest_provider_delivery_status, row.provider_delivery_status, row.delivery_status) || null,
    failure_reason: firstClean(row.latest_failure_reason, row.failure_reason, row.error_message) || null,
    error_message: firstClean(row.latest_failure_reason, row.failure_reason, row.error_message) || null,
    from_phone_number: fromPhone || row.from_phone_number || null,
    to_phone_number: toPhone || row.to_phone_number || null,
    property_id: clean(lookup.propertyId) || row.property_id || row.final_property_id || null,
    prospect_id: clean(lookup.prospectId) || row.prospect_id || row.final_prospect_id || null,
    master_owner_id: clean(lookup.masterOwnerId || lookup.ownerId) || row.master_owner_id || row.final_master_owner_id || row.owner_id || null,
    source_app: `${previewSource}:latest_preview`,
    latest_message_source: previewSource,
    metadata,
  });

  return {
    ...normalized,
    source_table: previewSource,
    source_app: `${previewSource}:latest_preview`,
    latest_message_source: previewSource,
    preview_fallback: true,
    synthetic_preview: !latestMessageId,
    metadata,
  };
}

function candidateMatchesThreadIdentity(candidate = {}, thread = {}) {
  const threadConversationId = clean(thread.conversation_thread_id) || buildConversationThreadId(thread);
  const candidateConversationId = clean(candidate.conversation_thread_id) || buildConversationThreadId(candidate);
  if (threadConversationId && candidateConversationId && threadConversationId === candidateConversationId) return true;

  const threadPhone = normalizedPhoneForIdentity(thread);
  const candidatePhones = new Set(buildPhoneVariants(
    candidate.normalized_phone,
    candidate.canonical_e164,
    candidate.seller_phone,
    candidate.from_phone_number,
    candidate.to_phone_number,
    candidate.thread_key,
  ));
  const phoneMatches = Boolean(threadPhone && buildPhoneVariants(threadPhone).some((phone) => candidatePhones.has(phone)));
  if (!phoneMatches) return false;

  const threadProspectId = clean(thread.prospect_id || thread.final_prospect_id || thread.canonical_prospect_id);
  const threadPropertyId = clean(thread.property_id || thread.final_property_id || thread.selected_property_id || thread.thread_property_id);
  const threadOwnerId = clean(thread.master_owner_id || thread.final_master_owner_id || thread.owner_id || thread.thread_master_owner_id);
  if (threadProspectId && clean(candidate.prospect_id || candidate.canonical_prospect_id) === threadProspectId) return true;
  if (threadPropertyId && clean(candidate.property_id || candidate.final_property_id) === threadPropertyId) return true;
  if (threadOwnerId && clean(candidate.master_owner_id || candidate.owner_id || candidate.final_master_owner_id) === threadOwnerId) return true;
  return !threadProspectId && !threadPropertyId && !threadOwnerId;
}

async function queryMessageEventsByStrictStrategy({
  supabase,
  lookup,
  strategy,
  offset,
  limit,
  diagnostics,
}) {
  let query = supabase
    .from("message_events")
    .select("*", { count: "exact" });

  query = strategy.apply(query);
  const filterAudit = {
    table: "message_events",
    strategy: strategy.name,
    filters: strategy.filter || null,
    order: [
      { column: "event_timestamp", ascending: false, nullsFirst: false },
      { column: "created_at", ascending: false, nullsFirst: false },
    ],
    range: { from: offset, to: offset + limit - 1 },
  };

  console.log("[THREAD_HYDRATION_MESSAGE_FILTER]", filterAudit);

  if (typeof query.order === "function") {
    query = query.order("event_timestamp", { ascending: false, nullsFirst: false });
    query = query.order("created_at", { ascending: false, nullsFirst: false });
  }

  if (typeof query.range === "function") {
    query = query.range(offset, offset + limit - 1);
  } else if (typeof query.limit === "function") {
    query = query.limit(limit);
  }

  const { data, error, count } = await query;
  if (error) {
    diagnostics.sourceResults.push({
      source: "message_events",
      strategy: strategy.name,
      filter: filterAudit,
      ok: false,
      rows: 0,
      error: error.message || String(error),
    });
    return { rows: [], total: 0, error };
  }

  const rows = dedupeRowsByMessageId(Array.isArray(data) ? data : [])
    .filter((row) => messageMatchesStrictLookup(row, lookup, strategy.name))
    .map((row) => normalizeMessageRow(row))
    .sort((left, right) => (
      asTime(left.event_timestamp || left.message_created_at || left.created_at) -
      asTime(right.event_timestamp || right.message_created_at || right.created_at) ||
      clean(left.id).localeCompare(clean(right.id))
    ));

  diagnostics.sourceResults.push({
    source: "message_events",
    strategy: strategy.name,
    filter: filterAudit,
    ok: true,
    rows: rows.length,
    total: Number.isFinite(Number(count)) ? Number(count) : rows.length,
  });
  return {
    rows,
    total: Number.isFinite(Number(count)) ? Number(count) : rows.length,
    error: null,
  };
}

export async function getThreadMessages(threadLookupInput, { offset = 0, limit = 50 } = {}, deps = {}) {
  const startedAt = nowMs();
  const supabase = deps.supabase || defaultSupabase;
  const baseLookup = normalizeThreadLookupInput(threadLookupInput);
  const parsedConversationId = parseConversationThreadId(baseLookup.conversationThreadId || baseLookup.selectedThreadKey);
  const lookup = {
    ...baseLookup,
    prospectId: baseLookup.prospectId || parsedConversationId.prospectId || null,
    propertyId: baseLookup.propertyId || parsedConversationId.propertyId || null,
    masterOwnerId: baseLookup.masterOwnerId || parsedConversationId.masterOwnerId || null,
    normalizedPhone: baseLookup.normalizedPhone || parsedConversationId.normalizedPhone || null,
    latestMessageId: baseLookup.latestMessageId || null,
  };
  const safeOffset = Math.max(0, Number.parseInt(clean(offset) || "0", 10) || 0);
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(clean(limit) || "50", 10) || 50));
  const { strategies, normalizedPhone, conversationThreadId } = buildStrictMessageStrategies(lookup);
  const diagnostics = {
    selected_thread_key: lookup.selectedThreadKey,
    legacy_thread_key: lookup.legacyThreadKey || null,
    conversation_thread_id: conversationThreadId,
    canonical_thread_key: conversationThreadId || lookup.selectedThreadKey || lookup.canonicalE164 || lookup.phoneE164 || lookup.phone || lookup.bestPhone || lookup.sellerPhone || null,
    canonical_e164: normalizedPhone || lookup.canonicalE164 || lookup.phoneE164 || null,
    normalized_phone: normalizedPhone || null,
    input: {
      thread_key: lookup.selectedThreadKey,
      conversation_thread_id: lookup.conversationThreadId,
      legacy_thread_key: lookup.legacyThreadKey,
      normalized_phone: lookup.normalizedPhone,
      phone_e164: lookup.phoneE164,
      phone: lookup.phone,
      best_phone: lookup.bestPhone,
      seller_phone: lookup.sellerPhone,
      prospect_id: lookup.prospectId,
      property_id: lookup.propertyId,
      master_owner_id: lookup.masterOwnerId,
      owner_id: lookup.ownerId,
      latest_message_id: lookup.latestMessageId,
    },
    lookup_strategy_used: "message_events_fallback_order",
    fallback_used: false,
    strategies_tried: strategies.map((strategy) => strategy.name),
    fallback_order: [
      "latest_message_id_exact",
      "property_id+normalized_phone",
      "master_owner_id+normalized_phone",
      "prospect_id+normalized_phone",
      "normalized_phone_fallback",
      "latest_preview_source_row",
    ],
    sourceResults: [],
  };

  if (strategies.length === 0 && !deps.latestPreviewRow) {
    const audit = auditThreadIdentity({ lookup, rows: [], conversationThreadId });
    const finalDiagnostics = {
      ...diagnostics,
      identityUsed: null,
      sourceUsed: "message_events:empty",
      identities_tried: {
        conversation_thread_id: conversationThreadId,
        normalized_phone: normalizedPhone,
        prospect_ids: lookup.prospectId ? [lookup.prospectId] : [],
        property_ids: lookup.propertyId ? [lookup.propertyId] : [],
        master_owner_ids: lookup.masterOwnerId || lookup.ownerId ? [lookup.masterOwnerId || lookup.ownerId] : [],
      },
      identitiesTried: null,
      threadIdentityAudit: audit,
      message_count: 0,
      total_matched_messages: 0,
      queryMs: elapsedMs(startedAt),
      error_code: "missing_safe_conversation_identity",
    };
    console.warn("[THREAD_IDENTITY_AUDIT]", audit);
    return {
      rows: [],
      total: 0,
      diagnostics: finalDiagnostics,
      threadKey: lookup.selectedThreadKey || null,
      conversationThreadId,
      integrityBlocked: false,
      identityUsed: null,
      sourceUsed: "message_events:empty",
      queryMs: finalDiagnostics.queryMs,
    };
  }

  const strategyResults = [];
  const fetchLimit = safeOffset + safeLimit;
  for (const strategy of strategies) {
    const result = await queryMessageEventsByStrictStrategy({
      supabase,
      lookup,
      strategy,
      offset: 0,
      limit: fetchLimit,
      diagnostics,
    });
    if (result.error) {
      diagnostics.fallback_used = true;
      continue;
    }
    strategyResults.push({ ...result, strategy });
    // Short-circuit: once we have enough rows from a reliable strategy, stop.
    const totalFound = strategyResults.reduce((sum, r) => sum + r.rows.length, 0);
    if (totalFound >= fetchLimit && strategy.name !== "conversation_thread_id") break;
  }

  if (strategyResults.flatMap((r) => r.rows).length === 0 && deps.latestPreviewRow) {
    const previewSource = clean(deps.latestPreviewSource) || clean(deps.previewSource) || "latest_preview_source";
    const previewMessage = buildLatestPreviewMessageRow({
      lookup,
      previewRow: deps.latestPreviewRow,
      previewSource,
    });
    if (previewMessage) {
      strategyResults.push({
        rows: [previewMessage],
        total: 1,
        error: null,
        strategy: { name: "latest_preview_source_row", source: previewSource },
      });
      diagnostics.fallback_used = true;
      diagnostics.preview_fallback_used = true;
      diagnostics.sourceResults.push({
        source: previewSource,
        strategy: "latest_preview_source_row",
        ok: true,
        rows: 1,
        filter: {
          source_row: true,
          latest_message_body: true,
          latest_message_event_id: previewMessage.message_event_id || null,
          thread_key: previewMessage.thread_key || null,
        },
      });
      console.warn("[THREAD_HYDRATION_PREVIEW_ROW_FALLBACK]", {
        source: previewSource,
        thread_key: lookup.selectedThreadKey,
        conversation_thread_id: conversationThreadId,
        latest_message_event_id: previewMessage.message_event_id || null,
        latest_message_at: previewMessage.event_timestamp || previewMessage.message_created_at || null,
      });
    } else {
      diagnostics.sourceResults.push({
        source: previewSource,
        strategy: "latest_preview_source_row",
        ok: true,
        rows: 0,
        skipped: true,
        reason: "preview_source_row_missing_body",
      });
    }
  }

  const mergedRows = dedupeRowsByMessageId(strategyResults.flatMap((result) => result.rows))
    .map((row) => normalizeMessageRow(row))
    .sort((left, right) => (
      asTime(right.event_timestamp || right.message_created_at || right.created_at) -
      asTime(left.event_timestamp || left.message_created_at || left.created_at) ||
      clean(right.id).localeCompare(clean(left.id))
    ));
  const pagedRows = mergedRows
    .slice(safeOffset, safeOffset + safeLimit)
    .sort((left, right) => (
      asTime(left.event_timestamp || left.message_created_at || left.created_at) -
      asTime(right.event_timestamp || right.message_created_at || right.created_at) ||
      clean(left.id).localeCompare(clean(right.id))
    ));
  const rows = pagedRows;
  const total = Math.max(
    mergedRows.length,
    ...strategyResults.map((result) => Number.isFinite(Number(result.total)) ? Number(result.total) : 0),
  );
  const audit = auditThreadIdentity({ lookup, rows, conversationThreadId });
  const identityUsed = strategyResults
    .filter((result) => result.rows.length > 0)
    .map((result) => result.strategy?.name)
    .filter(Boolean)
    .join("+") || null;
  const latestIdExactUsed = strategyResults.some((r) => r.strategy?.name === "latest_message_id_exact" && r.rows.length > 0);
  const previewFallbackUsed = strategyResults.find((r) => r.strategy?.name === "latest_preview_source_row" && r.rows.length > 0);
  const sourceUsed = rows.length > 0
    ? (previewFallbackUsed ? `${previewFallbackUsed.strategy.source || "latest_preview_source"}:latest_preview` : latestIdExactUsed ? "message_events:latest_message_id_exact" : "message_events")
    : "message_events:empty";
  const identitiesTried = {
    conversation_thread_id: conversationThreadId,
    normalized_phone: normalizedPhone,
    prospect_ids: lookup.prospectId ? [lookup.prospectId] : [],
    property_ids: lookup.propertyId ? [lookup.propertyId] : [],
    master_owner_ids: lookup.masterOwnerId || lookup.ownerId ? [lookup.masterOwnerId || lookup.ownerId] : [],
    latest_message_id: lookup.latestMessageId || null,
  };
  const finalDiagnostics = {
    ...diagnostics,
    identityUsed,
    sourceUsed,
    identities_tried: identitiesTried,
    identitiesTried,
    threadIdentityAudit: audit,
    integrity_blocked: audit.integrity_blocked,
    message_count: rows.length,
    total_matched_messages: total,
    strategy_match_counts: Object.fromEntries(strategyResults.map((result) => [result.strategy?.name || "unknown", result.rows.length])),
    queryMs: elapsedMs(startedAt),
  };

  const auditLog = {
    ...audit,
    messages_returned: rows.length,
    distinct_thread_ids: audit.distinct_thread_ids,
  };
  if (audit.integrity_blocked) {
    console.error("[THREAD_IDENTITY_AUDIT]", auditLog);
  } else {
    console.log("[THREAD_IDENTITY_AUDIT]", auditLog);
  }
  console.log("[INBOX_THREAD_MESSAGE_LOOKUP]", finalDiagnostics);

  const fallbackResult = strategyResults.find((r) => r.strategy?.name === "normalized_phone_fallback");
  console.log("[THREAD_HYDRATION_QUERY_AUDIT]", {
    received_thread_key: lookup.selectedThreadKey || null,
    parsed_conversation_thread_id: conversationThreadId || null,
    parsed_prospect_id: lookup.prospectId || null,
    parsed_property_id: lookup.propertyId || null,
    parsed_owner_id: lookup.masterOwnerId || lookup.ownerId || null,
    parsed_phone: normalizedPhone || null,
    query_strategy_used: identityUsed || null,
    messages_found: rows.length,
    fallback_strategy_used: fallbackResult && fallbackResult.rows.length > 0 ? "normalized_phone_fallback" : null,
    fallback_messages_found: fallbackResult?.rows?.length ?? 0,
  });

  if (audit.integrity_blocked) {
    return {
      rows: [],
      total: 0,
      diagnostics: {
        ...finalDiagnostics,
        error_code: "thread_identity_integrity_violation",
        warning: "Multiple prospects/properties/owners/thread IDs matched this selection. Messages were blocked to avoid rendering the wrong thread.",
      },
      threadKey: lookup.selectedThreadKey || null,
      conversationThreadId,
      integrityBlocked: true,
      identityUsed,
      sourceUsed: "message_events:blocked",
      queryMs: finalDiagnostics.queryMs,
    };
  }

  return {
    rows,
    total,
    diagnostics: finalDiagnostics,
    threadKey: lookup.selectedThreadKey || null,
    conversationThreadId,
    integrityBlocked: false,
    identityUsed,
    sourceUsed,
    queryMs: finalDiagnostics.queryMs,
  };
}
