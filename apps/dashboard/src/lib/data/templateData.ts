import type { InboxThread } from '../../domain/inbox/inbox-model-types'
import type { ThreadContext } from './inboxData'
import { fetchSmsTemplatesFromApi } from '../api/backendClient'
import { asBoolean, asString, normalizeStatus, safeArray, type AnyRecord } from './shared'

export interface SmsTemplate {
  id: string
  templateId: string | null
  active: boolean
  useCase: string
  useCaseSlug: string
  stageCode: string | null
  stageLabel: string | null
  language: string
  agentStyle: string | null
  propertyTypeScope: string | null
  dealStrategy: string | null
  isFirstTouch: boolean
  isFollowUp: boolean
  templateText: string
  englishTranslation: string | null
  variables: string[]
  raw: AnyRecord
}

export interface SmsTemplateFilters {
  query?: string
  useCase?: string
  language?: string
  stageCode?: string
  agentStyle?: string
  includeInactive?: boolean
}

export interface SmsTemplateFetchParams extends SmsTemplateFilters {
  limit?: number
}

export interface TemplateCategory {
  slug: string
  label: string
  count: number
}

export interface TemplateValidation {
  valid: boolean
  reason: string | null
}

export interface TemplateRenderResult {
  renderedText: string
  missingVariables: string[]
  variableMap: Record<string, string>
}

const DEV = Boolean(import.meta.env?.DEV)
let _loggedSchemaKeys = false
let _templatesCache: { key: string; expiresAt: number; templates: SmsTemplate[] } | null = null

const USE_CASE_LABELS: Record<string, string> = {
  ownership_check: 'Ownership Check',
  consider_selling: 'Soft Intent Probe',
  soft_intent_probe: 'Soft Intent Probe',
  asking_price: 'Asking Price',
  condition_probe: 'Condition Probe',
  property_confirmation: 'Basic Property Confirmation',
  creative_finance_probe: 'Creative Finance Probe',
  offer_reveal: 'Offer Reveal',
  follow_up: 'Follow-Up',
  re_engagement: 'Re-Engagement',
  wrong_number: 'Wrong Number',
  not_interested: 'Not Interested',
  already_sold: 'Already Sold',
  tenant_occupancy: 'Tenant / Occupancy',
  listed_realtor: 'Listed / Realtor',
  opt_out_compliance: 'Opt-Out / Compliance',
  close_handoff: 'Close / Handoff',
  buyer_dispo: 'Buyer / Dispo',
  title_closing: 'Title / Closing',
  custom: 'Custom',
}

const normalizePhone = (value: unknown): string => asString(value, '').replace(/\D/g, '')

const titleize = (value: string): string =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')

const USE_CASE_STAGE_MAP: Record<string, string[]> = {
  new_reply: ['ownership_check', 'consider_selling', 'soft_intent_probe'],
  needs_response: ['soft_intent_probe', 'condition_probe', 'asking_price'],
  interested: ['asking_price', 'condition_probe', 'offer_reveal'],
  needs_offer: ['offer_reveal', 'creative_finance_probe'],
  needs_call: ['close_handoff'],
  nurture: ['follow_up', 're_engagement'],
  not_interested: ['not_interested', 'follow_up'],
  wrong_number: ['wrong_number'],
  dnc_opt_out: ['opt_out_compliance'],
}

const variableMatcher = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

