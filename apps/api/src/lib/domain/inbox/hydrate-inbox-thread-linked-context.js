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
  const threadKey = clean(row.thread_key || row.canonical_thread_key);
  const dealContext = threadKey ? maps.contextByThreadKey?.get(threadKey) : null;

  const propertyId = clean(
    row.property_id || row.final_property_id || dealContext?.property_id,
  );
  const masterOwnerId = clean(
    row.master_owner_id || row.final_master_owner_id || row.owner_id || dealContext?.master_owner_id,
  );
  const prospectId = clean(row.prospect_id || row.final_prospect_id || dealContext?.prospect_id);

  const property = propertyId ? maps.propertyById?.get(propertyId) : null;
  const masterOwner = masterOwnerId ? maps.ownerById?.get(masterOwnerId) : null;
  const prospect = prospectId ? maps.prospectById?.get(prospectId) : null;

  if (!property && !masterOwner && !prospect && !dealContext) return row;

  const ownerName = resolveOwnerName({ row, masterOwner, prospect })
    || (dealContext ? firstReal(dealContext.owner_name) : null);
  const propertyAddress = property
    ? resolvePropertyAddress(property)
    : (dealContext ? firstReal(dealContext.property_address_full) : null);
  const market = firstReal(property?.market, property?.market_region, row.market, dealContext?.market);
  const propertyType = firstReal(property?.property_type, property?.property_class, row.property_type);
  const unitsCount = parseNumber(property?.units_count ?? property?.number_of_units);
  const estimatedValue = parseNumber(property?.estimated_value ?? property?.arv);
  const equityPercent = parseNumber(property?.equity_percent);
  const equityAmount = property ? resolveEquityAmount(property) : null;
  const finalAcquisitionScore = resolvePriorityScore({ property, masterOwner });
  const buildingCondition = firstReal(property?.building_condition, property?.condition);
  const conversationStage = firstReal(
    row.seller_stage,
    dealContext?.universal_stage,
    row.conversation_stage,
    row.universal_stage,
    row.current_stage,
    row.stage,
  );

  const patch = {
    property_id: propertyId || row.property_id || null,
    master_owner_id: masterOwnerId || row.master_owner_id || null,
    prospect_id: prospectId || row.prospect_id || null,
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
    deal_strength_score: parseNumber(property?.deal_strength_score) ?? row.deal_strength_score ?? null,
    tag_distress_score: parseNumber(property?.tag_distress_score) ?? row.tag_distress_score ?? null,
    distress_score: parseNumber(property?.tag_distress_score) ?? row.distress_score ?? row.tag_distress_score ?? null,
    motivation_score: parseNumber(property?.structured_motivation_score)
      ?? parseNumber(property?.motivation_score)
      ?? row.motivation_score
      ?? null,
    property_flags_text: firstReal(property?.property_flags_text, row.property_flags_text) || row.property_flags_text || null,
    priority_score: parseNumber(masterOwner?.priority_score) ?? row.priority_score ?? null,
    building_condition: buildingCondition || null,
    conversation_stage: conversationStage || row.conversation_stage || null,
    universal_stage: conversationStage || row.universal_stage || null,
    current_stage: conversationStage || row.current_stage || null,
    prospect_data: prospect || row.prospect_data || null,
    master_owner_data: masterOwner || row.master_owner_data || null,
    property_data: property || row.property_data || null,
    prospect_best_phone: firstReal(
      row.prospect_best_phone,
      prospect?.best_phone,
      masterOwner?.best_phone_1,
    ),
    prospect_best_email: firstReal(
      row.prospect_best_email,
      prospect?.best_email,
      masterOwner?.best_email_1,
    ),
    prospect_contact_score: parseNumber(prospect?.contact_score_final) ?? row.prospect_contact_score ?? null,
    prospect_phone_score: parseNumber(prospect?.phone_score_final) ?? row.prospect_phone_score ?? null,
    est_household_income: firstReal(row.est_household_income, prospect?.est_household_income),
    net_asset_value: firstReal(row.net_asset_value, prospect?.net_asset_value),
    occupation_group: firstReal(row.occupation_group, prospect?.occupation_group),
    gender: firstReal(row.gender, prospect?.gender),
    marital_status: firstReal(row.marital_status, prospect?.marital_status),
    education_model: firstReal(row.education_model, prospect?.education_model),
    owner_type_guess: firstReal(row.owner_type_guess, masterOwner?.owner_type_guess),
    primary_owner_address: firstReal(row.primary_owner_address, masterOwner?.primary_owner_address),
    portfolio_total_value: parseNumber(masterOwner?.portfolio_total_value) ?? row.portfolio_total_value ?? null,
    portfolio_total_equity: parseNumber(masterOwner?.portfolio_total_equity) ?? row.portfolio_total_equity ?? null,
    property_count: parseNumber(masterOwner?.property_count) ?? row.property_count ?? null,
    portfolio_total_units: parseNumber(masterOwner?.portfolio_total_units) ?? row.portfolio_total_units ?? null,
    financial_pressure_score: parseNumber(masterOwner?.financial_pressure_score) ?? row.financial_pressure_score ?? null,
    best_language: firstReal(row.best_language, masterOwner?.best_language, prospect?.language_preference),
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
  "deal_strength_score",
  "tag_distress_score",
  "structured_motivation_score",
  "property_flags_text",
  "tax_delinquent",
  "active_lien",
].join(",");

