import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { normalizePhone } from "@/lib/utils/phones.js";
import {
  ACQUISITION_STAGES,
  normalizeAcquisitionStage,
} from "@/lib/domain/acquisition/acquisition-stage-registry.js";
import {
  acquisitionRuntimeDisabled,
  getAcquisitionRuntimeControl,
} from "@/lib/domain/acquisition/acquisition-runtime-control.js";

const TABLE = "acquisition_contacts";
const TEMPERATURES = new Set(["hot", "warm", "cool", "cold", "suppressed"]);
const PRIORITIES = new Set(["high", "normal", "low"]);
const PATCH_FIELDS = new Set([
  "phone",
  "canonical_e164",
  "property_id",
  "master_owner_id",
  "thread_id",
  "campaign_id",
  "current_stage",
  "stage_updated_at",
  "contact_temperature",
  "priority",
  "ownership_confirmed",
  "is_opt_out",
  "is_wrong_number",
  "is_hostile",
  "last_delivered_at",
  "last_inbound_at",
  "seller_asking_price",
  "internal_target_price",
  "offer_ratio",
  "property_type",
  "unit_count",
  "condition_summary",
  "retry_count",
  "tried_template_ids",
  "next_followup_at",
  "automation_status",
  "metadata",
]);

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function clean(value) {
  return String(value ?? "").trim();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function canonicalPhone(context = {}) {
  return normalizePhone(
    clean(context.canonical_e164 ?? context.phone ?? context.to_phone_number ?? context.thread_id)
  );
}

function contactIdFrom(context) {
  if (typeof context === "string") return clean(context);
  return clean(context?.contact_id ?? context?.acquisition_contact_id ?? context?.id);
}

function sanitizePatch(patch = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (PATCH_FIELDS.has(key) && value !== undefined) safe[key] = value;
  }
  return safe;
}

function operationMetadata(operation, metadata = {}) {
  const detail = asObject(metadata);
  return Object.keys(detail).length
    ? { last_automation_operation: operation, last_automation_metadata: detail }
    : { last_automation_operation: operation };
}

export async function getAcquisitionContact(contactId, deps = {}) {
  const id = clean(contactId);
  if (!id) return { ok: false, status: 400, error: "acquisition_contact_id_required" };

  const { data, error } = await db(deps)
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false, status: 404, error: "acquisition_contact_not_found" };
  return { ok: true, contact: data };
}

export async function findAcquisitionContact(context = {}, deps = {}) {
  const client = db(deps);
  const id = contactIdFrom(context);
  if (id) return getAcquisitionContact(id, deps);

  const phone = canonicalPhone(context);
  const propertyWasProvided = Object.prototype.hasOwnProperty.call(
    context || {},
    "property_id"
  );
  const propertyId = clean(context.property_id) || null;
  const masterOwnerId = clean(context.master_owner_id) || null;
  const threadId = clean(context.thread_id) || null;

  let query = client.from(TABLE).select("*");
  if (phone) {
    query = query.eq("canonical_e164", phone);
    if (propertyId) {
      query = query.eq("property_id", propertyId);
    } else if (propertyWasProvided) {
      query = query.is("property_id", null);
    } else if (threadId) {
      query = query.eq("thread_id", threadId);
    } else if (masterOwnerId) {
      query = query.eq("master_owner_id", masterOwnerId);
    }
  } else if (threadId) {
    query = query.eq("thread_id", threadId);
  } else if (masterOwnerId) {
    query = query.eq("master_owner_id", masterOwnerId);
  } else {
    return { ok: false, status: 400, error: "acquisition_contact_identity_required" };
  }

  const { data, error } = await query.limit(2);
  if (error) throw error;
  const matches = Array.isArray(data) ? data : data ? [data] : [];
  if (matches.length > 1) {
    return {
      ok: false,
      status: 409,
      error: "ambiguous_contact",
      match_count: matches.length,
    };
  }
  return { ok: true, contact: matches[0] ?? null };
}

