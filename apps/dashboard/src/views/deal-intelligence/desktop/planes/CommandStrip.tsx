import { Icon } from '../../../../shared/icons'
import { cx, LCButton, LCIconButton, LCMenu, LCStatus, LCTabs, LCTooltip, lcMenu } from '../../../../shared/lc'
import { ago, humanize, phone as fmtPhone, splitAddress } from '../di-format'
import type { DiLinks } from '../di-links'
import { STAGE_ORDER, type DecisionState, type SellerIdentity, type UnderwritingStatus } from '../di-model'
import type { DiSubject } from '../di-subject'
import { DI_MODES, type DiDecision, type DiMode } from '../di-types'

const CONTACT: Record<string, { label: string; tone: 'ok' | 'attn' | 'crit' }> = {
  contactable: { label: 'Contactable', tone: 'ok' },
  do_not_contact: { label: 'Do not contact', tone: 'crit' },
  dnc: { label: 'Do not contact', tone: 'crit' },
  wrong_number: { label: 'Wrong number', tone: 'attn' },
  opted_out: { label: 'Opted out', tone: 'crit' },
}

const OPERATIONAL: Record<string, string> = {
  waiting_on_seller: 'Waiting on seller',
  active_communication: 'In conversation',
  not_contacted: 'Not contacted',
  needs_review: 'Needs review',
}

export interface CommandStripProps {
  d: DiDecision | null
  subject: DiSubject
  pending: boolean
  identity: SellerIdentity | null
  state: DecisionState | null
  status: UnderwritingStatus
  mode: DiMode
  onMode: (m: DiMode) => void
  links: DiLinks | null
  link: { follows: boolean; pinned: boolean; pinLabel: string | null }
  inspector: { docked: boolean; open: boolean; onToggle: () => void }
  onRefresh: () => void
  refreshing: boolean
  now: number
  criticalRisk: boolean
}

/**
 * ONE acquisition-context strip: who, which property, where in acquisition,
 * whether we can reach them — then the actions that are valid right now.
 */
