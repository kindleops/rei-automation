import { Icon } from '../../shared/icons'
import { LCButton } from '../../shared/lc'
import type { EmbedMode } from './registry'

/**
 * Every way a page can NOT be shown inside the cockpit, said plainly. None
 * of these is a blank white frame dressed up as success.
 *
 *   external     the site is not proven embeddable (or refuses framing, or
 *                needs its own sign-in) → the premium external card
 *   offline      the network is down
 *   timeout      the page never reported back
 */

export type PageProblem =
  | { kind: 'external'; embed: EmbedMode }
  | { kind: 'offline' }
  | { kind: 'timeout' }

const EXTERNAL_REASON: Record<EmbedMode, { title: string; body: string }> = {
  BLOCKED: { title: 'This site does not allow embedding', body: 'It refuses to be shown inside another application. Open it in your browser — this tab keeps the link and its context.' },
  AUTH: { title: 'This site requires its own sign-in', body: 'Sign in on the site itself. LeadCommand never passes your credentials to it.' },
  EXTERNAL_ONLY: { title: 'Opens outside LeadCommand', body: 'This source is kept external by policy. The research tab keeps its link and context.' },
  UNKNOWN: { title: 'Not yet verified for in-app viewing', body: 'Sites open externally until they are proven safe to show here.' },
  EMBEDS: { title: 'Opens outside LeadCommand', body: 'This page is shown in your browser.' },
}

export interface PageStateProps {
  problem: PageProblem
  url: string
  host: string | null
  title: string | null
  insecure: boolean
  contextLabel: string | null
  onOpenExternal: () => void
  onCopy: () => void
  onKeep: (() => void) | null
  onReturn: () => void
  onRetry: () => void
}

export function PageState({ problem, url, host, title, insecure, contextLabel, onOpenExternal, onCopy, onKeep, onReturn, onRetry }: PageStateProps) {
  const copy = problem.kind === 'external'
    ? EXTERNAL_REASON[problem.embed]
    : problem.kind === 'offline'
      ? { title: 'No network connection', body: 'The page could not be requested. Nothing else in LeadCommand is affected.' }
      : { title: 'This page is not responding', body: 'It has not finished loading. The site may be down or slow — try again, or open it in your browser.' }
  return (
    <div className="lcb-state" role={problem.kind === 'external' ? 'region' : 'alert'} aria-label={copy.title}>
      <div className="lcb-state__card">
        <div className="lcb-state__site">
          <span className="lcb-state__glyph" aria-hidden="true"><Icon name={problem.kind === 'external' ? 'external-link' : 'alert-circle'} size={16} /></span>
          <span className="lcb-state__host">{host ?? 'Unknown site'}</span>
          {insecure ? <span className="lcb-insecure" title="This page is served over HTTP — not encrypted">Not secure</span> : null}
        </div>
        <h2 className="lcb-state__title">{copy.title}</h2>
        <p className="lcb-state__body">{copy.body}</p>
        {problem.kind === 'external' ? <p className="lcb-state__why">Google and Zillow don't allow other apps to display them. Opens in your browser.</p> : null}
        <dl className="lcb-state__facts">
          {title ? <><dt>Page</dt><dd>{title}</dd></> : null}
          <dt>Link</dt><dd className="lcb-state__url">{url}</dd>
          {contextLabel ? <><dt>Researching</dt><dd>{contextLabel}</dd></> : null}
        </dl>
        <div className="lcb-state__actions">
          <LCButton variant="primary" size="md" icon="external-link" onClick={onOpenExternal} autoFocus={problem.kind === 'external'} className="lcb-state__open">Open {host ?? 'site'} in your browser</LCButton>
          <LCButton variant="secondary" size="sm" icon="link" onClick={onCopy}>Copy link</LCButton>
          {problem.kind !== 'external' ? <LCButton variant="secondary" size="sm" icon="refresh-cw" onClick={onRetry}>Try again</LCButton> : null}
          {onKeep ? <LCButton variant="ghost" size="sm" icon="bookmark" onClick={onKeep}>Keep research tab</LCButton> : null}
          <LCButton variant="ghost" size="sm" icon="chevron-left" onClick={onReturn}>Return</LCButton>
        </div>
      </div>
    </div>
  )
}