export async function getOrCreateAcquisitionContact(context = {}, deps = {}) {
  const phone = canonicalPhone(context);
  if (!phone) return { ok: false, status: 400, error: "acq_contact_phone_required" };

  const lookup = { canonical_e164: phone };
  if (Object.prototype.hasOwnProperty.call(context || {}, "property_id")) {
    lookup.property_id = clean(context.property_id) || null;
  } else if (clean(context.thread_id)) {
    lookup.thread_id = clean(context.thread_id);
  } else if (clean(context.master_owner_id)) {
    lookup.master_owner_id = clean(context.master_owner_id);
  }
  const existing = await findAcquisitionContact(lookup, deps);
  if (!existing.ok) return existing;
  if (existing.ok && existing.contact) {
    return { ok: true, contact: existing.contact, created: false };
  }

  const runtime = await getAcquisitionRuntimeControl("contact_create", deps);
  if (!runtime.enabled) return acquisitionRuntimeDisabled(runtime);

  const now = deps.now || new Date().toISOString();
  const row = {
    phone: clean(context.phone) || phone,
    canonical_e164: phone,
    property_id: clean(context.property_id) || null,
    master_owner_id: clean(context.master_owner_id) || null,
    thread_id: clean(context.thread_id) || phone,
    campaign_id: clean(context.campaign_id) || null,
    current_stage: normalizeAcquisitionStage(
      context.current_stage ?? context.stage,
      ACQUISITION_STAGES.OWNERSHIP_CHECK
    ),
    stage_updated_at: now,
    contact_temperature: TEMPERATURES.has(clean(context.contact_temperature))
      ? clean(context.contact_temperature)
      : "cold",
    priority: PRIORITIES.has(clean(context.priority)) ? clean(context.priority) : "normal",
    ownership_confirmed: context.ownership_confirmed === true,
    is_opt_out: context.is_opt_out === true,
    is_wrong_number: context.is_wrong_number === true,
    is_hostile: context.is_hostile === true,
    property_type: clean(context.property_type) || null,
    unit_count: Number.isFinite(Number(context.unit_count)) ? Number(context.unit_count) : null,
    retry_count: Math.max(0, Number(context.retry_count) || 0),
    tried_template_ids: Array.isArray(context.tried_template_ids)
      ? [...new Set(context.tried_template_ids.map(clean).filter(Boolean))]
      : [],
    next_followup_at: context.next_followup_at || null,
    automation_status: clean(context.automation_status) || "active",
    metadata: asObject(context.metadata),
  };

  const { data, error } = await db(deps).from(TABLE).insert(row).select("*").single();
  if (error?.code === "23505") {
    const raced = await findAcquisitionContact(
      { canonical_e164: phone, property_id: row.property_id },
      deps
    );
    return { ok: true, contact: raced.contact, created: false, raced: true };
  }
  if (error) throw error;
  return { ok: true, contact: data, created: true };
}

export async function updateAcquisitionContact(contactId, patch = {}, deps = {}) {
  const id = contactIdFrom(contactId);
  if (!id) return { ok: false, status: 400, error: "acquisition_contact_id_required" };

  const safePatch = sanitizePatch(patch);
  if (safePatch.contact_temperature && !TEMPERATURES.has(safePatch.contact_temperature)) {
    return { ok: false, status: 400, error: "invalid_temperature" };
  }
  if (safePatch.priority && !PRIORITIES.has(safePatch.priority)) {
    return { ok: false, status: 400, error: "invalid_priority" };
  }
  if (safePatch.canonical_e164) {
    safePatch.canonical_e164 = normalizePhone(safePatch.canonical_e164);
  }
  safePatch.updated_at = deps.now || new Date().toISOString();

  const { data, error } = await db(deps)
    .from(TABLE)
    .update(safePatch)
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw error;
  return { ok: true, contact: data };
}

async function resolveContact(context, deps = {}) {
  const id = contactIdFrom(context);
  if (id) return getAcquisitionContact(id, deps);
  return getOrCreateAcquisitionContact(context, deps);
}

async function patchContext(context, patch, operation, metadata = {}, deps = {}) {
  const resolved = await resolveContact(context, deps);
  if (!resolved.ok) return resolved;

  const currentMetadata = asObject(resolved.contact.metadata);
  return updateAcquisitionContact(
    resolved.contact.id,
    {
      ...patch,
      metadata: {
        ...currentMetadata,
        ...operationMetadata(operation, metadata),
      },
    },
    deps
  );
}

export async function recordDelivered(context, metadata = {}, deps = {}) {
  const deliveredAt = metadata.delivered_at || deps.now || new Date().toISOString();
  return patchContext(
    context,
    {
      last_delivered_at: deliveredAt,
      retry_count: 0,
      tried_template_ids: [],
      automation_status: "awaiting_reply",
    },
    "record_delivered",
    metadata,
    deps
  );
}

