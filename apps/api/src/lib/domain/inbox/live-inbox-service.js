import { supabase as defaultSupabase, hasSupabaseConfig } from "@/lib/supabase/client.js";
import { classifyInboxMessage, findMatchedKeywords, KEYWORD_GROUPS } from "@/lib/domain/inbox/keywords.js";
import { getDealContextCounts, listDealContexts } from "@/lib/domain/deal-context/deal-context-service.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clean(value) { return String(value ?? "").trim(); }
function lower(value) { return clean(value).toLowerCase(); }
function int(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), MAX_LIMIT) : fallback; }
function bool(value) { return ["1", "true", "yes", "on"].includes(lower(value)); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function asTime(value) { const t = new Date(value || 0).getTime(); return Number.isFinite(t) ? t : 0; }
function latestAt(row = {}) { return row.latest_activity_at || row.event_timestamp || row.received_at || row.sent_at || row.created_at || row.updated_at || null; }
function cursorFor(row = {}) { return Buffer.from(JSON.stringify({ t: latestAt(row), id: row.id || row.message_event_key || row.provider_message_sid || "" })).toString("base64url"); }
function parseCursor(cursor) { try { return JSON.parse(Buffer.from(clean(cursor), "base64url").toString("utf8")); } catch { return null; } }
function normalizeDirection(value) { const d = lower(value); if (d.startsWith("in")) return "inbound"; if (d.startsWith("out")) return "outbound"; return d || null; }
function msgId(row) { return row.id || row.message_event_key || row.provider_message_sid || row.provider_message_id || null; }
function threadKey(row = {}) {
  const meta = object(row.metadata);
  const enrichment = object(meta.enrichment);
  if (row.thread_key || enrichment.thread_key) return row.thread_key || enrichment.thread_key;
  const phones = [row.from_phone_number, row.to_phone_number].map(clean).filter(Boolean).sort().join(":");
  return [row.property_id || row.master_owner_id || "unknown", phones || "no_phone"].join(":");
}
function displayName(row = {}) { return row.seller_display_name || object(row.metadata)?.enrichment?.seller_name || object(row.metadata)?.seller_display_name || null; }

export function applyInboxRowComputedFields(row = {}, query = {}) {
  const keywordGroups = [];
  if (query.keyword_group && KEYWORD_GROUPS[lower(query.keyword_group)]) keywordGroups.push(lower(query.keyword_group));
  const searchTerms = clean(query.q) ? clean(query.q).split(/\s+/).filter(Boolean) : [];
  const groupMatches = keywordGroups.length ? findMatchedKeywords(row.message_body || "", keywordGroups) : [];
  const searchMatches = searchTerms.length ? findMatchedKeywords(row.message_body || "", searchTerms) : [];
  const flags = classifyInboxMessage(row);
  return {
    ...row,
    id: msgId(row),
    direction: normalizeDirection(row.direction),
    thread_key: threadKey(row),
    latest_activity_at: latestAt(row),
    seller_display_name: displayName(row),
    property_address: row.property_address || object(row.metadata)?.enrichment?.property_address || null,
    market: row.market || object(row.metadata)?.enrichment?.market || null,
    flags,
    matched_keywords: [...new Set([...flags.matched_keywords, ...groupMatches.map((m) => m.term), ...searchMatches.map((m) => m.term)])],
    highlight_ranges: [...groupMatches, ...searchMatches].map(({ start, end, term }) => ({ start, end, term })),
  };
}

function rowMatchesFilter(row = {}, filter = "all") {
  const f = lower(filter) || "all";
  const bucket = lower(row.inbox_bucket || 'all');
  const status = lower(row.universal_status || '');

  if (f === "dead") return bucket === "dead" || status === "dead";
  if (f === "cold") return bucket === "cold" && status !== "dead";

  if (bucket === f) return true; // Direct match on real Supabase deal_thread_state / operator_thread_state
  if (f === "all") return true;

  const dir = normalizeDirection(row.direction);

  // Strict aliases mapped to canonical inbox buckets
  if (f === "inbound_only") return dir === "inbound";
  if (f === "outbound_only") return dir === "outbound";
  if (f === "needs_reply") return bucket === "new_replies";
  if (f === "positive_hot") return bucket === "priority";
  if (f === "wrong_number") return bucket === "dead" || status === "dead";
  if (f === "opt_out" || f === "dnc_opt_out") return bucket === "suppressed";
  if (f === "missing_context") return !row.property_id && !row.master_owner_id && !object(row.metadata)?.enrichment?.property_id;
  if (f === "manual_review") return bucket === "needs_review";
  if (f === "waiting" || f === "outbound_active") return bucket === "waiting_on_seller" || (dir === "outbound" && bucket !== "suppressed" && bucket !== "dead" && status !== "dead");
  if (f === "follow_up_due") return bucket === "follow_up";
  
  return false;
}

function buildThreads(messages = []) {
  const byThread = new Map();
  for (const message of messages) {
    const key = message.thread_key;
    const existing = byThread.get(key) || { thread_key: key, messages: [], message_count: 0 };
    existing.messages.push(message.id);
    existing.message_count += 1;
    if (!existing.latest_activity_at || asTime(message.latest_activity_at) > asTime(existing.latest_activity_at)) {
      Object.assign(existing, {
        latest_activity_at: message.latest_activity_at,
        latest_message_direction: message.direction,
        latest_message_body: message.message_body || null,
        property_id: message.property_id || existing.property_id || null,
        master_owner_id: message.master_owner_id || existing.master_owner_id || null,
        seller_display_name: message.seller_display_name || existing.seller_display_name || null,
        property_address: message.property_address || existing.property_address || null,
        market: message.market || existing.market || null,
        needs_reply: rowMatchesFilter(message, "needs_reply"),
        positive_hot: Boolean(message.flags?.positive_hot || existing.positive_hot),
        auto_reply_status: message.auto_reply_status || existing.auto_reply_status || null,
        inbox_bucket: message.inbox_bucket || existing.inbox_bucket || null,
        review_status: message.review_status || existing.review_status || null,
        conversation_stage: message.conversation_stage || existing.conversation_stage || null,
        seller_stage: message.seller_stage || existing.seller_stage || null,
        lead_temperature: message.lead_temperature || existing.lead_temperature || null,
      });
    }
    byThread.set(key, existing);
  }
  return [...byThread.values()].sort((a, b) => asTime(b.latest_activity_at) - asTime(a.latest_activity_at));
}

function buildCounts(rows = []) {
  const counts = { all: rows.length, inbound_only: 0, outbound_only: 0, needs_reply: 0, auto_replied: 0, auto_reply_failed: 0, positive_hot: 0, offer_requested: 0, wrong_number: 0, opt_out: 0, missing_context: 0, manual_review: 0 };
  for (const row of rows) for (const key of Object.keys(counts)) if (key !== "all" && rowMatchesFilter(row, key)) counts[key] += 1;
  return counts;
}

async function loadMapPins(supabase, query, filteredRows = []) {
  const filteredPropertyIds = [...new Set(filteredRows.map((r) => r.property_id).filter(Boolean))];
  let q = supabase.from("properties").select("id,property_id,latitude,longitude,address,property_address,market,lead_status,stage,seller_name,master_owner_id").not("latitude", "is", null).not("longitude", "is", null).limit(10000);
  if (bool(query.filtered_pins) && filteredPropertyIds.length) q = q.in("id", filteredPropertyIds);
  const { data, error } = await q;
  if (error) return [];
  const latestByProperty = new Map();
  for (const row of filteredRows) if (row.property_id && (!latestByProperty.has(String(row.property_id)) || asTime(row.latest_activity_at) > asTime(latestByProperty.get(String(row.property_id)).latest_activity_at))) latestByProperty.set(String(row.property_id), row);
  return (Array.isArray(data) ? data : []).map((p) => {
    const id = p.id || p.property_id;
    const latest = latestByProperty.get(String(id)) || {};
    return { property_id: id, thread_key: latest.thread_key || null, latitude: Number(p.latitude), longitude: Number(p.longitude), address: p.address || p.property_address, market: p.market || latest.market || null, seller_name: p.seller_name || latest.seller_display_name || null, lead_status: p.lead_status || p.stage || null, stage: p.stage || latest.stage_after || latest.stage_before || null, latest_message_direction: latest.direction || null, latest_message_at: latest.latest_activity_at || null, needs_reply: latest.id ? rowMatchesFilter(latest, "needs_reply") : false, positive_hot: Boolean(latest.flags?.positive_hot), auto_reply_status: latest.auto_reply_status || null };
  });
}

export async function getLiveInbox(params = {}, deps = {}) {
  if (!deps.supabase && !hasSupabaseConfig()) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  const limit = int(params.limit, DEFAULT_LIMIT);
  const wantsMap = bool(params.map);
  const filter = lower(params.inbox_bucket || params.filter || "all");
  const offset = int(params.offset, 0);

  const dealContextParams = {
    limit,
    offset,
    q: clean(params.q),
    order_by: 'latest_message_at',
  };

  const canonicalBuckets = ["new_replies", "priority", "needs_review", "follow_up", "cold", "dead", "suppressed"];
  if (canonicalBuckets.includes(filter)) {
    dealContextParams.inbox_bucket = filter;
  }
  if (filter === "dnc_opt_out") {
    dealContextParams.inbox_bucket = "suppressed";
  }
  if (filter === "unlinked") {
    dealContextParams.context_type = "unlinked_thread";
  }
  if (filter === "all" || filter === "all_messages") {
    delete dealContextParams.inbox_bucket;
  }
  if (lower(params.direction) === "inbound") {
    dealContextParams.latest_message_direction = "inbound";
  }
  if (lower(params.direction) === "outbound") {
    dealContextParams.latest_message_direction = "outbound";
  }

  const [contexts, counts] = await Promise.all([
    listDealContexts(dealContextParams, deps),
    getDealContextCounts({}, deps),
  ]);

  let rows = (contexts.rows || []).map((row) => ({
    ...row,
    id: row.deal_context_id,
    latest_activity_at: row.latest_message_at || row.updated_at || row.created_at || null,
    latest_direction: row.latest_message_direction || null,
    direction: row.latest_message_direction || null,
    
    // Use the resolved phones from listDealContexts if available, or row values
    seller_phone: row.seller_phone || null,
    sender_phone: row.sender_phone || null,
    
    phone: row.seller_phone || null,
    best_phone: row.seller_phone || null,
    our_number: row.sender_phone || null,
    
    owner_name: row.owner_name || null,
    prospect_full_name: row.full_name || row.prospect_name || object(row.prospect_data).full_name || null,
    prospect_name: row.full_name || row.prospect_name || object(row.prospect_data).full_name || null,
    property_address: row.property_address_full || null,
    market_name: row.market || null,
    conversation_stage: row.universal_stage || null,
    seller_stage: row.universal_stage || null,
    queue_stage: row.universal_stage || null,
    workflow_stage: row.universal_stage || null,
    review_status: row.universal_status || null,
    auto_reply_status: row.queue_status || null,
    failure_reason: object(row.queue_data).failed_reason || null,
    latest_intent: row.reply_intent || object(row.thread_state_data).reply_intent || null,
    final_acquisition_score: row.final_acquisition_score || row.priority_score || null,
    priority_score: row.priority_score || null,
    lat: row.latitude || null,
    lng: row.longitude || null,
  }));

  if (params.keyword_group) {
    rows = rows.filter((row) => findMatchedKeywords(row.latest_message_body || "", [params.keyword_group]).length > 0);
  }

  rows = rows
    .map((row) => applyInboxRowComputedFields(row, params))
    .filter((row) => rowMatchesFilter(row, filter))
    .sort((a, b) => asTime(b.latest_activity_at) - asTime(a.latest_activity_at));

  const mapPins = wantsMap
    ? rows
        .filter((row) => Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude)))
        .map((row) => ({
          id: row.deal_context_id,
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
    threads: rows,
    messages: [],
    counts: {
      all: counts.total || 0,
      all_messages: counts.total || 0,
      priority: counts.by_inbox_bucket?.priority || 0,
      new_replies: counts.by_inbox_bucket?.new_replies || 0,
      needs_review: counts.by_inbox_bucket?.needs_review || 0,
      follow_up: counts.by_inbox_bucket?.follow_up || 0,
      cold: counts.by_inbox_bucket?.cold || 0,
      dead: counts.by_inbox_bucket?.dead || 0,
      suppressed: counts.by_inbox_bucket?.suppressed || 0,
      unlinked: counts.by_context_type?.unlinked_thread || 0,
    },
    mapPins,
    pagination: {
      limit,
      returned: rows.length,
      has_more: contexts.pagination?.has_more || false,
      next_cursor: contexts.pagination?.next_offset != null ? String(contexts.pagination.next_offset) : null,
    },
  };
}
