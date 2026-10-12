import { AnimatePresence, motion } from 'framer-motion'
import { useLcReducedMotion } from '../../../../shared/lc'
import { setUi } from '../../runtime/agent-store'
import { activeThread, newThread, requestFocus, setPalette, showHistory, useAsk } from '../ask-store'
import { AskPanel } from './AskPanel'
import { Glyph } from './glyphs'
import { useAskContext } from './use-ask-context'

/**
 * THE FLOATING PALETTE (⌘⇧L) — the same thread and composer as the dock,
 * as a centred command-palette sheet over the workspace. Esc or a click
 * outside closes it; “Dock” moves the conversation into the sidebar.
 */
export function AskPalette() {
  const s = useAsk()
  const reduced = useLcReducedMotion()
  const { autoChips, quickScan, suggestions } = useAskContext()
  const thread = activeThread(s)
  const close = () => setPalette(false)
  return (
    <AnimatePresence>
      {s.palette ? (
        <motion.div key="ak-palette" className="agx ak-palette" role="dialog" aria-modal="true" aria-label="Ask LeadCommand"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: reduced ? 0 : 0.12 } }} transition={{ duration: reduced ? 0 : 0.16 }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
          <motion.div className="ak-palette__card"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.99 }}
            transition={{ duration: reduced ? 0 : 0.2, ease: [0.16, 1, 0.3, 1] }}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}>
            <header className="ak-palette__h">
              <span className="ak-palette__t"><Glyph name="model" size={12} />{thread ? thread.title : 'Ask LeadCommand'}</span>
              <button type="button" className="ak-ghost" onClick={() => { newThread(); requestFocus('palette') }}><Glyph name="plus" size={11} />New</button>
              <button type="button" className="ak-ghost" onClick={() => showHistory(s.view !== 'history')} aria-pressed={s.view === 'history'}><Glyph name="history" size={11} />History</button>
              <button type="button" className="ak-ghost" onClick={() => { setPalette(false); setUi({ dock: 'open', wsOpen: false }); requestFocus('dock') }}><Glyph name="dock" size={11} />Dock<kbd>⌘L</kbd></button>
              <kbd className="ak-palette__esc">esc</kbd>
            </header>
            <AskPanel surface="palette" autoChips={autoChips} onClose={close} quickScan={quickScan} suggestions={suggestions} />
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
