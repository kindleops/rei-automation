/**
 * ADD TO CAMPAIGN (desk) — stack Entity Graph cohorts into one DRAFT.
 *
 *   filter A → "Add to campaign" → draft X
 *   filter B → "Add to campaign" → the same draft X   (deduped, counted)
 *
 * The server (POST /api/cockpit/entity-graph/campaign-stack) resolves the
 * selection or the WHOLE filtered cohort itself, counts it against the
 * campaign target graph with the builder's own readiness rule, and pins only
 * the targetable properties on the draft. A dry run runs first, so the
 * operator sees "already present / ready / held / not targetable" before
 * anything is written. Nothing here builds targets, schedules, launches or
 * sends — Campaigns' Build and every gate still run on the draft.
 */
import { useEffect, useMemo, useState } from 'react'
import { LCButton, LCDialog, LCSkeleton, cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { callBackend } from '../../../lib/api/backendClient'
import type { EntityGraphFieldFilter } from '../../../domain/entity-graph/entity-graph-field-filters'
import { scopeNoun, type EntityScope } from '../mobile/entity-graph-mobile-format'
import { smsBlockLabel } from '../mobile/entity-graph-table-columns'
import { fmtCount } from './desk-model'

export type StackDraft = { id: string; name: string; pinned_properties: number; segments: number; from_entity_graph: boolean; stackable: boolean; reason: string | null; updated_at?: string }
export type StackResult = {
  ok: boolean
  dry_run: boolean
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
  unchanged?: boolean
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: EntityScope
  /** entity ids of the selected rows in this scope */
  selectedIds: string[]
  filters: EntityGraphFieldFilter[]
  query: string
  cohortTotal: number | null
  cohortLabel: string
  onDone?: (result: StackResult) => void
}

const STACKABLE: EntityScope[] = ['properties', 'master_owners', 'people']

export function stackScopeSupported(scope: EntityScope): boolean {
  return STACKABLE.includes(scope)
}

async function postStack(body: Record<string, unknown>): Promise<StackResult> {
  const res = await callBackend<StackResult & { message?: string; error?: string }>('/api/cockpit/entity-graph/campaign-stack', { method: 'POST', body: JSON.stringify(body) })
  // the server's refusal sentence (409 not a draft, 422 too large, …) — not the transport summary
  if (!res.ok) throw new Error((res.upstream as { message?: string } | undefined)?.message || res.message || res.error || 'campaign_stack_failed')
  if (!res.data?.ok) throw new Error(res.data?.message || 'campaign_stack_failed')
  return res.data
}

export function DeskCampaignStack({ open, onOpenChange, scope, selectedIds, filters, query, cohortTotal, cohortLabel, onDone }: Props) {
  const [drafts, setDrafts] = useState<StackDraft[] | null>(null)
  const [draftsError, setDraftsError] = useState<string | null>(null)
  const [mode, setMode] = useState<'selection' | 'cohort'>(selectedIds.length ? 'selection' : 'cohort')
  const [target, setTarget] = useState<string>('new')
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<{ sig: string; data: StackResult | null; error: string | null } | null>(null)
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState<StackResult | null>(null)
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) {
      setMode(selectedIds.length ? 'selection' : 'cohort')
      setDone(null)
      setPreview(null)
    }
  }

  useEffect(() => {
    if (!open) return
    const ctl = new AbortController()
    setDrafts(null)
    setDraftsError(null)
    void callBackend<{ ok: boolean; drafts: StackDraft[] }>('/api/cockpit/entity-graph/campaign-stack', { signal: ctl.signal })
      .then((res) => { if (!ctl.signal.aborted) { if (res.ok && res.data?.drafts) setDrafts(res.data.drafts); else { setDrafts([]); setDraftsError(!res.ok && res.message ? res.message : 'Draft campaigns did not load') } } })
      .catch(() => { if (!ctl.signal.aborted) { setDrafts([]); setDraftsError('Draft campaigns did not load') } })
    return () => ctl.abort()
  }, [open])

  const cohortBlocked = query.trim()
    ? 'A search is a ranked lookup, not a cohort — clear it and use filters, or select rows.'
    : !filters.length ? 'No filters are active — narrow the cohort first.' : null
  const noun = scopeNoun(scope, 2)
  const defaultName = `Entity Graph · ${cohortLabel}`.slice(0, 80)
  const body = useMemo(() => ({
    scope,
    mode,
    ...(mode === 'selection' ? { ids: selectedIds } : { field_filters: filters }),
    ...(target === 'new' ? { new_campaign_name: name.trim() || defaultName } : { campaign_id: target }),
    label: cohortLabel,
  }), [scope, mode, selectedIds, filters, target, name, defaultName, cohortLabel])
  const sig = JSON.stringify({ ...body, new_campaign_name: undefined })
  const canRun = mode === 'selection' ? selectedIds.length > 0 : !cohortBlocked

  // dry run: the counts before anything is written
  useEffect(() => {
    if (!open || !canRun || done) return
    let alive = true
    const t = window.setTimeout(() => {
      setPreview({ sig, data: null, error: null })
      postStack({ ...body, dry_run: true })
        .then((data) => { if (alive) setPreview({ sig, data, error: null }) })
        .catch((e: unknown) => { if (alive) setPreview({ sig, data: null, error: e instanceof Error ? e.message : 'Could not count this cohort' }) })
    }, 250)
    return () => { alive = false; window.clearTimeout(t) }
  }, [open, sig, canRun, done]) // eslint-disable-line react-hooks/exhaustive-deps -- sig encodes body

  const current = preview?.sig === sig ? preview : null
  const counts = done ?? current?.data ?? null

  const commit = async () => {
    setSaving(true)
    try {
      const result = await postStack(body)
      setDone(result)
      onDone?.(result)
      // the draft list now carries the new pin count (and the new draft)
      void callBackend<{ ok: boolean; drafts: StackDraft[] }>('/api/cockpit/entity-graph/campaign-stack').then((res) => { if (res.ok && res.data?.drafts) setDrafts(res.data.drafts) })
      if (result.campaign_id) setTarget(result.campaign_id)
    } catch (e) {
      setPreview({ sig, data: null, error: e instanceof Error ? e.message : 'The draft was not updated' })
    } finally {
      setSaving(false)
    }
  }

  const destinationName = target === 'new' ? (name.trim() || defaultName) : drafts?.find((d) => d.id === target)?.name ?? 'draft'
  const addLabel = counts && !done ? `Add ${fmtCount(counts.added)} to ${target === 'new' ? 'a new draft' : `“${destinationName}”`}` : 'Add to draft'

  return (
    <LCDialog
      open={open}
      onOpenChange={onOpenChange}
      width={620}
      sticky={saving}
      title={done ? (done.created ? 'Draft created' : 'Added to the draft') : 'Add to campaign'}
      description={done ? `${fmtCount(done.added)} properties pinned on “${done.campaign_name ?? destinationName}” — ${fmtCount(done.total_after)} in total.` : 'Pins the targetable properties on a draft. Run another filter and add it to the same draft to stack cohorts.'}
      footer={done ? (
        <>
          <LCButton variant="quiet" onClick={() => onOpenChange(false)}>Close</LCButton>
          <LCButton variant="primary" icon="plus" onClick={() => { setDone(null); setPreview(null); onOpenChange(false) }}>Run another filter</LCButton>
        </>
      ) : (
        <>
          <LCButton variant="quiet" onClick={() => onOpenChange(false)}>Cancel</LCButton>
          <LCButton variant="primary" disabled={!canRun || !counts || counts.added === 0 || saving || Boolean(current?.error)} onClick={() => { void commit() }}>{saving ? 'Adding…' : addLabel}</LCButton>
        </>
      )}
    >
      <div className="egdk-stack">
        {!done ? (
          <>
            <section className="egdk-stack__sec">
              <span className="egdk-eyebrow">What to add</span>
              <div className="egdk-stack__modes" role="radiogroup" aria-label="What to add">
                <button type="button" role="radio" aria-checked={mode === 'selection'} disabled={!selectedIds.length} className={cx('egdk-stack__mode', mode === 'selection' && 'is-on')} onClick={() => setMode('selection')}>
                  <strong>{fmtCount(selectedIds.length)} selected {selectedIds.length === 1 ? scopeNoun(scope, 1) : noun}</strong>
                  <small>{selectedIds.length ? 'Exactly these rows.' : 'Select rows in the grid to use this.'}</small>
                </button>
                <button type="button" role="radio" aria-checked={mode === 'cohort'} disabled={Boolean(cohortBlocked)} className={cx('egdk-stack__mode', mode === 'cohort' && 'is-on')} onClick={() => setMode('cohort')} title={cohortBlocked ?? undefined}>
                  <strong>All {cohortTotal !== null ? fmtCount(cohortTotal) : ''} matching {noun}</strong>
                  <small>{cohortBlocked ?? `Every row these filters match, resolved on the server — not just the loaded rows.`}</small>
                </button>
              </div>
            </section>

            <section className="egdk-stack__sec">
              <span className="egdk-eyebrow">Destination · drafts only</span>
              {drafts === null ? <LCSkeleton shape="lines" count={3} label="Loading draft campaigns" /> : (
                <ul className="egdk-stack__dests">
                  <li>
                    <label className={cx('egdk-stack__dest', target === 'new' && 'is-on')}>
                      <input type="radio" name="egdk-stack-dest" checked={target === 'new'} onChange={() => setTarget('new')} />
                      <span className="egdk-stack__dest-main">
                        <strong>New draft</strong>
                        {target === 'new' ? <input className="egdk-input" value={name} placeholder={defaultName} aria-label="Draft name" onChange={(e) => setName(e.target.value)} /> : <small>Name it after this cohort</small>}
                      </span>
                    </label>
                  </li>
                  {drafts.map((d) => (
                    <li key={d.id}>
                      <label className={cx('egdk-stack__dest', target === d.id && 'is-on', !d.stackable && 'is-off')} title={d.stackable ? undefined : 'This draft targets by filters — pinning properties beside them would intersect, not add.'}>
                        <input type="radio" name="egdk-stack-dest" checked={target === d.id} disabled={!d.stackable} onChange={() => setTarget(d.id)} />
                        <span className="egdk-stack__dest-main">
                          <strong>{d.name}</strong>
                          <small>{d.stackable ? `${fmtCount(d.pinned_properties)} pinned${d.segments ? ` · ${d.segments} ${d.segments === 1 ? 'cohort' : 'cohorts'} stacked` : ''}` : 'Targets by filters — cannot stack'}</small>
                        </span>
                      </label>
                    </li>
                  ))}
                  {draftsError ? <li className="egdk-none">{draftsError}</li> : null}
                </ul>
              )}
            </section>
          </>
        ) : null}

        <section className="egdk-stack__sec" aria-live="polite">
          <span className="egdk-eyebrow">{done ? 'What was added' : 'What will be added'}</span>
          {!canRun ? <p className="egdk-none">{mode === 'cohort' ? cohortBlocked : 'Select rows first.'}</p>
            : current?.error ? <p className="egdk-stack__error"><Icon name="alert-circle" size={13} />{current.error}</p>
              : !counts ? <LCSkeleton shape="lines" count={3} label="Counting against the campaign audience" />
                : <StackCounts result={counts} scope={scope} />}
        </section>

        <p className="egdk-stack__contract"><Icon name="shield" size={13} />Only the draft’s target list changes. Nothing is built, scheduled, launched or sent — Campaigns runs Build and every gate (suppression, contactability, identity, sender coverage, templates) on the draft.</p>
      </div>
    </LCDialog>
  )
}

