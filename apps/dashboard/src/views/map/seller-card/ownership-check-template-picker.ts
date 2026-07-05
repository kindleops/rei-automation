import { getSupabaseClient } from '../../../lib/supabaseClient'
import {
  normalizeSmsTemplate,
  renderTemplate,
  type SmsTemplate,
} from '../../../lib/data/templateData'
import { asString, type AnyRecord } from '../../../lib/data/shared'
import { isEntityName } from '../../../lib/identity/entityDetection'

const OWNERSHIP_CHECK_USE_CASE = 'ownership_check'

const OWNER_LANGUAGE_ALIASES: Record<string, string> = {
  english: 'English',
  spanish: 'Spanish',
  espanol: 'Spanish',
  español: 'Spanish',
  portuguese: 'Portuguese',
  italian: 'Italian',
  vietnamese: 'Vietnamese',
  french: 'French',
  german: 'German',
  greek: 'Greek',
  russian: 'Russian',
  polish: 'Polish',
  arabic: 'Arabic',
  hebrew: 'Hebrew',
  japanese: 'Japanese',
  korean: 'Korean',
  mandarin: 'Mandarin',
  chinese: 'Mandarin',
  hindi: 'Indian (Hindi or Other)',
  'indian (hindi or other)': 'Indian (Hindi or Other)',
  'asian indian (hindi or other)': 'Indian (Hindi or Other)',
}

export const canonicalizeOwnerLanguage = (value: unknown): string => {
  const raw = asString(value, '').trim()
  if (!raw) return 'English'
  const lowered = raw.toLowerCase()
  if (OWNER_LANGUAGE_ALIASES[lowered]) return OWNER_LANGUAGE_ALIASES[lowered]
  return raw
}

export const languagesMatchForTemplate = (ownerLanguage: string, templateLanguage: string): boolean => {
  const owner = canonicalizeOwnerLanguage(ownerLanguage)
  const template = canonicalizeOwnerLanguage(templateLanguage)
  if (owner.toLowerCase() === template.toLowerCase()) return true

  const ownerToken = owner.toLowerCase()
  const templateToken = template.toLowerCase()
  if (ownerToken.includes('hindi') && templateToken.includes('hindi')) return true
  if (ownerToken.includes('indian') && templateToken.includes('indian')) return true
  return false
}

const hasBlankGreeting = (message: string): boolean =>
  /^(hi|hey|hello|hola|ola|marhaba)\s*,/i.test(message.trim())

const hasUnresolvedTemplateTokens = (message: string): boolean =>
  /\[\[[a-z0-9_]+\]\]/i.test(message) || /\{\{[^}]+\}\}/.test(message)

// Final safety rail: even if an entity name reaches this point through some other
// path, never let it go out addressed to "Hey West 7th Apartments LLC,". Checks the
// literal greeting-name slot, not the whole message (which may legitimately mention
// an LLC/company later in the body).
const GREETING_NAME_PATTERN = /^\s*(?:hi|hey|hello|hola|ola|marhaba)\s+([^,]+),/i

const hasEntityGreeting = (message: string): boolean => {
  const match = message.trim().match(GREETING_NAME_PATTERN)
  if (!match) return false
  return isEntityName(match[1])
}

const repairRenderedTemplate = (message: string): string =>
  message
    .replace(/^(hi|hey|hello|hola|ola|marhaba)\s+,/i, '$1 there,')
    .replace(/^(hi|hey|hello|hola|ola|marhaba)\s*,/i, '$1 there,')
    .replace(/\[\[[a-z0-9_]+\]\]/gi, '')
    .trim()

export type OwnershipTemplateCandidate = {
  template: SmsTemplate
  repaired: string
  weight: number
}

export const evaluateOwnershipTemplate = (
  template: SmsTemplate,
  context: Record<string, string>,
): OwnershipTemplateCandidate | null => {
  const { renderedText, missingVariables } = renderTemplate(template, context)
  const repaired = repairRenderedTemplate(renderedText)
  if (!repaired) return null
  if (hasBlankGreeting(repaired)) return null
  if (hasUnresolvedTemplateTokens(repaired)) return null
  if (hasEntityGreeting(repaired)) return null
  if (missingVariables.length > 0) return null

  const raw = template.raw as AnyRecord
  const metadata = (raw.metadata && typeof raw.metadata === 'object'
    ? raw.metadata
    : {}) as AnyRecord
  const weight = Math.max(
    1,
    Number(raw.traffic_weight ?? metadata.traffic_weight ?? raw.usage_count ?? 1) || 1,
  )

  return { template, repaired, weight }
}

