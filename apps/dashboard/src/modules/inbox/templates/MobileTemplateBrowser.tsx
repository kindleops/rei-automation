/**
 * §4 — THE MOBILE TEMPLATE BROWSER.
 *
 * "Browse all templates" opened TemplatePicker, a two-pane desktop layout with
 * a filter rail and a side-by-side preview. On a 390pt phone that is a dead
 * end, which is what the brief called it.
 *
 * This is NOT a new application. It is a Conversation overlay for choosing a
 * template: the same `fetchSmsTemplates`, the same `renderTemplate`, the same
 * `buildTemplateContextFromThread`. It adds no data layer and no template
 * model — only a way to use them with a thumb.
 *
 * Two properties it must hold, because both were live defects:
 *
 *   - The preview hydrates against the CURRENTLY SELECTED PARTICIPANT, not the
 *     thread. Switching Dinora -> Jorge changed who a message would be sent to
 *     but not who it addressed.
 *   - A template whose required variables cannot resolve does not get inserted.
 *     `agent_name` resolves to '' by design when an owner has no assigned
 *     agent, and inserting `[[agent_name]]` puts broken copy one Send from a
 *     real seller.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { ThreadContext } from '../../../lib/data/inboxData'
import type { InboxThread } from '../inbox.adapter'
import {
  buildTemplateContextFromThread,
  fetchSmsTemplates,
  renderTemplate,
  type SmsTemplate,
} from '../../../lib/data/templateData'

type SelectedParticipant = {
  display_name?: string | null
  canonical_e164?: string | null
} | null

type Props = {
  open: boolean
  onClose: () => void
  thread: InboxThread | null
  threadContext: ThreadContext | null
  selectedParticipant: SelectedParticipant
  /** The thread's canonical stage code, surfaced so the operator can see where they are. */
  currentStageCode?: string | null
  onInsert: (text: string, template: SmsTemplate) => void
}

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

/** S1..S10 first and in order; MF / follow-up codes after; unstaged last. */
const stageOrder = (code: string): number => {
  const plain = /^S(\d+)$/i.exec(code)
  if (plain) return Number(plain[1])
  const followUp = /^S(\d+)F$/i.exec(code)
  if (followUp) return Number(followUp[1]) + 0.5
  if (/^MF\d+$/i.test(code)) return 100 + Number(code.replace(/\D/g, '') || 0)
  if (code === '—') return Number.MAX_SAFE_INTEGER
  return 200
}