const textForSearch = (template: SmsTemplate): string =>
  [
    template.useCase,
    template.useCaseSlug,
    template.stageCode,
    template.stageLabel,
    template.language,
    template.agentStyle,
    template.templateText,
    template.englishTranslation,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

const getTemplateText = (row: AnyRecord): string =>
  asString(
    row['template_body'] ??
      row['template_text'] ??
      row['message_text'] ??
      row['text'] ??
      row['body'] ??
      row['template'] ??
      '',
    '',
  )

export const getTemplateVariables = (templateText: string): string[] => {
  if (!templateText) return []
  const found = new Set<string>()
  let match = variableMatcher.exec(templateText)
  while (match) {
    const variable = asString(match[1], '').trim()
    if (variable) found.add(variable)
    match = variableMatcher.exec(templateText)
  }
  return Array.from(found)
}

export const normalizeSmsTemplate = (row: AnyRecord): SmsTemplate => {
  const templateText = getTemplateText(row)
  const useCaseRaw = asString(row['use_case_slug'] ?? row['use_case'] ?? row['category'] ?? row['type'], 'custom')
  const useCaseSlug = slugify(useCaseRaw) || 'custom'
  const useCase = USE_CASE_LABELS[useCaseSlug] ?? titleize(asString(row['use_case'] ?? useCaseSlug, 'Custom'))
  const language = asString(row['language'] ?? row['lang'] ?? 'English', 'English')
  const stageCode = asString(row['stage_code'] ?? row['stage'] ?? row['workflow_stage'], '') || null
  const stageLabel = asString(row['stage_label'] ?? row['stage_name'], '') || null
  const active = asBoolean(row['active'] ?? row['is_active'] ?? true, true)

  return {
    id: asString(row['id'] ?? row['template_id'] ?? `${useCaseSlug}:${language}:${templateText.slice(0, 18)}`, ''),
    templateId: asString(row['template_id'] ?? row['id'], '') || null,
    active,
    useCase,
    useCaseSlug,
    stageCode,
    stageLabel,
    language,
    agentStyle: asString(row['agent_style'] ?? row['agent_style_fit'], '') || null,
    propertyTypeScope: asString(row['property_type_scope'], '') || null,
    dealStrategy: asString(row['deal_strategy'], '') || null,
    isFirstTouch: asBoolean(row['is_first_touch'], false),
    isFollowUp: asBoolean(row['is_follow_up'], false),
    templateText,
    englishTranslation: asString(row['english_translation'], '') || null,
    variables: getTemplateVariables(templateText),
    raw: row,
  }
}

const applyFilters = (templates: SmsTemplate[], filters: SmsTemplateFilters): SmsTemplate[] => {
  const query = asString(filters.query, '').trim().toLowerCase()
  return templates.filter((template) => {
    if (!filters.includeInactive && !template.active) return false
    if (filters.useCase && filters.useCase !== 'all' && template.useCaseSlug !== filters.useCase) return false
    if (filters.language && filters.language !== 'all' && normalizeStatus(template.language) !== normalizeStatus(filters.language)) return false
    if (filters.stageCode && filters.stageCode !== 'all' && normalizeStatus(template.stageCode) !== normalizeStatus(filters.stageCode)) return false
    if (filters.agentStyle && filters.agentStyle !== 'all' && normalizeStatus(template.agentStyle) !== normalizeStatus(filters.agentStyle)) return false
    if (query && !textForSearch(template).includes(query)) return false
    return true
  })
}

export const fetchSmsTemplates = async (params: SmsTemplateFetchParams = {}): Promise<SmsTemplate[]> => {
  const limit = Math.max(1, params.limit ?? 200)
  const cacheKey = `${limit}:${params.includeInactive ? 'all' : 'active'}`
  const now = Date.now()
  if (_templatesCache && _templatesCache.key === cacheKey && _templatesCache.expiresAt > now) {
    return applyFilters(_templatesCache.templates, params)
  }

  const apiResult = await fetchSmsTemplatesFromApi({
    limit,
    includeInactive: params.includeInactive,
  })
  if (!apiResult.ok) {
    const err = apiResult as { message?: string; error?: string }
    throw new Error(err.message || err.error || 'sms_templates_unavailable')
  }
  if (!apiResult.data) {
    throw new Error('sms_templates_unavailable')
  }

  const rows = safeArray((apiResult.data as AnyRecord).templates as AnyRecord[])
  if (DEV && rows[0] && !_loggedSchemaKeys) {
    _loggedSchemaKeys = true
    console.log('[templateData] sms_templates schema sample keys', Object.keys(rows[0]))
  }

  const normalized = rows.map(normalizeSmsTemplate)
  _templatesCache = {
    key: cacheKey,
    expiresAt: now + 60_000,
    templates: normalized,
  }
  return applyFilters(normalized, params)
}

export const fetchTemplateCategories = async (): Promise<TemplateCategory[]> => {
  const templates = await fetchSmsTemplates({ includeInactive: true, limit: 2000 })
  const counter = new Map<string, number>()
  for (const template of templates) {
    counter.set(template.useCaseSlug, (counter.get(template.useCaseSlug) ?? 0) + 1)
  }

  const categories = Array.from(counter.entries()).map(([slug, count]) => ({
    slug,
    label: USE_CASE_LABELS[slug] ?? titleize(slug),
    count,
  }))

  categories.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  return categories
}

export const fetchTemplateLanguages = async (): Promise<string[]> => {
  const templates = await fetchSmsTemplates({ includeInactive: true, limit: 2000 })
  const langs = new Set<string>()
  for (const template of templates) langs.add(template.language || 'English')
  return ['All', ...Array.from(langs).sort((a, b) => a.localeCompare(b))]
}

export const fetchTemplatesByUseCase = async (useCase: string): Promise<SmsTemplate[]> =>
  fetchSmsTemplates({ useCase, limit: 1000 })

export const fetchTemplatesByLanguage = async (language: string): Promise<SmsTemplate[]> =>
  fetchSmsTemplates({ language, limit: 1000 })

export const searchTemplates = async (
  query: string,
  filters: Omit<SmsTemplateFilters, 'query'> = {},
): Promise<SmsTemplate[]> => fetchSmsTemplates({ ...filters, query, limit: 2000 })

const firstName = (fullName: string): string => fullName.split(' ').filter(Boolean)[0] ?? fullName

const contextValue = (key: string, context: Record<string, string>): string | null => {
  const direct = context[key]
  if (direct && direct.trim()) return direct.trim()
  return null
}

export const renderTemplate = (
  template: SmsTemplate,
  context: Record<string, string>,
): TemplateRenderResult => {
  const missing = new Set<string>()
  const variableMap: Record<string, string> = {}

  const renderedText = template.templateText.replace(variableMatcher, (_, rawVar: string) => {
    const variable = asString(rawVar, '').trim()
    const value = contextValue(variable, context)
    if (!value) {
      missing.add(variable)
      variableMap[variable] = ''
      return `[[${variable}]]`
    }
    variableMap[variable] = value
    return value
  })

  return {
    renderedText,
    missingVariables: Array.from(missing),
    variableMap,
  }
}

export const validateTemplateForThread = (
  template: SmsTemplate,
  threadContext: ThreadContext | null,
): TemplateValidation => {
  if (!template.active) return { valid: false, reason: 'Template is inactive' }
  if (!threadContext?.seller && !threadContext?.property) {
    return { valid: false, reason: 'Thread context is missing seller and property links' }
  }
  return { valid: true, reason: null }
}

export const buildTemplateContextFromThread = (
  thread: InboxThread | null,
  threadContext: ThreadContext | null,
  manualValues: Record<string, string> = {},
): Record<string, string> => {
  const threadRecord = (thread ?? {}) as AnyRecord
  const ownerName = asString(
    threadContext?.seller?.name
    ?? thread?.ownerName
    ?? thread?.ownerDisplayName
    ?? threadRecord.owner_display_name
    ?? threadRecord.seller_name
    ?? threadRecord.entity_name,
    '',
  )
  const prospectName = asString(
    threadRecord.prospect_full_name
    ?? threadRecord.prospect_name
    ?? threadRecord.prospect_first_name,
    '',
  )
  const resolvedOwnerName = ownerName || prospectName
  const address = asString(threadContext?.property?.address ?? thread?.propertyAddress ?? thread?.subject, '')
  const cityStateZip = address.split(',').map((part) => part.trim())

  return {
    seller_first_name: firstName(resolvedOwnerName),
    seller_name: resolvedOwnerName,
    owner_name: resolvedOwnerName,
    property_address: address,
    property_city: asString(cityStateZip[1], ''),
    property_state: asString(cityStateZip[2], ''),
    property_zip: asString((thread?.marketId ?? '').split('-').slice(-1)[0], ''),
    market: asString(threadContext?.property?.market ?? thread?.marketId, ''),
    agent_name: 'Operator',
    company_name: 'Nexus',
    callback_number: asString(thread?.ourNumber ?? '', ''),
    offer_price: '',
    ...manualValues,
  }
}

const detectIntentSlug = (thread: InboxThread, threadContext: ThreadContext | null): string[] => {
  const preview = asString(thread.preview, '').toLowerCase()
  const intent = asString(threadContext?.aiContext?.intent, '').toLowerCase()
  const text = `${preview} ${intent}`
  const slugs: string[] = []

  if (/wrong number|dont know|not .*owner/.test(text)) slugs.push('wrong_number')
  if (/not interested|stop|remove me|opt out/.test(text)) slugs.push('not_interested', 'opt_out_compliance')
  if (/offer|price|number/.test(text)) slugs.push('offer_reveal', 'asking_price')
  if (/yes|interested|tell me more/.test(text)) slugs.push('soft_intent_probe', 'asking_price')
  if (/condition|repair|fix/.test(text)) slugs.push('condition_probe')

  return Array.from(new Set(slugs))
}

const inferThreadLanguage = (thread: InboxThread, threadContext: ThreadContext | null): string => {
  const explicit = asString((threadContext?.seller as AnyRecord | null)?.language, '')
  if (explicit) return explicit
  const text = `${thread.preview} ${threadContext?.aiContext?.summary ?? ''}`.toLowerCase()
  if (/\bhola\b|\bgracias\b|\busted\b/.test(text)) return 'Spanish'
  if (/\bbonjour\b|\bmerci\b/.test(text)) return 'French'
  if (/\bol[aá]\b|\bobrigado\b/.test(text)) return 'Portuguese'
  return 'English'
}

const scoreTemplate = (
  template: SmsTemplate,
  thread: InboxThread,
  threadContext: ThreadContext | null,
  preferredLanguage: string,
  intentSlugs: string[],
): number => {
  let score = 0
  const workflowThread = thread as InboxThread & { inboxStage?: string; inboxStatus?: string }
  const threadStage = normalizeStatus(workflowThread.inboxStage ?? '')
  const threadStatus = normalizeStatus(workflowThread.inboxStatus ?? '')

  if (normalizeStatus(template.language) === normalizeStatus(preferredLanguage)) score += 30
  if (normalizeStatus(template.language) === 'english') score += 8

  if (threadStage && normalizeStatus(template.stageCode) === threadStage) score += 24
  if (threadStatus === 'queued' && template.isFollowUp) score += 10
  if (threadStatus === 'unread' && template.isFirstTouch) score += 8

  if (intentSlugs.includes(template.useCaseSlug)) score += 35
  if (USE_CASE_STAGE_MAP[threadStage]?.includes(template.useCaseSlug)) score += 20

  const propertyType = asString(thread.propertyAddress ?? thread.subject, '').toLowerCase()
  if (template.propertyTypeScope && propertyType.includes(template.propertyTypeScope.toLowerCase())) score += 6
  if (threadContext?.queueContext?.items?.length && template.isFollowUp) score += 8

  return score
}

export const getRecommendedTemplates = async (
  thread: InboxThread,
  threadContext: ThreadContext | null,
): Promise<SmsTemplate[]> => {
  const templates = await fetchSmsTemplates({ includeInactive: false, limit: 1200 })
  const preferredLanguage = inferThreadLanguage(thread, threadContext)
  const intentSlugs = detectIntentSlug(thread, threadContext)

  const ranked = templates
    .map((template) => ({
      template,
      score: scoreTemplate(template, thread, threadContext, preferredLanguage, intentSlugs),
    }))
    .sort((a, b) => b.score - a.score)

  return ranked.slice(0, 8).map((item) => item.template)
}

export const getTemplateThreadHints = (thread: InboxThread, threadContext: ThreadContext | null): Record<string, string> => ({
  language: inferThreadLanguage(thread, threadContext),
  inboxStage: asString((thread as InboxThread & { inboxStage?: string }).inboxStage, ''),
  inboxStatus: asString((thread as InboxThread & { inboxStatus?: string }).inboxStatus, ''),
  sellerPhone: normalizePhone(thread.phoneNumber),
})
