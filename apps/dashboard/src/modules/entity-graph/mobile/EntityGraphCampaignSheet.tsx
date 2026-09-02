import { useEffect, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { MobileSheet } from '../../mobile/MobileSheet'
import * as backendClient from '../../../lib/api/backendClient'
import type { EntityGraphFilters, EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'
import { cohortToCampaignFilters, describeCampaignFilters, unmappedCohortFilters } from './entity-graph-cohort'
import type { EntityScope } from './entity-graph-mobile-format'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export type HandoffMode = 'cohort' | 'selection'

type DraftCampaign = { id: string; name: string; status: string; market?: string | null }

/**
 * Add to Campaign.
 *
 * Two explicit modes, because they target different things and silently picking
 * one would be a correctness bug:
 *   • cohort    — hands over the *filter set*, so Campaigns re-resolves it and
 *                 picks up rows added since this screen loaded.
 *   • selection — hands over an explicit `properties.property_id in [...]`
 *                 filter, so exactly the chosen records are targeted.
 *
 * Either way this writes a campaign *draft* and nothing else. It never builds
 * targets and never touches send_queue: Campaigns still runs its own REACH /
 * LAUNCH readiness, routing, suppression, template and schedulability checks
 * before anything becomes sendable. That separation is the whole point — this
 * screen decides *who*, Campaigns decides *whether*.
 */

async function loadDraftCampaigns(signal?: AbortSignal): Promise<DraftCampaign[]> {
  const res = await backendClient.callBackend<{ ok: boolean; campaigns: DraftCampaign[] }>(
    '/api/cockpit/campaigns',
    { signal },
  )
  if (!res.ok || !res.data?.campaigns) return []
  return res.data.campaigns.filter((c) => c.status === 'draft')
}

type Props = {
  open: boolean
  scope: EntityScope
  filters: EntityGraphFilters
  query: string
  cohortTotal: number | null
  selected: EntitySearchResult[]
  onClose: () => void
  onDone: (message: string) => void
}

export function EntityGraphCampaignSheet({
  open,
  scope,
  filters,
  query,
  cohortTotal,
  selected,
  onClose,
  onDone,
}: Props) {
  const [mode, setMode] = useState<HandoffMode>(selected.length > 0 ? 'selection' : 'cohort')
  const [target, setTarget] = useState<'new' | string>('new')
  const [name, setName] = useState('')
  const [drafts, setDrafts] = useState<DraftCampaign[] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wasOpen, setWasOpen] = useState(open)

  // The sheet stays mounted, so `useState` ran once with whatever the selection
  // was at mount — usually empty. Re-derive the default on the closed → open
  // transition, otherwise opening it with 4 records selected still defaulted to
  // targeting the whole cohort.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setMode(selected.length > 0 ? 'selection' : 'cohort')
      setError(null)
    }
  }

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void loadDraftCampaigns(controller.signal).then(setDrafts).catch(() => setDrafts([]))
    return () => controller.abort()
  }, [open])

  const campaignFilters = cohortToCampaignFilters({ scope, filters, mode, selected })
  const described = describeCampaignFilters(campaignFilters)
  const unmapped = mode === 'cohort' ? unmappedCohortFilters(filters) : []
  const targetCount = mode === 'selection' ? selected.length : cohortTotal
  const unsupported = mode === 'cohort' && campaignFilters.length === 0 && !query

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const label = name.trim() || defaultName(mode, scope, selected.length, cohortTotal)
      const targetFilters = { properties: campaignFilters }

      if (target === 'new') {
        const res = await backendClient.callBackend<{ ok: boolean; campaign_id?: string; message?: string }>(
          '/api/cockpit/campaigns',
          {
            method: 'POST',
            body: JSON.stringify({
              name: label,
              status: 'draft',
              // Explicitly inert. createCampaign rejects both of these anyway,
              // but stating them keeps the intent legible at the call site.
              auto_send_enabled: false,
              auto_reply_mode: 'disabled',
              metadata: { target_filters: targetFilters, source: 'entity_graph', handoff_mode: mode },
              target_filters: targetFilters,
            }),
          },
        )
        if (!res.ok) throw new Error(res.message || res.error || 'campaign_create_failed')
        onDone(`Draft “${label}” created. Open Campaigns to run readiness and launch checks.`)
      } else {
        const res = await backendClient.callBackend<{ ok: boolean; message?: string }>(
          `/api/cockpit/campaigns/${encodeURIComponent(target)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              metadata: { target_filters: targetFilters, source: 'entity_graph', handoff_mode: mode },
              target_filters: targetFilters,
            }),
          },
        )
        if (!res.ok) throw new Error(res.message || res.error || 'campaign_update_failed')
        const draftName = drafts?.find((d) => d.id === target)?.name ?? 'draft'
        onDone(`Cohort applied to “${draftName}”. Campaigns will re-resolve targets on its next build.`)
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'campaign_handoff_failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <MobileSheet
      open={open}
      title="Add to Campaign"
      subtitle={scope.replace(/_/g, ' ')}
      height="full"
      className="egm-sheet"
      onClose={onClose}
    >
      <div className="egc">
        <section className="egc-block">
          <h4>What gets targeted</h4>
          <div className="egc-modes">
            <button
              type="button"
              className={cls('egc-mode', mode === 'cohort' && 'is-on')}
              onClick={() => setMode('cohort')}
            >
              <span className="egc-mode__top">
                <Icon name="filter" />
                <strong>Current filtered cohort</strong>
              </span>
              <span className="egc-mode__count">
                {cohortTotal === null ? '—' : cohortTotal.toLocaleString()} records
              </span>
              <span className="egc-mode__note">
                Hands over the filter set. Campaigns re-resolves it at build time, so
                records added later are included.
              </span>
            </button>

            <button
              type="button"
              className={cls('egc-mode', mode === 'selection' && 'is-on')}
              disabled={selected.length === 0}
              onClick={() => setMode('selection')}
            >
              <span className="egc-mode__top">
                <Icon name="check-double" />
                <strong>Selected records</strong>
              </span>
              <span className="egc-mode__count">{selected.length.toLocaleString()} selected</span>
              <span className="egc-mode__note">
                {selected.length === 0
                  ? 'Select records in the list to enable this.'
                  : 'Pins an explicit id list. Exactly these records, nothing else.'}
              </span>
            </button>
          </div>
        </section>

        <section className="egc-block">
          <h4>Filters handed to Campaigns</h4>
          {described.length > 0 ? (
            <ul className="egc-filters">
              {described.map((line) => (
                <li key={line.key}>
                  <span className="egc-filters__key">{line.label}</span>
                  <span className="egc-filters__val">{line.value}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="egc-warn">
              {mode === 'selection'
                ? 'No records selected.'
                : 'No filters are active, so this would target the entire universe. Narrow the cohort first.'}
            </p>
          )}
          {unmapped.length > 0 ? (
            <p className="egc-warn">
              Not carried over (Campaigns has no equivalent target filter):{' '}
              {unmapped.join(' · ')}. The campaign cohort will be wider than what you see here.
            </p>
          ) : null}
          {query ? (
            <p className="egc-warn">
              The active search “{query}” is not a campaign filter and will not be carried over —
              only the filters listed above are.
            </p>
          ) : null}
        </section>

        <section className="egc-block">
          <h4>Destination</h4>
          <button
            type="button"
            className={cls('egc-dest', target === 'new' && 'is-on')}
            onClick={() => setTarget('new')}
          >
            <Icon name="spark" />
            <span>Create new campaign</span>
          </button>
          {drafts === null ? (
            <p className="egc-hint">Loading draft campaigns…</p>
          ) : drafts.length === 0 ? (
            <p className="egc-hint">No draft campaigns to add to.</p>
          ) : (
            drafts.map((draft) => (
              <button
                key={draft.id}
                type="button"
                className={cls('egc-dest', target === draft.id && 'is-on')}
                onClick={() => setTarget(draft.id)}
              >
                <Icon name="file-text" />
                <span>{draft.name}</span>
                <em>draft</em>
              </button>
            ))
          )}

          {target === 'new' ? (
            <label className="egm-field" style={{ marginTop: 10 }}>
              <span>Campaign name</span>
              <input
                value={name}
                placeholder={defaultName(mode, scope, selected.length, cohortTotal)}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          ) : null}
        </section>

        <p className="egc-contract">
          <Icon name="shield" />
          This creates or updates a campaign <strong>draft</strong> only. Entity Graph never
          builds targets or writes queue rows — Campaigns runs REACH and LAUNCH readiness,
          routing, suppression, template and schedulability checks before anything can send.
        </p>

        {error ? <p className="egc-error">{error}</p> : null}

        <div className="egm-filters__footer">
          <button type="button" className="egm-btn is-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="egm-btn is-primary"
            disabled={submitting || described.length === 0 || unsupported}
            onClick={() => void submit()}
          >
            {submitting
              ? 'Saving…'
              : target === 'new'
                ? `Create draft · ${targetCount === null ? '—' : targetCount.toLocaleString()}`
                : `Apply to draft · ${targetCount === null ? '—' : targetCount.toLocaleString()}`}
          </button>
        </div>
      </div>
    </MobileSheet>
  )
}

function defaultName(mode: HandoffMode, scope: EntityScope, selectedCount: number, cohortTotal: number | null): string {
  const size = mode === 'selection' ? selectedCount : (cohortTotal ?? 0)
  const noun = scope === 'properties' ? 'properties' : scope.replace(/_/g, ' ')
  return `Entity Graph · ${size.toLocaleString()} ${noun}`
}
