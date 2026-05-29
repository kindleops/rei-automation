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
function normalizeDirection(value) { const d = lower(value); if (d.startsWith("in")) return "inbound"; if (d.startsWith("out")) return "outbound"; return d || null; }
function msgId(row) { return row.id || row.message_event_key || row.provider_message_sid || row.provider_message_id || null; }
function displayName(row = {}) { return row.seller_display_name || object(row.metadata)?.enrichment?.seller_name || object(row.metadata)?.seller_display_name || null; }
// E.164: +<7–15 digits>
function isE164(value) { return typeof value === 'string' && /^\+\d{7,15}$/.test(value.trim()); }

// Direction-aware phone resolver.
// Primary invariant: thread_key IS the seller's canonical phone when it is E.164.
// Never reads deal_thread_state.best_phone (stores our TextGrid number, not the seller).
// Prefers latestMsg.raw_event over deal_context_index.latest_message_event_data to avoid
// direction/event mismatch when the stored event is outbound but latestMsg is inbound.
function resolvePhones(thread, latestMsg, queueData, msgEventData, phoneData, prospectData, masterOwnerData) {
  const qMeta = object(queueData?.metadata);
  const eMeta = object(msgEventData?.metadata);
  const direction = normalizeDirection(
    latestMsg?.direction || thread.latest_message_direction || 'outbound'
  );
  const isInbound = direction === 'inbound';

  if (isE164(thread.thread_key)) {
    // Invariant: thread_key is the seller phone — no message data can override it.
    const seller_phone = thread.thread_key;
    const our_raw = isInbound
      ? (msgEventData?.to_phone_number || queueData?.from_phone_number || qMeta?.selected_textgrid_number || null)
      : (queueData?.from_phone_number || msgEventData?.from_phone_number || qMeta?.selected_textgrid_number || eMeta?.send_result?.from || null);
    const our_number = (our_raw && our_raw !== seller_phone) ? our_raw : null;
    return { seller_phone, our_number, direction, source: 'thread_key_e164' };
  }

  // Non-E.164 thread key: direction-based resolution
  let seller_phone, our_number;
  if (isInbound) {
    seller_phone =
      msgEventData?.from_phone_number ||
      thread.canonical_e164 ||
      thread.thread_key ||
      queueData?.to_phone_number ||
      phoneData?.canonical_e164 ||
      phoneData?.phone ||
      prospectData?.best_phone ||
      masterOwnerData?.best_phone_1 ||
      null;
    our_number =
      msgEventData?.to_phone_number ||
      queueData?.from_phone_number ||
      qMeta?.selected_textgrid_number ||
      null;
  } else {
    seller_phone =
      thread.canonical_e164 ||
      thread.thread_key ||
      queueData?.to_phone_number ||
      msgEventData?.to_phone_number ||
      phoneData?.canonical_e164 ||
      phoneData?.phone ||
      prospectData?.best_phone ||
      masterOwnerData?.best_phone_1 ||
      null;
    our_number =
      queueData?.from_phone_number ||
      msgEventData?.from_phone_number ||
      qMeta?.selected_textgrid_number ||
      eMeta?.send_result?.from ||
      null;
  }

  if (our_number && our_number === seller_phone) our_number = null;
  return { seller_phone: seller_phone || null, our_number: our_number || null, direction, source: 'direction_based' };
}

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
    latest_activity_at: latestAt(row),
    seller_display_name: displayName(row),
    property_address: row.property_address || object(row.metadata)?.enrichment?.property_address || null,
    market: row.market || object(row.metadata)?.enrichment?.market || null,
    flags,
    matched_keywords: [...new Set([...flags.matched_keywords, ...groupMatches.map((m) => m.term), ...searchMatches.map((m) => m.term)])],
    highlight_ranges: [...groupMatches, ...searchMatches].map(({ start, end, term }) => ({ start, end, term })),
  };
}

