// Workflow Studio V2 — asset-class underwriting playbooks.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';

export const ASSET_PLAYBOOKS = Object.freeze({
  single_family: {
    required_facts: [
      'occupancy_status',
      'property_condition',
      'bedrooms',
      'bathrooms',
      'square_feet',
      'year_built',
      'lot_size',
      'hoa_status',
      'mortgage_balance',
      'asking_price',
    ],
    escalation_threshold_missing: 4,
  },
  multifamily_2_4: {
    required_facts: [
      'unit_count',
      'occupancy_by_unit',
      'monthly_rent_roll',
      'operating_expenses',
      'property_condition',
      'utilities_paid_by',
      'asking_price',
    ],
    escalation_threshold_missing: 3,
  },
  multifamily_5_plus: {
    required_facts: [
      'unit_count',
      'rent_roll',
      'vacancy_rate',
      'noi',
      'operating_expenses',
      'property_management',
      'cap_ex_needs',
      'asking_price',
    ],
    escalation_threshold_missing: 3,
  },
  self_storage: {
    required_facts: [
      'unit_count',
      'occupancy_rate',
      'average_rent_per_unit',
      'climate_control_mix',
      'property_condition',
      'asking_price',
    ],
    escalation_threshold_missing: 3,
  },
  retail_strip: {
    required_facts: [
      'tenant_count',
      'lease_terms',
      'vacancy_rate',
      'nnn_structure',
      'property_condition',
      'asking_price',
    ],
    escalation_threshold_missing: 3,
  },
  office_industrial_commercial: {
    required_facts: [
      'square_feet',
      'lease_structure',
      'tenant_profile',
      'vacancy_rate',
      'property_condition',
      'environmental_flags',
      'asking_price',
    ],
    escalation_threshold_missing: 3,
  },
  land: {
    required_facts: [
      'acreage',
      'zoning',
      'utilities_available',
      'access_road',
      'entitlements',
      'asking_price',
    ],
    escalation_threshold_missing: 2,
  },
});

const QUESTION_LIBRARY = Object.freeze({
  occupancy_status: 'Is the property currently occupied, vacant, or tenant-occupied?',
  property_condition: 'How would you describe the current condition of the property?',
  bedrooms: 'How many bedrooms does the property have?',
  bathrooms: 'How many bathrooms does the property have?',
  square_feet: 'What is the approximate square footage?',
  year_built: 'What year was the property built?',
  lot_size: 'What is the lot size?',
  hoa_status: 'Is there an HOA, and if so what are the monthly dues?',
  mortgage_balance: 'Do you have an approximate mortgage balance remaining?',
  asking_price: 'What price are you hoping to get for the property?',
  unit_count: 'How many units does the property have?',
  occupancy_by_unit: 'Which units are occupied and what are the current rents?',
  monthly_rent_roll: 'What is the current monthly rent roll?',
  operating_expenses: 'What are the monthly operating expenses?',
  utilities_paid_by: 'Are utilities paid by owner or tenant?',
  rent_roll: 'Can you share the current rent roll?',
  vacancy_rate: 'What is the current vacancy rate?',
  noi: 'Do you know the current NOI?',
  property_management: 'Is the property self-managed or professionally managed?',
  cap_ex_needs: 'Are there any major capital expenditures needed soon?',
  occupancy_rate: 'What is the current occupancy rate?',
  average_rent_per_unit: 'What is the average rent per unit?',
  climate_control_mix: 'What mix of climate-controlled vs non-climate units do you have?',
  tenant_count: 'How many tenants are in the strip?',
  lease_terms: 'What are the remaining lease terms for each tenant?',
  nnn_structure: 'Are leases NNN, gross, or modified gross?',
  square_feet: 'What is the leasable square footage?',
  lease_structure: 'What lease structure is in place?',
  tenant_profile: 'Who is the current tenant or target tenant profile?',
  environmental_flags: 'Are there any known environmental issues?',
  acreage: 'How many acres is the parcel?',
  zoning: 'What is the current zoning?',
  utilities_available: 'Which utilities are available at the site?',
  access_road: 'What kind of road access does the parcel have?',
  entitlements: 'Are there any entitlements or approvals already in place?',
});

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function normalizeAssetClass(assetClass) {
  const normalized = lower(assetClass).replace(/[\s-]+/g, '_');
  if (normalized.includes('single') || normalized === 'sfr' || normalized === 'residential') {
    return 'single_family';
  }
  if (normalized.includes('5_plus') || normalized.includes('5plus') || normalized.includes('commercial_multifamily')) {
    return 'multifamily_5_plus';
  }
  if (normalized.includes('2_4') || normalized.includes('2-4') || normalized.includes('duplex')) {
    return 'multifamily_2_4';
  }
  if (normalized.includes('storage')) return 'self_storage';
  if (normalized.includes('retail') || normalized.includes('strip')) return 'retail_strip';
  if (normalized.includes('office') || normalized.includes('industrial') || normalized.includes('commercial')) {
    return 'office_industrial_commercial';
  }
  if (normalized.includes('land') || normalized.includes('vacant_lot')) return 'land';
  return normalized || 'single_family';
}

