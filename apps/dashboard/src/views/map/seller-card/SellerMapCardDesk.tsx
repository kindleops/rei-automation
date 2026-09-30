/**
 * THE DESKTOP SELLER CARD — one spatial object in three states.
 *
 *   PREVIEW  glance      a capsule tethered to the pin; it rides the map as it
 *                        moves and stays inside the pane. The camera does not move.
 *   HALF     operate     a floating command card docked right; the camera frames
 *                        the property beside it.
 *   FULL     investigate a wide inspector; the map stays, slightly quieted.
 *
 * One root element persists through all three (see use-desk-morph), so every
 * change of state is the same object changing shape. The phone never renders
 * this: it keeps its bottom sheet.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SellerMapCardViewModel } from './seller-map-card.types'
import {
  FULL_TABS,
  HALF_TABS,
  placePreview,
  readRememberedTab,
  rememberTab,
  tabForState,
  type DeskState,
  type DeskTab,
  type SellerDeskModel,
} from './seller-card-desk-model'
import {
  Badge,
  FactRows,
  GraphSnapshot,
  Icon,
  LAUNCH_META,
  LaunchCard,
  PropertyRecord,
  Section,
  StageRail,
  TabRail,
  Tiles,
  Timeline,
  cls,
  type DeskLaunch,
} from './SellerMapCardDeskParts'
import { useDeskMorph } from './use-desk-morph'

export type { DeskLaunch } from './SellerMapCardDeskParts'

export type DeskHero = {
  /** Street View when the metadata probe confirmed a panorama, else the aerial. */
  url: string | null
  ready: boolean
  loading: boolean
  usingFallback: boolean
  aerialUrl: string | null
  onError: () => void
}

export type DeskPrimary = {
  kind: 'send' | 'reply' | 'blocked' | 'unavailable'
  label: string
  state: 'idle' | 'sending' | 'sent' | 'blocked' | 'failed'
  reason: string | null
  run: () => void
}

type DeskProps = {
  host: HTMLElement
  state: DeskState
  conversation: boolean
  full: boolean
  anchor: { x: number; y: number } | null
  viewModel: SellerMapCardViewModel
  model: SellerDeskModel
  hero: DeskHero
  detailLoading: boolean
  threadLoading: boolean
  threadError: string | null
  primary: DeskPrimary
  canMessage: boolean
  canLookAround: boolean
  reducedMotion: boolean
  conversationNode: ReactNode
  onExpand: () => void
  onFull: () => void
  onHalf: () => void
  onCollapse: () => void
  onClose?: () => void
  onOpenConversation: () => void
  onLookAround: () => void
  onLaunch: (target: DeskLaunch) => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  /** The tab on screen (null in PREVIEW / conversation) — the thread is hydrated only for Activity. */
  onVisibleTab?: (tab: DeskTab | null) => void
}

const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [role="tab"], [data-no-expand]'

const useHostSize = (host: HTMLElement) => {
  const [size, setSize] = useState(() => ({ width: host.clientWidth || 1200, height: host.clientHeight || 800 }))
  useLayoutEffect(() => {
    const read = () => setSize((s) => (s.width === host.clientWidth && s.height === host.clientHeight ? s : { width: host.clientWidth, height: host.clientHeight }))
    read()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null
    ro?.observe(host)
    return () => ro?.disconnect()
  }, [host])
  return size
}

/* ── imagery ───────────────────────────────────────────────────────────── */

const HeroImage = ({ hero, alt, className }: { hero: DeskHero; alt: string; className?: string }) => (
  <div className={cls('smcd-img', className, hero.ready && 'is-ready', !hero.url && 'is-empty')}>
    {hero.url ? (
      <img key={hero.url} src={hero.url} alt={alt} loading="eager" decoding="async" onError={hero.onError} />
    ) : null}
    {!hero.ready ? (
      <span className="smcd-img__empty" aria-hidden="true">
        <Icon name="home" size={18} />
        <em>{hero.loading ? 'Loading imagery' : 'No imagery here'}</em>
      </span>
    ) : null}
  </div>
)

