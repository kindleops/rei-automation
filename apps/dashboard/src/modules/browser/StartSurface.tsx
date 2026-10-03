import { useMemo, useState, type FormEvent } from 'react'
import { Icon } from '../../shared/icons'
import { LCButton, LCSkeleton, LCStatus, cx } from '../../shared/lc'
import { companyLaunchItems, grouped, propertyLaunchItems, type LaunchItem } from './launch-plane'
import { REGISTRY_LIVE, type SearchProvider } from './registry'
import { companyOf, usePropertyFacts } from './research-context'
import { clearRecent, readRecent, type RecentItem } from './session-store'
import type { ResearchSubject } from './session-model'

/**
 * THE START SURFACE — three things, terse:
 *   Search the web · Research <subject> (the launch plane) · Recent research
 */

const EMBED_WORD: Record<string, string> = { EMBEDS: 'Opens here', BLOCKED: 'Opens externally', AUTH: 'Own sign-in', EXTERNAL_ONLY: 'Opens externally', UNKNOWN: 'Opens externally' }

export function LaunchRow({ item, onOpen }: { item: LaunchItem; onOpen: (item: LaunchItem) => void }) {
  const blocked = !item.url || Boolean(item.reason)
  return (
    <li className={cx('lcb-launch__row', blocked && 'is-blocked')}>
      <button type="button" className="lcb-launch__btn" disabled={blocked} onClick={() => onOpen(item)} title={item.url ?? undefined}>
        <span className="lcb-launch__name">{item.label}</span>
        <span className="lcb-launch__host">{item.host ?? ''}</span>
        <span className="lcb-launch__meta">
          {blocked
            ? <LCStatus label={item.reason ?? 'Unavailable'} tone="attn" quiet />
            : <>
                {item.confidence === 'VERIFIED' ? <LCStatus label="Verified" tone="ok" quiet /> : <LCStatus label={item.confidence === 'GENERIC' ? 'Search page' : 'Unavailable'} tone="neutral" quiet hollow />}
                <span className="lcb-launch__embed">{EMBED_WORD[item.embed] ?? 'Opens externally'}</span>
              </>}
        </span>
      </button>
      {item.copy && !blocked ? <span className="lcb-launch__copy">Paste {item.copy.label}: <b>{item.copy.value}</b></span> : null}
    </li>
  )
}

export function LaunchPlane({ subject, provider, onOpen, notice }: { subject: ResearchSubject; provider: SearchProvider; onOpen: (item: LaunchItem) => void; notice?: string | null }) {
  const facts = usePropertyFacts(subject)
  const company = companyOf(subject)
  const items = useMemo<LaunchItem[]>(() => {
    if (company) return companyLaunchItems(company, provider)
    if (facts.facts) return propertyLaunchItems(facts.facts.property, provider)
    // no canonical record (a recorded sale only): its label is still an address worth searching
    if (facts.status === 'missing' && subject.label) return propertyLaunchItems({ property_address_full: subject.label, property_address: subject.label.split(',')[0] }, provider).filter((i) => i.group === 'search')
    return []
  }, [company, facts.facts, facts.status, subject.label, provider])
  const groups = grouped(items)
  const county = facts.facts?.county
  return (
    <section className="lcb-launch" aria-label={`Research ${subject.label ?? ''}`}>
      <header className="lcb-launch__head">
        <span className="lcb-eyebrow">{subject.role === 'comp' ? 'Comp' : subject.kind === 'company' ? 'Company' : 'Property'}</span>
        <h2 className="lcb-launch__title">{subject.label ?? 'This record'}</h2>
        <span className="lcb-launch__sub">
          {[county ? `${county} County` : null, facts.facts?.property.property_address_state ?? null, facts.facts ? (facts.facts.apn ? `Parcel ${facts.facts.apn}` : 'Parcel ID not on record') : null].filter(Boolean).join(' · ')}
        </span>
      </header>
      {notice ? <p className="lcb-launch__notice" role="status"><Icon name="alert-circle" size={13} /> {notice}</p> : null}
      {facts.status === 'loading' ? <LCSkeleton shape="lines" count={4} label="Reading the property record" /> : null}
      {facts.status === 'missing' && !company ? <p className="lcb-launch__notice">No canonical property record for this id — only a web search by its label is offered.</p> : null}
      {groups.map((g) => (
        <div key={g.group} className="lcb-launch__group">
          <h3 className="lcb-eyebrow">{g.label}</h3>
          <ul>{g.items.map((i) => <LaunchRow key={i.id} item={i} onOpen={onOpen} />)}</ul>
        </div>
      ))}
      {facts.status !== 'loading' && !groups.some((g) => g.group === 'official') && (facts.status === 'ready' || company) ? (
        <p className="lcb-launch__quiet">{REGISTRY_LIVE ? `No official sources are on record for ${county ? `${county} County` : 'this jurisdiction'} yet.` : 'Official sources load from the destination registry — not available in this build yet.'}</p>
      ) : null}
    </section>
  )
}

export interface StartSurfaceProps {
  subject: ResearchSubject | null
  provider: SearchProvider
  notice: string | null
  onSearch: (input: string) => void
  onOpenItem: (item: LaunchItem, subject: ResearchSubject) => void
  onOpenRecent: (r: RecentItem) => void
}

export function StartSurface({ subject, provider, notice, onSearch, onOpenItem, onOpenRecent }: StartSurfaceProps) {
  const [q, setQ] = useState('')
  const [recent, setRecent] = useState<RecentItem[]>(() => readRecent())
  const submit = (e: FormEvent) => { e.preventDefault(); if (q.trim()) onSearch(q) }
  return (
    <div className="lcb-start">
      <form className="lcb-start__search" onSubmit={submit} role="search">
        <Icon name="search" size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the web or enter an address" aria-label="Search the web or enter an address" spellCheck={false} autoComplete="off" />
        <LCButton type="submit" size="sm" variant="primary" disabled={!q.trim()}>Go</LCButton>
      </form>
      <div className="lcb-start__cols">
        {subject
          ? <LaunchPlane subject={subject} provider={provider} onOpen={(i) => onOpenItem(i, subject)} notice={notice} />
          : (
            <section className="lcb-launch is-empty">
              <span className="lcb-eyebrow">Research current property</span>
              <p className="lcb-launch__quiet">Select a property anywhere in LeadCommand — or use Research on any property — and its official records, market sources and web search appear here.</p>
              {notice ? <p className="lcb-launch__notice" role="status">{notice}</p> : null}
            </section>
          )}
        <section className="lcb-recent" aria-label="Recent research">
          <header className="lcb-recent__head">
            <span className="lcb-eyebrow">Recent research</span>
            {recent.length ? <button type="button" className="lcb-linkbtn" onClick={() => { clearRecent(); setRecent([]) }}>Clear</button> : null}
          </header>
          {recent.length
            ? <ul>{recent.map((r) => (
                <li key={r.url}>
                  <button type="button" className="lcb-recent__row" onClick={() => onOpenRecent(r)} title={r.url}>
                    <span className="lcb-recent__title">{r.title ?? r.host}</span>
                    <span className="lcb-recent__host">{r.host}{r.context ? ` · ${r.context}` : ''}</span>
                  </button>
                </li>
              ))}</ul>
            : <p className="lcb-launch__quiet">Nothing yet. Kept on this device only.</p>}
        </section>
      </div>
    </div>
  )
}
