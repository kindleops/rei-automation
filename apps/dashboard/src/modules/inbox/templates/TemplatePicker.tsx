/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useMemo, useState } from 'react'
import type { InboxThread } from '../inbox.adapter'
import type { ThreadContext } from '../../../lib/data/inboxData'
import {
  buildTemplateContextFromThread,
  fetchSmsTemplates,
  fetchTemplateCategories,
  fetchTemplateLanguages,
  getRecommendedTemplates,
  renderTemplate,
  type SmsTemplate,
  type TemplateCategory,
  type TemplateRenderResult,
} from '../../../lib/data/templateData'
import { TemplateCard } from './TemplateCard'
import { TemplateFilters, type TemplateFilterState } from './TemplateFilters'
import { TemplateLanguageTabs } from './TemplateLanguageTabs'
import { TemplatePreview } from './TemplatePreview'
import { TemplateUseCaseTabs } from './TemplateUseCaseTabs'

const defaultFilters: TemplateFilterState = {
  search: '',
  stage: 'all',
  agentStyle: 'all',
  includeInactive: false,
}

export const TemplatePicker = ({
  thread,
  threadContext,
  selectedParticipant = null,
  onInsert,
  onReplace,
  onSendNow,
  onQueue,
  onSchedule,
}: {
  thread: InboxThread | null
  threadContext: ThreadContext | null
  /** §22 — templates hydrate against the person actually selected. */
  selectedParticipant?: { display_name?: string | null; canonical_e164?: string | null } | null
  onInsert: (text: string) => void
  onReplace: (text: string) => void
  onSendNow: (text: string, template: SmsTemplate | null) => void
  onQueue: (text: string, template: SmsTemplate | null) => void
  onSchedule: (text: string, template: SmsTemplate | null) => void
}) => {
  const [templates, setTemplates] = useState<SmsTemplate[]>([])
  const [categories, setCategories] = useState<TemplateCategory[]>([])
  const [languages, setLanguages] = useState<string[]>(['All'])
  const [recommended, setRecommended] = useState<SmsTemplate[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [useCase, setUseCase] = useState<string>('all')
  const [language, setLanguage] = useState<string>('All')
  const [filters, setFilters] = useState<TemplateFilterState>(defaultFilters)
  const [variableValues, setVariableValues] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    Promise.all([
      fetchSmsTemplates({ includeInactive: true, limit: 2000 }),
      fetchTemplateCategories(),
      fetchTemplateLanguages(),
      thread ? getRecommendedTemplates(thread, threadContext) : Promise.resolve([]),
    ])
      .then(([allTemplates, allCategories, allLanguages, rec]) => {
        if (cancelled) return
        setTemplates(allTemplates)
        setCategories(allCategories)
        setLanguages(allLanguages)
        setRecommended(rec)
        setSelectedTemplateId(rec[0]?.id ?? allTemplates[0]?.id ?? null)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not load templates')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [thread, threadContext])

  const visible = useMemo(() => {
    const query = filters.search.trim().toLowerCase()
    return templates.filter((template) => {
      if (!filters.includeInactive && !template.active) return false
      if (useCase !== 'all' && template.useCaseSlug !== useCase) return false
      if (language !== 'All' && template.language !== language) return false
      if (filters.stage !== 'all' && (template.stageCode ?? '') !== filters.stage) return false
      if (filters.agentStyle !== 'all' && (template.agentStyle ?? '') !== filters.agentStyle) return false
      if (query && ![
        template.useCase,
        template.templateText,
        template.language,
        template.stageCode,
        template.stageLabel,
        template.agentStyle,
      ].filter(Boolean).join(' ').toLowerCase().includes(query)) return false
      return true
    })
  }, [templates, filters, useCase, language])

  /*
   * §21 -- STAGE FIRST.
   *
   * Templates already carry stageCode/stageLabel and the picker already had a
   * stage FILTER, but the list itself was one flat scroll of every stage mixed
   * together -- so choosing the right S3 message meant reading past S1 and S6.
   * Grouping uses the canonical lifecycle order; it does not define, reorder or
   * invent a stage, and a stage with no matching template simply does not
   * appear. Templates with no stage are collected last rather than dropped.
   */
  const stageGroups = useMemo(() => {
    const byCode = new Map<string, { code: string; label: string; templates: typeof visible }>()
    for (const template of visible) {
      const code = String(template.stageCode ?? '').trim() || 'other'
      if (!byCode.has(code)) {
        byCode.set(code, {
          code: code === 'other' ? '—' : code,
          label: code === 'other' ? 'Unassigned' : (template.stageLabel || code),
          templates: [],
        })
      }
      byCode.get(code)!.templates.push(template)
    }
    const order = (code: string) => {
      const m = /^S(\d+)$/i.exec(code)
      return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
    }
    return [...byCode.values()].sort((a, b) => order(a.code) - order(b.code) || a.code.localeCompare(b.code))
  }, [visible])

  const stageOptions = useMemo(() => ['all', ...Array.from(new Set(templates.map((template) => template.stageCode).filter(Boolean) as string[]))], [templates])
  const agentStyleOptions = useMemo(() => ['all', ...Array.from(new Set(templates.map((template) => template.agentStyle).filter(Boolean) as string[]))], [templates])

  const selectedTemplate = visible.find((template) => template.id === selectedTemplateId) ??
    templates.find((template) => template.id === selectedTemplateId) ??
    null

  const renderResult: TemplateRenderResult | null = useMemo(() => {
    if (!selectedTemplate) return null
    const baseContext = buildTemplateContextFromThread(thread, threadContext, variableValues, selectedParticipant)
    return renderTemplate(selectedTemplate, baseContext)
  }, [selectedTemplate, thread, threadContext, variableValues])

  const recommendedIds = useMemo(() => new Set(recommended.map((template) => template.id)), [recommended])

  if (loading) return <div className="nx-template-picker-empty">Loading templates...</div>
  if (error) return <div className="nx-template-picker-empty">{error}</div>

  const textToApply = renderResult?.renderedText ?? ''

  return (
    <div className="nx-template-picker">
      <div className="nx-template-picker__left">
        <TemplateUseCaseTabs categories={categories} value={useCase} onChange={setUseCase} />
        <TemplateLanguageTabs languages={languages} value={language} onChange={setLanguage} />
        <TemplateFilters
          value={filters}
          stageOptions={stageOptions}
          agentStyles={agentStyleOptions}
          onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
        />
        <div className="nx-template-picker__list">
          {visible.length === 0 && <div className="nx-template-picker-empty">No templates match current filters.</div>}
          {stageGroups.map((group) => (
            <section key={group.code} className="nx-template-stage-group">
              <h4 className="nx-template-stage-group__head">
                <span className="nx-template-stage-group__code">{group.code}</span>
                <span className="nx-template-stage-group__label">{group.label}</span>
                <span className="nx-template-stage-group__count">{group.templates.length}</span>
              </h4>
              {group.templates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  selected={selectedTemplateId === template.id}
                  recommended={recommendedIds.has(template.id)}
                  onSelect={() => setSelectedTemplateId(template.id)}
                />
              ))}
            </section>
          ))}
        </div>
      </div>
      <div className="nx-template-picker__right">
        <TemplatePreview
          template={selectedTemplate}
          renderResult={renderResult}
          variableValues={variableValues}
          onVariableChange={(key, value) => setVariableValues((current) => ({ ...current, [key]: value }))}
          onInsert={() => onInsert(textToApply)}
          onReplace={() => onReplace(textToApply)}
          onSendNow={(template) => onSendNow(textToApply, template)}
          onQueue={(template) => onQueue(textToApply, template)}
          onSchedule={(template) => onSchedule(textToApply, template)}
        />
      </div>
    </div>
  )
}
