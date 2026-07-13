import { getSupabaseClient } from '../../../lib/supabaseClient'
import {
  canonicalizeOwnershipCheckLanguage,
  languagesMatchForOwnershipCheck,
  resolveOwnershipCheckSellerLanguage,
} from '../../../domain/map/ownership-check-language'
import {
  fetchTemplatesByUseCase,
  renderTemplate,
  type SmsTemplate,
} from '../../../lib/data/templateData'
import { asString, type AnyRecord } from '../../../lib/data/shared'
import { isEntityName, safeHumanName } from '../../../lib/identity/entityDetection'

const OWNERSHIP_CHECK_USE_CASE = 'ownership_check'

export const canonicalizeOwnerLanguage = canonicalizeOwnershipCheckLanguage

export const languagesMatchForTemplate = languagesMatchForOwnershipCheck

export const computeRotationExclusionLimit = (poolSize: number): number => {
  if (poolSize <= 1) return 0
  // Exclude as many recent templates as possible while keeping the full catalog in play.
  return Math.min(poolSize - 1, Math.max(12, Math.floor(poolSize * 0.85)))
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

const firstToken = (value: string): string => value.split(/\s+/).filter(Boolean)[0] ?? ''

/** Prospect greeting must always be a single first name — never a multi-word full name. */
export const resolveProspectGreetingFirstName = (
  prospectFirstName: unknown,
  prospectFullName?: unknown,
): string => {
  const fromFirst = safeHumanName(asString(prospectFirstName, '').trim())
  const fromFull = safeHumanName(asString(prospectFullName, '').trim())
  if (fromFirst) return firstToken(fromFirst)
  if (fromFull) return firstToken(fromFull)
  return ''
}

const greetingUsesFullNameInsteadOfFirst = (message: string, sellerFirstName: string): boolean => {
  const first = asString(sellerFirstName, '').trim()
  if (!first || first.includes(' ')) return false
  const match = message.trim().match(GREETING_NAME_PATTERN)
  if (!match) return false
  const greeted = match[1].trim()
  if (greeted.toLowerCase() === first.toLowerCase()) return false
  return greeted.toLowerCase().startsWith(`${first.toLowerCase()} `)
}

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
  excludedRecentTemplateIds: string[]
}

export type EvaluateOwnershipTemplateOptions = Record<string, never>

