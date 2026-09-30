/**
 * One asset, several vendor labels.
 *
 * campaign_target_graph.property_type carries "Apartment" (8,983 rows, median
 * 3 units) and "Multi-Family" (32,164 rows, median 2 units) for the same
 * multifamily class, plus one "Multifamily 5+"; "SFR" (4 rows) is "Single
 * Family". The canonical taxonomy (template-asset-compatibility.js) already
 * treats each set as one class. Choosing "Multi-Family" used to silently miss
 * every "Apartment" row, and choosing "Apartment" did not mean 5+ units.
 *
 * Shared by the audience predicate (campaign-graph-filter-plan.js) and the
 * builder's option list (campaign-field-catalog.js), so the option the
 * operator picks is exactly the set the filter applies.
 */
export const PROPERTY_TYPE_FAMILIES = Object.freeze([
  Object.freeze({ value: 'Single Family', label: 'Single Family', members: Object.freeze(['Single Family', 'SFR']) }),
  Object.freeze({ value: 'Multi-Family', label: 'Multi-Family (incl. Apartment)', members: Object.freeze(['Multi-Family', 'Apartment', 'Multifamily 5+']) }),
])

function lowerText(value) {
  return String(value ?? '').trim().toLowerCase()
}

export function propertyTypeFamilyOf(value) {
  const key = lowerText(value)
  if (!key) return null
  return PROPERTY_TYPE_FAMILIES.find((family) =>
    lowerText(family.value) === key || family.members.some((member) => lowerText(member) === key)) || null
}

/** The graph values a property-type selection stands for. */
export function expandPropertyTypeValues(values = []) {
  const out = new Set()
  for (const raw of values || []) {
    const value = String(raw ?? '').trim()
    if (!value) continue
    const family = propertyTypeFamilyOf(value)
    if (family) family.members.forEach((member) => out.add(member))
    else out.add(value)
  }
  return [...out]
}

/**
 * Facet options with each family collapsed into one option (counts summed),
 * ordered by count. Non-family values pass through unchanged.
 */
export function collapsePropertyTypeOptions(options = []) {
  const merged = new Map()
  for (const option of options || []) {
    const family = propertyTypeFamilyOf(option?.value)
    const key = family ? `family:${family.value}` : `value:${option?.value}`
    const current = merged.get(key)
    if (!current) {
      merged.set(key, family
        ? { ...option, value: family.value, label: family.label, members: [...family.members] }
        : { ...option })
      continue
    }
    for (const field of ['count', 'clean_count', 'queueable_count', 'sender_covered_count', 'sms_eligible_count', 'healthy_count']) {
      if (field in option || field in current) current[field] = Number(current[field] || 0) + Number(option[field] || 0)
    }
  }
  return [...merged.values()].sort((left, right) => Number(right.count || 0) - Number(left.count || 0))
}