/* ── primary outreach, as a PREVIEW quick action: arm, then confirm ───── */

const PrimaryQuick = ({ primary }: { primary: DeskPrimary }) => {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return undefined
    const t = window.setTimeout(() => setArmed(false), 4000)
    return () => window.clearTimeout(t)
  }, [armed])
  if (primary.kind === 'blocked' || primary.kind === 'unavailable') return null
  if (primary.kind === 'reply') {
    return (
      <button type="button" className="smcd-qa is-primary" data-seller-action="reply" onClick={(e) => { e.stopPropagation(); primary.run() }}>
        <Icon name="message" />Reply
      </button>
    )
  }
  const busy = primary.state !== 'idle'
  return (
    <button
      type="button"
      className={cls('smcd-qa', 'is-primary', armed && 'is-armed', busy && `is-${primary.state}`)}
      data-seller-action="primary-send"
      disabled={primary.state === 'sending' || primary.state === 'sent'}
      title={armed ? 'Sends a live SMS now' : primary.reason ?? undefined}
      onClick={(e) => {
        e.stopPropagation()
        // A glance surface never sends on one click: arm first, send on the second.
        if (!armed && !busy) { setArmed(true); return }
        setArmed(false)
        primary.run()
      }}
    >
      <Icon name="send" />
      {armed ? 'Confirm · send now' : primary.label}
    </button>
  )
}