export function classifyThread(thread, latestMessage) {
  let bucket = lower(thread.inbox_bucket);
  let status = lower(thread.universal_status);
  let opt_out = Boolean(thread.opt_out);
  let wrong_number = Boolean(thread.wrong_number);
  let not_interested = Boolean(thread.not_interested);
  let needs_review = Boolean(thread.needs_review);

  if (latestMessage) {
    const is_inbound = latestMessage.direction === 'inbound';
    const body = latestMessage.message_body || '';
    const flags = classifyInboxMessage(latestMessage.raw_event || { message_body: body });

    if (is_inbound) {
      if (flags.opt_out) {
        opt_out = true;
      }
      if (flags.wrong_number) {
        wrong_number = true;
      }
      if (flags.manual_review) {
        needs_review = true;
      }

      if (!opt_out && !wrong_number) {
        if (flags.positive_hot || flags.offer_requested) {
          bucket = 'priority';
        } else if (needs_review) {
          bucket = 'needs_review';
        } else {
          bucket = 'new_replies';
        }
      }
    } else {
      if (bucket === 'new_replies' || bucket === 'priority' || bucket === 'needs_review') {
        bucket = 'follow_up';
      }
    }
  }

  if (opt_out || bucket === 'suppressed' || status === 'suppressed') {
    return 'suppressed';
  }
  if (wrong_number || not_interested || bucket === 'dead' || status === 'dead') {
    return 'dead';
  }
  if (bucket === 'priority') {
    return 'priority';
  }
  if (bucket === 'new_replies') {
    return 'new_replies';
  }
  if (bucket === 'needs_review' || needs_review) {
    return 'needs_review';
  }
  if (bucket === 'follow_up' || bucket === 'waiting_on_seller') {
    return 'follow_up';
  }
  return 'cold';
}

export async function getLiveCounts(params = {}, deps = {}) {
  // getDealContextCounts uses head:true exact queries — avoids Supabase's 1000-row default cap
  const raw = await getDealContextCounts(params, deps);
  const b = raw.by_inbox_bucket || {};
  const counts = {
    priority: b.priority ?? 0,
    new_replies: b.new_replies ?? 0,
    needs_review: b.needs_review ?? 0,
    follow_up: b.follow_up ?? 0,
    cold: b.cold ?? 0,
    dead: b.dead ?? 0,
    suppressed: b.suppressed ?? 0,
    all: raw.all ?? 0,
    all_messages: raw.all_messages ?? 0,
    unlinked: raw.by_context_type?.unlinked_thread ?? 0,
  };
  console.log('[INBOX_COUNTS_UPDATED]', counts);
  return counts;
}

