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
  onInsert,
  onReplace,
  onSendNow,
  onQueue,
  onSchedule,
}: {
  thread: InboxThread | null
  threadContext: ThreadContext | null
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

  const stageOptions = useMemo(() => ['all', ...Array.from(new Set(templates.map((template) => template.stageCode).filter(Boolean) as string[]))], [templates])
  const agentStyleOptions = useMemo(() => ['all', ...Array.from(new Set(templates.map((template) => template.agentStyle).filter(Boolean) as string[]))], [templates])

  const selectedTemplate = visible.find((template) => template.id === selectedTemplateId) ??
    templates.find((template) => template.id === selectedTemplateId) ??
    null

  const renderResult: TemplateRenderResult | null = useMemo(() => {
    if (!selectedTemplate) return null
    const baseContext = buildTemplateContextFromThread(thread, threadContext, variableValues)
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
          {visible.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              selected={selectedTemplateId === template.id}
              recommended={recommendedIds.has(template.id)}
              onSelect={() => setSelectedTemplateId(template.id)}
            />
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
