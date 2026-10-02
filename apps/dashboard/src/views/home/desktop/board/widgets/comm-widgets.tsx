import { ObjectMenu, handleObjectClick, objectAttrs, sellerObject } from '../../../../../modules/desktop/objects'
import { openInboxThread } from '../../../../../modules/mobile/mobile-inbox-bridge'
import { relativeTime, type HomeThread } from '../../../home-signals'
import { SOURCES } from '../board-data'
import { cx, fmt, openPath, useWidgetSource } from '../widget-runtime'
import { WEmpty, WFacts, WFigure, WState } from '../widget-ui'
import type { WidgetRenderProps } from '../widget-registry'

/* ── Inbox ──────────────────────────────────────────────────────────── */

function ThreadRow({ t, showPreview }: { t: HomeThread; showPreview: boolean }) {
  const ref = t.threadKey ? sellerObject({ threadKey: t.threadKey, prospectId: t.prospectId, masterOwnerId: t.masterOwnerId, propertyId: t.propertyId, propertyLabel: t.address, label: t.seller, source: 'home' }) : null
  const row = (
    <button
      type="button"
      className={cx('hb-thread', t.unread && 'is-unread', t.hot && 'is-hot')}
      {...objectAttrs(ref)}
      onClick={(e) => handleObjectClick(e, ref, () => { if (t.threadKey) openInboxThread({ threadKey: t.threadKey }) })}
    >
      <span className="hb-thread__top">
        <strong>{t.seller}</strong>
        {t.hot ? <span className="hb-tag is-attn">Hot</span> : null}
        <time dateTime={t.at ?? undefined}>{relativeTime(t.at)}</time>
      </span>
      <span className="hb-thread__where">{[t.address, t.market].filter(Boolean).join(' · ') || 'No property on record'}</span>
      {showPreview && t.preview ? <span className="hb-thread__msg">{t.preview}</span> : null}
    </button>
  )
  return <li>{ref ? <ObjectMenu object={ref} showOnMap={{ source: 'home' }}>{row}</ObjectMenu> : row}</li>
}

export function InboxWidget({ size, cells }: WidgetRenderProps) {
  const { load, reload } = useWidgetSource(SOURCES.inbox)
  return (
    <WState load={load} what="the inbox" onRetry={reload} shape={size === 'compact' ? 'metric' : 'lines'}>
      {(d) => {
        const head = (
          <div className="hb-row">
            <WFigure value={fmt(d.newReplies)} label="new replies" tone={(d.newReplies ?? 0) > 0 ? 'exec' : null} onClick={() => openPath('/inbox')} size={size === 'compact' ? 'md' : 'lg'} />
            {size !== 'compact' || cells.w >= 4 ? <WFigure value={fmt(d.priority)} label="priority" tone={(d.priority ?? 0) > 0 ? 'attn' : null} /> : null}
            {size !== 'compact' && size !== 'small' ? <WFigure value={fmt(d.needsAttention)} label="need attention" tone={(d.needsAttention ?? 0) > 0 ? 'attn' : null} /> : null}
          </div>
        )
        if (size === 'compact') return head
        const rows = size === 'small' ? 1 : size === 'medium' ? 3 : 6
        const latest = d.threads[0]
        return (
          <div className={cx('hb-inbox', `is-${size}`)}>
            {head}
            {size === 'small' && latest ? <p className="hb-muted hb-inbox__latest">Latest reply {relativeTime(latest.at)} · {latest.seller}</p> : null}
            {size !== 'small' ? (d.threads.length ? (
              <ul className={cx('hb-threads', (size === 'wide' || size === 'feature') && 'is-cols')}>
                {d.threads.slice(0, rows).map((t) => <ThreadRow key={t.id} t={t} showPreview={size !== 'medium'} />)}
              </ul>
            ) : <WEmpty>No seller replies waiting.</WEmpty>) : null}
          </div>
        )
      }}
    </WState>
  )
}

/* ── Email Command ──────────────────────────────────────────────────── */

export function EmailWidget({ size }: WidgetRenderProps) {
  const { load, reload } = useWidgetSource(SOURCES.email)
  return (
    <WState load={load} what="Email Command" onRetry={reload} shape={size === 'compact' ? 'metric' : 'lines'}>
      {(h) => {
        const needs = h.counts.needs_you ?? 0
        const failed = h.counts.failed ?? 0
        const sending = h.delivery.send_enabled
        return (
          <div className={cx('hb-email', `is-${size}`)}>
            <div className="hb-row">
              <WFigure value={fmt(needs)} label="need you" tone={needs ? 'attn' : null} onClick={() => openPath('/email-command')} />
              {size !== 'compact' ? <WFigure value={fmt(h.counts.system_handling ?? 0)} label="system handling" tone="exec" /> : null}
              {size !== 'compact' ? <WFigure value={fmt(failed)} label="failed" tone={failed ? 'crit' : null} /> : null}
            </div>
            {size === 'compact' ? null : (
              <WFacts items={[
                { label: 'Sending', value: sending ? 'On' : 'Off', tone: sending ? 'ok' : null, title: sending ? 'Email sending is enabled' : 'Email sending is switched off — nothing is sent' },
                { label: 'Waiting', value: fmt(h.counts.waiting ?? 0) },
                { label: 'Unresolved', value: fmt(h.counts.unresolved ?? 0) },
              ]} />
            )}
            {size === 'compact' || size === 'small' ? null : h.needs_you.length ? (
              <ul className="hb-list">
                {h.needs_you.slice(0, size === 'medium' ? 3 : 6).map((t) => (
                  <li key={t.id}>
                    <button type="button" className="hb-list__row" onClick={() => openPath(`/email-command?thread=${encodeURIComponent(t.id)}`)}>
                      <span className="hb-dot is-attn" aria-hidden="true" />
                      <span className="hb-list__main"><strong>{t.counterparty.name || t.counterparty.email || 'Unknown sender'}</strong><small>{t.needs?.reason || t.subject || t.property_address || ''}</small></span>
                      <em>{relativeTime(t.last_message.at)}</em>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <WEmpty>No email needs you.</WEmpty>}
          </div>
        )
      }}
    </WState>
  )
}