const MASTER_OWNER_SELECT = [
  "master_owner_id",
  "display_name",
  "owner_type_guess",
  "priority_score",
  "priority_tier",
  "urgency_score",
  "financial_pressure_score",
  "contactability_score",
  "best_contact_window",
  "portfolio_total_value",
  "portfolio_total_equity",
  "portfolio_total_loan_balance",
  "property_count",
  "portfolio_total_units",
  "tax_delinquent_count",
  "active_lien_count",
  "seller_tags_text",
  "primary_owner_address",
  "best_language",
  "routing_market",
  "routing_timezone",
  "best_phone_1",
  "best_phone_2",
  "best_phone_3",
  "best_email_1",
  "best_email_2",
].join(",");

const PROSPECT_SELECT = [
  "prospect_id",
  "master_owner_id",
  "full_name",
  "first_name",
  "owner_display_name",
  "person_flags_text",
  "matching_flags",
  "occupation_group",
  "est_household_income",
  "net_asset_value",
  "buying_power",
  "contact_score_final",
  "phone_score_final",
  "best_phone",
  "best_email",
  "language_preference",
  "gender",
  "marital_status",
  "education_model",
  "mob",
  "likely_owner",
  "likely_renting",
  "email_score_final",
].join(",");

const DEAL_CONTEXT_SELECT = [
  "thread_key",
  "universal_stage",
  "market",
  "owner_name",
  "property_address_full",
  "property_id",
  "master_owner_id",
  "prospect_id",
].join(",");

async function safeInQuery(supabase, table, select, column, values = []) {
  const unique = [...new Set(values.map((value) => clean(value)).filter(Boolean))];
  if (!unique.length) return [];

  const chunkSize = 200;
  const rows = [];

  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    const { data, error } = await supabase.from(table).select(select).in(column, chunk);
    if (error) {
      console.warn("[INBOX_LINKED_CONTEXT_QUERY_FAILED]", {
        table,
        column,
        message: error.message,
        code: error.code || null,
      });
      return rows;
    }
    rows.push(...(data || []));
  }

  return rows;
}

