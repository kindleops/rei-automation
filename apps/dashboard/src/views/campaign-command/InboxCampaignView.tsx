/**
 * InboxCampaignView — Full Campaign Command Center inside the Inbox workspace pane.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Icon } from '../../shared/icons'
import { emitNotification } from '../../shared/NotificationToast'
import { loadCampaigns, fetchCampaignTargets } from './campaigns.adapter'
import { executeCampaignAction } from './campaign-actions'
import { matchesListFilter, type CampaignListFilter } from './campaign-health'
import type { CampaignModel, CampaignSummary, CampaignTarget, CampaignDetailTab, CampaignCommandState } from './campaigns.types'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { ViewWidthPercent, ViewLayoutMode } from '../../domain/inbox/view-layout'
import { CreateCampaignModal } from './CreateCampaignModal'
import { CampaignScheduleModal } from './CampaignScheduleModal'
import {
  cls,
  fmt,
  fmtPct,
  fmtRelative,
  KpiStrip,
  CampaignHealthSidebar,
  CampaignListPanel,
  DetailPanel,
  primaryAction,
} from './CampaignsPage'
import './campaigns.css'
import './inbox-campaign-view.css'

const LinkedChip = ({
  campaign,
  target,
  onFocus,
}: {
  campaign: CampaignSummary | null
  target: CampaignTarget | null
  onFocus: () => void
}) => {
  if (!campaign) return null
  const tStatus = target?.target_status ?? null
  return (
    <div className="icv-linked-chip" onClick={onFocus} title="Jump to linked campaign">
      <div className="icv-linked-chip__dot is-active" />
      <div className="icv-linked-chip__body">
        <span className="icv-linked-chip__name">{campaign.campaign_name}</span>
        <span className="icv-linked-chip__meta">
          {fmtPct(campaign.reply_rate)} reply
          {tStatus && (
            <><span className="icv-linked-chip__sep">·</span>
            <span className={`icv-linked-chip__status is-${tStatus}`}>{tStatus.replace(/_/g, ' ')}</span></>
          )}
          <span className="icv-linked-chip__sep">·</span>
          next {fmtRelative(campaign.next_send_at)}
        </span>
      </div>
      <span className="icv-linked-chip__action">
        <Icon name="arrow-up-right" size={10} />
      </span>
    </div>
  )
}

const CompactList = ({
  campaigns,
  loading,
  linkedId,
  onAction,
}: {
  campaigns: CampaignSummary[]
  loading: boolean
  linkedId: string | null
  onAction: (action: string, campaign: CampaignSummary) => void
}) => (
  <div className="icv-compact">
    <div className="icv-compact__header">
      <Icon name="send" size={11} />
      <span>Campaigns</span>
      <span className="icv-compact__count">{campaigns.length}</span>
    </div>
    <div className="icv-compact__list">
      {loading ? (
        [1, 2, 3].map((i) => <div key={i} className="ccc__shimmer" style={{ height: 44, marginBottom: 4, borderRadius: 4 }} />)
      ) : campaigns.map((c) => {
        const pAction = primaryAction(c)
        return (
          <div key={c.id} className={cls('icv-compact__row', linkedId === c.id && 'is-linked')}>
            <div className={cls('icv-compact__dot', `is-${c.status}`)} />
            <div className="icv-compact__info">
              <div className="icv-compact__name">{c.campaign_name}</div>
              <div className="icv-compact__stats">
                <span>{fmt(c.ready_targets)} ready</span>
              </div>
            </div>
            <button className={cls('icv-btn icv-btn--xs', pAction.variant)} onClick={() => onAction(pAction.action, c)}>
              {pAction.label}
            </button>
          </div>
        )
      })}
    </div>
  </div>
)

interface InboxCampaignViewProps {
  selectedThread: InboxWorkflowThread | null
  paneWidth?: ViewWidthPercent
  layoutMode?: ViewLayoutMode
}

export const InboxCampaignView = ({
  selectedThread,
  paneWidth = '100',
}: InboxCampaignViewProps) => {
  const [model, setModel] = useState<CampaignModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [editCampaignId, setEditCampaignId] = useState<string | null>(null)
  const [scheduleCampaign, setScheduleCampaign] = useState<CampaignSummary | null>(null)
  const [scheduleMode, setScheduleMode] = useState<'schedule' | 'reschedule'>('schedule')
  const [detailTab, setDetailTab] = useState<CampaignDetailTab | undefined>(undefined)

  const [commandState, setCommandState] = useState<CampaignCommandState>({
    activeCampaignId: null,
    activeCampaignContext: null,
    displayScope: 'campaign',
  })

  const [linkedTarget, setLinkedTarget] = useState<CampaignTarget | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<CampaignListFilter>('all')

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true)
    try {
      const data = await loadCampaigns()
      setModel(data)
    } catch {
      emitNotification({ title: 'Failed to load campaigns', severity: 'critical' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const linkedCampaign = useMemo<CampaignSummary | null>(() => {
    if (!model || !selectedThread) return null
    const market = (selectedThread as any).market ?? (selectedThread as any).marketName ?? ''
    const byMarket = model.campaigns.find((c) =>
      market && c.campaign_name.toLowerCase().includes(market.toLowerCase()),
    )
    return byMarket ?? model.campaigns.find((c) => c.status === 'active') ?? null
  }, [model, selectedThread])

  useEffect(() => {
    if (!linkedCampaign || !selectedThread) { setLinkedTarget(null); return }
    let active = true
    fetchCampaignTargets(linkedCampaign.id).then((targets) => {
      if (!active) return
      const phone = (selectedThread as any).phoneNumber ?? (selectedThread as any).canonicalE164 ?? ''
      const match = targets.find((t) => phone && t.canonical_e164?.replace(/\D/g, '').includes(phone.replace(/\D/g, '')))
      setLinkedTarget(match ?? targets[0] ?? null)
    }).catch(() => { if (active) setLinkedTarget(null) })
    return () => { active = false }
  }, [linkedCampaign, selectedThread])

  const campaigns = useMemo(() => {
    if (!model) return []
    let list = [...model.campaigns]
    if (statusFilter !== 'all') list = list.filter((c) => matchesListFilter(c, statusFilter))
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter((c) => c.campaign_name.toLowerCase().includes(q))
    }
    if (linkedCampaign) {
      list = [
        ...list.filter((c) => c.id === linkedCampaign.id),
        ...list.filter((c) => c.id !== linkedCampaign.id),
      ]
    }
    return list
  }, [model, statusFilter, searchQuery, linkedCampaign])

  const actionCallbacks = useMemo(() => ({
    onRefresh: () => load({ silent: true }),
    onOpenBuilder: (campaign: CampaignSummary) => {
      setEditCampaignId(campaign.id)
      setIsCreateModalOpen(true)
    },
    onOpenSchedule: (campaign: CampaignSummary, mode: 'schedule' | 'reschedule') => {
      setScheduleCampaign(campaign)
      setScheduleMode(mode)
    },
    onSelectTab: (campaignId: string, tab: string) => {
      setCommandState((prev) => ({ ...prev, activeCampaignId: campaignId }))
      setDetailTab(tab as CampaignDetailTab)
    },
  }), [load])

  const handleAction = useCallback(
    async (action: string, campaign: CampaignSummary) => {
      if (action === 'open') {
        setCommandState((prev) => ({ ...prev, activeCampaignId: campaign.id }))
        return
      }
      await executeCampaignAction(action, campaign, actionCallbacks)
    },
    [actionCallbacks],
  )

  const isCompact = paneWidth === '25'
  const showHealthSidebar = paneWidth === '100'
  const showKpis = paneWidth === '75' || paneWidth === '100'

  const selectedCampaign = useMemo(() => {
    return campaigns.find((c) => c.id === commandState.activeCampaignId) || null
  }, [campaigns, commandState.activeCampaignId])

  if (isCompact) {
    return (
      <CompactList
        campaigns={campaigns}
        loading={loading}
        linkedId={linkedCampaign?.id ?? null}
        onAction={handleAction}
      />
    )
  }

  return (
    <div
      className={cls('ccc', `is-pane-${paneWidth}`, commandState.activeCampaignId && 'is-detail-open')}
      style={{ height: '100%', maxHeight: '100%' }}
    >
      <div className="ccc__header" style={{ padding: '10px 14px 8px' }}>
        <div className="ccc__brand">
          <div className="ccc__brand-icon"><Icon name="send" size={13} /></div>
          <div>
            <div className="ccc__title" style={{ fontSize: 12 }}>Campaign Command</div>
            {selectedThread && linkedCampaign && (
              <div className="ccc__subtitle">Thread linked to {linkedCampaign.campaign_name}</div>
            )}
          </div>
        </div>
        <div className="ccc__actions">
          <button className="ccc-btn is-primary" style={{ padding: '4px 9px', fontSize: 10 }} onClick={() => { setEditCampaignId(null); setIsCreateModalOpen(true) }}>
            <Icon name="bolt" size={10} /> New
          </button>
          <button className="ccc-btn" style={{ padding: '4px 9px', fontSize: 10 }} onClick={() => load({ silent: true })}>
            <Icon name="refresh-cw" size={10} /> Refresh
          </button>
        </div>
      </div>

      {linkedCampaign && (
        <LinkedChip
          campaign={linkedCampaign}
          target={linkedTarget}
          onFocus={() => {
            setCommandState({
              activeCampaignId: linkedCampaign.id,
              activeCampaignContext: { selectedThreadId: selectedThread?.id, source: 'thread' },
              displayScope: 'thread',
            })
          }}
        />
      )}

      {showKpis && model && <KpiStrip kpis={model.kpis} />}

      <div className="ccc__body">
        <CampaignListPanel
          campaigns={campaigns}
          loading={loading}
          selectedId={commandState.activeCampaignId}
          onSelect={(c) => setCommandState({ activeCampaignId: c?.id ?? null, activeCampaignContext: null, displayScope: 'campaign' })}
          onCampaignAction={handleAction}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
        />
        <DetailPanel
          campaign={selectedCampaign}
          commandState={commandState}
          onClose={() => setCommandState((prev) => ({ ...prev, activeCampaignId: null }))}
          onAction={handleAction}
          initialTab={detailTab}
        />
        {showHealthSidebar && <CampaignHealthSidebar campaign={selectedCampaign} />}
      </div>

      {isCreateModalOpen && (
        <CreateCampaignModal
          campaignId={editCampaignId ?? undefined}
          mode={editCampaignId ? 'edit' : 'create'}
          onClose={() => { setIsCreateModalOpen(false); setEditCampaignId(null) }}
          onSuccess={(newId) => {
            setIsCreateModalOpen(false)
            setEditCampaignId(null)
            load().then(() => setCommandState((p) => ({ ...p, activeCampaignId: newId })))
          }}
        />
      )}

      {scheduleCampaign && (
        <CampaignScheduleModal
          campaign={scheduleCampaign}
          mode={scheduleMode}
          onClose={() => setScheduleCampaign(null)}
          onSuccess={() => load({ silent: true })}
        />
      )}
    </div>
  )
}