export const MobileTemplateBrowser = ({
  open,
  onClose,
  thread,
  threadContext,
  selectedParticipant,
  currentStageCode = null,
  onInsert,
}: Props) => {
  const [templates, setTemplates] = useState<SmsTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<SmsTemplate | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  /*
   * SEARCH GOES TO THE DATABASE, BECAUSE THE BROWSE LIST CANNOT HOLD THE CORPUS.
   *
   * There are 8,782 active templates and the unfiltered list route caps at 500
   * by design. Filtering that 500 client-side produced a search that answered
   * "no templates match" while hundreds of real matches sat unloaded -- "asking
   * price" alone has 768. A term is therefore pushed down; an empty term browses
   * the capped list, and the count below says plainly which of the two it is.
   */
  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    setLoading(true)
    const term = search.trim()
    const run = () => {
      void fetchSmsTemplates({ includeInactive: false, limit: term ? 2000 : 1200, query: term || undefined })
        .then((rows) => { if (!cancelled) setTemplates(rows) })
        .catch(() => { if (!cancelled) setTemplates([]) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }
    // Typing must not fire a request per keystroke.
    const timer = window.setTimeout(run, term ? 280 : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [open, search])

  // Closing must not leave a previous choice armed for the next open.
  useEffect(() => { if (!open) { setSelected(null); setSearch('') } }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /*
   * The context is rebuilt whenever the selected participant changes, which is
   * what makes a prospect switch move the preview with it. Listing the
   * participant in the dependencies is the whole fix -- reading the thread
   * alone is what produced "Hey Dinora" addressed to Jorge.
   */
  const context = useMemo(
    () => buildTemplateContextFromThread(thread, threadContext, {}, selectedParticipant),
    [thread, threadContext, selectedParticipant],
  )

  const preview = useMemo(
    () => (selected ? renderTemplate(selected, context) : null),
    [selected, context],
  )

  // The server has already applied the term; re-filtering here would only
  // narrow it again with weaker matching.
  const visible = templates

  const groups = useMemo(() => {
    const byCode = new Map<string, { code: string; label: string; items: SmsTemplate[] }>()
    for (const template of visible) {
      const code = String(template.stageCode ?? '').trim() || '—'
      if (!byCode.has(code)) {
        byCode.set(code, {
          code,
          label: code === '—' ? 'No stage recorded' : (template.stageLabel || code),
          items: [],
        })
      }
      byCode.get(code)!.items.push(template)
    }
    return [...byCode.values()].sort((a, b) => stageOrder(a.code) - stageOrder(b.code) || a.code.localeCompare(b.code))
  }, [visible])

  const unresolved = preview?.missingVariables ?? []
  const canInsert = Boolean(selected && preview && unresolved.length === 0)

  const handleInsert = useCallback(() => {
    if (!selected || !preview || unresolved.length > 0) return
    onInsert(preview.renderedText, selected)
    onClose()
  }, [selected, preview, unresolved.length, onInsert, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="nx-mtb-overlay"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <section
        className="nx-mtb"
        role="dialog"
        aria-modal="true"
        aria-label="Template library"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="nx-mtb__glass" aria-hidden="true" />

        <header className="nx-mtb__header">
          <div className="nx-mtb__title">
            <strong>Templates</strong>
            {currentStageCode ? (
              <span className="nx-mtb__current" title="This conversation's stage">
                Now: {currentStageCode}
              </span>
            ) : null}
          </div>
          <button type="button" className="nx-mtb__close" onClick={onClose} aria-label="Close templates">
            <Icon name="close" />
          </button>
        </header>

        <div className="nx-mtb__search">
          <Icon name="search" />
          <input
            type="search"
            value={search}
            placeholder="Search templates…"
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search templates"
          />
          {search ? (
            <button type="button" onClick={() => setSearch('')} aria-label="Clear search">
              <Icon name="close" />
            </button>
          ) : null}
        </div>

        <p className="nx-mtb__count">
          {loading
            ? 'Searching…'
            : search.trim()
              ? `${templates.length} matching template${templates.length === 1 ? '' : 's'}`
              : `${templates.length} most recently updated — search to reach the rest`}
        </p>

        <div className="nx-mtb__body" ref={bodyRef}>
          {loading ? (
            <p className="nx-mtb__state">Loading templates…</p>
          ) : groups.length === 0 ? (
            <p className="nx-mtb__state">
              {templates.length === 0 ? 'No templates available.' : 'No templates match that search.'}
            </p>
          ) : groups.map((group) => (
            <section key={group.code} className="nx-mtb__group">
              <h4 className={cls('nx-mtb__group-head', group.code === currentStageCode && 'is-current')}>
                <span className="nx-mtb__group-code">{group.code}</span>
                <span className="nx-mtb__group-label">{group.label}</span>
                <span className="nx-mtb__group-count">{group.items.length}</span>
              </h4>
              {group.items.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className={cls('nx-mtb__item', selected?.id === template.id && 'is-selected')}
                  onClick={() => setSelected(template)}
                >
                  <span className="nx-mtb__item-name">{template.useCase || template.useCaseSlug}</span>
                  <span className="nx-mtb__item-preview">{template.templateText}</span>
                </button>
              ))}
            </section>
          ))}
        </div>

        {selected && preview ? (
          <footer className="nx-mtb__footer">
            <div className="nx-mtb__preview-head">
              <span>Preview</span>
              {selectedParticipant?.display_name ? (
                <span className="nx-mtb__preview-who">to {selectedParticipant.display_name}</span>
              ) : null}
            </div>
            <p className="nx-mtb__preview-body">{preview.renderedText}</p>

            {unresolved.length > 0 ? (
              <p className="nx-mtb__gap" role="status">
                <Icon name="alert-circle" />
                <span>
                  Cannot resolve {unresolved.map((v) => v.replace(/_/g, ' ')).join(', ')} — this
                  template is not ready to send for this contact.
                </span>
              </p>
            ) : null}

            <div className="nx-mtb__actions">
              <button type="button" className="nx-mtb__cancel" onClick={() => setSelected(null)}>
                Back
              </button>
              <button
                type="button"
                className="nx-mtb__insert"
                onClick={handleInsert}
                disabled={!canInsert}
              >
                Insert
              </button>
            </div>
          </footer>
        ) : null}
      </section>
    </div>,
    document.body,
  )
}
