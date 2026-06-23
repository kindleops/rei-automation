import { useCallback, useEffect, useState } from 'react'
import type { ColumnPreset, TableDensity, TemplateIntelligenceRow } from '../../../../domain/templates/template-intelligence.types'
import {
  applyTemplateControlShadow,
  fetchTemplateDossier,
  fetchTemplateIntelligenceList,
  fetchTemplateIntelligenceSummary,
  kpiCardsFromSummary,
} from '../../../../lib/data/templateIntelligenceData'
import { useTemplateIntelligenceFilters } from '../../hooks/useTemplateIntelligenceFilters'
import { TemplateDossierDrawer } from './TemplateDossierDrawer'
import { TemplateFiltersBar } from './TemplateFiltersBar'
import { TemplateIntelligenceHeader } from './TemplateIntelligenceHeader'
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(500)
  const [sort, setSort] = useState('template_name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [preset, setPreset] = useState<ColumnPreset>('performance')
  const [density, setDensity] = useState<TableDensity>('compact')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dossier, setDossier] = useState<Record<string, unknown> | null>(null)
  const [dossierLoading, setDossierLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [list, summary] = await Promise.all([
        fetchTemplateIntelligenceList(filters, page, pageSize, sort, sortDir, 'shadow'),
        fetchTemplateIntelligenceSummary(filters, 'shadow'),
      ])
      if (!list.ok) throw new Error(list.error ?? 'Failed to load templates')
      setRows(list.data)
      setMeta(list.meta as unknown as Record<string, unknown>)
      if (summary.ok) setKpiCards(kpiCardsFromSummary(summary.cards))
      setStale(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed')
      setStale(true)
    } finally {
      setLoading(false)
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
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  const handleSort = (col: string) => {
    if (sort === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSort(col); setSortDir('asc') }
  }

  const handleControl = async (action: string) => {
    if (!selectedId) return
    const reason = window.prompt('Reason for control action (required):')
    if (!reason?.trim()) return
    await applyTemplateControlShadow({ templateId: selectedId, action, reason: reason.trim() })
    void load()
  }

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `template-intelligence-export-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="occ-tpl-intel-layout">
      <TemplateIntelligenceHeader
        cards={kpiCards}
        loading={loading}
        onCardClick={(key) => {
          if (key === 'sends') updateFilters({})
        }}
      />
      <TemplateFiltersBar
        filters={filters}
        preset={preset}
        density={density}
        onFiltersChange={(patch) => { setPage(0); updateFilters(patch) }}
        onPresetChange={setPreset}
        onDensityChange={setDensity}
        onReset={() => { setPage(0); resetFilters() }}
        onExport={handleExport}
      />
      <div className="occ-tpl-intel-main">
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
        />
        <TemplateDossierDrawer
          row={selectedRow}
          dossier={dossier}
          loading={dossierLoading}
          onClose={() => setSelectedId(null)}
          onControl={handleControl}
        />
      </div>
      <div className="occ-tpl-intel-footer">
        <span>
          {Number(meta.filtered_count ?? totalCount).toLocaleString()} shown
          {meta.filtered_count != null && Number(meta.filtered_count) !== totalCount
            ? ` of ${totalCount.toLocaleString()} catalog`
            : ` · ${totalCount.toLocaleString()} templates`}
          {' · '}page {page + 1} of {totalPages}
          {' · '}source: template_performance_kpis_v
        </span>
        <label className="occ-page-size">
          <span>Per page</span>
          <select value={pageSize} onChange={(e) => { setPage(0); setPageSize(Number(e.target.value)) }}>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={250}>250</option>
            <option value={500}>500</option>
            <option value={5000}>All</option>
          </select>
        </label>
        <div className="occ-pagination">
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