import { useCallback, useEffect, useRef, useState } from 'react'
import type { ColumnPreset, TableDensity, TemplateIntelligenceRow } from '../../../../domain/templates/template-intelligence.types'
import {
  exportFilteredTemplates,
  fetchTemplateDossier,
  fetchTemplateIntelligenceList,
  fetchTemplateIntelligenceSummary,
  kpiCardsFromSummary,
  DEFAULT_PERFORMANCE_COLUMNS,
} from '../../../../lib/data/templateIntelligenceData'
import { useTemplateIntelligenceFilters } from '../../hooks/useTemplateIntelligenceFilters'
import { OccTemplateFilterMenu } from './OccTemplateFilterMenu'
import { TemplateDetailModal } from './TemplateDetailModal'
import { TemplateFiltersBar } from './TemplateFiltersBar'
import { TemplateInsightStrip } from './TemplateInsightStrip'
import { TemplateIntelligenceHeader } from './TemplateIntelligenceHeader'
import { TemplateIntelligenceTable } from './TemplateIntelligenceTable'
import './template-intelligence.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface TemplateIntelligenceModuleProps {
  searchParams: URLSearchParams
  setSearchParams: (next: URLSearchParams) => void
  globalRangeLabel?: string
  isMobileLayout?: boolean
  onViewQueueRows?: (templateId: string) => void
}

export function TemplateIntelligenceModule({
  searchParams,
  setSearchParams,
  globalRangeLabel,
  isMobileLayout = false,
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
  const [sort, setSort] = useState('stage_code')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [preset, setPreset] = useState<ColumnPreset>('performance')
  const [density, setDensity] = useState<TableDensity>('comfortable')
  const [visibleColumns, setVisibleColumns] = useState<string[]>([...DEFAULT_PERFORMANCE_COLUMNS])
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
      const list = await fetchTemplateIntelligenceList(filters, page, pageSize, sort, sortDir, 'shadow')
      if (controller.signal.aborted) return
      if (!list.ok) throw new Error(list.error ?? 'Failed to load templates')
      setRows(list.data)
      setMeta(list.meta as unknown as Record<string, unknown>)
      setStale(false)

      void fetchTemplateIntelligenceSummary(filters, 'shadow')
        .then((summary) => {
          if (controller.signal.aborted) return
          if (summary.ok) {
            setKpiCards(kpiCardsFromSummary(summary.cards, summary.meta))
            setRail(summary.intelligence_rail ?? null)
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setStale(true)
        })
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
    <div className={cls('occ-tpl-intel-layout', isMobileLayout && 'is-mobile-layout')}>
      {isMobileLayout && (
        <OccTemplateFilterMenu
          filters={filters}
          preset={preset}
          density={density}
          matchingCount={matchingCount}
          onFiltersChange={(patch) => { setPage(0); updateFilters(patch) }}
          onPresetChange={setPreset}
          onDensityChange={setDensity}
          onReset={() => { setPage(0); resetFilters() }}
          onExport={exporting ? undefined : handleExport}
        />
      )}
      <TemplateIntelligenceHeader
        cards={kpiCards}
        loading={loading}
        filters={filters}
        globalRangeLabel={globalRangeLabel}
        isMobileLayout={isMobileLayout}
        onFiltersChange={(patch) => { setPage(0); updateFilters(patch) }}
      />
      <TemplateFiltersBar
        filters={filters}
        preset={preset}
        density={density}
        visibleColumns={visibleColumns}
        isMobileLayout={isMobileLayout}
        onFiltersChange={(patch) => { setPage(0); updateFilters(patch) }}
        onPresetChange={setPreset}
        onDensityChange={setDensity}
        onVisibleColumnsChange={setVisibleColumns}
        onReset={() => { setPage(0); resetFilters() }}
        onExport={exporting ? undefined : handleExport}
      />
      <TemplateInsightStrip
        data={rail as Parameters<typeof TemplateInsightStrip>[0]['data']}
        loading={loading}
        isMobileLayout={isMobileLayout}
        onSelectTemplate={setSelectedId}
      />
      <div className="occ-tpl-intel-main">
        <TemplateIntelligenceTable
          rows={rows}
          preset={preset}
          density={density}
          visibleColumns={visibleColumns}
          loading={loading}
          error={error}
          stale={stale}
          selectedId={selectedId}
          sort={sort}
          sortDir={sortDir}
          onSelect={setSelectedId}
          onSort={handleSort}
          stageCode={stageCode}
          isMobileLayout={isMobileLayout}
        />
      </div>
      {selectedRow && (
        <TemplateDetailModal
          row={selectedRow}
          rows={rows}
          dossier={dossier}
          loading={dossierLoading}
          isMobileLayout={isMobileLayout}
          onClose={() => setSelectedId(null)}
          onNavigate={setSelectedId}
          onViewQueueRows={onViewQueueRows}
        />
      )}
      <div className={cls('occ-tpl-intel-footer', isMobileLayout && 'occ-tpl-intel-footer--mobile')}>
        {isMobileLayout ? (
          <>
            <span className="occ-tpl-intel-footer__mobile-meta">
              {matchingCount.toLocaleString()} templates · Page {page + 1}/{totalPages}
            </span>
            <div className="occ-pagination occ-pagination--mobile">
              <button type="button" className="occ-page-btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">‹ Prev</button>
              <button type="button" className="occ-page-btn" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)} aria-label="Next page">Next ›</button>
            </div>
          </>
        ) : (
          <>
            <span>
              Matching {matchingCount.toLocaleString()} templates
              {' · '}Catalog {totalCount.toLocaleString()}
              {' · '}With activity {trackedCount.toLocaleString()}
              {' · '}Page {page + 1} of {totalPages}
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
              <button type="button" className="occ-page-btn" disabled={page === 0} onClick={() => setPage(0)}>«</button>
              <button type="button" className="occ-page-btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>‹</button>
              <button type="button" className="occ-page-btn" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>›</button>
              <button type="button" className="occ-page-btn" disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>»</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}