export async function recordInbound(context, metadata = {}, deps = {}) {
  return patchContext(
    context,
    {
      last_inbound_at: metadata.received_at || deps.now || new Date().toISOString(),
      next_followup_at: null,
      automation_status: "active",
    },
    "record_inbound",
    metadata,
    deps
  );
}

export async function markOwnershipConfirmed(context, metadata = {}, deps = {}) {
  return patchContext(
    context,
    {
      ownership_confirmed: true,
      priority: "high",
      contact_temperature: metadata.temperature === "hot" ? "hot" : "warm",
    },
    "mark_ownership_confirmed",
    metadata,
    deps
  );
}

export async function markOptOut(context, metadata = {}, deps = {}) {
  return patchContext(
    context,
    {
      is_opt_out: true,
      contact_temperature: "suppressed",
      automation_status: "suppressed",
      next_followup_at: null,
    },
    "mark_opt_out",
    metadata,
    deps
  );
}

export async function markWrongNumber(context, metadata = {}, deps = {}) {
  return patchContext(
    context,
    {
      is_wrong_number: true,
      contact_temperature: "suppressed",
      automation_status: "suppressed",
      next_followup_at: null,
    },
    "mark_wrong_number",
    metadata,
    deps
  );
}

export async function markHostile(context, metadata = {}, deps = {}) {
  return patchContext(
    context,
    {
      is_hostile: true,
      contact_temperature: "suppressed",
      automation_status: "needs_review",
      next_followup_at: null,
    },
    "mark_hostile",
    metadata,
    deps
  );
}

export async function updateStage(context, nextStage, metadata = {}, deps = {}) {
  const stage = normalizeAcquisitionStage(nextStage, null);
  if (!stage) return { ok: false, status: 400, error: "next_stage_required" };
  return patchContext(
    context,
    {
      current_stage: stage,
      stage_updated_at: deps.now || new Date().toISOString(),
    },
    "update_stage",
    metadata,
    deps
  );
}

export async function updateTemperature(context, temperature, metadata = {}, deps = {}) {
  const value = clean(temperature);
  if (!TEMPERATURES.has(value)) {
    return {
      ok: false,
      status: 400,
      error: `invalid_temperature: must be one of ${[...TEMPERATURES].join(", ")}`,
    };
  }
  return patchContext(
    context,
    { contact_temperature: value },
    "update_temperature",
    metadata,
    deps
  );
}

export async function recordSellerAskingPrice(context, askingPrice, metadata = {}, deps = {}) {
  const price = Number(askingPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, status: 400, error: "invalid_asking_price" };
  }

  const resolved = await resolveContact(context, deps);
  if (!resolved.ok) return resolved;
  const target = Number(resolved.contact.internal_target_price);
  const patch = {
    seller_asking_price: Math.round(price),
    metadata: {
      ...asObject(resolved.contact.metadata),
      ...operationMetadata("record_seller_asking_price", metadata),
    },
  };
  if (Number.isFinite(target) && target > 0) {
    patch.offer_ratio = Number((price / target).toFixed(4));
  }
  return updateAcquisitionContact(resolved.contact.id, patch, deps);
}

export async function recordOfferTarget(context, targetPrice, metadata = {}, deps = {}) {
  const runtime = await getAcquisitionRuntimeControl("offer", deps);
  if (!runtime.enabled) return acquisitionRuntimeDisabled(runtime);

  const price = Number(targetPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, status: 400, error: "invalid_target_price" };
  }

  const resolved = await resolveContact(context, deps);
  if (!resolved.ok) return resolved;
  const asking = Number(resolved.contact.seller_asking_price);
  const patch = {
    internal_target_price: Math.round(price),
    metadata: {
      ...asObject(resolved.contact.metadata),
      ...operationMetadata("record_offer_target", metadata),
    },
  };
  if (Number.isFinite(asking) && asking > 0) {
    patch.offer_ratio = Number((asking / price).toFixed(4));
  }
  return updateAcquisitionContact(resolved.contact.id, patch, deps);
}

export async function scheduleNextFollowup(context, scheduledFor, metadata = {}, deps = {}) {
  const scheduledAt = new Date(scheduledFor);
  if (Number.isNaN(scheduledAt.getTime())) {
    return { ok: false, status: 400, error: "invalid_followup_time" };
  }
  return patchContext(
    context,
    {
      next_followup_at: scheduledAt.toISOString(),
      automation_status: "awaiting_reply",
    },
    "schedule_next_followup",
    metadata,
    deps
  );
}
