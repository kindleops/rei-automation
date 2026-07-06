import { getSupabaseClient } from '../../../lib/supabaseClient'
import {
  fetchTemplatesByUseCase,
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
  'mandarin chinese': 'Mandarin',
  chinese: 'Mandarin',
  zh: 'Mandarin',
  'zh-cn': 'Mandarin',
  cn: 'Mandarin',
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
  const mandarinFamily = new Set(['mandarin', 'chinese', 'zh', 'zh-cn', 'cn'])
  if (mandarinFamily.has(ownerToken) && mandarinFamily.has(templateToken)) return true
  return false
}

const usesNonLatinSellerNameMatching = (sellerFirstName: string): boolean =>
  /[\u3040-\u9fff\u3400-\u4dbf\uac00-\ud7af\u0600-\u06ff\u0590-\u05ff]/.test(sellerFirstName)

// Mirror apps/api textgrid.js BLANK_GREETING_RE — any "Hi," opener is provider-blocked.
export const TEXTGRID_BLANK_GREETING_RE =
  /^(Hello|Hi|Hey|Hola|Ola|Marhaba)\s*,|(Hello\s*,|Hey\s*,|Hi\s*,|Hola\s*,|Ola\s*,|Marhaba\s*,)/i

export const hasTextgridBlockedGreeting = (message: string): boolean =>
  TEXTGRID_BLANK_GREETING_RE.test(message.trim())

const hasBlankGreeting = (message: string): boolean =>
  hasTextgridBlockedGreeting(message)

const hasHiThereGreeting = (message: string): boolean =>
  /^(hi|hey|hello|hola|ola|marhaba)\s+there\b/i.test(message.trim())

const hasGenericRightPersonWording = (message: string): boolean =>
  /\bright person\b/i.test(message)
  || /\bwho handles\b/i.test(message)
  || /\btrying to reach\b/i.test(message)
  || /\bhad a quick question\b/i.test(message)
  || /\bare you connected with\b/i.test(message)

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

  // Reject only when the resolved seller full name is itself an entity/LLC/trust
  // (a leaked master-owner display name), not ordinary human full names such as
  // "Amanda L Tallen" that templates may legitimately use via {{seller_name}}.
  if (
    sellerFullName
    && isEntityName(sellerFullName)
    && lowered.includes(sellerFullName.toLowerCase())
  ) {
    return true
  }

  return false
}

const greetingIncludesSellerFirstName = (message: string, sellerFirstName: string): boolean => {
  const first = asString(sellerFirstName, '').trim()
  if (!first) return false
  if (usesNonLatinSellerNameMatching(first)) {
    return message.includes(first)
  }
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

export type EvaluateOwnershipTemplateOptions = {
  /** When true and seller_first_name is resolved, reject templates that omit it from the greeting. */
  requireSellerNameInGreeting?: boolean
}

export const evaluateOwnershipTemplate = (
  template: SmsTemplate,
  context: Record<string, string>,
  options: EvaluateOwnershipTemplateOptions = {},
): OwnershipTemplateCandidate | null => {
  const requireSellerNameInGreeting = options.requireSellerNameInGreeting !== false
  const { renderedText, missingVariables } = renderTemplate(template, context)
  const rendered = renderedText.trim()
  if (!rendered) return null
  if (hasBlankGreeting(rendered)) return null
  if (hasHiThereGreeting(rendered)) return null
  if (hasUnresolvedTemplateTokens(rendered)) return null
  if (hasEntityGreeting(rendered)) return null
  if (missingVariables.length > 0) return null
  const sellerFirstName = asString(context.seller_first_name, '').trim()
  if (
    requireSellerNameInGreeting
    && sellerFirstName
    && !greetingIncludesSellerFirstName(rendered, sellerFirstName)
  ) {
    return null
  }
  if (hasGenericRightPersonWording(rendered)) {
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
  const canonical = canonicalizeOwnerLanguage(ownerLanguage)
  const languageMatched = templates.filter((template) =>
    languagesMatchForTemplate(canonical, template.language),
  )
  if (languageMatched.length) return languageMatched
  // Never silently downgrade a Mandarin/Spanish/etc prospect to English templates.
  if (canonical.toLowerCase() === 'english') {
    return templates.filter((template) => languagesMatchForTemplate('English', template.language))
  }
  return []
}

const evaluateTemplates = (
  templates: SmsTemplate[],
  context: Record<string, string>,
  evaluateOptions: EvaluateOwnershipTemplateOptions = {},
): OwnershipTemplateCandidate[] =>
  templates
    .map((template) => evaluateOwnershipTemplate(template, context, evaluateOptions))
    .filter((entry): entry is OwnershipTemplateCandidate => Boolean(entry))

const dedupeCandidates = (pool: OwnershipTemplateCandidate[]): OwnershipTemplateCandidate[] => {
  const uniqueById = new Map<string, OwnershipTemplateCandidate>()
  for (const entry of pool) {
    const key = entry.template.templateId || entry.template.id
    if (!uniqueById.has(key)) uniqueById.set(key, entry)
  }
  return Array.from(uniqueById.values())
}

export const buildOwnershipTemplatePool = (
  templates: SmsTemplate[],
  context: Record<string, string>,
  ownerLanguage: string,
  options: { excludeTemplateId?: string | null } = {},
): OwnershipTemplateCandidate[] => {
  const languageScoped = filterOwnershipTemplatesForLanguage(templates, ownerLanguage)
  const firstTouch = languageScoped.filter((template) => template.isFirstTouch)
  const hasResolvedSellerName = Boolean(asString(context.seller_first_name, '').trim())
  const hasResolvedAgentName = Boolean(asString(context.agent_first_name, '').trim())

  // Ownership check must greet the human seller by name. Generic "Hi," / right-person
  // templates are rejected by TextGrid and must never be selected from the map card.
  if (!hasResolvedSellerName || !hasResolvedAgentName) {
    return []
  }

  const personalizedFirstTouch = evaluateTemplates(firstTouch, context, { requireSellerNameInGreeting: true })
  const personalizedLanguageScoped = evaluateTemplates(languageScoped, context, { requireSellerNameInGreeting: true })

  const pool = personalizedFirstTouch.length
    ? personalizedFirstTouch
    : personalizedLanguageScoped

  let candidates = dedupeCandidates(pool)
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

export const resetOwnershipCheckTemplateCacheForTests = (): void => {
  ownershipTemplateCache = null
}

/** Active ownership_check rows from Supabase sms_templates (via authenticated template API). */
export const fetchOwnershipCheckTemplates = async (): Promise<SmsTemplate[]> => {
  const now = Date.now()
  if (ownershipTemplateCache && ownershipTemplateCache.expiresAt > now) {
    return ownershipTemplateCache.templates
  }

  const templates = await fetchTemplatesByUseCase(OWNERSHIP_CHECK_USE_CASE)
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
  const inline = asString(record.best_language ?? record.bestLanguage, '').trim()
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