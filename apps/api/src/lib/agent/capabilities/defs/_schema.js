// Closed, bounded JSON-schema helpers for capability inputs (validated by tools/schema.js).
export const UUID = Object.freeze({ type: 'string', minLength: 36, maxLength: 36, pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' })
export const str = (max, extra = {}) => ({ type: 'string', maxLength: max, ...extra })
export const int = (min, max) => ({ type: 'integer', minimum: min, maximum: max })
export const num = (min, max) => ({ type: 'number', minimum: min, maximum: max })
export const bool = () => ({ type: 'boolean' })
export const enumOf = (values) => ({ type: 'string', enum: [...values] })
export const list = (items, maxItems) => ({ type: 'array', maxItems, items })
export const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required })

const clean = (v) => String(v ?? '').trim()
export { clean }
export const lower = (v) => clean(v).toLowerCase()
export const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
export const isoOrNull = (v) => (v ? String(v).slice(0, 40) : null)