export const filterOwnershipTemplatesForLanguage = (
  templates: SmsTemplate[],
  ownerLanguage: string,
): SmsTemplate[] => {
  const languageMatched = templates.filter((template) =>
    languagesMatchForTemplate(ownerLanguage, template.language),
  )
  if (languageMatched.length) return languageMatched
  return templates.filter((template) => languagesMatchForTemplate('English', template.language))
}

const evaluateTemplates = (
  templates: SmsTemplate[],
  context: Record<string, string>,
): OwnershipTemplateCandidate[] =>
  templates
    .map((template) => evaluateOwnershipTemplate(template, context))
    .filter((entry): entry is OwnershipTemplateCandidate => Boolean(entry))

export const buildOwnershipTemplatePool = (
  templates: SmsTemplate[],
  context: Record<string, string>,
  ownerLanguage: string,
): OwnershipTemplateCandidate[] => {
  const languageScoped = filterOwnershipTemplatesForLanguage(templates, ownerLanguage)
  const firstTouch = languageScoped.filter((template) => template.isFirstTouch)

  // Prefer personalized first-touch templates, but that preference must be based
  // on whether one actually renders successfully with the resolved context — not
  // merely whether one exists. When the recipient's name is unresolved (no linked
  // prospect), every first-touch template requiring {{seller_first_name}} will
  // fail to render; in that case fall through to the full language-scoped set so
  // an approved generic (name-free) template can still be selected, instead of
  // reporting no compatible template while one actually exists.
  const firstTouchPool = evaluateTemplates(firstTouch, context)
  const pool = firstTouchPool.length ? firstTouchPool : evaluateTemplates(languageScoped, context)

  const uniqueById = new Map<string, OwnershipTemplateCandidate>()
  for (const entry of pool) {
    const key = entry.template.templateId || entry.template.id
    if (!uniqueById.has(key)) uniqueById.set(key, entry)
  }
  return Array.from(uniqueById.values())
}

export const pickWeightedRandom = <T extends { weight: number }>(items: T[]): T | null => {
  if (!items.length) return null
  const totalWeight = items.reduce((sum, item) => sum + Math.max(1, item.weight), 0)
  let roll = Math.random() * totalWeight
  for (const item of items) {
    roll -= Math.max(1, item.weight)
    if (roll <= 0) return item
  }
  return items[items.length - 1] ?? null
}

export const pickRandomOwnershipCheckTemplate = (
  templates: SmsTemplate[],
  context: Record<string, string>,
  ownerLanguage: string,
): SmsTemplate | null => {
  const pool = buildOwnershipTemplatePool(templates, context, ownerLanguage)
  return pickWeightedRandom(pool)?.template ?? null
}

let ownershipTemplateCache: { expiresAt: number; templates: SmsTemplate[] } | null = null

export const fetchOwnershipCheckTemplates = async (): Promise<SmsTemplate[]> => {
  const now = Date.now()
  if (ownershipTemplateCache && ownershipTemplateCache.expiresAt > now) {
    return ownershipTemplateCache.templates
  }

  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('sms_templates')
    .select('*')
    .eq('use_case', OWNERSHIP_CHECK_USE_CASE)
    .eq('is_active', true)
    .limit(2000)

  if (error) {
    throw new Error(error.message || 'ownership_check_templates_unavailable')
  }

  const templates = (Array.isArray(data) ? data : []).map((row) => normalizeSmsTemplate(row as AnyRecord))
  ownershipTemplateCache = {
    templates,
    expiresAt: now + 60_000,
  }
  return templates
}

export const resolveMapOwnerLanguage = async (
  record: Record<string, unknown>,
  masterOwnerId: string | null,
): Promise<string> => {
  const inline = asString(
    record.best_language
    ?? record.bestLanguage
    ?? record.language_preference
    ?? record.languagePreference
    ?? record.language
    ?? record.seller_language
    ?? record.sellerLanguage,
    '',
  ).trim()
  if (inline) return canonicalizeOwnerLanguage(inline)

  const ownerId = asString(masterOwnerId, '').trim()
  if (!ownerId) return 'English'

  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('master_owners')
    .select('best_language')
    .eq('master_owner_id', ownerId)
    .limit(1)
    .maybeSingle()

  if (error) return 'English'
  return canonicalizeOwnerLanguage((data as AnyRecord | null)?.best_language)
}

export const pickOwnershipCheckTemplateForMap = async (
  record: Record<string, unknown>,
  context: Record<string, string>,
  masterOwnerId: string | null,
): Promise<SmsTemplate | null> => {
  const [templates, ownerLanguage] = await Promise.all([
    fetchOwnershipCheckTemplates(),
    resolveMapOwnerLanguage(record, masterOwnerId),
  ])
  return pickRandomOwnershipCheckTemplate(templates, context, ownerLanguage)
}