export function CommandStrip({ d: shown, subject, pending, identity: shownIdentity, state: shownState, status, mode, onMode, links: shownLinks, link, inspector, onRefresh, refreshing, now, criticalRisk }: CommandStripProps) {
  // While the next subject loads, the strip already names IT (from what the
  // selection carried) and every action is off — never call or message the
  // previous seller from under the next one's header.
  const d = pending ? null : shown
  const identity = pending ? null : shownIdentity
  const links = pending ? null : shownLinks
  const state = pending ? null : shownState
  const incoming = pending ? (subject.address ?? (subject.propertyId ? `Property ${subject.propertyId}` : subject.threadKey ? `Conversation ${subject.threadKey}` : null)) : null
  const { street, locality } = splitAddress(d?.subject.address ?? subject.address ?? null)
  const contact = d?.contact ?? null
  const stage = d?.pipeline?.stage ?? null
  const stageIdx = stage ? STAGE_ORDER.indexOf(stage) : -1
  const contactState = contact?.suppressed
    ? { label: 'Suppressed', tone: 'crit' as const }
    : contact?.contactability ? CONTACT[contact.contactability] ?? { label: humanize(contact.contactability) ?? '—', tone: 'attn' as const } : null
  const conversation = contact?.operationalStatus ? OPERATIONAL[contact.operationalStatus] ?? humanize(contact.operationalStatus) : null
  const lastReply = contact?.lastInboundAt ? ago(contact.lastInboundAt, now) : null
  const telHref = contact?.phone && !contact.suppressed ? `tel:${contact.phone}` : null

  const more = links ? lcMenu(
    [
      ...(links.pipeline ? [{ label: 'Open in Pipeline', icon: 'layers' as const, onSelect: links.pipeline }] : []),
      { label: 'Open in Comp Intelligence', icon: 'stats' as const, onSelect: links.comps },
      { label: 'Open in Buyer Match', icon: 'users' as const, onSelect: links.buyers },
      { label: 'Open in Entity Graph', icon: 'link' as const, onSelect: links.graph },
      ...(links.map ? [{ label: 'Show on Map', icon: 'map' as const, hint: 'Subject and qualified comps', onSelect: links.map }] : []),
      { label: 'Open Workflow Studio', icon: 'zap' as const, hint: 'Seller inbound workflow', onSelect: links.workflow },
    ],
    [{ label: refreshing ? 'Re-reading…' : 'Re-read decision', icon: 'refresh-cw' as const, hint: 'Reads the latest canonical decision', disabled: refreshing, onSelect: onRefresh }],
  ) : []

  return (
    <header className={cx('dr-strip', pending && 'is-pending')}>
      <div className="dr-strip__row">
        <div className="dr-strip__who">
          {stageIdx >= 0 ? (
            <LCTooltip content={`Pipeline stage S${stageIdx + 1} · ${d?.pipeline?.stageLabel ?? stage}`}>
              <span className="dr-stage" data-stage={stageIdx + 1}><b>S{stageIdx + 1}</b>{d?.pipeline?.stageLabel ?? humanize(stage)}</span>
            </LCTooltip>
          ) : d ? <span className="dr-stage is-none">No deal</span> : null}
          <div className="dr-strip__identity">
            <h1 className="dr-strip__name">{identity?.name ?? (incoming ? incoming.split(',')[0] : 'Deal Intelligence')}</h1>
            <p className="dr-strip__where">
              {street ? <span className="dr-strip__street">{street}</span> : null}
              {locality ? <span>{locality}</span> : null}
              {d?.subject.market && !(locality ?? '').toLowerCase().startsWith(d.subject.market.toLowerCase()) ? <span>{d.subject.market}</span> : null}
              {identity && identity.role !== 'unknown' ? <span className="dr-strip__role">{identity.roleLabel}</span> : null}
              {pending ? <span className="dr-strip__role">Loading the decision…</span> : null}
            </p>
          </div>
        </div>

        <div className="dr-strip__signals" aria-label="Seller status">
          {contactState ? <LCStatus label={contactState.label} tone={contactState.tone} /> : null}
          {contact?.temperature ? <span className="dr-chip" data-temp={contact.temperature}>{humanize(contact.temperature)}</span> : null}
          {conversation ? <span className="dr-chip is-quiet">{conversation}{lastReply ? ` · replied ${lastReply}` : ''}</span> : null}
        </div>

        <div className="dr-strip__actions">
          {telHref ? (
            <a className="lc-btn is-secondary is-sm" href={telHref} aria-label={`Call ${fmtPhone(contact?.phone)}`}>
              <Icon name="phone" size={13} className="lc-btn__icon" /><span className="lc-btn__label">Call</span>
            </a>
          ) : (
            <LCTooltip content={contact?.suppressed ? 'Contact is suppressed' : 'No phone on this conversation'}>
              <span><LCButton size="sm" icon="phone" disabled>Call</LCButton></span>
            </LCTooltip>
          )}
          <LCButton size="sm" variant="primary" icon="message" disabled={!links?.conversation} onClick={() => links?.conversation?.()}>Message</LCButton>
          <span className="dr-strip__sep" aria-hidden="true" />
          <LCIconButton icon="layers" label={links?.pipeline ? 'Open deal in Pipeline' : 'No pipeline deal'} disabled={!links?.pipeline} onClick={() => links?.pipeline?.()} />
          <LCIconButton icon="map" label={links?.map ? 'Show on Map' : 'No coordinates'} disabled={!links?.map} onClick={() => links?.map?.()} />
          <LCIconButton icon="link" label="Open in Entity Graph" disabled={!links} onClick={() => links?.graph()} />
          <LCMenu label="More actions" items={more} trigger={<LCIconButton icon="more" label="More" disabled={!links} />} />
        </div>
      </div>

      <div className="dr-strip__row is-modes">
        <LCTabs
          label="Deal Intelligence modes"
          value={mode}
          onChange={(m) => onMode(m as DiMode)}
          items={DI_MODES.map((m) => ({ id: m.id, label: m.label, tone: m.id === 'decision' && criticalRisk ? 'crit' as const : undefined }))}
          className="dr-modes"
        />
        <div className="dr-strip__state">
          <LCStatus label={status.label} tone={status.tone} quiet={status.key === 'analyzed'} />
          {state?.computedAt ? <span className="dr-strip__stamp">analyzed {ago(state.computedAt, now)}</span> : null}
          <LCTooltip content={link.pinned ? `Pinned${link.pinLabel ? ` to ${link.pinLabel}` : ''} — ignores workspace selection` : link.follows ? 'Linked — follows the workspace selection' : 'Independent — ignores workspace selection'}>
            <span className={cx('dr-link', link.follows ? 'is-linked' : 'is-pinned')}>
              <Icon name={link.follows ? 'link' : 'pin'} size={12} />{link.follows ? 'Linked' : link.pinned ? 'Pinned' : 'Independent'}
            </span>
          </LCTooltip>
          <LCIconButton icon="refresh-cw" size="sm" label={refreshing ? 'Re-reading…' : 'Re-read decision'} disabled={refreshing || !d} onClick={onRefresh} />
          <LCIconButton icon="layout-split" size="sm" label={inspector.open ? 'Hide inspector' : 'Show inspector'} selected={inspector.open} onClick={inspector.onToggle} />
        </div>
      </div>
    </header>
  )
}