/** Eligibility is render + identity safety only — template copy always comes from Supabase. */
export const evaluateOwnershipTemplate = (
  template: SmsTemplate,
  context: Record<string, string>,
  _options: EvaluateOwnershipTemplateOptions = {},
): OwnershipTemplateCandidate | null => {
  const { renderedText, missingVariables } = renderTemplate(template, context)
  const rendered = renderedText.trim()
  if (!rendered) return null
  if (hasUnresolvedTemplateTokens(rendered)) return null
  if (missingVariables.length > 0) return null
  if (hasEntityGreeting(rendered)) return null
  if (containsForbiddenEntityGreeting(rendered, context)) return null

  const templateKey = asString(
    (template.raw as AnyRecord).template_key
    ?? (template.raw as AnyRecord).template_id
    ?? template.templateId
    ?? template.id,
    template.id,
  )

  return {
    template,
    rendered,
    weight: 1,
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

const templateIdentity = (template: SmsTemplate): string =>
  asString(template.templateId || template.id, '').trim()

export const buildOwnershipTemplatePool = (
  templates: SmsTemplate[],
  context: Record<string, string>,
  ownerLanguage: string,
  options: { excludeTemplateIds?: string[] } = {},
): OwnershipTemplateCandidate[] => {
  const languageScoped = filterOwnershipTemplatesForLanguage(templates, ownerLanguage)

  // Rotate across every active Supabase ownership_check row that renders for this context.
  let candidates = dedupeCandidates(
    evaluateTemplates(languageScoped, context),
  )
  const excludeIds = Array.from(new Set(
    (options.excludeTemplateIds ?? [])
      .map((id) => asString(id, '').trim())
      .filter(Boolean),
  ))
  if (excludeIds.length && candidates.length > 1) {
    const maxExclusions = Math.max(0, candidates.length - 1)
    const activeExclusions = new Set(excludeIds.slice(0, maxExclusions))
    const filtered = candidates.filter((entry) => !activeExclusions.has(templateIdentity(entry.template)))
    if (filtered.length) candidates = filtered
  }

  return candidates
}

export const pickUniformRandom = <T>(items: T[]): T | null => {
  if (!items.length) return null
  const index = Math.floor(Math.random() * items.length)
  return items[index] ?? null
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
  options: { excludeTemplateIds?: string[] } = {},
): OwnershipTemplateSelection | null => {
  const sellerLanguage = canonicalizeOwnershipCheckLanguage(ownerLanguage)
  const excludeIds = Array.from(new Set(
    (options.excludeTemplateIds ?? [])
      .map((id) => asString(id, '').trim())
      .filter(Boolean),
  ))
  const pool = buildOwnershipTemplatePool(templates, context, sellerLanguage, {
    excludeTemplateIds: excludeIds,
  })
  const picked = pickUniformRandom(pool)
  if (!picked) return null

  const pickedId = templateIdentity(picked.template)
  const excludedHit = excludeIds.filter((id) => id !== pickedId)
  const selectionReason = excludedHit.length
    ? 'supabase_language_catalog_rotation'
    : 'supabase_language_catalog_random'

  return {
    template: picked.template,
    renderedMessage: picked.rendered,
    templateId: pickedId,
    templateKey: picked.templateKey,
    language: picked.language,
    weight: picked.weight,
    selectionReason,
    excludedRecentTemplateId: excludedHit[0] ?? null,
    excludedRecentTemplateIds: excludeIds,
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

const readTemplateIdFromQueueRow = (row: AnyRecord): string => {
  const metadata = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as AnyRecord
  return asString(
    row.selected_template_id
    ?? row.template_id
    ?? metadata.selected_template_id
    ?? metadata.template_id,
    '',
  ).trim()
}

export const fetchRecentOwnershipCheckTemplateIds = async (
  options: {
    propertyId?: string | null
    recipientPhone?: string | null
    language?: string | null
    globalLimit?: number
    localLimit?: number
  } = {},
): Promise<string[]> => {
  const propertyId = asString(options.propertyId, '').trim()
  const recipientPhone = asString(options.recipientPhone, '').trim()
  const language = canonicalizeOwnershipCheckLanguage(options.language)
  const globalLimit = Math.max(0, options.globalLimit ?? 0)
  const localLimit = Math.max(0, options.localLimit ?? 0)
  let supabase
  try {
    supabase = getSupabaseClient()
  } catch {
    return []
  }
  if (!supabase?.from) return []

  const recentIds: string[] = []
  const seen = new Set<string>()

  const pushId = (value: string) => {
    const id = asString(value, '').trim()
    if (!id || seen.has(id)) return
    seen.add(id)
    recentIds.push(id)
  }

  if (propertyId && recipientPhone && localLimit > 0) {
    const { data, error } = await supabase
      .from('send_queue')
      .select('template_id, selected_template_id, metadata')
      .eq('property_id', propertyId)
      .eq('to_phone_number', recipientPhone)
      .eq('message_type', 'ownership_check')
      .order('created_at', { ascending: false })
      .limit(localLimit)

    if (!error && Array.isArray(data)) {
      for (const row of data) pushId(readTemplateIdFromQueueRow(row as AnyRecord))
    }
  }

  if (globalLimit > 0) {
    const fetchLimit = Math.max(globalLimit * 3, globalLimit)
    const { data: globalRows, error: globalError } = await supabase
      .from('send_queue')
      .select('template_id, selected_template_id, metadata, language')
      .eq('message_type', 'ownership_check')
      .order('created_at', { ascending: false })
      .limit(fetchLimit)

    if (!globalError && Array.isArray(globalRows)) {
      for (const row of globalRows) {
        const record = row as AnyRecord
        const rowLanguage = asString(record.language, '').trim()
        if (language && rowLanguage && !languagesMatchForOwnershipCheck(language, rowLanguage)) {
          continue
        }
        pushId(readTemplateIdFromQueueRow(record))
        if (recentIds.length >= globalLimit) break
      }
    }
  }

  return recentIds
}

export const fetchRecentOwnershipCheckTemplateId = async (
  propertyId: string,
  recipientPhone: string,
): Promise<string | null> => {
  const ids = await fetchRecentOwnershipCheckTemplateIds({
    propertyId,
    recipientPhone,
    localLimit: 1,
    globalLimit: 0,
  })
  return ids[0] ?? null
}

export const resolveMapOwnerLanguage = async (
  record: Record<string, unknown>,
  masterOwnerId: string | null,
): Promise<string> => {
  const ownerId = asString(masterOwnerId, '').trim()
  let ownerBestLanguage: string | null = asString(record.best_language ?? record.bestLanguage, '').trim() || null

  if (!ownerBestLanguage && ownerId) {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase
      .from('master_owners')
      .select('best_language')
      .eq('master_owner_id', ownerId)
      .limit(1)
      .maybeSingle()

    if (!error) {
      ownerBestLanguage = asString((data as AnyRecord | null)?.best_language, '').trim() || null
    }
  }

  return resolveOwnershipCheckSellerLanguage({
    prospectLanguagePreference: asString(record.prospect_language_preference, '').trim() || null,
    languagePreference: asString(
      record.language_preference ?? record.languagePreference ?? record.seller_language,
      '',
    ).trim() || null,
    bestLanguage: ownerBestLanguage,
    ownerBestLanguage,
  })
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
  const sellerLanguage = canonicalizeOwnershipCheckLanguage(ownerLanguage)
  const templates = await fetchOwnershipCheckTemplates()
  const languageCatalog = filterOwnershipTemplatesForLanguage(templates, sellerLanguage)
  const rotationWindow = computeRotationExclusionLimit(languageCatalog.length)

  const recentTemplateIds = await fetchRecentOwnershipCheckTemplateIds({
    propertyId: options.propertyId,
    recipientPhone: options.recipientPhone,
    language: sellerLanguage,
    globalLimit: rotationWindow,
    localLimit: Math.min(3, rotationWindow),
  })

  const originalRandom = Math.random
  if (options.random) {
    Math.random = options.random
  }
  try {
    return pickRandomOwnershipCheckTemplate(templates, context, sellerLanguage, {
      excludeTemplateIds: recentTemplateIds,
    })
  } finally {
    Math.random = originalRandom
  }
}