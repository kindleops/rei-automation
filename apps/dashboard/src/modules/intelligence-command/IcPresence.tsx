import { cx } from '../../shared/lc'
import { openIntelligenceCommand } from './ic-nav'
import { usePresence } from './ui/use-presence'
import './ui/ic-presence.css'

/** The shell's one-word intelligence status (Command Deck). Opens Intelligence Command. */
export default function IcPresence() {
  const p = usePresence()
  return (
    <button type="button" className={cx('ic-pres', `is-${p.state}`)} onClick={openIntelligenceCommand} title={`${p.detail} — Intelligence Command (⌘⇧E)`} aria-label={`Intelligence: ${p.label}. ${p.detail}`}>
      <i aria-hidden="true" /><span>{p.label}</span>
    </button>
  )
}
