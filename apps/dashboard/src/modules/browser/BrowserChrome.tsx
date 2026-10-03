import { useState, type DragEvent, type FormEvent, type RefObject } from 'react'
import { Icon } from '../../shared/icons'
import { LCIconButton, LCMenu, cx, type LCMenuEntry } from '../../shared/lc'
import { tabTitle, type BrowserTab, type LinkMode, type ResearchSubject } from './session-model'
import { hostOf } from './registry'

/**
 * THE BROWSER CHROME — one glass header, ~84px:
 *   row 1  tabs (compact, closable, reorderable) + new tab
 *   row 2  ← → ↻ · address (real host always visible, lock / Not secure) ·
 *          context chip · open externally · more
 *   rail   a 2px progress line while the active page loads
 * Compact (narrow panes, container query): tabs fold into a menu; the host
 * stays visible.
 */

export interface ChromeProps {
  tabs: BrowserTab[]
  activeId: string
  active: BrowserTab
  canBack: boolean
  canForward: boolean
  loading: boolean
  drifted: boolean
  link: LinkMode
  linkForced: boolean
  addressRef: RefObject<HTMLInputElement>
  addressError: string | null
  more: LCMenuEntry[]
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNewTab: () => void
  onReorder: (id: string, toIndex: number) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onSubmit: (input: string) => void
  onExternal: () => void
  onToggleLink: () => void
}

function ContextChip({ ctx, link, linkForced, onToggle }: { ctx: ResearchSubject | null; link: LinkMode; linkForced: boolean; onToggle: () => void }) {
  const pinned = link === 'pinned' || linkForced
  const title = linkForced ? 'This pane is pinned or independent in the workspace — it does not follow the selection' : pinned ? 'Pinned — the Browser ignores the workspace selection. Click to link.' : 'Linked — a new selection is offered, never applied. Click to pin.'
  return (
    <button type="button" className={cx('lcb-chip', pinned && 'is-pinned')} onClick={onToggle} disabled={linkForced} title={title} aria-label={`${ctx ? `Researching ${ctx.label ?? ctx.id}` : 'No research subject'} — ${pinned ? 'pinned' : 'linked'}`}>
      <Icon name={pinned ? 'pin' : 'link'} size={12} />
      <span className="lcb-chip__text">{ctx ? `${ctx.role === 'comp' ? 'Comp' : 'Researching'} ${ctx.label ?? (ctx.kind === 'company' ? 'company' : 'property')}` : pinned ? 'Pinned' : 'Linked'}</span>
    </button>
  )
}