export async function getLiveInbox(params = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const limit = int(params.limit, DEFAULT_LIMIT);
  const filter = lower(params.inbox_bucket || params.filter || "all");
  const wantsMap = bool(params.map);

  let cursor = params.cursor || null;
  let offset = int(params.offset || params.skip, 0);

  let cursorKeyset = null;
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (parsed && parsed.latest_message_at && parsed.thread_key) {
        cursorKeyset = parsed;
      }
    } catch (e) {
      const num = Number(cursor);
      if (Number.isFinite(num) && num >= 0) {
        offset = num;
      }
    }
  }

  let query = supabase.from('deal_thread_state').select('*', { count: 'exact' });

  if (params.direction && params.direction !== 'all') {
    if (typeof query.eq === 'function') {
      if (typeof query.or === 'function') {
        query = query.eq('latest_message_direction', params.direction);
      } else {
        query = query.eq('direction', params.direction);
      }
    }
  }

  if (filter === 'dead' && typeof query.or === 'function') {
    query = query.or('inbox_bucket.eq.dead,universal_status.eq.dead,wrong_number.eq.true,not_interested.eq.true');
  } else if ((filter === 'suppressed' || filter === 'dnc_opt_out' || filter === 'opt_out') && typeof query.or === 'function') {
    query = query.or('inbox_bucket.eq.suppressed,universal_status.eq.suppressed,opt_out.eq.true');
  } else if (filter === 'priority' || filter === 'positive_hot') {
    query = query.eq('inbox_bucket', 'priority');
  } else if (filter === 'new_replies' || filter === 'needs_reply') {
    query = query.eq('inbox_bucket', 'new_replies');
  } else if ((filter === 'needs_review' || filter === 'manual_review') && typeof query.or === 'function') {
    query = query.or('inbox_bucket.eq.needs_review,needs_review.eq.true');
  } else if ((filter === 'follow_up' || filter === 'waiting' || filter === 'outbound_active') && typeof query.or === 'function') {
    query = query.or('inbox_bucket.eq.follow_up,inbox_bucket.eq.waiting_on_seller');
  } else if (filter === 'cold') {
    query = query.eq('inbox_bucket', 'cold');
    if (typeof query.neq === 'function') {
      query = query.neq('universal_status', 'dead')
        .eq('wrong_number', false)
        .eq('opt_out', false)
        .eq('not_interested', false);
    }
  } else if (filter === 'unlinked' && typeof query.is === 'function') {
    query = query.is('property_id', null);
  }

  if (params.q) {
    const qStr = `%${params.q.trim()}%`;
    let contextQuery = supabase.from('deal_context_index').select('thread_key');
    let matchedContexts = null;
    
    if (typeof contextQuery.or === 'function') {
      const res = await contextQuery
        .or(`property_address_full.ilike.${qStr},owner_name.ilike.${qStr},thread_key.ilike.${qStr},canonical_e164.ilike.${qStr}`)
        .limit(500);
      matchedContexts = res.data;
    } else {
      const res = await contextQuery.limit(500);
      matchedContexts = res.data;
    }
    
    const matchedThreadKeys = matchedContexts ? [...new Set(matchedContexts.map(c => c.thread_key).filter(Boolean))] : [];
    
    if (matchedThreadKeys.length > 0 && typeof query.or === 'function') {
      const threadKeyList = matchedThreadKeys.map(k => `"${k}"`).join(',');
      query = query.or(`thread_key.in.(${threadKeyList}),latest_message_body.ilike.${qStr},best_phone.ilike.${qStr}`);
    } else {
      if (typeof query.or === 'function') {
        query = query.or(`thread_key.ilike.${qStr},latest_message_body.ilike.${qStr},best_phone.ilike.${qStr}`);
      } else if (typeof query.ilike === 'function') {
        query = query.ilike('message_body', qStr);
      }
    }
  }

  if (typeof query.order === 'function') {
    query = query.order('latest_message_at', { ascending: false, nullsFirst: false });
    query = query.order('thread_key', { ascending: false });
  }

  if (cursorKeyset && typeof query.or === 'function') {
    query = query.or(`latest_message_at.lt.${cursorKeyset.latest_message_at},and(latest_message_at.eq.${cursorKeyset.latest_message_at},thread_key.lt."${cursorKeyset.thread_key}")`);
    query = query.limit(limit + 1);
  } else if (offset > 0 && typeof query.range === 'function') {
    query = query.range(offset, offset + limit);
  } else {
    if (typeof query.range === 'function') {
      query = query.range(0, limit);
    } else if (typeof query.limit === 'function') {
      query = query.limit(limit + 1);
    }
  }

  // Fire counts in parallel with the main thread query — they're independent.
  const countsPromise = getLiveCounts({}, deps);

  const { data: baseThreads, error: threadsError, count } = await query;
  if (threadsError) throw threadsError;

  const hasMore = baseThreads && baseThreads.length > limit;
  const slicedThreads = hasMore ? baseThreads.slice(0, limit) : (baseThreads || []);

  const threadKeys = (slicedThreads || []).map(t => t.thread_key).filter(Boolean);

  let events = [];
  let queue = [];
  let contextData = [];

  if (threadKeys.length > 0) {
    // Narrow columns — only what enrichment actually reads. Full message history
    // belongs in the thread messages endpoint, not the list view.
    const EVENT_COLS = 'id,thread_key,direction,message_body,event_timestamp,received_at,sent_at,created_at,from_phone_number,to_phone_number,property_id,master_owner_id,metadata,queue_id';
    const QUEUE_COLS = 'id,thread_key,queue_status,sent_at,delivered_at,scheduled_for,created_at,message_body,message_text,rendered_message,property_id,master_owner_id,metadata,from_phone_number,to_phone_number,seller_display_name,seller_first_name,market,property_address,failed_reason';
    // Cap: 5 rows per thread is sufficient to find the latest message; max 250 rows per batch.
    const batchCap = Math.max(threadKeys.length * 5, 250);

    const propertyIds = (slicedThreads || []).map(t => t.property_id).filter(Boolean);
    const masterOwnerIds = (slicedThreads || []).map(t => t.master_owner_id).filter(Boolean);

    const buildContextQuery = async () => {
      let q = supabase.from('deal_context_index').select('*');
      if (typeof q.or === 'function') {
        const clauses = [];
        if (threadKeys.length) clauses.push(`thread_key.in.(${threadKeys.map(k => `"${k}"`).join(',')})`);
        if (propertyIds.length) clauses.push(`property_id.in.(${propertyIds.map(id => `"${id}"`).join(',')})`);
        if (masterOwnerIds.length) clauses.push(`master_owner_id.in.(${masterOwnerIds.map(id => `"${id}"`).join(',')})`);
        if (clauses.length) {
          const { data } = await q.or(clauses.join(','));
          return data || [];
        }
      }
      const { data } = await q;
      return data || [];
    };

    const [eventsRes, queueRes, contextResult] = await Promise.all([
      supabase.from('message_events').select(EVENT_COLS)
        .in('thread_key', threadKeys)
        .order('event_timestamp', { ascending: false, nullsFirst: false })
        .limit(batchCap),
      supabase.from('send_queue').select(QUEUE_COLS)
        .in('thread_key', threadKeys)
        .order('created_at', { ascending: false, nullsFirst: false })
        .limit(batchCap),
      buildContextQuery(),
    ]);

    events = eventsRes.data || [];
    queue = queueRes.data || [];
    contextData = contextResult;
  }

  const enrichedRows = (slicedThreads || []).map(thread => {
    const threadEvents = events.filter(e => e.thread_key === thread.thread_key);
    const threadQueue = queue.filter(q => q.thread_key === thread.thread_key);
    
    let latestMsg = null;
    let latestMsgTs = 0;

    for (const ev of threadEvents) {
      const ts = asTime(ev.event_timestamp || ev.received_at || ev.sent_at || ev.created_at);
      if (ts > latestMsgTs) {
        latestMsgTs = ts;
        latestMsg = {
          id: ev.id,
          direction: normalizeDirection(ev.direction),
          message_body: ev.message_body,
          property_id: ev.property_id,
          master_owner_id: ev.master_owner_id,
          metadata: ev.metadata,
          timestamp: ts,
          source: 'message_events',
          raw_event: ev,
        };
      }
    }

    for (const q of threadQueue) {
      const ts = asTime(q.sent_at || q.delivered_at || q.scheduled_for || q.created_at);
      if (ts > latestMsgTs) {
        latestMsgTs = ts;
        latestMsg = {
          id: q.id,
          direction: 'outbound',
          message_body: q.message_body || q.message_text || q.rendered_message || '',
          property_id: q.property_id,
          master_owner_id: q.master_owner_id,
          metadata: q.metadata,
          timestamp: ts,
          source: 'send_queue',
          raw_event: q,
        };
      }
    }

    let latestQueueItem = null;
    let latestQueueTs = 0;
    for (const q of threadQueue) {
      const ts = asTime(q.scheduled_for || q.created_at);
      if (ts > latestQueueTs) {
        latestQueueTs = ts;
        latestQueueItem = q;
      }
    }

    let resolvedPropertyId = null;
    let selectionReason = 'none';

    if (latestMsg && latestMsg.property_id) {
      resolvedPropertyId = latestMsg.property_id;
      selectionReason = 'latest_message.property_id';
    } else if (thread.property_id) {
      resolvedPropertyId = thread.property_id;
      selectionReason = 'deal_thread_state.property_id';
    } else if (latestQueueItem && latestQueueItem.property_id) {
      resolvedPropertyId = latestQueueItem.property_id;
      selectionReason = 'latest_queue.property_id';
    } else if (latestMsg && latestMsg.metadata?.enrichment?.property_id) {
      resolvedPropertyId = latestMsg.metadata.enrichment.property_id;
      selectionReason = 'latest_message.metadata.enrichment.property_id';
    } else {
      const contextMatches = contextData.filter(c => c.thread_key === thread.thread_key);
      if (contextMatches.length > 0) {
        const sortedMatches = contextMatches.sort((a, b) => 
          asTime(b.latest_message_at) - asTime(a.latest_message_at) || 
          (b.final_acquisition_score || 0) - (a.final_acquisition_score || 0)
        );
        resolvedPropertyId = sortedMatches[0].property_id;
        selectionReason = 'deal_context_index_fallback';
      }
    }

    let matchedContext = null;
    let enrichmentStrategy = 'none';

    if (resolvedPropertyId) {
      matchedContext = contextData.find(c => c.property_id === resolvedPropertyId);
      if (matchedContext) enrichmentStrategy = 'property_id';
    }
    if (!matchedContext && thread.thread_key) {
      matchedContext = contextData.find(c => c.thread_key === thread.thread_key);
      if (matchedContext) enrichmentStrategy = 'thread_key';
    }
    if (!matchedContext && thread.master_owner_id) {
      matchedContext = contextData.find(c => c.master_owner_id === thread.master_owner_id);
      if (matchedContext) enrichmentStrategy = 'master_owner_id';
    }
    if (!matchedContext && thread.best_phone) {
      matchedContext = contextData.find(c => c.canonical_e164 === thread.best_phone || c.best_phone === thread.best_phone || c.phone === thread.best_phone);
      if (matchedContext) enrichmentStrategy = 'phone';
    }

    const storedBucket = lower(thread.inbox_bucket) || 'cold';
    const liveBucket = classifyThread(thread, latestMsg || (thread.message_body ? thread : null));
    // For specific filter requests, display the stored bucket (which matched the DB query).
    // classifyThread() may reclassify based on message content but the counts use stored bucket,
    // so using stored bucket keeps rows and counts consistent.
    const isSpecificFilter = filter !== 'all' && filter !== 'all_messages';
    const displayedBucket = isSpecificFilter ? storedBucket : liveBucket;

    // Pre-resolve source blobs (used by phone/name/address resolvers below)
    const resolvedPropertyData = matchedContext?.property_data || thread?.property_data || null;
    const resolvedMasterOwnerData = matchedContext?.master_owner_data || thread?.master_owner_data || null;
    const resolvedProspectData = matchedContext?.prospect_data || thread?.prospect_data || null;
    const resolvedPhoneData = matchedContext?.phone_data || thread?.phone_data || null;
    const resolvedQueueData = matchedContext?.queue_data || thread?.queue_data || latestQueueItem || null;
    // Prefer latestMsg.raw_event — it comes from the freshest message scan and its direction
    // matches latestMsg.direction. deal_context_index.latest_message_event_data may be stale/outbound.
    const resolvedMsgEventData = latestMsg?.raw_event || matchedContext?.latest_message_event_data || thread?.latest_message_event_data || null;

    const phones = resolvePhones(thread, latestMsg, resolvedQueueData, resolvedMsgEventData, resolvedPhoneData, resolvedProspectData, resolvedMasterOwnerData);

    const ownerName =
      matchedContext?.owner_name ||
      resolvedMasterOwnerData?.display_name ||
      resolvedProspectData?.owner_display_name ||
      resolvedPropertyData?.owner_name ||
      null;
    const sellerFirstName =
      thread.seller_first_name ||
      resolvedQueueData?.seller_first_name ||
      object(resolvedQueueData?.metadata)?.seller_identity?.seller_first_name ||
      resolvedProspectData?.first_name ||
      null;
    const prospectFullName =
      resolvedProspectData?.full_name ||
      resolvedMasterOwnerData?.display_name ||
      ownerName ||
      null;
    const sellerDisplayName =
      resolvedQueueData?.seller_display_name ||
      object(resolvedQueueData?.metadata)?.seller_identity?.seller_display_name ||
      sellerFirstName ||
      prospectFullName ||
      ownerName ||
      null;

    const propertyAddressFull =
      matchedContext?.property_address_full ||
      resolvedPropertyData?.property_address_full ||
      object(resolvedPropertyData?.raw_payload_json)?.property_address_full ||
      resolvedQueueData?.property_address ||
      null;
    const marketName =
      matchedContext?.market ||
      resolvedPropertyData?.market ||
      object(resolvedPropertyData?.raw_payload_json)?.market ||
      resolvedMasterOwnerData?.routing_market ||
      resolvedQueueData?.market ||
      null;

    const finalRow = {
      ...matchedContext,
      ...thread,
      thread_key: thread.thread_key,
      id: thread.thread_key,
      deal_context_id: matchedContext?.deal_context_id || thread.thread_key,

      latest_activity_at: latestMsg ? new Date(latestMsg.timestamp).toISOString() : (thread.latest_message_at || thread.last_message_at || thread.updated_at || thread.created_at),
      latest_message_body: latestMsg ? latestMsg.message_body : (thread.latest_message_body || thread.last_message_body || null),
      latest_message_direction: latestMsg ? latestMsg.direction : (thread.latest_message_direction || thread.direction || null),
      direction: latestMsg ? latestMsg.direction : (thread.latest_message_direction || thread.direction || null),
      latest_direction: latestMsg ? latestMsg.direction : (thread.latest_message_direction || thread.direction || null),

      inbox_bucket: displayedBucket,
      universal_status: thread.universal_status || matchedContext?.universal_status || 'active',
      universal_stage: thread.universal_stage || matchedContext?.universal_stage || 'ownership_check',
      review_status: thread.universal_status || matchedContext?.universal_status || 'active',
      conversation_stage: thread.universal_stage || matchedContext?.universal_stage || 'ownership_check',
      seller_stage: thread.universal_stage || matchedContext?.universal_stage || 'ownership_check',
      workflow_stage: thread.universal_stage || matchedContext?.universal_stage || 'ownership_check',

      property_id: resolvedPropertyId || thread.property_id || matchedContext?.property_id || null,
      master_owner_id: thread.master_owner_id || matchedContext?.master_owner_id || null,
      prospect_id: thread.prospect_id || matchedContext?.prospect_id || null,

      canonical_e164: phones.seller_phone,
      seller_phone: phones.seller_phone,
      phone: phones.seller_phone,
      best_phone: phones.seller_phone,
      display_phone: phones.seller_phone,
      our_number: phones.our_number,
      sender_phone: phones.direction === 'outbound' ? phones.our_number : phones.seller_phone,

      owner_name: ownerName,
      seller_first_name: sellerFirstName,
      seller_display_name: sellerDisplayName,
      prospect_full_name: prospectFullName,
      prospect_name: prospectFullName,

      property_address_full: propertyAddressFull,
      property_address: propertyAddressFull,
      market: marketName,
      market_name: marketName,

      queue_status: latestQueueItem ? latestQueueItem.queue_status : (matchedContext?.queue_status || null),
      auto_reply_status: latestQueueItem ? latestQueueItem.queue_status : (matchedContext?.queue_status || null),
      failure_reason: latestQueueItem?.failed_reason || matchedContext?.queue_data?.failed_reason || null,

      final_acquisition_score: matchedContext?.final_acquisition_score || thread.priority_score || null,
      priority_score: thread.priority_score || matchedContext?.priority_score || null,

      // Canonical bucket routing fields — exposed so UI/automation can read them
      outbound_count: thread.outbound_count ?? matchedContext?.outbound_count ?? 0,
      inbound_count: thread.inbound_count ?? matchedContext?.inbound_count ?? 0,
      last_inbound_at: thread.last_inbound_at || matchedContext?.last_inbound_at || null,
      last_outbound_at: thread.last_outbound_at || matchedContext?.last_outbound_at || null,
      automation_status: thread.automation_status || matchedContext?.automation_status || null,
      next_follow_up_at: thread.next_follow_up_at || matchedContext?.next_follow_up_at || object(latestQueueItem?.metadata)?.next_follow_up_at || null,

      lat: matchedContext?.latitude || null,
      lng: matchedContext?.longitude || null,

      // Source Data Blobs
      property_data: resolvedPropertyData,
      master_owner_data: resolvedMasterOwnerData,
      prospect_data: resolvedProspectData,
      phone_data: resolvedPhoneData,
      email_data: matchedContext?.email_data || thread?.email_data || null,
      thread_state_data: matchedContext?.thread_state_data || thread?.thread_state_data || thread || null,
      queue_data: resolvedQueueData,
      suppression_data: matchedContext?.suppression_data || thread?.suppression_data || null,
      valuation_data: matchedContext?.valuation_data || thread?.valuation_data || null,
      buyer_match_data: matchedContext?.buyer_match_data || thread?.buyer_match_data || null,
      latest_message_event_data: resolvedMsgEventData,
    };

    const computedRow = applyInboxRowComputedFields(finalRow, params);

    // Diagnostics — always present so frontend and curl can verify correctness
    computedRow.requested_filter = filter;
    computedRow.resolved_bucket = displayedBucket;
    computedRow.original_inbox_bucket = liveBucket !== displayedBucket ? liveBucket : null;
    computedRow.live_bucket = liveBucket;
    computedRow.bucket_reason = `stored=${storedBucket} live=${liveBucket} displayed=${displayedBucket}`;
    computedRow.phone_resolution_source = phones.source;
    computedRow.phone_resolution_warning = (phones.our_number && phones.our_number === phones.seller_phone) ? 'our_number_equals_seller_phone' : null;
    computedRow.selected_property_reason = selectionReason;
    computedRow.latest_message_source = latestMsg ? latestMsg.source : 'deal_thread_state';
    computedRow.enrichment_match_strategy = enrichmentStrategy;

    return computedRow;
  });

  // Strict post-enrichment bucket enforcement — always runs regardless of DB query capabilities.
  // This is the last line of defense: even if classifyThread() reassigned displayedBucket
  // or context enrichment modified fields, rows that don't match the requested filter are dropped.
  let finalRows = enrichedRows;
  if (filter !== 'all' && filter !== 'all_messages') {
    if (filter === 'dead') {
      finalRows = enrichedRows.filter(r => r.inbox_bucket === 'dead' || r.universal_status === 'dead' || r.wrong_number || r.not_interested);
    } else if (filter === 'suppressed' || filter === 'dnc_opt_out' || filter === 'opt_out') {
      finalRows = enrichedRows.filter(r => r.inbox_bucket === 'suppressed' || r.universal_status === 'suppressed' || r.opt_out);
    } else if (filter === 'priority' || filter === 'positive_hot') {
      finalRows = enrichedRows.filter(r => r.inbox_bucket === 'priority');
    } else if (filter === 'new_replies' || filter === 'needs_reply') {
      finalRows = enrichedRows.filter(r => r.inbox_bucket === 'new_replies');
    } else if (filter === 'needs_review' || filter === 'manual_review') {
      finalRows = enrichedRows.filter(r => r.inbox_bucket === 'needs_review' || r.needs_review === true);
    } else if (filter === 'follow_up' || filter === 'waiting' || filter === 'outbound_active') {
      finalRows = enrichedRows.filter(r => r.inbox_bucket === 'follow_up' || r.inbox_bucket === 'waiting_on_seller');
    } else if (filter === 'cold') {
      finalRows = enrichedRows.filter(r => r.inbox_bucket === 'cold' && r.universal_status !== 'dead' && !r.wrong_number && !r.opt_out && !r.not_interested);
    } else if (filter === 'unlinked') {
      finalRows = enrichedRows.filter(r => !r.property_id);
    }
  }

  if (params.q) {
    const qLower = params.q.trim().toLowerCase();
    finalRows = finalRows.filter(r =>
      (r.latest_message_body && r.latest_message_body.toLowerCase().includes(qLower)) ||
      (r.thread_key && r.thread_key.toLowerCase().includes(qLower)) ||
      (r.property_address_full && r.property_address_full.toLowerCase().includes(qLower)) ||
      (r.owner_name && r.owner_name.toLowerCase().includes(qLower))
    );
  }

  console.log('[INBOX_BUCKET_ROWS]', {
    bucket: filter,
    count: finalRows.length,
    firstThreadKey: finalRows[0]?.thread_key || null,
    firstLatestAt: finalRows[0]?.latest_activity_at || finalRows[0]?.latest_message_at || null,
  });

  const liveCounts = await countsPromise;

  const lastRow = finalRows[finalRows.length - 1];
  let nextCursor = null;
  if (hasMore && lastRow) {
    if (cursorKeyset || (!offset && typeof query.or === 'function')) {
      const nextCursorObj = {
        latest_message_at: lastRow.latest_activity_at || lastRow.latest_message_at,
        thread_key: lastRow.thread_key,
      };
      nextCursor = Buffer.from(JSON.stringify(nextCursorObj)).toString('base64');
    } else {
      nextCursor = String(offset + finalRows.length);
    }
  }

  const mapPins = wantsMap
    ? finalRows
        .filter((row) => Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lng)))
        .map((row) => ({
          id: row.thread_key,
          thread_key: row.thread_key || null,
          latitude: Number(row.lat),
          longitude: Number(row.lng),
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
    mapPins,
    pagination: {
      limit,
      returned: finalRows.length,
      has_more: hasMore,
      next_cursor: nextCursor,
    },
  };
}

export async function getThreadMessages(threadKey, { offset = 0, limit = 200 } = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;

  const { data: events, error: eventsError } = await supabase
    .from('message_events')
    .select('*')
    .eq('thread_key', threadKey);

  if (eventsError) throw eventsError;

  const { data: queue, error: queueError } = await supabase
    .from('send_queue')
    .select('*')
    .eq('thread_key', threadKey);

  if (queueError) throw queueError;

  const normalized = [];

  for (const ev of events || []) {
    normalized.push({
      message_event_id: ev.id,
      thread_key: ev.thread_key,
      direction: normalizeDirection(ev.direction),
      message_body: ev.message_body,
      message_created_at: ev.created_at,
      event_timestamp: ev.event_timestamp || ev.sent_at || ev.delivered_at || ev.created_at,
      delivery_status: ev.delivery_status || null,
      event_type: ev.event_type || null,
      provider_message_sid: ev.provider_message_sid || null,
      to_phone_number: ev.to_phone_number || null,
      from_phone_number: ev.from_phone_number || null,
      queue_id: ev.queue_id || null,
      template_id: ev.template_id || null,
      master_owner_id: ev.master_owner_id || null,
      prospect_id: ev.prospect_id || null,
      property_id: ev.property_id || null,
      phone_number_id: ev.phone_number_id || null,
      market_id: ev.market_id || null,
      detected_intent: ev.detected_intent || null,
      current_stage: ev.current_stage || null,
      safety_status: ev.safety_status || null,
      priority: ev.priority || null,
      risk: ev.risk || null,
      routing_allowed: ev.routing_allowed || null,
      language: ev.language || null,
      classification_confidence: ev.classification_confidence || null,
      metadata: ev.metadata || {},
      updated_at: ev.updated_at || ev.created_at,
      source_table: 'message_events',
    });
  }

  const representedQueueIds = new Set(
    (events || []).map(ev => ev.queue_id).filter(Boolean)
  );

  for (const q of queue || []) {
    if (representedQueueIds.has(q.id)) {
      continue;
    }

    normalized.push({
      message_event_id: q.id,
      thread_key: q.thread_key,
      direction: 'outbound',
      message_body: q.message_body || q.message_text || q.rendered_message || '',
      message_created_at: q.created_at,
      event_timestamp: q.sent_at || q.delivered_at || q.scheduled_for || q.created_at,
      delivery_status: q.queue_status || null,
      event_type: 'outbound_queue',
      provider_message_sid: q.provider_message_id || null,
      to_phone_number: q.to_phone_number || null,
      from_phone_number: q.from_phone_number || null,
      queue_id: q.id,
      template_id: q.template_id || q.selected_template_id || null,
      master_owner_id: q.master_owner_id || null,
      prospect_id: q.prospect_id || null,
      property_id: q.property_id || null,
      phone_number_id: q.phone_number_id || null,
      market_id: q.market_id || null,
      detected_intent: q.detected_intent || null,
      current_stage: q.current_stage || null,
      safety_status: q.safety_status || null,
      priority: q.priority || null,
      risk: q.risk || q.risk_level || null,
      routing_allowed: q.routing_allowed || null,
      language: q.language || null,
      classification_confidence: q.ai_confidence || null,
      metadata: q.metadata || {},
      updated_at: q.updated_at || q.created_at,
      source_table: 'send_queue',
    });
  }

  normalized.sort((a, b) => asTime(a.event_timestamp) - asTime(b.event_timestamp));

  const paginated = normalized.slice(offset, offset + limit);

  return {
    rows: paginated,
    total: normalized.length,
  };
}