const MoreMenu = ({ model, canLookAround, onLookAround, onLaunch }: {
  model: SellerDeskModel
  canLookAround: boolean
  onLookAround: () => void
  onLaunch: (t: DeskLaunch) => void
}) => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])
  const items: Array<{ key: string; label: string; icon: Parameters<typeof Icon>[0]['name']; run: () => void }> = [
    ...(model.links.threadKey ? [{ key: 'inbox', label: LAUNCH_META.inbox.label, icon: LAUNCH_META.inbox.icon, run: () => onLaunch('inbox') }] : []),
    { key: 'deal', label: LAUNCH_META.deal.label, icon: LAUNCH_META.deal.icon, run: () => onLaunch('deal') },
    { key: 'comps', label: LAUNCH_META.comps.label, icon: LAUNCH_META.comps.icon, run: () => onLaunch('comps') },
    { key: 'buyers', label: LAUNCH_META.buyers.label, icon: LAUNCH_META.buyers.icon, run: () => onLaunch('buyers') },
    { key: 'graph', label: LAUNCH_META.graph.label, icon: LAUNCH_META.graph.icon, run: () => onLaunch('graph') },
    ...(canLookAround ? [{ key: 'look', label: 'Look Around', icon: 'globe' as const, run: onLookAround }] : []),
  ]
  return (
    <div className="smcd-more" ref={ref}>
      <button type="button" className={cls('smcd-qa', 'is-icon', open && 'is-open')} aria-label="More actions" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}>
        <Icon name="more" size={16} />
      </button>
      {open ? (
        <div className="smcd-menu" role="menu">
          {items.map((item) => (
            <button key={item.key} type="button" role="menuitem" className="smcd-menu__item" onClick={(e) => { e.stopPropagation(); setOpen(false); item.run() }}>
              <Icon name={item.icon} />{item.label}
              {item.key !== 'look' ? <span aria-hidden="true">↗</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ── PREVIEW — the glance ──────────────────────────────────────────────── */

const PreviewFace = memo(({ model, hero, primary, canMessage, canLookAround, closable, onExpand, onClose, onOpenConversation, onLookAround, onLaunch }: {
  model: SellerDeskModel
  hero: DeskHero
  primary: DeskPrimary
  canMessage: boolean
  canLookAround: boolean
  closable: boolean
  onExpand: () => void
  onClose?: () => void
  onOpenConversation: () => void
  onLookAround: () => void
  onLaunch: (t: DeskLaunch) => void
}) => {
  const { identity, stage, value } = model
  return (
    <>
      <StageRail rail={model.rail} color={stage.color} compact />
      <div className="smcd-preview" data-morph="face">
        <header className="smcd-preview__head">
          <div className="smcd-chips" aria-label="Lead state">
            <span className="smcd-chip is-stage" style={{ '--smcd-stage': stage.color } as CSSProperties}><i aria-hidden="true" />{stage.label}</span>
            <span className={cls('smcd-chip', stage.blocked ? 'is-blocker' : 'is-status')}>{stage.blocked ? stage.blockReason || 'Suppressed' : stage.statusLabel}</span>
            {stage.temperature === 'hot' ? <span className="smcd-chip is-attention">Hot</span> : null}
            {canLookAround ? (
              <button type="button" className="smcd-chip is-button" data-look-around onClick={(e) => { e.stopPropagation(); onLookAround() }}>
                <Icon name="globe" size={12} />Look Around
              </button>
            ) : null}
          </div>
          <div className="smcd-head-tools">
            <button type="button" className="smcd-icon" aria-label="Open the property card" title="Open (click the capsule)" onClick={(e) => { e.stopPropagation(); onExpand() }}>
              <Icon name="expand" size={13} />
            </button>
            {closable ? (
              <button type="button" className="smcd-icon" aria-label="Close" onClick={(e) => { e.stopPropagation(); onClose?.() }}>
                <Icon name="close" size={13} />
              </button>
            ) : null}
          </div>
        </header>
        <div className="smcd-preview__main">
          <div className="smcd-thumb" data-morph="hero">
            <HeroImage hero={hero} alt={`Street View of ${identity.full}`} />
          </div>
          <div className="smcd-preview__id">
            <strong className="smcd-address" title={identity.full}>{identity.line1}</strong>
            {identity.locality ? <span className="smcd-locality">{identity.locality}</span> : null}
            <span className="smcd-owner">
              {identity.ownerKnown ? identity.ownerName : 'Owner not on record'}
              {identity.ownerKind ? <em> · {identity.ownerKind}</em> : null}
            </span>
            {model.factLine ? <span className="smcd-specline">{model.factLine}</span> : null}
          </div>
        </div>
        <div className={cls('smcd-assay', !value.estimated && !value.equityPct && 'is-empty')}>
          {value.estimated || value.equityPct ? (
            <>
              <div className="smcd-assay__fig">
                <strong>{value.estimated ?? '—'}</strong>
                <em>Est. value{value.perSqft ? ` · ${value.perSqft}/sqft` : ''}</em>
              </div>
              <span className="smcd-assay__rule" aria-hidden="true" />
              <div className="smcd-assay__fig">
                <strong>{value.equityPct ?? '—'}</strong>
                <em>Equity{value.equityAmt ? ` · ${value.equityAmt}` : ''}</em>
              </div>
            </>
          ) : (
            <em className="smcd-assay__none">No valuation on record</em>
          )}
        </div>
        <footer className="smcd-quick">
          {canMessage ? (
            <button type="button" className="smcd-qa" data-seller-action="messages" onClick={(e) => { e.stopPropagation(); onOpenConversation() }}>
              <Icon name="message" />Messages
            </button>
          ) : null}
          <button type="button" className="smcd-qa" data-seller-action="details" onClick={(e) => { e.stopPropagation(); onExpand() }}>
            Details
          </button>
          <PrimaryQuick primary={primary} />
          {primary.kind === 'blocked' ? (
            <span className="smcd-qa is-static is-blocker" role="status"><span aria-hidden="true">⊘</span>{primary.reason || 'Suppressed'}</span>
          ) : null}
          <MoreMenu model={model} canLookAround={canLookAround} onLookAround={onLookAround} onLaunch={onLaunch} />
        </footer>
      </div>
    </>
  )
})
PreviewFace.displayName = 'PreviewFace'

/* ── HALF / FULL — the tab bodies ──────────────────────────────────────── */

const NextAction = ({ model }: { model: SellerDeskModel }) => (
  <div className={cls('smcd-next', `is-${model.nextAction.tone}`)}>
    <span className="smcd-next__label">Next</span>
    <strong>{model.nextAction.label}</strong>
    {model.nextAction.detail ? <em>{model.nextAction.detail}</em> : null}
  </div>
)

const Signals = ({ viewModel }: { viewModel: SellerMapCardViewModel }) => (
  viewModel.weightedSignals.length ? (
    <Section title="Signals">
      <div className="smcd-signals">
        {viewModel.weightedSignals.map((s) => (
          <span key={s.key} className={cls('smcd-signal', `is-${s.tier ?? 'neutral'}`)} title={s.tooltip}>{s.label}</span>
        ))}
      </div>
    </Section>
  ) : null
)

const TabBody = memo(({ tab, state, model, viewModel, pending, threadLoading, threadError, onLaunch }: {
  tab: DeskTab
  state: DeskState
  model: SellerDeskModel
  viewModel: SellerMapCardViewModel
  pending: boolean
  threadLoading: boolean
  threadError: string | null
  onLaunch: (t: DeskLaunch) => void
}) => {
  const full = state === 'full'
  switch (tab) {
    case 'overview':
      return full ? (
        <div className="smcd-body is-grid">
          <Section title="Summary" className="is-wide">
            <p className="smcd-summary">{model.summary}</p>
            {model.aiBrief ? <p className="smcd-brief"><span>Conversation brief</span>{model.aiBrief}</p> : null}
          </Section>
          <div className="is-wide"><NextAction model={model} /></div>
          <Section title="Acquisition"><FactRows facts={model.acquisition} pending={pending} /></Section>
          <Section title="Recent activity" aside={<span className="smcd-section__aside">{model.events.length ? `${model.events.length} events` : null}</span>}>
            <Timeline events={model.events} loading={threadLoading} error={threadError} limit={4} />
          </Section>
          <div className="is-wide"><Signals viewModel={viewModel} /></div>
        </div>
      ) : (
        <div className="smcd-body">
          <Tiles facts={model.tiles} pending={pending} />
          <NextAction model={model} />
          <Section title="Acquisition"><FactRows facts={model.acquisition} pending={pending} /></Section>
          <Signals viewModel={viewModel} />
        </div>
      )
    case 'seller':
      return (
        <div className={cls('smcd-body', full && 'is-grid')}>
          <Section title="Owner"><FactRows facts={model.seller.owner} pending={pending} /></Section>
          <Section title="Contact"><FactRows facts={model.seller.contact} pending={pending} /></Section>
          <Section title="Occupancy"><FactRows facts={model.seller.occupancy} pending={pending} /></Section>
          <Section title="Automation"><FactRows facts={model.seller.automation} pending={pending} /></Section>
          <Section title="Compliance" className={full ? 'is-wide' : undefined}><FactRows facts={model.seller.compliance} pending={pending} /></Section>
        </div>
      )
    case 'property':
      return <div className="smcd-body"><PropertyRecord viewModel={viewModel} loading={pending} /></div>
    case 'activity':
      return (
        <div className="smcd-body">
          <Timeline events={model.events} loading={threadLoading} error={threadError} />
          {!model.hasRealThread ? <p className="smcd-note">No conversation exists for this property yet; record events are shown.</p> : null}
        </div>
      )
    case 'deal':
      return (
        <div className={cls('smcd-body', full && 'is-grid')}>
          <Section title="Stage" className={full ? 'is-wide' : undefined}>
            <ol className="smcd-stages">
              {model.rail.map((s) => (
                <li key={s.code} className={cls(s.reached && 'is-reached', s.current && 'is-current')}>
                  <span>S{s.n}</span>{s.label}
                </li>
              ))}
            </ol>
          </Section>
          <Section title="Valuation inputs"><FactRows facts={model.deal.valuation} pending={pending} /></Section>
          <Section title="Scores"><FactRows facts={model.deal.scores} pending={pending} /></Section>
          <div className={full ? 'is-wide' : undefined}>
            <LaunchCard target="deal" onLaunch={onLaunch} lede="Offer posture, underwriting and the decision live there." />
          </div>
        </div>
      )
    case 'comps':
      return (
        <div className={cls('smcd-body', full && 'is-grid')}>
          <Section title="Subject"><FactRows facts={model.subject} pending={pending} /></Section>
          <Section title="Market record"><FactRows facts={model.market} pending={pending} /></Section>
          <div className={full ? 'is-wide' : undefined}>
            <LaunchCard target="comps" onLaunch={onLaunch} lede="Sold comps aren't loaded on the map card — run them against this subject." />
          </div>
        </div>
      )
    case 'buyers':
      return (
        <div className="smcd-body">
          <LaunchCard target="buyers" onLaunch={onLaunch} lede="Ranks active buyers for this property from their purchase evidence." />
          <Section title="What Buyer Match reads">
            <FactRows
              facts={[
                { key: 'asset', label: 'Asset', value: model.assetLabel },
                { key: 'market', label: 'Market', value: model.identity.market, missing: 'Not on record' },
                { key: 'value', label: 'Est. value', value: model.value.estimated, tone: 'value', missing: 'Not on record' },
                ...model.subject.slice(1, 4),
              ]}
              pending={pending}
            />
          </Section>
        </div>
      )
    case 'campaigns':
      return (
        <div className="smcd-body is-grid">
          <Section title="Outreach"><FactRows facts={model.outreach} pending={pending} /></Section>
          <Section title="Send window">
            <p className="smcd-note">Queued sends go out only inside the seller's local contact window; the queue enforces it and holds anything outside it.</p>
            {model.stage.blocked ? <p className="smcd-note is-blocker">This contact is suppressed — nothing will be queued.</p> : null}
          </Section>
          <div className="is-wide">
            <LaunchCard target="campaigns" onLaunch={onLaunch} lede="Campaign membership isn't on the map record; open Campaign Command to review campaigns." />
          </div>
        </div>
      )
    case 'graph':
      return (
        <div className="smcd-body">
          <GraphSnapshot graph={model.graph} />
          <LaunchCard target="graph" onLaunch={onLaunch} lede="Owner, entities, portfolio and every linked record." />
        </div>
      )
    default:
      return null
  }
})
TabBody.displayName = 'TabBody'

/* ── HALF / FULL — the docked face ─────────────────────────────────────── */

const ActionBar = ({ model, primary, canMessage, canLookAround, full, onOpenConversation, onLookAround, onLaunch }: {
  model: SellerDeskModel
  primary: DeskPrimary
  canMessage: boolean
  canLookAround: boolean
  full: boolean
  onOpenConversation: () => void
  onLookAround: () => void
  onLaunch: (t: DeskLaunch) => void
}) => (
  <footer className="smcd-actionbar">
    {primary.kind === 'blocked' ? (
      <p className="smcd-blocked" role="status">
        <span aria-hidden="true">⊘</span>
        <span><strong>{primary.reason || 'Suppressed'}</strong><em>Outreach is suppressed for this contact.</em></span>
      </p>
    ) : primary.kind === 'unavailable' ? (
      <span className="smcd-btn is-static" role="status" title={primary.reason ?? undefined}>{primary.reason || primary.label}</span>
    ) : (
      <button
        type="button"
        className={cls('smcd-btn', 'is-primary', primary.state !== 'idle' && `is-${primary.state}`)}
        data-seller-action={primary.kind === 'reply' ? 'reply' : 'primary-send'}
        disabled={primary.state === 'sending'}
        title={primary.kind === 'send' ? 'Sends a live SMS' : undefined}
        onClick={(e) => { e.stopPropagation(); primary.run() }}
      >
        <Icon name={primary.kind === 'reply' ? 'message' : 'send'} />{primary.label}
      </button>
    )}
    {canMessage ? (
      <button type="button" className="smcd-btn" data-seller-action="messages" onClick={(e) => { e.stopPropagation(); onOpenConversation() }}>
        <Icon name="message" />Messages
      </button>
    ) : null}
    {model.links.threadKey ? (
      <button type="button" className="smcd-btn is-quiet" data-seller-action="open-inbox" onClick={(e) => { e.stopPropagation(); onLaunch('inbox') }}>
        <Icon name="inbox" />{full ? 'Open in Inbox' : 'Inbox'}
      </button>
    ) : null}
    {full && canLookAround ? (
      <button type="button" className="smcd-btn is-quiet" data-look-around onClick={(e) => { e.stopPropagation(); onLookAround() }}>
        <Icon name="globe" />Look Around
      </button>
    ) : null}
  </footer>
)

const CommandRow = ({ onLaunch }: { onLaunch: (t: DeskLaunch) => void }) => (
  <nav className="smcd-command" aria-label="Open this property in">
    {(['deal', 'comps', 'buyers', 'graph'] as DeskLaunch[]).map((t, i) => (
      <button key={t} type="button" className="smcd-cmd" data-launch={t} style={{ '--i': i } as CSSProperties} onClick={(e) => { e.stopPropagation(); onLaunch(t) }} title={`Open in ${LAUNCH_META[t].app}`}>
        <Icon name={LAUNCH_META[t].icon} />{LAUNCH_META[t].label}
      </button>
    ))}
  </nav>
)

const DockFace = memo(({ state, model, viewModel, hero, primary, pending, threadLoading, threadError, canMessage, canLookAround, closable, tab, onTab, onFull, onHalf, onCollapse, onClose, onOpenConversation, onLookAround, onLaunch }: {
  state: DeskState
  model: SellerDeskModel
  viewModel: SellerMapCardViewModel
  hero: DeskHero
  primary: DeskPrimary
  pending: boolean
  threadLoading: boolean
  threadError: string | null
  canMessage: boolean
  canLookAround: boolean
  closable: boolean
  tab: DeskTab
  onTab: (t: DeskTab) => void
  onFull: () => void
  onHalf: () => void
  onCollapse: () => void
  onClose?: () => void
  onOpenConversation: () => void
  onLookAround: () => void
  onLaunch: (t: DeskLaunch) => void
}) => {
  const full = state === 'full'
  const { identity, stage } = model
  const scrollRef = useRef<HTMLDivElement>(null)
  const tabs = full ? FULL_TABS : HALF_TABS
  const shown = tabForState(tab, state)
  const place = [identity.locality, identity.market && identity.market !== identity.locality ? identity.market : null].filter(Boolean).join(' · ')

  const pickTab = (next: DeskTab) => {
    onTab(next)
    // keep the tab rail in view when the hero has scrolled away
    const scroller = scrollRef.current
    const rail = scroller?.querySelector<HTMLElement>('.smcd-tabs')
    if (scroller && rail && scroller.scrollTop > rail.offsetTop) scroller.scrollTo({ top: rail.offsetTop })
  }

  return (
    <div className="smcd-dockface">
      <div className="smcd-controls">
        <button type="button" className="smcd-icon is-glass" aria-label="Collapse to preview" title="Collapse to preview" onClick={(e) => { e.stopPropagation(); onCollapse() }}>
          <Icon name="collapse" size={13} />
        </button>
        <button type="button" className="smcd-icon is-glass" aria-label={full ? 'Restore to half' : 'Expand to full'} title={full ? 'Restore' : 'Expand'} onClick={(e) => { e.stopPropagation(); if (full) onHalf(); else onFull() }}>
          <Icon name={full ? 'half' : 'full'} size={13} />
        </button>
        {closable ? (
          <button type="button" className="smcd-icon is-glass" aria-label="Close" onClick={(e) => { e.stopPropagation(); onClose?.() }}>
            <Icon name="close" size={13} />
          </button>
        ) : null}
      </div>
      <div className="smcd-scroll" ref={scrollRef}>
        <div className={cls('smcd-hero', full && 'is-strip', full && !(hero.aerialUrl && !hero.usingFallback) && 'is-single')} data-morph="hero">
          <HeroImage hero={hero} alt={`Street View of ${identity.full}`} className="smcd-hero__main" />
          {full && hero.aerialUrl && !hero.usingFallback ? (
            <div className="smcd-img smcd-hero__aerial is-ready">
              <img src={hero.aerialUrl} alt={`Aerial view of ${identity.full}`} loading="eager" decoding="async" />
              <span className="smcd-hero__tag">Aerial</span>
            </div>
          ) : null}
          <span className="smcd-hero__scrim" aria-hidden="true" />
          <div className="smcd-hero__chips">
            <span className="smcd-chip is-stage is-onimage" style={{ '--smcd-stage': stage.color } as CSSProperties}><i aria-hidden="true" />S{stage.n} · {stage.label}</span>
            <span className={cls('smcd-chip', 'is-onimage', stage.blocked && 'is-blocker')}>{stage.blocked ? stage.blockReason || 'Suppressed' : stage.statusLabel}</span>
          </div>
          {canLookAround ? (
            <button type="button" className="smcd-chip is-button is-onimage smcd-hero__look" data-look-around onClick={(e) => { e.stopPropagation(); onLookAround() }}>
              <Icon name="globe" size={12} />Look Around
            </button>
          ) : null}
          {hero.usingFallback && hero.ready ? <span className="smcd-hero__tag is-left">Aerial · no Street View here</span> : null}
        </div>
        <div className="smcd-face" data-morph="face">
          <div className="smcd-id">
            <h2 className="smcd-id__address" title={identity.full}>{identity.line1}</h2>
            {place ? <p className="smcd-id__place"><Icon name="pin" size={12} />{place}</p> : null}
            <p className="smcd-id__owner">
              <span>Owner</span>
              <strong>{identity.ownerKnown ? identity.ownerName : 'Not on record'}</strong>
              {identity.ownerKind ? <em>{identity.ownerKind}</em> : null}
              {identity.contactName && identity.contactName !== identity.ownerName ? <em>Contact · {identity.contactName}</em> : null}
            </p>
            {model.factLine ? <p className="smcd-specline">{model.factLine}</p> : null}
            <div className="smcd-id__stage">
              <StageRail rail={model.rail} color={stage.color} />
              <span>Stage {stage.n} of {model.rail.length} · {stage.statusLabel}</span>
            </div>
            {full && model.badges.length ? (
              <div className="smcd-badges">{model.badges.map((b) => <Badge key={b.key} badge={b} />)}</div>
            ) : null}
          </div>
          {full ? <div className="smcd-kpis"><Tiles facts={model.kpis} pending={pending} variant="kpi" /></div> : null}
          <CommandRow onLaunch={onLaunch} />
          <TabRail tabs={tabs} active={shown} onChange={pickTab} />
          <div className="smcd-tabpanel" role="tabpanel" key={`${shown}-${state}`}>
            <TabBody tab={shown} state={state} model={model} viewModel={viewModel} pending={pending} threadLoading={threadLoading} threadError={threadError} onLaunch={onLaunch} />
          </div>
        </div>
      </div>
      <ActionBar model={model} primary={primary} canMessage={canMessage} canLookAround={canLookAround} full={full} onOpenConversation={onOpenConversation} onLookAround={onLookAround} onLaunch={onLaunch} />
    </div>
  )
})
DockFace.displayName = 'DockFace'

/* ── the object ────────────────────────────────────────────────────────── */

export const SellerMapCardDesk = (props: DeskProps) => {
  const {
    host, state, conversation, full, anchor, viewModel, model, hero, detailLoading, threadLoading, threadError,
    primary, canMessage, canLookAround, reducedMotion, conversationNode,
    onExpand, onFull, onHalf, onCollapse, onClose, onOpenConversation, onLookAround, onLaunch, onMouseEnter, onMouseLeave, onVisibleTab,
  } = props
  const rootRef = useRef<HTMLDivElement>(null)
  const pane = useHostSize(host)
  const [tab, setTab] = useState<DeskTab>(readRememberedTab)
  const [previewHeight, setPreviewHeight] = useState(252)

  const docked = state !== 'preview' || conversation
  const size: DeskState = conversation ? (full ? 'full' : 'half') : state
  const rank = size === 'full' ? 2 : size === 'half' ? 1 : 0
  useDeskMorph(rootRef, conversation ? `conversation-${size}` : state, rank, reducedMotion)

  useLayoutEffect(() => {
    if (docked) return undefined
    const el = rootRef.current
    if (!el) return undefined
    const read = () => setPreviewHeight((h) => (Math.abs(h - el.offsetHeight) < 1 ? h : el.offsetHeight))
    read()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [docked])

  const placement = docked ? null : placePreview(anchor, pane, previewHeight)
  const style: CSSProperties | undefined = placement
    ? { left: placement.x, top: placement.y, width: placement.width }
    : undefined

  const onTab = useCallback((next: DeskTab) => {
    rememberTab(next)
    setTab(next)
  }, [])
  const visibleTab = docked && !conversation ? tabForState(tab, state) : null
  useEffect(() => { onVisibleTab?.(visibleTab) }, [visibleTab, onVisibleTab])

  const onRootClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation()
    const target = event.target as HTMLElement | null
    if (state === 'preview' && !conversation && !target?.closest(INTERACTIVE)) onExpand()
  }

  const pending = detailLoading && !viewModel.dossierReady
  const tether = placement?.tether && anchor && !placement.detached ? { from: anchor, to: placement.tether } : null

  return createPortal(
    <>
      {tether ? (
        <span
          className="smcd-tether"
          aria-hidden="true"
          style={{
            left: tether.from.x,
            top: tether.from.y,
            width: Math.max(0, Math.hypot(tether.to.x - tether.from.x, tether.to.y - tether.from.y)),
            transform: `rotate(${Math.atan2(tether.to.y - tether.from.y, tether.to.x - tether.from.x)}rad)`,
          }}
        />
      ) : null}
      {size === 'full' && !conversation ? <div className="smcd-veil" aria-hidden="true" /> : null}
      <div
        ref={rootRef}
        className={cls(
          'smcd',
          `is-${size}`,
          docked && 'smc-dock',
          conversation && 'is-conversation',
          placement?.detached && 'is-detached',
          placement && `is-side-${placement.side}`,
          reducedMotion && 'is-reduced-motion',
        )}
        style={style}
        data-desk-state={conversation ? 'conversation' : state}
        data-anchor={anchor ? `${Math.round(anchor.x)},${Math.round(anchor.y)}` : undefined}
        role={state === 'preview' && !conversation ? 'group' : 'region'}
        aria-label={state === 'preview' && !conversation ? `Property preview — ${model.identity.full}` : conversation ? 'Seller conversation' : `Property card — ${model.identity.full}`}
        onClick={onRootClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {conversation ? (
          <div className="smcd-convo" data-morph="face">{conversationNode}</div>
        ) : state === 'preview' ? (
          <PreviewFace
            model={model}
            hero={hero}
            primary={primary}
            canMessage={canMessage}
            canLookAround={canLookAround}
            closable={Boolean(onClose)}
            onExpand={onExpand}
            onClose={onClose}
            onOpenConversation={onOpenConversation}
            onLookAround={onLookAround}
            onLaunch={onLaunch}
          />
        ) : (
          <DockFace
            state={state}
            model={model}
            viewModel={viewModel}
            hero={hero}
            primary={primary}
            pending={pending}
            threadLoading={threadLoading}
            threadError={threadError}
            canMessage={canMessage}
            canLookAround={canLookAround}
            closable={Boolean(onClose)}
            tab={tab}
            onTab={onTab}
            onFull={onFull}
            onHalf={onHalf}
            onCollapse={onCollapse}
            onClose={onClose}
            onOpenConversation={onOpenConversation}
            onLookAround={onLookAround}
            onLaunch={onLaunch}
          />
        )}
      </div>
    </>,
    host,
  )
}

