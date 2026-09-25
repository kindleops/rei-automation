/**
 * The last asset check before transport.
 *
 * Every template-backed row — first touch, campaign, follow-up, deferred,
 * auto-reply — passes here after its body is final and before the provider
 * is called, so no selection path can ship an asset/template mismatch no
 * matter how it chose. It judges the stored template AND the rendered body
 * (the words the seller would read) against the property's canonical
 * classification, loaded fresh from `properties`.
 *
 * Operator-typed sends are exempt: the operator chose those words.
 */
import {
  isTemplateCompatibleWithProperty,
  canonicalPropertyGroupOf,
} from '@/lib/domain/templates/template-asset-compatibility.js'

const PROPERTY_ASSET_COLUMNS = [
  'property_id', 'property_type', 'property_class', 'units_count', 'asset_class', 'asset_subclass',
  'normalized_asset_subclass', 'property_group', 'original_property_type', 'commercial_property_type',
  'is_self_storage', 'is_storage', 'is_mini_storage', 'is_storage_facility', 'is_self_storage_facility',
  'is_mini_storage_facility', 'is_commercial_retail', 'building_square_feet', 'total_bedrooms', 'year_built',
].join(',')

const TEMPLATE_COLUMNS = 'template_id,property_type_scope,stage_code,use_case,language,template_body,allowed_property_groups,prohibited_property_groups'

const clean = (v) => String(v ?? '').trim()

export function queueTemplateIdOf(row = {}) {
  return clean(row.selected_template_id) || clean(row.template_id) || clean(row?.metadata?.selected_template_id) || null
}

/** The property's canonical classification, or null. */
export async function loadPropertyAssetRecord(supabase, property_id) {
  if (!supabase || !clean(property_id)) return null
  const { data } = await supabase.from('properties').select(PROPERTY_ASSET_COLUMNS).eq('property_id', property_id).maybeSingle()
  return data || null
}

/**
 * @returns {Promise<{ allowed: boolean, reason: string, property_group: string, checks: object[] }>}
 */
export async function evaluateTemplateAssetGuard({ supabase, queue_row, body }) {
  const row = queue_row || {}
  const templateId = queueTemplateIdOf(row)

  const property = await loadPropertyAssetRecord(supabase, row.property_id)
  // The row's own snapshot when the property record is unavailable.
  const assetProperty = property || {
    property_type: row.property_type,
    canonical_property_group: row?.metadata?.candidate_snapshot?.canonical_property_group,
    units_count: row?.metadata?.candidate_snapshot?.units_count,
  }
  const propertyGroup = canonicalPropertyGroupOf(assetProperty)

  let template = null
  if (supabase && templateId) {
    const { data } = await supabase.from('sms_templates').select(TEMPLATE_COLUMNS).eq('template_id', templateId).maybeSingle()
    template = data || null
  }

  const checks = []
  if (template) {
    checks.push({ source: 'template', ...isTemplateCompatibleWithProperty({ template, propertyGroup }) })
  }
  // The rendered body is judged on its own — it is what the seller reads,
  // and deferred/rotated rows can carry a body from a different template.
  const text = clean(body)
  if (text) {
    checks.push({ source: 'rendered_body', ...isTemplateCompatibleWithProperty({ template: { template_body: text }, propertyGroup, wordsOnly: true }) })
  }

  const failed = checks.find((c) => !c.compatible)
  return {
    allowed: !failed,
    reason: failed ? failed.reason : 'template_asset_compatible',
    property_group: propertyGroup,
    template_id: templateId,
    checks: checks.map(({ source, compatible, reason, templateScope }) => ({ source, compatible, reason, template_scope: templateScope })),
  }
}
