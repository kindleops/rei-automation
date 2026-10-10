// Minimal JSON-Schema subset validator for tool inputs (no dependency).
// Supports: type (object|string|integer|number|boolean|array), properties,
// required, additionalProperties:false, enum, maxLength, minLength, pattern,
// minimum, maximum, items, maxItems, minItems. Tool input schemas MUST be
// closed objects with bounded strings/arrays (checked by defineTool).

function typeOf(v) {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  if (Number.isInteger(v)) return 'integer'
  return typeof v
}

export function validateSchema(schema, value, path = '$') {
  const errors = []
  const t = schema.type
  const actual = typeOf(value)
  if (t) {
    const ok = t === actual || (t === 'number' && actual === 'integer')
    if (!ok) return [`${path}: expected ${t}, got ${actual}`]
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not in enum`)
  if (t === 'string') {
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`)
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`)
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern mismatch`)
  }
  if (t === 'integer' || t === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`)
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`)
  }
  if (t === 'array') {
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`)
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`)
    if (schema.items) value.forEach((v, i) => errors.push(...validateSchema(schema.items, v, `${path}[${i}]`)))
  }
  if (t === 'object') {
    const props = schema.properties || {}
    for (const r of schema.required || []) if (value[r] === undefined) errors.push(`${path}.${r}: required`)
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errors.push(...validateSchema(props[k], v, `${path}.${k}`))
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: not allowed`)
    }
  }
  return errors
}

/** A schema is "bounded" if it is a closed object and every string/array has a max. */
export function schemaBoundednessErrors(schema, path = '$') {
  const errs = []
  if (!schema || typeof schema !== 'object') return [`${path}: schema required`]
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) errs.push(`${path}: additionalProperties must be false`)
    for (const [k, s] of Object.entries(schema.properties || {})) errs.push(...schemaBoundednessErrors(s, `${path}.${k}`))
  } else if (schema.type === 'string') {
    if (schema.maxLength == null && !schema.enum) errs.push(`${path}: string needs maxLength or enum`)
  } else if (schema.type === 'array') {
    if (schema.maxItems == null) errs.push(`${path}: array needs maxItems`)
    if (schema.items) errs.push(...schemaBoundednessErrors(schema.items, `${path}[]`))
  }
  return errs
}