export function BrowserChrome({ addressRef, ...p }: ChromeProps) {
  const [draft, setDraft] = useState<{ tab: string; url: string | null; text: string } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const host = hostOf(p.active.url)
  const insecure = Boolean(p.active.url && p.active.url.startsWith('http:'))
  // the field shows what is typed while editing, the real URL otherwise (re-derived when the tab or its URL moves)
  const editing = draft && draft.tab === p.active.id && draft.url === p.active.url
  const value = editing ? draft!.text : (p.active.url ?? '')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (value.trim()) p.onSubmit(value)
    setDraft(null)
  }

  const onDragStart = (e: DragEvent, id: string) => { setDragId(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-lc-browser-tab', id) }
  const onDrop = (e: DragEvent, index: number) => {
    const id = e.dataTransfer.getData('application/x-lc-browser-tab')
    if (id) { e.preventDefault(); p.onReorder(id, index) }
    setDragId(null)
  }

  const tabMenu: LCMenuEntry[] = p.tabs.map((t) => ({ id: `tab-${t.id}`, label: tabTitle(t), hint: hostOf(t.url) ?? undefined, checked: t.id === p.activeId, onSelect: () => p.onActivate(t.id) }))

  return (
    <header className="lcb-chrome">
      <div className="lcb-tabs" role="tablist" aria-label="Browser tabs">
        <div className="lcb-tabs__compact">
          <LCMenu trigger={<button type="button" className="lcb-tabs__menu" aria-label={`${p.tabs.length} tabs`}><Icon name="layers" size={13} /><span>{p.tabs.length}</span><Icon name="chevron-down" size={11} /></button>} items={tabMenu} label="Tabs" align="start" />
        </div>
        {p.tabs.map((t, i) => {
          const on = t.id === p.activeId
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              className={cx('lcb-tab', on && 'is-active', dragId === t.id && 'is-dragging')}
              draggable
              onDragStart={(e) => onDragStart(e, t.id)}
              onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }}
              onDrop={(e) => onDrop(e, i)}
              onDragEnd={() => setDragId(null)}
              onClick={() => p.onActivate(t.id)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); p.onClose(t.id) } }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  const next = p.tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + p.tabs.length) % p.tabs.length]
                  p.onActivate(next.id)
                }
              }}
              title={t.url ?? undefined}
            >
              <span className={cx('lcb-tab__glyph', t.context && 'has-ctx')} aria-hidden="true"><Icon name={t.url ? (t.embed === 'EMBEDS' ? 'globe' : 'external-link') : 'compass'} size={12} /></span>
              <span className="lcb-tab__title">{tabTitle(t)}</span>
              <button type="button" className="lcb-tab__x" aria-label={`Close ${tabTitle(t)}`} onClick={(e) => { e.stopPropagation(); p.onClose(t.id) }}><Icon name="x" size={11} /></button>
            </div>
          )
        })}
        <LCIconButton icon="plus" label="New tab" size="sm" shortcut={['⌘', 'T']} onClick={p.onNewTab} className="lcb-tabs__new" />
      </div>
      <div className="lcb-bar">
        <div className="lcb-bar__nav">
          <LCIconButton icon="chevron-left" label="Back" size="sm" shortcut={['⌥', '←']} disabled={!p.canBack} onClick={p.onBack} />
          <LCIconButton icon="chevron-right" label="Forward" size="sm" shortcut={['⌥', '→']} disabled={!p.canForward} onClick={p.onForward} className="lcb-hide-compact" />
          <LCIconButton icon="refresh-cw" label="Reload this tab" size="sm" shortcut={['⌘', 'R']} disabled={!p.active.url} onClick={p.onReload} className="lcb-hide-compact" />
        </div>
        <form className={cx('lcb-addr', p.addressError && 'is-invalid', insecure && 'is-insecure')} onSubmit={submit} role="search">
          <span className="lcb-addr__lock" aria-hidden="true">{host ? <Icon name={insecure ? 'alert-circle' : 'shield'} size={12} /> : <Icon name="search" size={12} />}</span>
          {host ? <span className="lcb-addr__host" title={insecure ? `${host} — not secure (HTTP)` : host}>{host}{insecure ? <em className="lcb-insecure">Not secure</em> : null}</span> : null}
          <input
            ref={addressRef}
            className="lcb-addr__input"
            value={value}
            onChange={(e) => setDraft({ tab: p.active.id, url: p.active.url, text: e.target.value })}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur() } }}
            placeholder="Search or enter address"
            aria-label="Address — search or enter a web address"
            aria-invalid={Boolean(p.addressError)}
            spellCheck={false}
            autoComplete="off"
          />
          {p.drifted && !editing ? <span className="lcb-addr__drift" title="You followed a link inside the site; the page's own address is not visible to LeadCommand. Copy link and Open externally use the last known address.">moved within site</span> : null}
        </form>
        <ContextChip ctx={p.active.context} link={p.link} linkForced={p.linkForced} onToggle={p.onToggleLink} />
        <LCIconButton icon="external-link" label="Open externally" size="sm" disabled={!p.active.url} onClick={p.onExternal} className="lcb-hide-compact" />
        <LCMenu trigger={<LCIconButton icon="more" label="More" size="sm" />} items={p.more} label="Browser" align="end" width={260} />
      </div>
      {p.addressError ? <div className="lcb-addr__error" role="alert">{p.addressError}</div> : null}
      <div className={cx('lcb-progress', p.loading && 'is-on')} aria-hidden="true"><i /></div>
    </header>
  )
}
