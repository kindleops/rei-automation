import { NextResponse } from "next/server.js";
import { ensureMutationAuth } from "../../_shared.js";
import { supabase, hasSupabaseConfig } from "@/lib/supabase/client.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const SCAN_PAGE_SIZE = 500;
const MAX_SCAN_PAGES = 20;
const STATE_SCAN_PAGE_SIZE = 1000;

function clean(value) {
  return String(value ?? "").trim();
}

function uniq(values = []) {
  return [...new Set(values.map((v) => clean(v)).filter(Boolean))];
}

function asLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(parsed));
}

function asBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return fallback;
  const normalized = clean(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseCursor(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(clean(value), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function encodeCursor(row) {
  return Buffer.from(
    JSON.stringify({
      created_at: row?.created_at || null,
      id: row?.id || null,
    })
  ).toString("base64url");
}

function normalizeDirection(row) {
  const direction = clean(row?.direction).toLowerCase();
  const eventType = clean(row?.event_type).toLowerCase();
  if (direction === "inbound" || row?.received_at || eventType.includes("inbound")) return "inbound";
  if (direction === "outbound" || row?.sent_at || eventType === "outbound_send") return "outbound";
  return direction || "unknown";
}

function normalizeThreadKey(row, direction) {
  return clean(
    row?.thread_key ||
      (direction === "inbound" ? row?.from_phone_number : row?.to_phone_number) ||
      row?.from_phone_number ||
      row?.to_phone_number
  );
}

function normalizeIntentBucket(value) {
  return clean(value).toLowerCase();
}

function isPositiveIntent(intent) {
  const t = normalizeIntentBucket(intent);
  return ["positive", "seller_interested", "interested", "pricing", "asking_price_provided", "appointment", "asks_offer"].includes(t);
}

function isNegativeIntent(intent) {
  const t = normalizeIntentBucket(intent);
  return ["negative", "not_interested", "cold"].includes(t);
}

function isNeedsReviewIntent(intent) {
  const t = normalizeIntentBucket(intent);
  return ["unclear", "other_unclear", "unknown", "needs_review"].includes(t);
}

function parseIso(value) {
  const text = clean(value);
  if (!text) return null;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function computeThreadBucket(thread) {
  if (thread.is_suppressed) return "suppressed";
  if (thread.is_priority) return "priority";
  if (thread.is_new_reply) return "new_replies";
  if (thread.is_needs_review) return "needs_review";
  if (thread.is_follow_up) return "follow_up";
  if (thread.is_cold) return "cold";
  return "all_messages";
}

function passesTab(thread, tab, exclusionReasons) {
  const normalizedTab = clean(tab || "all_messages").toLowerCase();
  if (!normalizedTab || normalizedTab === "all_messages") return true;
  const bucket = computeThreadBucket(thread);
  const ok = bucket === normalizedTab;
  if (!ok) exclusionReasons[bucket] = Number(exclusionReasons[bucket] || 0) + 1;
  return ok;
}

async function fetchThreadStateRows() {
  const rows = [];
  let from = 0;

  while (true) {
    const to = from + STATE_SCAN_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("inbox_thread_state")
      .select("*")
      .order("updated_at", { ascending: false, nullsFirst: false })
      .range(from, to);
    if (error) throw error;
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < STATE_SCAN_PAGE_SIZE) break;
    from += STATE_SCAN_PAGE_SIZE;
  }

  return rows;
}

function buildCountsFromCanonicalRows(rows) {
  const nowMs = Date.now();
  const counts = {
    all_messages: 0,
    new_replies: 0,
    priority: 0,
    needs_review: 0,
    follow_up: 0,
    cold: 0,
    suppressed: 0,
  };

  for (const row of rows) {
    counts.all_messages += 1;

    const latestDirection = normalizeDirection(row);
    const isSuppressed =
      asBool(row?.is_suppressed, false) ||
      asBool(row?.is_opt_out, false) ||
      asBool(row?.is_dnc, false) ||
      normalizeIntentBucket(row?.status) === "suppressed";
    if (isSuppressed) counts.suppressed += 1;

    const isRead = asBool(row?.is_read, false);
    const isArchived = asBool(row?.is_archived, false);
    const isNewReply = latestDirection === "inbound" && !isRead && !isArchived && !isSuppressed;
    if (isNewReply) counts.new_replies += 1;

    const priorityValue = normalizeIntentBucket(row?.priority);
    const aiPriority = normalizeIntentBucket(row?.ai_priority_bucket);
    const isPriority =
      asBool(row?.is_hot_lead, false) ||
      ["high", "urgent"].includes(priorityValue) ||
      ["high", "urgent"].includes(aiPriority) ||
      isPositiveIntent(row?.detected_intent || row?.last_intent);
    if (isPriority) counts.priority += 1;

    const confidence = Number(row?.classification_confidence);
    const hasLowConfidence = Number.isFinite(confidence) ? confidence < 0.6 : false;
    const automationStatus = normalizeIntentBucket(row?.automation_status);
    const nextAction = normalizeIntentBucket(row?.next_action);
    const isNeedsReview =
      hasLowConfidence ||
      isNeedsReviewIntent(row?.detected_intent || row?.last_intent) ||
      ["failed", "review"].includes(automationStatus) ||
      nextAction === "requires_human_review";
    if (isNeedsReview) counts.needs_review += 1;

    const followUpAt = parseIso(row?.follow_up_at);
    const stage = normalizeIntentBucket(row?.stage || row?.current_stage);
    const status = normalizeIntentBucket(row?.status);
    const isFollowUp =
      (followUpAt ? Date.parse(followUpAt) <= nowMs : false) ||
      ["follow_up", "nurture"].includes(stage) ||
      status === "follow_up";
    if (isFollowUp) counts.follow_up += 1;

    const isCold = isNegativeIntent(row?.detected_intent || row?.last_intent) || status === "cold";
    if (isCold) counts.cold += 1;
  }

  return counts;
}

export async function GET(request) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ ok: false, error: "supabase_not_configured" }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const limit = asLimit(searchParams.get("limit"));
  const tab = clean(searchParams.get("tab") || "all_messages").toLowerCase();
  const parsedCursor = parseCursor(searchParams.get("cursor"));

  const diagnostics = {
    raw_events_scanned: 0,
    threads_built: 0,
    inbound_events: 0,
    outbound_events: 0,
    tab,
    exclusion_reasons: {},
    counts_source: "inbox_thread_state",
    count_rows_scanned: 0,
  };

  try {
    const threadsByKey = new Map();
    let page = 0;
    let queryCursor = parsedCursor?.created_at || null;
    let lastRawRow = null;
    let exhausted = false;

    while (threadsByKey.size < limit && page < MAX_SCAN_PAGES && !exhausted) {
      let query = supabase
        .from("message_events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(SCAN_PAGE_SIZE);
      if (queryCursor) query = query.lt("created_at", queryCursor);

      const { data, error } = await query;
      if (error) throw error;

      const rows = Array.isArray(data) ? data : [];
      diagnostics.raw_events_scanned += rows.length;
      if (rows.length === 0) break;

      for (const row of rows) {
        lastRawRow = row;
        const direction = normalizeDirection(row);
        if (direction === "inbound") diagnostics.inbound_events += 1;
        if (direction === "outbound") diagnostics.outbound_events += 1;

        const key = normalizeThreadKey(row, direction);
        if (!key) continue;

        const existing = threadsByKey.get(key);
        if (!existing) {
          threadsByKey.set(key, {
            thread_key: key,
            latest_event_id: row.id || null,
            latest_message_body: row.message_body || "",
            latest_direction: direction,
            latest_at: row.event_timestamp || row.received_at || row.sent_at || row.created_at || null,
            latest_message_at: row.event_timestamp || row.received_at || row.sent_at || row.created_at || null,
            from_phone_number: row.from_phone_number || null,
            to_phone_number: row.to_phone_number || null,
            master_owner_id: row.master_owner_id || null,
            property_id: row.property_id || null,
            prospect_id: row.prospect_id || null,
            is_opt_out: Boolean(row.is_opt_out),
            message_count: 1,
          });
        } else {
          existing.message_count += 1;
        }
      }

      exhausted = rows.length < SCAN_PAGE_SIZE;
      queryCursor = rows[rows.length - 1]?.created_at || null;
      page += 1;
    }

    const threadKeys = [...threadsByKey.keys()];

    const prospectIds = uniq([...threadsByKey.values()].map((t) => t.prospect_id));
    const propertyIds = uniq([...threadsByKey.values()].map((t) => t.property_id));
    const masterOwnerIds = uniq([...threadsByKey.values()].map((t) => t.master_owner_id));

    const [stateRes, prospectRes, propertyRes, aiStateRes, ownerRes] = await Promise.all([
      threadKeys.length
        ? supabase.from("inbox_thread_state").select("*").in("thread_key", threadKeys)
        : Promise.resolve({ data: [], error: null }),
      prospectIds.length ? supabase.from("prospects").select("*").in("prospect_id", prospectIds) : Promise.resolve({ data: [], error: null }),
      propertyIds.length ? supabase.from("properties").select("*").in("property_id", propertyIds) : Promise.resolve({ data: [], error: null }),
      threadKeys.length
        ? supabase.from("thread_ai_state").select("*").in("thread_key", threadKeys)
        : Promise.resolve({ data: [], error: null }),
      masterOwnerIds.length ? supabase.from("master_owners").select("*").in("master_owner_id", masterOwnerIds) : Promise.resolve({ data: [], error: null }),
    ]);

    if (stateRes?.error) throw stateRes.error;
    if (prospectRes?.error) throw prospectRes.error;
    if (propertyRes?.error) throw propertyRes.error;
    if (aiStateRes?.error) throw aiStateRes.error;
    if (ownerRes?.error) throw ownerRes.error;

    const prospects = Array.isArray(prospectRes.data) ? [...prospectRes.data] : [];
    const owners = Array.isArray(ownerRes.data) ? ownerRes.data : [];
    const ownerById = new Map(owners.map((r) => [clean(r.master_owner_id), r]));
    const ownerBestProspectIds = uniq(owners.map((r) => r.best_prospect_id));
    if (ownerBestProspectIds.length > 0) {
      const extraProspects = await supabase.from("prospects").select("*").in("prospect_id", ownerBestProspectIds);
      if (!extraProspects.error && Array.isArray(extraProspects.data)) {
        prospects.push(...extraProspects.data);
      }
    }

    const unresolvedProspectIds = prospectIds.filter((id) => !prospects.some((p) => clean(p.prospect_id) === id));
    if (unresolvedProspectIds.length > 0) {
      const byIdRes = await supabase.from("prospects").select("*").in("id", unresolvedProspectIds);
      if (!byIdRes.error && Array.isArray(byIdRes.data)) prospects.push(...byIdRes.data);
    }

    const properties = Array.isArray(propertyRes.data) ? [...propertyRes.data] : [];
    const unresolvedPropertyIds = propertyIds.filter((id) => !properties.some((p) => clean(p.property_id) === id));
    if (unresolvedPropertyIds.length > 0) {
      const byIdRes = await supabase.from("properties").select("*").in("id", unresolvedPropertyIds);
      if (!byIdRes.error && Array.isArray(byIdRes.data)) properties.push(...byIdRes.data);
    }

    const stateByThreadKey = new Map((stateRes.data || []).map((r) => [clean(r.thread_key), r]));
    const aiByThreadKey = new Map((aiStateRes.data || []).map((r) => [clean(r.thread_key), r]));
    const prospectsById = new Map(
      prospects.flatMap((r) => {
        const keys = uniq([r.prospect_id, r.id]);
        return keys.map((k) => [k, r]);
      })
    );
    const propertiesById = new Map(
      properties.flatMap((r) => {
        const keys = uniq([r.property_id, r.id]);
        return keys.map((k) => [k, r]);
      })
    );

    let threads = [...threadsByKey.values()].map((thread) => {
      const state = stateByThreadKey.get(clean(thread.thread_key)) || {};
      const ai = aiByThreadKey.get(clean(thread.thread_key)) || {};
      const owner = ownerById.get(clean(thread.master_owner_id)) || null;
      const resolvedProspectId = clean(thread.prospect_id || state.prospect_id || owner?.best_prospect_id);
      const prospect = prospectsById.get(resolvedProspectId) || null;
      const property = propertiesById.get(clean(thread.property_id)) || null;
      const detectedIntent = clean(state.detected_intent || state.last_intent || ai.detected_intent || ai.last_intent || "");
      const latestDirection = normalizeDirection({ ...thread, direction: thread.latest_direction });
      const isSuppressed =
        asBool(state.is_suppressed, false) ||
        asBool(state.is_opt_out, false) ||
        asBool(state.is_dnc, false) ||
        asBool(thread.is_opt_out, false);
      const isRead = asBool(state.is_read, false);
      const isArchived = asBool(state.is_archived, false);
      const classificationConfidence = Number(state.classification_confidence ?? ai.confidence_score ?? null);
      const isLowConfidence = Number.isFinite(classificationConfidence) ? classificationConfidence < 0.6 : false;
      const stage = clean(state.stage || state.current_stage || ai.current_stage || "");
      const status = clean(state.status || "");
      const priority = clean(state.priority || "");
      const aiPriorityBucket = clean(ai.ai_priority_bucket || state.ai_priority_bucket || "");
      const followUpAt = parseIso(state.follow_up_at || ai.follow_up_at);
      const nowMs = Date.now();

      const isNewReply = latestDirection === "inbound" && !isRead && !isArchived && !isSuppressed;
      const isPriority =
        asBool(state.is_hot_lead, false) ||
        ["high", "urgent"].includes(priority.toLowerCase()) ||
        ["high", "urgent"].includes(aiPriorityBucket.toLowerCase()) ||
        isPositiveIntent(detectedIntent);
      const isNeedsReview =
        isLowConfidence ||
        isNeedsReviewIntent(detectedIntent) ||
        ["failed", "review"].includes(clean(state.automation_status).toLowerCase()) ||
        clean(state.next_action).toLowerCase() === "requires_human_review";
      const isFollowUp =
        (followUpAt ? Date.parse(followUpAt) <= nowMs : false) ||
        ["follow_up", "nurture"].includes(stage.toLowerCase()) ||
        status.toLowerCase() === "follow_up";
      const isCold = isNegativeIntent(detectedIntent) || status.toLowerCase() === "cold";

      return {
        ...thread,
        prospect_id: resolvedProspectId || thread.prospect_id || null,
        prospect_full_name: prospect?.full_name || null,
        prospect_first_name: prospect?.first_name || null,
        property_address_full: property?.property_address_full || null,
        property_address_city: property?.property_address_city || null,
        property_address_state: property?.property_address_state || null,
        property_address_zip: property?.property_address_zip || null,
        property_type: property?.property_type || null,
        property_asset_class: property?.property_class || null,
        current_stage: stage || null,
        detected_intent: detectedIntent || null,
        status_bucket: status || null,
        is_read: isRead,
        is_archived: isArchived,
        is_suppressed: isSuppressed,
        follow_up_at: followUpAt,
        ai_priority_bucket: aiPriorityBucket || null,
        classification_confidence: Number.isFinite(classificationConfidence) ? classificationConfidence : null,
        is_priority: isPriority,
        is_new_reply: isNewReply,
        is_needs_review: isNeedsReview,
        is_follow_up: isFollowUp,
        is_cold: isCold,
      };
    });

    threads = threads
      .filter((thread) => passesTab(thread, tab, diagnostics.exclusion_reasons))
      .sort((a, b) => new Date(b.latest_at || 0).getTime() - new Date(a.latest_at || 0).getTime());

    threads = threads.slice(0, limit);
    diagnostics.threads_built = threads.length;

    const canonicalCountRows = await fetchThreadStateRows();
    diagnostics.count_rows_scanned = canonicalCountRows.length;
    const counts = buildCountsFromCanonicalRows(canonicalCountRows);

    const next_cursor = lastRawRow ? encodeCursor(lastRawRow) : null;
    return NextResponse.json(
      {
        ok: true,
        threads,
        counts,
        next_cursor,
        diagnostics,
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: "inbox_threads_failed",
        message: error?.message || "Unknown inbox threads error",
        threads: [],
        counts: null,
        next_cursor: null,
        diagnostics,
      },
      { status: 500 }
    );
  }
}
