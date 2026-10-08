import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { MobileSheet } from '../../mobile/MobileSheet'
import * as backendClient from '../../../lib/api/backendClient'
import type { EntityGraphFilters, EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'
import type { EntityGraphFieldFilter } from '../../../domain/entity-graph/entity-graph-field-filters'
import { filtersToApiParams } from '../../../domain/entity-graph/entity-graph-workspace-state'
import type { EntityScope } from './entity-graph-mobile-format'
import { smsBlockLabel } from './entity-graph-table-columns'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export type HandoffMode = 'cohort' | 'selection'

/**
 * Add to Campaign (phone) — the SAME stacking endpoint as the desk
 * (POST /api/cockpit/entity-graph/campaign-stack).
 *
 * It used to PATCH the draft's target_filters, which REPLACED whatever the
 * draft already targeted: run filter A into draft X, then filter B into X,
 * and X only held B. Now the server resolves the selection or the whole
 * filtered cohort, counts it against the campaign target graph with the
 * builder's own readiness rule (dry run first), and pins only the
 * targetable properties on the DRAFT, unioned with what it already holds —
 * written by compare-and-set, so two adds never lose each other.
 *
 * Nothing here builds targets, schedules, launches or sends. Campaigns'
 * Build and every gate still run on the draft.
 */

type StackDraft = { id: string; name: string; pinned_properties: number; segments: number; stackable: boolean }
type StackResult = {
  ok: boolean
  campaign_id: string | null
  campaign_name: string | null
  requested: number
  resolved_properties: number
  already_present: number
  added: number
  added_ready: number
  added_held: number
  held_by_reason: Record<string, number>
  ineligible: number
  ineligible_by_reason: Record<string, number>
  total_after: number
  notes?: string[]
  created?: boolean
  warnings?: Array<{ code: string; message: string }>
}

const STACKABLE: EntityScope[] = ['properties', 'master_owners', 'people']

async function postStack(body: Record<string, unknown>): Promise<StackResult> {
  const res = await backendClient.callBackend<StackResult & { message?: string }>('/api/cockpit/entity-graph/campaign-stack', { method: 'POST', body: JSON.stringify(body) })
  if (!res.ok) throw new Error((res.upstream as { message?: string } | undefined)?.message || res.message || res.error || 'campaign_stack_failed')
  if (!res.data?.ok) throw new Error(res.data?.message || 'campaign_stack_failed')
  return res.data
}

type Props = {
  open: boolean
  scope: EntityScope
  filters: EntityGraphFilters
  fieldFilters: EntityGraphFieldFilter[]
  query: string
  cohortTotal: number | null
  selected: EntitySearchResult[]
  onClose: () => void
  onDone: (message: string) => void
}

export function EntityGraphCampaignSheet({ open, scope, filters, fieldFilters, query, cohortTotal, selected, onClose, onDone }: Props) {
  const [mode, setMode] = useState<HandoffMode>(selected.length > 0 ? 'selection' : 'cohort')
  const [target, setTarget] = useState<'new' | string>('new')
  const [name, setName] = useState('')
  const [drafts, setDrafts] = useState<StackDraft[] | null>(null)
  const [preview, setPreview] = useState<{ sig: string; data: StackResult | null; error: string | null } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wasOpen, setWasOpen] = useState(open)

  // The sheet stays mounted: re-derive the default mode on each open.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setMode(selected.length > 0 ? 'selection' : 'cohort')
      setError(null)
      setPreview(null)
    }
  }

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setDrafts(null)
    void backendClient.callBackend<{ ok: boolean; drafts: StackDraft[] }>('/api/cockpit/entity-graph/campaign-stack', { signal: controller.signal })
      .then((res) => { if (!controller.signal.aborted) setDrafts(res.ok && res.data?.drafts ? res.data.drafts : []) })
      .catch(() => { if (!controller.signal.aborted) setDrafts([]) })
    return () => controller.abort()
  }, [open])

  const stackable = STACKABLE.includes(scope)
  const legacy = filtersToApiParams(filters)
  const hasFilters = fieldFilters.length > 0 || Object.values(legacy).some((v) => v !== undefined && v !== '')
  const cohortBlocked = !stackable ? 'Campaigns target properties, owners and people.'
    : query.trim() ? 'A search is not a cohort — clear it and use filters, or select records.'
      : !hasFilters ? 'No filters are active — narrow the cohort first.' : null
  const defaultName = defaultNameFor(mode, scope, selected.length, cohortTotal)
  const body = useMemo(() => ({
    scope,
    mode,
    ...(mode === 'selection' ? { ids: selected.map((r) => r.entityId) } : { ...legacy, field_filters: fieldFilters }),
    ...(target === 'new' ? { new_campaign_name: name.trim() || defaultName } : { campaign_id: target }),
  }), [scope, mode, selected, legacy, fieldFilters, target, name, defaultName]) // eslint-disable-line react-hooks/exhaustive-deps
  const sig = JSON.stringify({ ...body, new_campaign_name: undefined })
  const canRun = stackable && (mode === 'selection' ? selected.length > 0 : !cohortBlocked)

  useEffect(() => {
    if (!open || !canRun) return
    let alive = true
    const t = window.setTimeout(() => {
      setPreview({ sig, data: null, error: null })
      postStack({ ...body, dry_run: true })
        .then((data) => { if (alive) setPreview({ sig, data, error: null }) })
        .catch((e: unknown) => { if (alive) setPreview({ sig, data: null, error: e instanceof Error ? e.message : 'Could not count this cohort' }) })
    }, 250)
    return () => { alive = false; window.clearTimeout(t) }
  }, [open, sig, canRun]) // eslint-disable-line react-hooks/exhaustive-deps -- sig encodes body

  const current = preview?.sig === sig ? preview : null
  const counts = current?.data ?? null

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const result = await postStack(body)
      onDone(result.created
        ? `Draft “${result.campaign_name ?? ''}” created with ${result.added.toLocaleString()} properties. Open Campaigns to build and review.`
        : `${result.added.toLocaleString()} added to “${result.campaign_name ?? 'draft'}” · ${result.total_after.toLocaleString()} pinned in total.${result.warnings?.length ? ` ${result.warnings.map((w) => w.message).join(' ')}` : ''}`)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'campaign_stack_failed')
    } finally {
      setSubmitting(false)
    }
  }

  const reasons = (map: Record<string, number>) => Object.entries(map).sort((a, b) => b[1] - a[1])

  return (
    <MobileSheet open={open} title="Add to Campaign" subtitle={scope.replace(/_/g, ' ')} height="full" className="egm-sheet" onClose={onClose}>
      <div className="egc">
        <section className="egc-block">
          <h4>What gets added</h4>
          <div className="egc-modes">
            <button type="button" className={cls('egc-mode', mode === 'cohort' && 'is-on')} disabled={Boolean(cohortBlocked)} onClick={() => setMode('cohort')}>
              <span className="egc-mode__top"><Icon name="filter" /><strong>Current filtered cohort</strong></span>
              <span className="egc-mode__count">{cohortTotal === null ? '—' : cohortTotal.toLocaleString()} records</span>
              <span className="egc-mode__note">{cohortBlocked ?? 'Every record these filters match, resolved on the server — not just the loaded rows.'}</span>
            </button>
            <button type="button" className={cls('egc-mode', mode === 'selection' && 'is-on')} disabled={selected.length === 0 || !stackable} onClick={() => setMode('selection')}>
              <span className="egc-mode__top"><Icon name="check-double" /><strong>Selected records</strong></span>
              <span className="egc-mode__count">{selected.length.toLocaleString()} selected</span>
              <span className="egc-mode__note">{selected.length === 0 ? 'Select records in the list to enable this.' : 'Exactly these records.'}</span>
            </button>
          </div>
        </section>

        <section className="egc-block">
          <h4>Destination · drafts only</h4>
          <button type="button" className={cls('egc-dest', target === 'new' && 'is-on')} onClick={() => setTarget('new')}>
            <Icon name="spark" /><span>Create new draft</span>
          </button>
          {drafts === null ? <p className="egc-hint">Loading draft campaigns…</p>
            : drafts.length === 0 ? <p className="egc-hint">No draft campaigns to add to.</p>
              : drafts.map((draft) => (
                <button key={draft.id} type="button" disabled={!draft.stackable} className={cls('egc-dest', target === draft.id && 'is-on')} onClick={() => setTarget(draft.id)}>
                  <Icon name="file-text" />
                  <span>{draft.name}</span>
                  <em>{draft.stackable ? `${draft.pinned_properties.toLocaleString()} pinned` : 'targets by filters'}</em>
                </button>
              ))}
          {target === 'new' ? (
            <label className="egm-field" style={{ marginTop: 10 }}>
              <span>Campaign name</span>
              <input value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} />
            </label>
          ) : null}
        </section>

        <section className="egc-block" aria-live="polite">
          <h4>What will be added</h4>
          {!canRun ? <p className="egc-warn">{mode === 'cohort' ? cohortBlocked : 'No records selected.'}</p>
            : current?.error ? <p className="egc-error">{current.error}</p>
              : !counts ? <p className="egc-hint">Counting against the campaign audience…</p>
                : (
                  <ul className="egc-filters">
                    <li><span className="egc-filters__key">Properties</span><span className="egc-filters__val">{counts.resolved_properties.toLocaleString()}</span></li>
                    <li><span className="egc-filters__key">Already on the draft</span><span className="egc-filters__val">{counts.already_present.toLocaleString()}</span></li>
                    <li><span className="egc-filters__key">Ready</span><span className="egc-filters__val">{counts.added_ready.toLocaleString()}</span></li>
                    <li><span className="egc-filters__key">Held (pinned)</span><span className="egc-filters__val">{counts.added_held.toLocaleString()}</span></li>
                    {reasons(counts.held_by_reason).map(([k, n]) => <li key={`h:${k}`}><span className="egc-filters__key">· {smsBlockLabel(k)}</span><span className="egc-filters__val">{n.toLocaleString()}</span></li>)}
                    <li><span className="egc-filters__key">Not targetable</span><span className="egc-filters__val">{counts.ineligible.toLocaleString()}</span></li>
                    {reasons(counts.ineligible_by_reason).map(([k, n]) => <li key={`i:${k}`}><span className="egc-filters__key">· {smsBlockLabel(k)}</span><span className="egc-filters__val">{n.toLocaleString()}</span></li>)}
                    <li><span className="egc-filters__key">Draft total after</span><span className="egc-filters__val">{counts.total_after.toLocaleString()}</span></li>
                  </ul>
                )}
          {(counts?.notes ?? []).map((n) => <p key={n} className="egc-hint">{n}</p>)}
        </section>

        <p className="egc-contract">
          <Icon name="shield" />
          Only the draft’s target list changes. Nothing is built, scheduled, launched or sent — Campaigns runs Build and every gate (suppression, contactability, identity, sender coverage, templates) on the draft.
        </p>

        {error ? <p className="egc-error">{error}</p> : null}

        <div className="egm-filters__footer">
          <button type="button" className="egm-btn is-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="egm-btn is-primary" disabled={submitting || !canRun || !counts || counts.added === 0} onClick={() => void submit()}>
            {submitting ? 'Adding…' : counts ? `Add ${counts.added.toLocaleString()} to ${target === 'new' ? 'new draft' : 'draft'}` : 'Add to draft'}
          </button>
        </div>
      </div>
    </MobileSheet>
  )
}

function defaultNameFor(mode: HandoffMode, scope: EntityScope, selectedCount: number, cohortTotal: number | null): string {
  const size = mode === 'selection' ? selectedCount : (cohortTotal ?? 0)
  const noun = scope === 'properties' ? 'properties' : scope.replace(/_/g, ' ')
  return `Entity Graph · ${size.toLocaleString()} ${noun}`
}