function contextValue(context, key) {
  if (context[key] !== undefined && context[key] !== null && clean(context[key]) !== '') {
    return context[key];
  }
  const underwriting = context.underwriting_facts ?? context.underwriting ?? {};
  if (underwriting[key] !== undefined && underwriting[key] !== null && clean(underwriting[key]) !== '') {
    return underwriting[key];
  }
  const extracted = context.extracted_facts ?? {};
  if (extracted[key] !== undefined && extracted[key] !== null && clean(extracted[key]) !== '') {
    return extracted[key]?.value ?? extracted[key];
  }
  return null;
}

export function getRequiredFacts(assetClass) {
  const key = normalizeAssetClass(assetClass);
  return [...(ASSET_PLAYBOOKS[key]?.required_facts ?? ASSET_PLAYBOOKS.single_family.required_facts)];
}

export function getMissingFacts(assetClass, context = {}) {
  const required = getRequiredFacts(assetClass);
  return required.filter((factKey) => contextValue(context, factKey) === null);
}

export function buildUnderwritingQuestions(assetClass, context = {}) {
  const missing = getMissingFacts(assetClass, context);
  return missing.map((factKey) => ({
    fact_key: factKey,
    question: QUESTION_LIBRARY[factKey] ?? `Please provide ${factKey.replace(/_/g, ' ')}.`,
    required: true,
  }));
}

export async function persistPartialAnswers(enrollmentId, answers = {}, deps = {}) {
  const client = db(deps);
  const enrollment_id = clean(enrollmentId);
  if (!enrollment_id) return { ok: false, error: 'enrollment_id_required' };

  const current = await client
    .from('workflow_enrollments')
    .select('context')
    .eq('id', enrollment_id)
    .maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) return { ok: false, error: 'enrollment_not_found' };

  const ctx = current.data.context ?? {};
  const underwritingFacts = { ...(ctx.underwriting_facts ?? {}) };
  for (const [key, value] of Object.entries(answers)) {
    if (value !== undefined && value !== null && clean(value) !== '') {
      underwritingFacts[key] = value;
    }
  }

  const { data, error } = await client
    .from('workflow_enrollments')
    .update({
      context: {
        ...ctx,
        underwriting_facts: underwritingFacts,
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', enrollment_id)
    .select('*')
    .single();
  if (error) throw error;

  return { ok: true, enrollment: data, underwriting_facts: underwritingFacts };
}

export function shouldRunUnderwriting(assetClass, context = {}) {
  const missing = getMissingFacts(assetClass, context);
  const askingPrice = contextValue(context, 'asking_price');
  const interest = lower(context.seller_interest_level ?? context.interest_level ?? '');
  return missing.length > 0 || (askingPrice !== null && ['interested', 'latent_interest'].includes(interest));
}

export function shouldEscalate(assetClass, context = {}) {
  const key = normalizeAssetClass(assetClass);
  const playbook = ASSET_PLAYBOOKS[key] ?? ASSET_PLAYBOOKS.single_family;
  const missing = getMissingFacts(assetClass, context);
  return missing.length >= Number(playbook.escalation_threshold_missing ?? 3);
}