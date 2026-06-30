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
} as const

export type StageCode = keyof typeof STAGE_LABELS

export const STAGE_FILTER_OPTIONS = [
  { key: 'all', label: 'All Stages' },
  ...(
    Object.entries(STAGE_LABELS) as Array<[StageCode, string]>
  ).map(([key, label]) => ({ key, label: `${key} · ${label}` })),
]

const STAGE_CODE_ALIASES: Record<string, StageCode> = {
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

export function normalizeStageCode(raw: unknown): StageCode | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  const upper = value.toUpperCase()
  if (upper in STAGE_LABELS) return upper as StageCode
  const alias = STAGE_CODE_ALIASES[value.toLowerCase()]
  if (alias) return alias
  const match = value.match(/s(?:tage)?[_\-\s]?([1-6])(?:f|fu|follow)?/i)
  if (match) {
    const follow = /f|follow/i.test(value)
    return follow && match[1] === '1' ? 'S1F' : (`S${match[1]}` as StageCode)
  }
  if (/follow/i.test(value) && /1|ownership/i.test(value)) return 'S1F'
  return null
}

export function resolveStageLabel(stageCode: unknown, fallbackLabel: string | null = null): string {
  const code = normalizeStageCode(stageCode)
  if (code && STAGE_LABELS[code]) return STAGE_LABELS[code]
  if (fallbackLabel) return String(fallbackLabel).trim()
  return code ? STAGE_LABELS[code] ?? code : STAGE_LABELS.other
}

interface StageRow {
  touch_number?: number | null
  follow_up_number?: number | null
  is_first_touch?: boolean
  is_follow_up?: boolean
  stage_code?: string | null
  metadata?: { touch_number?: number; follow_up_number?: number }
}

export function deriveTouchNumber(row: StageRow = {}): number | null {
  const explicit = Number(row.touch_number ?? row.metadata?.touch_number)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  if (row.is_first_touch === true) return 1
  if (row.is_follow_up === true) return 2
  const code = normalizeStageCode(row.stage_code)
  if (code === 'S1') return 1
  if (code === 'S1F') return 2
  return null
}

export function deriveFollowUpNumber(row: StageRow = {}): number {
  const explicit = Number(row.follow_up_number ?? row.metadata?.follow_up_number)
  if (Number.isFinite(explicit) && explicit >= 0) return explicit
  const code = normalizeStageCode(row.stage_code)
  if (code === 'S1F') return 1
  if (row.is_follow_up === true) return 1
  return 0
}

export const STAGE_SORT_ORDER: StageCode[] = [
  'S1', 'S1F', 'S2', 'S3', 'S4', 'S5', 'S6', 'manual_reply', 'auto_reply', 'other',
]

export function stageSortIndex(raw: unknown): number {
  const code = normalizeStageCode(raw) ?? 'other'
  const idx = STAGE_SORT_ORDER.indexOf(code)
  return idx >= 0 ? idx : STAGE_SORT_ORDER.length
}

export function compareStageCodes(a: unknown, b: unknown): number {
  return stageSortIndex(a) - stageSortIndex(b)
}

export function buildCanonicalDisplayName(row: StageRow & { stage_label?: string | null; language?: string | null } = {}): string {
  const code = normalizeStageCode(row.stage_code) ?? '—'
  const label = resolveStageLabel(code, row.stage_label ?? null)
  const touch = deriveTouchNumber(row)
  const language = String(row.language ?? 'English').trim()
  const touchPart = touch ? `Touch ${touch}` : null
  return [code, label, touchPart, language].filter(Boolean).join(' · ')
}