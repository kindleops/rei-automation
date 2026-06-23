/** Canonical outbound stage labels for Template Intelligence. */

export const STAGE_LABELS = {
  S1: 'Ownership Confirmation',
  S1F: 'Ownership Follow-Up',
  S2: 'Selling Interest',
  S3: 'Asking Price',
  S4: 'Condition & Underwriting',
  S5: 'Offer & Negotiation',
  S6: 'Contract to Close',
  manual_reply: 'Manual Reply',
  auto_reply: 'Auto Reply',
  other: 'Other',
}

const STAGE_CODE_ALIASES = {
  s1: 'S1',
  s1f: 'S1F',
  's1-f': 'S1F',
  s1_follow_up: 'S1F',
  s2: 'S2',
  s3: 'S3',
  s4: 'S4',
  s5: 'S5',
  s6: 'S6',
  stage_1: 'S1',
  stage_2: 'S2',
  stage_3: 'S3',
  stage_4: 'S4',
  stage_5: 'S5',
  stage_6: 'S6',
}

export function normalizeStageCode(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return null
  const upper = value.toUpperCase()
  if (STAGE_LABELS[upper]) return upper
  const alias = STAGE_CODE_ALIASES[value.toLowerCase()]
  if (alias) return alias
  const match = value.match(/s(?:tage)?[_\-\s]?([1-6])(?:f|fu|follow)?/i)
  if (match) {
    const follow = /f|follow/i.test(value)
    return follow && match[1] === '1' ? 'S1F' : `S${match[1]}`
  }
  if (/follow/i.test(value) && /1|ownership/i.test(value)) return 'S1F'
  return null
}

export function resolveStageLabel(stageCode, fallbackLabel = null) {
  const code = normalizeStageCode(stageCode)
  if (code && STAGE_LABELS[code]) return STAGE_LABELS[code]
  if (fallbackLabel) return String(fallbackLabel).trim()
  return code ? STAGE_LABELS[code] ?? code : 'Other'
}

export function deriveTouchNumber(row = {}) {
  const explicit = Number(row.touch_number ?? row.metadata?.touch_number)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  if (row.is_first_touch === true) return 1
  if (row.is_follow_up === true) return 2
  const code = normalizeStageCode(row.stage_code)
  if (code === 'S1') return 1
  if (code === 'S1F') return 2
  return null
}

export function deriveFollowUpNumber(row = {}) {
  const explicit = Number(row.follow_up_number ?? row.metadata?.follow_up_number)
  if (Number.isFinite(explicit) && explicit >= 0) return explicit
  const code = normalizeStageCode(row.stage_code)
  if (code === 'S1F') return 1
  if (row.is_follow_up === true) return 1
  return 0
}

export function buildCanonicalDisplayName(row = {}) {
  const code = normalizeStageCode(row.stage_code) ?? '—'
  const label = resolveStageLabel(code, row.stage_label)
  const touch = deriveTouchNumber(row)
  const language = String(row.language ?? 'English').trim()
  const touchPart = touch ? `Touch ${touch}` : null
  return [code, label, touchPart, language].filter(Boolean).join(' · ')
}