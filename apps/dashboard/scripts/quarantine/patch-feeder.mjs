
import fs from 'fs';

const filePath = '../real-estate-automation/src/lib/domain/outbound/supabase-candidate-feeder.js';
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add RECENTLY_CONTACTED to REASON_CODES
content = content.replace(
  'DUPLICATE_QUEUE_ITEM: "DUPLICATE_QUEUE_ITEM",',
  'DUPLICATE_QUEUE_ITEM: "DUPLICATE_QUEUE_ITEM",\n  RECENTLY_CONTACTED: "RECENTLY_CONTACTED",'
);

// 2. Update mapReasonToDiagnosticCounter
content = content.replace(
  'if (reason === REASON_CODES.DUPLICATE_QUEUE_ITEM) return "duplicate_queue_block_count";',
  'if (reason === REASON_CODES.DUPLICATE_QUEUE_ITEM || reason === REASON_CODES.RECENTLY_CONTACTED) return "duplicate_queue_block_count";'
);

// 3. Update hasDuplicateQueueItem
const oldFunction = `async function hasDuplicateQueueItem(candidate = {}, options = {}, deps = {}) {
  if (typeof deps.hasDuplicateQueueItem === "function") {
    return deps.hasDuplicateQueueItem(candidate, options);
  }

  const supabase = getSupabase(deps);
  const statuses = ["queued", "sending", "sent"];

  const { data, error, count } = await supabase
    .from(SEND_QUEUE_TABLE)
    .select("id,queue_status,queue_key,touch_number,to_phone_number,use_case_template,metadata,scheduled_for,sent_at,created_at,updated_at", { count: "exact" })
    .eq("master_owner_id", candidate.master_owner_id)
    .eq("property_id", candidate.property_id)
    .in("queue_status", statuses)
    .eq("touch_number", candidate.touch_number)
    .limit(20);

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const phone = normalizePhone(candidate.canonical_e164);

  const matched = rows.find((row) => {
    const row_phone = normalizePhone(row?.to_phone_number);
    const template_use_case = getQueueRowUseCase(row);
    return row_phone === phone && template_use_case === clean(candidate.template_use_case);
  });

  return {
    duplicate: Boolean(matched),
    policy: {
      match_basis: [
        "master_owner_id",
        "property_id",
        "touch_number",
        "to_phone_number",
        "template_use_case"
      ],
      blocking_statuses: statuses
    },
    matched_row: matched ? {
      id: matched.id,
      queue_status: matched.queue_status,
      queue_key: matched.queue_key,
      touch_number: matched.touch_number,
      to_phone_number_masked: maskPhone(matched.to_phone_number),
      template_use_case: clean(
        matched?.metadata?.template_use_case || matched?.metadata?.selected_use_case || matched?.use_case_template
      ),
      scheduled_for: matched.scheduled_for,
      sent_at: matched.sent_at,
      created_at: matched.created_at,
      updated_at: matched.updated_at
    } : null,
    scanned_duplicate_rows_count: count ?? rows.length
  };
}`;

const newFunction = `async function hasDuplicateQueueItem(candidate = {}, options = {}, deps = {}) {
  if (typeof deps.hasDuplicateQueueItem === "function") {
    return deps.hasDuplicateQueueItem(candidate, options);
  }

  const supabase = getSupabase(deps);
  const statuses = ["queued", "scheduled", "pending", "approved", "ready", "sending", "sent", "delivered"];
  const phone = normalizePhone(candidate.canonical_e164);

  // 1. Check send_queue
  const { data, error, count } = await supabase
    .from(SEND_QUEUE_TABLE)
    .select("id,queue_status,queue_key,touch_number,to_phone_number,use_case_template,metadata,scheduled_for,sent_at,created_at,updated_at", { count: "exact" })
    .eq("master_owner_id", candidate.master_owner_id)
    .eq("property_id", candidate.property_id)
    .in("queue_status", statuses)
    .eq("touch_number", candidate.touch_number)
    .limit(20);

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const matched = rows.find((row) => {
    const row_phone = normalizePhone(row?.to_phone_number);
    const template_use_case = getQueueRowUseCase(row);
    return row_phone === phone && template_use_case === clean(candidate.template_use_case);
  });

  if (matched) {
    return {
      duplicate: true,
      reason_code: REASON_CODES.DUPLICATE_QUEUE_ITEM,
      policy: {
        match_basis: [
          "master_owner_id",
          "property_id",
          "touch_number",
          "to_phone_number",
          "template_use_case"
        ],
        blocking_statuses: statuses
      },
      matched_row: {
        id: matched.id,
        queue_status: matched.queue_status,
        queue_key: matched.queue_key,
        touch_number: matched.touch_number,
        to_phone_number_masked: maskPhone(matched.to_phone_number),
        template_use_case: clean(
          matched?.metadata?.template_use_case || matched?.metadata?.selected_use_case || matched?.use_case_template
        ),
        scheduled_for: matched.scheduled_for,
        sent_at: matched.sent_at,
        created_at: matched.created_at,
        updated_at: matched.updated_at
      },
      scanned_duplicate_rows_count: count ?? rows.length
    };
  }

  // 2. Check message_events for recent outbound (72 hours)
  // Condition: Same phone AND (Same Owner OR Same Property)
  const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  
  const { data: recentEvents, error: eventError } = await supabase
    .from("message_events")
    .select("id, created_at, canonical_e164, to_phone_number, master_owner_id, property_id")
    .eq("direction", "outbound")
    .gte("created_at", seventyTwoHoursAgo)
    .or(\`canonical_e164.eq.\${phone},to_phone_number.eq.\${phone}\`)
    .or(\`master_owner_id.eq.\${candidate.master_owner_id},property_id.eq.\${candidate.property_id}\`)
    .limit(1);

  if (eventError) {
    // Graceful failure for message_events check if table/columns don't exist as expected
    console.error("[hasDuplicateQueueItem] message_events check failed:", eventError.message);
  } else if (recentEvents && recentEvents.length > 0) {
    const event = recentEvents[0];
    return {
      duplicate: true,
      recently_contacted: true,
      reason_code: REASON_CODES.RECENTLY_CONTACTED,
      matched_event: {
        id: event.id,
        created_at: event.created_at,
        phone_masked: maskPhone(event.canonical_e164 || event.to_phone_number),
        master_owner_id: event.master_owner_id,
        property_id: event.property_id
      }
    };
  }

  return {
    duplicate: false,
    scanned_duplicate_rows_count: count ?? rows.length
  };
}`;

content = content.replace(oldFunction, newFunction);

fs.writeFileSync(filePath, content);
console.log('Successfully updated supabase-candidate-feeder.js');
