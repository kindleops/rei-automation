function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

const PLACEHOLDER_VALUES = new Set([
  "",
  "unknown",
  "unknown seller",
  "unknown owner",
  "unknown market",
  "unknown type",
  "n/a",
  "na",
  "none",
  "null",
  "no address",
  "property unknown",
]);

export function isRealDisplayValue(value) {
  const text = clean(value);
  if (!text) return false;
  return !PLACEHOLDER_VALUES.has(lower(text));
}

function firstReal(...values) {
  for (const value of values) {
    if (isRealDisplayValue(value)) return clean(value);
  }
  return null;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(String(value).replace(/[,$\s]/g, ""));
  return Number.isFinite(num) ? num : null;
}

function normalizePhone(value) {
  const raw = clean(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.startsWith("+") ? raw : digits ? `+${digits}` : raw;
}

function formatDisplayPhone(value) {
  const normalized = normalizePhone(value);
  if (!normalized) return null;
  const digits = normalized.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return normalized;
}

function resolveOwnerName({ row = {}, masterOwner = null, prospect = null } = {}) {
  const owner = masterOwner || {};
  const contact = prospect || {};
  const prospectName = firstReal(
    contact.full_name,
    contact.first_name,
    contact.owner_display_name,
  );

  return (
    firstReal(
      owner.display_name,
      prospectName,
      row.seller_display_name,
      row.owner_display_name,
      formatDisplayPhone(
        row.seller_phone ||
        row.canonical_e164 ||
        row.best_phone ||
        row.display_phone ||
        row.phone,
      ),
    ) || null
  );
}

function resolvePropertyAddress(property = {}) {
  const full = firstReal(
    property.property_address_full,
    property.property_address,
  );
  if (full) return full;

  const parts = [
    property.property_address_street,
    property.property_address_city || property.property_city,
    property.property_address_state || property.property_state,
    property.property_address_zip || property.property_zip,
  ].map((part) => clean(part)).filter(Boolean);

  return parts.length ? parts.join(", ") : null;
}

function resolveEquityAmount(property = {}) {
  const direct = parseNumber(property.equity_amount ?? property.estimated_equity_amount);
  if (direct != null && direct > 0) return direct;

  const percent = parseNumber(property.equity_percent);
  const value = parseNumber(property.estimated_value);
  if (percent != null && percent > 0 && value != null && value > 0) {
    return (percent / 100) * value;
  }
  return null;
}

function resolvePriorityScore({ property = null, masterOwner = null } = {}) {
  const prop = property || {};
  const owner = masterOwner || {};
  return parseNumber(prop.final_acquisition_score)
    ?? parseNumber(owner.priority_score)
    ?? null;
}

function buildLinkedContextMaps({ properties = [], masterOwners = [], prospects = [], dealContexts = [] } = {}) {
  const propertyById = new Map();
  for (const row of properties) {
    const key = clean(row.property_id);
    if (key) propertyById.set(key, row);
  }

  const ownerById = new Map();
  for (const row of masterOwners) {
    const key = clean(row.master_owner_id);
    if (key) ownerById.set(key, row);
  }

  const prospectById = new Map();
  for (const row of prospects) {
    const key = clean(row.prospect_id);
    if (key) prospectById.set(key, row);
  }

  const contextByThreadKey = new Map();
  for (const row of dealContexts) {
    const key = clean(row.thread_key);
    if (key) contextByThreadKey.set(key, row);
  }

  return { propertyById, ownerById, prospectById, contextByThreadKey };
}

export function mergeLinkedContextIntoThreadRow(row = {}, maps = {}) {
  const propertyId = clean(row.property_id || row.final_property_id);
  const masterOwnerId = clean(row.master_owner_id || row.final_master_owner_id || row.owner_id);
  const prospectId = clean(row.prospect_id || row.final_prospect_id);
  const threadKey = clean(row.thread_key || row.canonical_thread_key);

  const property = propertyId ? maps.propertyById?.get(propertyId) : null;
  const masterOwner = masterOwnerId ? maps.ownerById?.get(masterOwnerId) : null;
  const prospect = prospectId ? maps.prospectById?.get(prospectId) : null;
  const dealContext = threadKey ? maps.contextByThreadKey?.get(threadKey) : null;

  if (!property && !masterOwner && !prospect && !dealContext) return row;

  const ownerName = resolveOwnerName({ row, masterOwner, prospect });
  const propertyAddress = property ? resolvePropertyAddress(property) : null;
  const market = firstReal(property?.market, property?.market_region, row.market, dealContext?.market);
  const propertyType = firstReal(property?.property_type, property?.property_class, row.property_type);
  const unitsCount = parseNumber(property?.units_count ?? property?.number_of_units);
  const estimatedValue = parseNumber(property?.estimated_value ?? property?.arv);
  const equityPercent = parseNumber(property?.equity_percent);
  const equityAmount = property ? resolveEquityAmount(property) : null;
  const finalAcquisitionScore = resolvePriorityScore({ property, masterOwner });
  const buildingCondition = firstReal(property?.building_condition, property?.condition);
  const conversationStage = firstReal(
    dealContext?.universal_stage,
    row.conversation_stage,
    row.universal_stage,
    row.current_stage,
    row.stage,
  );

  const patch = {
    owner_name: firstReal(row.owner_name, ownerName),
    owner_display_name: firstReal(row.owner_display_name, ownerName),
    seller_display_name: firstReal(row.seller_display_name, ownerName),
    prospect_full_name: firstReal(row.prospect_full_name, prospect?.full_name),
    prospect_name: firstReal(row.prospect_name, prospect?.full_name),
    property_address_full: firstReal(row.property_address_full, propertyAddress),
    property_address: firstReal(row.property_address, propertyAddress),
    property_address_city: firstReal(row.property_address_city, property?.property_address_city, property?.property_city),
    property_address_state: firstReal(row.property_address_state, property?.property_address_state, property?.property_state),
    property_address_zip: firstReal(row.property_address_zip, property?.property_address_zip, property?.property_zip),
    market: market || row.market || null,
    property_type: propertyType || row.property_type || null,
    units_count: unitsCount ?? row.units_count ?? null,
    units: unitsCount != null && unitsCount > 1 ? unitsCount : row.units ?? null,
    number_of_units: unitsCount ?? row.number_of_units ?? null,
    estimated_value: estimatedValue ?? row.estimated_value ?? null,
    equity_percent: equityPercent ?? row.equity_percent ?? null,
    equity_amount: equityAmount ?? row.equity_amount ?? null,
    final_acquisition_score: finalAcquisitionScore ?? row.final_acquisition_score ?? null,
    priority_score: parseNumber(masterOwner?.priority_score) ?? row.priority_score ?? null,
    building_condition: buildingCondition || null,
    conversation_stage: conversationStage || row.conversation_stage || null,
    universal_stage: conversationStage || row.universal_stage || null,
    current_stage: conversationStage || row.current_stage || null,
  };

  return {
    ...row,
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  };
}

const PROPERTY_SELECT = [
  "property_id",
  "property_address_full",
  "property_address",
  "property_address_city",
  "property_address_state",
  "property_address_zip",
  "property_state",
  "property_zip",
  "market",
  "market_region",
  "property_type",
  "property_class",
  "units_count",
  "estimated_value",
  "equity_percent",
  "equity_amount",
  "building_condition",
  "final_acquisition_score",
].join(",");

const MASTER_OWNER_SELECT = [
  "master_owner_id",
  "display_name",
  "priority_score",
].join(",");

const PROSPECT_SELECT = [
  "prospect_id",
  "full_name",
  "first_name",
  "owner_display_name",
].join(",");

const DEAL_CONTEXT_SELECT = [
  "thread_key",
  "universal_stage",
  "market",
  "owner_name",
  "property_address_full",
].join(",");

async function safeInQuery(supabase, table, select, column, values = []) {
  const unique = [...new Set(values.map((value) => clean(value)).filter(Boolean))];
  if (!unique.length) return [];

  const chunkSize = 200;
  const rows = [];

  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    const { data, error } = await supabase.from(table).select(select).in(column, chunk);
    if (error) throw error;
    rows.push(...(data || []));
  }

  return rows;
}

