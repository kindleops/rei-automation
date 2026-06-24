import { useCallback, useEffect, useRef, useState } from 'react'
import type { ColumnPreset, TableDensity, TemplateIntelligenceRow } from '../../../../domain/templates/template-intelligence.types'
import {
  applyTemplateControlShadow,
  exportFilteredTemplates,
  fetchTemplateDossier,
  fetchTemplateIntelligenceList,
  fetchTemplateIntelligenceSummary,
  kpiCardsFromSummary,
} from '../../../../lib/data/templateIntelligenceData'
import { useTemplateIntelligenceFilters } from '../../hooks/useTemplateIntelligenceFilters'
import { TemplateDossierDrawer } from './TemplateDossierDrawer'
import { TemplateFiltersBar } from './TemplateFiltersBar'
import { TemplateIntelligenceHeader } from './TemplateIntelligenceHeader'
import { TemplateIntelligenceRail } from './TemplateIntelligenceRail'
import { TemplateIntelligenceTable } from './TemplateIntelligenceTable'
import './template-intelligence.css'

interface TemplateIntelligenceModuleProps {
  searchParams: URLSearchParams
  setSearchParams: (next: URLSearchParams) => void
  onViewQueueRows?: (templateId: string) => void
}

export function TemplateIntelligenceModule({
  searchParams,
  setSearchParams,
  onViewQueueRows,
}: TemplateIntelligenceModuleProps) {
  const { filters, updateFilters, resetFilters } = useTemplateIntelligenceFilters(searchParams, setSearchParams)
  const [rows, setRows] = useState<TemplateIntelligenceRow[]>([])
  const [kpiCards, setKpiCards] = useState(kpiCardsFromSummary({}))
  const [meta, setMeta] = useState({ total_count: 0, page: 0, page_size: 500 } as Record<string, unknown>)
  const [rail, setRail] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(100)
  const [sort, setSort] = useState('template_name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [preset, setPreset] = useState<ColumnPreset>('performance')
  const [density, setDensity] = useState<TableDensity>('comfortable')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dossier, setDossier] = useState<Record<string, unknown> | null>(null)
  const [dossierLoading, setDossierLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setError(null)
    try {
      const [list, summary] = await Promise.all([
        fetchTemplateIntelligenceList(filters, page, pageSize, sort, sortDir, 'shadow'),
        fetchTemplateIntelligenceSummary(filters, 'shadow'),
      ])
      if (controller.signal.aborted) return
      if (!list.ok) throw new Error(list.error ?? 'Failed to load templates')
      setRows(list.data)
      setMeta(list.meta as unknown as Record<string, unknown>)
      if (summary.ok) {
        setKpiCards(kpiCardsFromSummary(summary.cards, summary.meta))
        setRail((summary as { intelligence_rail?: Record<string, unknown> }).intelligence_rail ?? null)
      }
      setStale(false)
    } catch (err) {
      if (controller.signal.aborted) return
      setError(err instanceof Error ? err.message : 'Load failed')
      setStale(true)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [filters, page, pageSize, sort, sortDir])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!selectedId) {
      setDossier(null)
      return
    }
    setDossierLoading(true)
    fetchTemplateDossier(selectedId, filters, 'shadow')
      .then((res) => {
        if (res.ok && 'dossier' in res) setDossier(res.dossier ?? null)
      })
      .finally(() => setDossierLoading(false))
  }, [selectedId, filters])

  const selectedRow = rows.find((r) => r.identity.template_id === selectedId) ?? null
  const totalCount = Number(meta.total_count ?? rows.length)
  const matchingCount = Number(meta.matching_templates ?? meta.filtered_count ?? totalCount)
  const trackedCount = Number(meta.tracked_templates ?? 0)
  const totalPages = Math.max(1, Math.ceil(matchingCount / pageSize))

  const handleSort = (col: string) => {
    if (sort === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSort(col); setSortDir('asc') }
  }

  const handleControl = async (action: string) => {
    if (!selectedId) return
    const reason = window.prompt('Reason for control action (required):')
    if (!reason?.trim()) return
    if (!window.confirm(`Confirm ${action} for ${selectedId}?`)) return
    await applyTemplateControlShadow({ templateId: selectedId, action, reason: reason.trim() })
    void load()
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const exported = await exportFilteredTemplates(filters, sort, sortDir, matchingCount, 500)
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `template-intelligence-export-${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  const stageCode = filters.stage && filters.stage !== 'all' ? filters.stage : selectedRow?.identity.stage_code

  return (
    <div className="occ-tpl-intel-layout">
      <TemplateIntelligenceHeader cards={kpiCards} loading={loading} />
      <TemplateFiltersBar
        filters={filters}
        preset={preset}
        density={density}
        onFiltersChange={(patch) => { setPage(0); updateFilters(patch) }}
        onPresetChange={setPreset}
        onDensityChange={setDensity}
        onReset={() => { setPage(0); resetFilters() }}
        onExport={exporting ? undefined : handleExport}
      />
      <div className={selectedId ? 'occ-tpl-intel-main occ-tpl-intel-main--split' : 'occ-tpl-intel-main'}>
        <TemplateIntelligenceTable
          rows={rows}
          preset={preset}
          density={density}
          loading={loading}
          error={error}
          stale={stale}
          selectedId={selectedId}
          sort={sort}
          sortDir={sortDir}
          onSelect={setSelectedId}
          onSort={handleSort}
          stageCode={stageCode}
        />
        {selectedId ? (
          <TemplateDossierDrawer
            row={selectedRow}
            dossier={dossier}
            loading={dossierLoading}
            onClose={() => setSelectedId(null)}
            onControl={handleControl}
            onViewQueueRows={onViewQueueRows}
          />
        ) : (
          <TemplateIntelligenceRail
            data={rail as Parameters<typeof TemplateIntelligenceRail>[0]['data']}
            loading={loading}
            onFilter={(patch) => {
              const next = new URLSearchParams(searchParams)
              for (const [k, v] of Object.entries(patch)) next.set(k, v)
              setSearchParams(next)
            }}
          />
        )}
      </div>
      <div className="occ-tpl-intel-footer">
        <span>
          Matching {matchingCount.toLocaleString()} templates
          {' · '}Active catalog {totalCount.toLocaleString()}
          {' · '}Tracked {trackedCount.toLocaleString()}
          {' · '}Displayed {rows.length.toLocaleString()} (page {page + 1} of {totalPages}, size {pageSize})
        </span>
        <label className="occ-page-size">
          <span>Per page</span>
          <select value={pageSize} onChange={(e) => { setPage(0); setPageSize(Number(e.target.value)) }}>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={250}>250</option>
            <option value={500}>500</option>
          </select>
        </label>
        <div className="occ-pagination">
          <span className="occ-pagination__range">{page * pageSize + 1}–{Math.min((page + 1) * pageSize, matchingCount)} of {matchingCount.toLocaleString()}</span>
          <button type="button" className="occ-page-btn" disabled={page === 0} onClick={() => setPage(0)}>« First</button>
          <button type="button" className="occ-page-btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
          <button type="button" className="occ-page-btn" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Next ›</button>
          <button type="button" className="occ-page-btn" disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>Last »</button>
        </div>
        {selectedRow && onViewQueueRows && (
          <button type="button" className="occ-action-btn is-secondary" onClick={() => onViewQueueRows(selectedRow.identity.template_id)}>
            View queue rows
          </button>
        )}
      </div>
    </div>
  )
}