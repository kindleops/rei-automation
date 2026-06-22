/**
 * Evidence field wrapper — never silently convert missing to zero.
 */

function clean(value) {
  return String(value ?? '').trim();
}

export function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

export function evidenceField(value, {
  source = null,
  sourceTimestamp = null,
  confidence = null,
  applicability = 'subject',
  missingReason = null,
} = {}) {
  if (!hasValue(value)) {
    return {
      value: null,
      source,
      source_timestamp: sourceTimestamp,
      confidence,
      applicability,
      missing_reason: missingReason ?? 'not_available',
      present: false,
    };
  }
  return {
    value,
    source,
    source_timestamp: sourceTimestamp,
    confidence,
    applicability,
    missing_reason: null,
    present: true,
  };
}

export function evidenceNumber(value, meta = {}) {
  if (!hasValue(value)) return evidenceField(null, meta);
  const n = Number(String(value).replace(/[$,]/g, ''));
  if (!Number.isFinite(n)) return evidenceField(null, { ...meta, missingReason: 'invalid_number' });
  return evidenceField(n, meta);
}

export function evidenceString(value, meta = {}) {
  const text = clean(value);
  if (!text || text.toLowerCase() === 'unknown' || text.toLowerCase() === 'n/a') {
    return evidenceField(null, { ...meta, missingReason: meta.missingReason ?? 'empty_or_unknown' });
  }
  return evidenceField(text, meta);
}

export default { evidenceField, evidenceNumber, evidenceString, hasValue };