export async function bulkHydrateInboxThreadLinkedContext(rows = [], supabase) {
  if (!rows.length || !supabase) return rows;

  const propertyIds = [];
  const masterOwnerIds = [];
  const prospectIds = [];
  const threadKeys = [];

  for (const row of rows) {
    const propertyId = clean(row.property_id || row.final_property_id);
    const masterOwnerId = clean(row.master_owner_id || row.final_master_owner_id || row.owner_id);
    const prospectId = clean(row.prospect_id || row.final_prospect_id);
    const threadKey = clean(row.thread_key || row.canonical_thread_key);
    if (propertyId) propertyIds.push(propertyId);
    if (masterOwnerId) masterOwnerIds.push(masterOwnerId);
    if (prospectId) prospectIds.push(prospectId);
    if (threadKey) threadKeys.push(threadKey);
  }

  const [properties, masterOwners, prospects, dealContexts] = await Promise.all([
    safeInQuery(supabase, "properties", PROPERTY_SELECT, "property_id", propertyIds),
    safeInQuery(supabase, "master_owners", MASTER_OWNER_SELECT, "master_owner_id", masterOwnerIds),
    safeInQuery(supabase, "prospects", PROSPECT_SELECT, "prospect_id", prospectIds),
    safeInQuery(supabase, "deal_context_index", DEAL_CONTEXT_SELECT, "thread_key", threadKeys),
  ]);

  const maps = buildLinkedContextMaps({ properties, masterOwners, prospects, dealContexts });

  return rows.map((row) => mergeLinkedContextIntoThreadRow(row, maps));
}