async function hydrateThreadIdentityFromMessageEvents(rows = [], supabase) {
  if (!rows.length || !supabase?.from) return rows;

  const targets = rows.filter((row) => {
    const propertyId = clean(row.property_id || row.final_property_id);
    const masterOwnerId = clean(row.master_owner_id || row.final_master_owner_id || row.owner_id);
    return !propertyId && !masterOwnerId;
  });
  if (!targets.length) return rows;

  const phones = [...new Set(
    targets
      .map((row) => normalizePhone(
        row.canonical_e164 || row.seller_phone || row.best_phone || row.display_phone || row.thread_key,
      ))
      .filter(Boolean),
  )];
  if (!phones.length) return rows;

  const orClause = phones
    .flatMap((phone) => [
      `from_phone_number.eq.${phone}`,
      `to_phone_number.eq.${phone}`,
      `thread_key.eq.${phone}`,
    ])
    .join(",");

  let query = supabase
    .from("message_events")
    .select("thread_key,from_phone_number,to_phone_number,property_id,master_owner_id,prospect_id,event_timestamp")
    .or(orClause)
    .not("property_id", "is", null);
  if (typeof query.order === "function") {
    query = query.order("event_timestamp", { ascending: false, nullsFirst: false });
  }
  if (typeof query.limit === "function") {
    query = query.limit(Math.min(Math.max(phones.length * 4, 20), 200));
  }

  const { data, error } = await query;
  if (error) {
    console.warn("[INBOX_IDENTITY_FROM_MESSAGES_SKIPPED]", error.message);
    return rows;
  }

  const identityByPhone = new Map();
  for (const message of data || []) {
    const keys = [
      normalizePhone(message.thread_key),
      normalizePhone(message.from_phone_number),
      normalizePhone(message.to_phone_number),
    ].filter(Boolean);
    for (const key of keys) {
      if (!identityByPhone.has(key)) {
        identityByPhone.set(key, message);
      }
    }
  }

  return rows.map((row) => {
    const propertyId = clean(row.property_id || row.final_property_id);
    const masterOwnerId = clean(row.master_owner_id || row.final_master_owner_id || row.owner_id);
    if (propertyId || masterOwnerId) return row;

    const phone = normalizePhone(
      row.canonical_e164 || row.seller_phone || row.best_phone || row.display_phone || row.thread_key,
    );
    const match = phone ? identityByPhone.get(phone) : null;
    if (!match) return row;

    return {
      ...row,
      property_id: clean(match.property_id) || row.property_id || null,
      master_owner_id: clean(match.master_owner_id) || row.master_owner_id || null,
      prospect_id: clean(match.prospect_id) || row.prospect_id || null,
    };
  });
}

export async function bulkHydrateInboxThreadLinkedContext(rows = [], supabase) {
  if (!rows.length || !supabase) return rows;

  const threadKeys = [];
  for (const row of rows) {
    const threadKey = clean(row.thread_key || row.canonical_thread_key);
    if (threadKey) threadKeys.push(threadKey);
  }

  const propertyIds = [];
  const masterOwnerIds = [];
  const prospectIds = [];

  for (const row of rows) {
    const propertyId = clean(row.property_id || row.final_property_id);
    const masterOwnerId = clean(row.master_owner_id || row.final_master_owner_id || row.owner_id);
    const prospectId = clean(row.prospect_id || row.final_prospect_id);
    if (propertyId) propertyIds.push(propertyId);
    if (masterOwnerId) masterOwnerIds.push(masterOwnerId);
    if (prospectId) prospectIds.push(prospectId);
  }

  const dealContexts = await safeInQuery(
    supabase,
    "deal_context_index",
    DEAL_CONTEXT_SELECT,
    "thread_key",
    threadKeys,
  );

  for (const ctx of dealContexts) {
    const propertyId = clean(ctx.property_id);
    const masterOwnerId = clean(ctx.master_owner_id);
    const prospectId = clean(ctx.prospect_id);
    if (propertyId) propertyIds.push(propertyId);
    if (masterOwnerId) masterOwnerIds.push(masterOwnerId);
    if (prospectId) prospectIds.push(prospectId);
  }

  const [properties, masterOwners, prospects] = await Promise.all([
    safeInQuery(supabase, "properties", PROPERTY_SELECT, "property_id", propertyIds),
    safeInQuery(supabase, "master_owners", MASTER_OWNER_SELECT, "master_owner_id", masterOwnerIds),
    safeInQuery(supabase, "prospects", PROSPECT_SELECT, "prospect_id", prospectIds),
  ]);

  const maps = buildLinkedContextMaps({ properties, masterOwners, prospects, dealContexts });

  return rows.map((row) => mergeLinkedContextIntoThreadRow(row, maps));
}

export { hydrateThreadIdentityFromMessageEvents };