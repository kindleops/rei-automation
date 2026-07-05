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

const hasHiThereGreeting = (message: string): boolean =>
  /^(hi|hey|hello|hola|ola|marhaba)\s+there\b/i.test(message.trim())

const hasUnresolvedTemplateTokens = (message: string): boolean =>
  /\[\[[a-z0-9_]+\]\]/i.test(message) || /\{\{[^}]+\}\}/.test(message)

const GREETING_NAME_PATTERN = /^\s*(?:hi|hey|hello|hola|ola|marhaba)\s+([^,]+),/i

const hasEntityGreeting = (message: string): boolean => {
  const match = message.trim().match(GREETING_NAME_PATTERN)
  if (!match) return false
  return isEntityName(match[1])
}

const containsForbiddenEntityGreeting = (
  message: string,
  context: Record<string, string>,
): boolean => {
  const ownerName = asString(context.owner_name, '').trim()
  const sellerFullName = asString(context.seller_name, '').trim()
  const sellerFirstName = asString(context.seller_first_name, '').trim()
  const lowered = message.toLowerCase()

  if (ownerName && sellerFirstName && ownerName.toLowerCase() !== sellerFirstName.toLowerCase()) {
    if (lowered.includes(ownerName.toLowerCase())) return true
  }

  if (
    sellerFullName
    && sellerFirstName
    && sellerFullName.toLowerCase() !== sellerFirstName.toLowerCase()
    && lowered.includes(sellerFullName.toLowerCase())
  ) {
    return true
  }

  return false
}

const greetingIncludesSellerFirstName = (message: string, sellerFirstName: string): boolean => {
  const first = asString(sellerFirstName, '').trim()
  if (!first) return false
  const pattern = new RegExp(`\\b${first.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i')
  return pattern.test(message)
}

export type OwnershipTemplateCandidate = {
  template: SmsTemplate
  rendered: string
  weight: number
  templateKey: string
  language: string
}

export type OwnershipTemplateSelection = {
  template: SmsTemplate
  renderedMessage: string
  templateId: string
  templateKey: string
  language: string
  weight: number
  selectionReason: string
  excludedRecentTemplateId: string | null
}

export const evaluateOwnershipTemplate = (
  template: SmsTemplate,
  context: Record<string, string>,
): OwnershipTemplateCandidate | null => {
  const { renderedText, missingVariables } = renderTemplate(template, context)
  const rendered = renderedText.trim()
  if (!rendered) return null
  if (hasBlankGreeting(rendered)) return null
  if (hasHiThereGreeting(rendered)) return null
  if (hasUnresolvedTemplateTokens(rendered)) return null
  if (hasEntityGreeting(rendered)) return null
  if (missingVariables.length > 0) return null
  if (asString(context.seller_first_name, '').trim()
    && !greetingIncludesSellerFirstName(rendered, context.seller_first_name)) {
    return null
  }
  if (containsForbiddenEntityGreeting(rendered, context)) return null

  const raw = template.raw as AnyRecord
  const metadata = (raw.metadata && typeof raw.metadata === 'object'
    ? raw.metadata
    : {}) as AnyRecord
  const weight = Math.max(
    1,
    Number(raw.traffic_weight ?? metadata.traffic_weight ?? 0) || 0,
  )
  const resolvedWeight = weight > 0 ? weight : 1
  const templateKey = asString(
    raw.template_key ?? raw.template_id ?? template.templateId ?? template.id,
    template.id,
  )

  return {
    template,
    rendered,
    weight: resolvedWeight,
    templateKey,
    language: template.language,
  }
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
  options: { excludeTemplateId?: string | null } = {},
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

  let candidates = Array.from(uniqueById.values())
  const excludeId = asString(options.excludeTemplateId, '').trim()
  if (excludeId && candidates.length > 1) {
    const filtered = candidates.filter(
      (entry) => (entry.template.templateId || entry.template.id) !== excludeId,
    )
    if (filtered.length) candidates = filtered
  }

  return candidates
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
  options: { excludeTemplateId?: string | null } = {},
): OwnershipTemplateSelection | null => {
  const pool = buildOwnershipTemplatePool(templates, context, ownerLanguage, options)
  const picked = pickWeightedRandom(pool)
  if (!picked) return null

  const excludeId = asString(options.excludeTemplateId, '').trim() || null
  const selectionReason = excludeId && pool.length > 1 && excludeId !== (picked.template.templateId || picked.template.id)
    ? 'uniform_random_excluding_recent'
    : picked.weight > 1
      ? 'traffic_weighted_random'
      : 'uniform_random'

  return {
    template: picked.template,
    renderedMessage: picked.rendered,
    templateId: picked.template.templateId || picked.template.id,
    templateKey: picked.templateKey,
    language: picked.language,
    weight: picked.weight,
    selectionReason,
    excludedRecentTemplateId: excludeId,
  }
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

export const fetchRecentOwnershipCheckTemplateId = async (
  propertyId: string,
  recipientPhone: string,
): Promise<string | null> => {
  const normalizedPropertyId = asString(propertyId, '').trim()
  const normalizedPhone = asString(recipientPhone, '').trim()
  if (!normalizedPropertyId || !normalizedPhone) return null

  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('send_queue')
    .select('template_id, selected_template_id, metadata')
    .eq('property_id', normalizedPropertyId)
    .eq('to_phone_number', normalizedPhone)
    .eq('message_type', 'ownership_check')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null
  const row = data as AnyRecord
  const metadata = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as AnyRecord
  return asString(
    row.selected_template_id ?? row.template_id ?? metadata.selected_template_id ?? metadata.template_id,
    '',
  ) || null
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
  context: Record<string, string>,
  ownerLanguage: string,
  options: {
    propertyId?: string | null
    recipientPhone?: string | null
    random?: () => number
  } = {},
): Promise<OwnershipTemplateSelection | null> => {
  const [templates, recentTemplateId] = await Promise.all([
    fetchOwnershipCheckTemplates(),
    options.propertyId && options.recipientPhone
      ? fetchRecentOwnershipCheckTemplateId(options.propertyId, options.recipientPhone)
      : Promise.resolve(null),
  ])

  const originalRandom = Math.random
  if (options.random) {
    Math.random = options.random
  }
  try {
    return pickRandomOwnershipCheckTemplate(templates, context, ownerLanguage, {
      excludeTemplateId: recentTemplateId,
    })
  } finally {
    Math.random = originalRandom
  }
}