function ReasonList({ reasons }: { reasons: Record<string, number> }) {
  const entries = Object.entries(reasons).sort((a, b) => b[1] - a[1])
  if (!entries.length) return null
  return (
    <ul className="egdk-stack__reasons">
      {entries.map(([code, n]) => <li key={code}><span>{smsBlockLabel(code)}</span><b>{fmtCount(n)}</b></li>)}
    </ul>
  )
}

function StackCounts({ result, scope }: { result: StackResult; scope: EntityScope }) {
  return (
    <div className="egdk-stack__counts">
      <div className="egdk-stack__figs">
        <Fig label={scope === 'properties' ? 'Properties' : 'Properties resolved'} value={result.resolved_properties} hint={scope !== 'properties' ? `from ${fmtCount(result.requested)} ${scopeNoun(scope, result.requested)}` : undefined} />
        <Fig label="Already on the draft" value={result.already_present} />
        <Fig label="Ready" value={result.added_ready} tone="ok" />
        <Fig label="Held" value={result.added_held} tone="attn" hint="pinned · Build holds them" />
        <Fig label="Not targetable" value={result.ineligible} tone="mute" hint="not pinned" />
      </div>
      {result.added_held ? <><p className="egdk-stack__why">Held (pinned — Build carries them as held targets until the reason clears)</p><ReasonList reasons={result.held_by_reason} /></> : null}
      {result.ineligible ? <><p className="egdk-stack__why">Not targetable (not pinned)</p><ReasonList reasons={result.ineligible_by_reason} /></> : null}
      {(result.notes ?? []).map((n) => <p key={n} className="egdk-stack__note">{n}</p>)}
      <p className="egdk-stack__note">Draft total after this: <b>{fmtCount(result.total_after)}</b> properties. Phones shared across properties are collapsed to one recipient at Build.</p>
    </div>
  )
}

function Fig({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: 'ok' | 'attn' | 'mute' }) {
  return (
    <div className={cx('egdk-stack__fig', tone && `is-${tone}`)}>
      <span>{label}</span>
      <b>{fmtCount(value)}</b>
      {hint ? <small>{hint}</small> : null}
    </div>
  )
}
