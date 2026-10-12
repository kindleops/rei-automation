import { FAILURE_TITLE } from '../ask-model'
import { refreshStatus } from '../ask-store'
import { Glyph } from './glyphs'

/** The one clean state a non-allowlisted / signed-out / switched-off session sees (no composer, no fixtures). */
export function LockedState({ kind, message }: { kind: keyof typeof FAILURE_TITLE; message: string }) {
  return (
    <div className="ak-locked" role="status">
      <span className="ak-locked__ic" aria-hidden="true"><Glyph name="refused" size={18} /></span>
      <b>{FAILURE_TITLE[kind]}</b>
      <p>{message}</p>
      {kind === 'not_allowlisted' ? <small>An owner can add your account to the agent allowlist. Nothing else in LeadCommand changes.</small> : null}
      <button type="button" className="ak-ghost" onClick={() => void refreshStatus()}>Check again</button>
    </div>
  )
}
