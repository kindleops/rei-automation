import { Icon } from '../../../../shared/icons'
import { cx, LCButton, LCSkeleton, LCTimeline, LCTooltip, type LCTimelineItem } from '../../../../shared/lc'
import { ago, dateShort, dateTime, humanize, minutes, phone, usd } from '../di-format'
import type { DiLinks } from '../di-links'
import { factsDiffer, GAP_RULE, type EvidenceGap, type SellerIdentity } from '../di-model'
import type { DiDecision, DiSelection, DiStory } from '../di-types'
import { Gauge, Plane, Prov } from '../di-ui'

const BAND: Record<string, { label: string; tone: string }> = {
  hot: { label: 'Hot', tone: 'var(--lc-attn)' },
  warm: { label: 'Warm', tone: 'var(--lc-attn)' },
  engaged: { label: 'Engaged', tone: 'var(--lc-exec)' },
  lukewarm: { label: 'Lukewarm', tone: 'var(--lc-neutral)' },
  cold: { label: 'Cold', tone: 'var(--lc-neutral)' },
  hostile: { label: 'Hostile', tone: 'var(--lc-crit)' },
  opted_out: { label: 'Opted out', tone: 'var(--lc-crit)' },
  no_reply: { label: 'No reply yet', tone: 'var(--lc-neutral)' },
}

const BEAT_ICON: Record<string, LCTimelineItem['icon']> = { contact: 'send', reply: 'message', created: 'target', advance: 'trending-up', retreat: 'arrow-down-left', offer: 'dollar-sign', accepted: 'check', closing: 'key', heat: 'zap', now: 'clock' }

export interface ProspectPlaneProps {
  d: DiDecision
  identity: SellerIdentity
  story: DiStory | null
  storyLoading: boolean
  gaps: EvidenceGap[]
  selection: DiSelection | null
  onSelect: (s: DiSelection) => void
  links: DiLinks | null
  now: number
  /** inside the inspector column: one column, tighter */
  variant?: 'inline' | 'column'
}

/**
 * PROSPECT INTELLIGENCE — the other half of the decision: who the seller is,
 * whether they own it, how reachable and engaged they are, what they have
 * said (with provenance), what they asked, and what we are still waiting on.
 * Real conversation analytics only; no psychological profiling.
 */
export function ProspectPlane({ d, identity, story, storyLoading, gaps, selection, onSelect, links, now, variant = 'inline' }: ProspectPlaneProps) {
  const c = d.conversation
  const contact = d.contact
  const band = c ? BAND[c.band] ?? BAND.cold : null
  const facts = d.sellerFacts
  const groups = new Map<string, typeof facts>()
  for (const f of facts) groups.set(f.label, [...(groups.get(f.label) ?? []), f])
  const asks = d.history.filter((h) => h.kind === 'ask')
  const last = story?.conversation?.lastInbound ?? null
  const peak = c ? Math.max(1, ...c.timing.hourBuckets) : 1
  const beats: LCTimelineItem[] = (story?.story ?? []).slice(-9).map((b, i) => ({
    id: `${b.kind}-${i}-${b.at}`,
    at: b.kind === 'now' ? null : Date.parse(b.at),
    title: b.title,
    body: b.detail ? <span className="dr-quote-inline">{b.kind === 'reply' || b.kind === 'contact' ? `“${b.detail}”` : b.detail}</span> : undefined,
    meta: b.intent ? humanize(b.intent) : undefined,
    icon: BEAT_ICON[b.kind] ?? 'clock',
    state: b.kind === 'now' ? (b.lane === 'blocked' ? 'blocked' : b.lane === 'operator' ? 'waiting' : 'now') : 'done',
  }))

  return (
    <Plane id="prospect" eyebrow="Prospect intelligence" title={identity.name} className={cx('dr-prospect', `is-${variant}`)} under="flow"
      aside={contact?.temperature ? <span className="dr-chip" data-temp={contact.temperature}>{humanize(contact.temperature)}</span> : null}>
      <div className="dr-prospect__grid">
        <div className="dr-prospect__col">
          <div className="dr-who">
            <p className="dr-who__role">{identity.roleLabel}</p>
            {identity.recordOwner && identity.role !== 'owner_of_record' ? (
              <p className="dr-who__owner">
                Owner of record: <b>{identity.recordOwner}</b>
                {identity.namesMatch === true ? <span className="dr-match is-yes"><Icon name="check" size={10} />names match</span> : identity.namesMatch === false ? <LCTooltip content="Separate records — nothing asserts they are the same person"><span className="dr-match is-no">names differ</span></LCTooltip> : null}
              </p>
            ) : null}
            {identity.entity.corporate || identity.entity.trust || identity.entity.bank ? (
              <p className="dr-who__entity"><Icon name="briefcase" size={11} />{[identity.entity.corporate && 'Corporate owner', identity.entity.trust && 'Trust', identity.entity.bank && 'Bank-owned'].filter(Boolean).join(' · ')} — not an individual seller</p>
            ) : null}
            <p className="dr-who__contact">
              {contact?.phone ? <span><Icon name="phone" size={11} />{phone(contact.phone)}</span> : <span className="dr-none">No phone on the conversation</span>}
              {contact?.suppressed ? <span className="is-crit">Suppressed</span> : contact?.contactability ? <span>{humanize(contact.contactability)}</span> : null}
              {contact?.messageCount ? <span>{contact.messageCount} messages</span> : null}
            </p>
          </div>

          {c && band ? (
            <section className="dr-signal" aria-label="Seller signal">
              <div className="dr-signal__gauge">
                <Gauge value={c.score} tone={band.tone} />
                <div className="dr-signal__score"><b className="lc-num">{c.score ?? '—'}</b><span style={{ color: band.tone }}>{band.label}</span></div>
              </div>
              <div className="dr-signal__body">
              <dl className="dr-signal__stats">
                <div><dt>Reply rate</dt><dd className="lc-num">{c.responsiveness.replyRate !== null ? `${Math.round(c.responsiveness.replyRate * 100)}%` : '—'}</dd></div>
                <div><dt>Median reply</dt><dd className="lc-num">{minutes(c.responsiveness.medianReplyMinutes) ?? '—'}</dd></div>
                <div><dt>Replies</dt><dd className="lc-num">{c.counts.inbound}</dd></div>
                <div><dt>Words / msg</dt><dd className="lc-num">{c.counts.avgWordsPerInbound ?? '—'}</dd></div>
                <div><dt>Last reply</dt><dd>{ago(c.responsiveness.lastInboundAt, now) ?? '—'}</dd></div>
                <div><dt>Trend</dt><dd>{c.responsiveness.trend ?? '—'}</dd></div>
              </dl>
              </div>
              <span className="dr-signal__note">{c.confidence} confidence · deterministic read of {c.counts.inbound} seller and {c.counts.outbound} outbound messages{c.responsiveness.awaitingUs ? ' · seller spoke last' : ''}</span>
            </section>
          ) : (
            <p className="dr-none">{d.pipeline?.threadKey ? 'The conversation signal could not be read.' : 'No seller conversation is linked to this property.'}</p>
          )}

          {c ? (
            <div className="dr-rhythm" aria-label="When the seller replies (hour of day)">
              <div className="dr-rhythm__bars">
                {c.timing.hourBuckets.map((n, h) => (
                  <i key={h} style={{ height: `${Math.max(4, (n / peak) * 100)}%` }} className={cx(n === 0 && 'is-zero', h >= 9 && h < 17 && 'is-day')} title={`${h}:00 · ${n}`} />
                ))}
              </div>
              <div className="dr-rhythm__axis"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div>
              <p className="dr-quiet">Replies {Math.round(c.timing.share.workday * 100)}% work hours · {Math.round(c.timing.share.evening * 100)}% evening · {Math.round(c.timing.share.lateNight * 100)}% late night{c.timing.timezoneSource === 'utc_fallback' ? ' (UTC — seller timezone unknown)' : c.timing.timezone ? ` (${c.timing.timezone.replace('America/', '').replace('_', ' ')})` : ''}</p>
            </div>
          ) : null}
        </div>

        <div className="dr-prospect__col">
          <div className="dr-facts-list">
            <span className="dr-eyebrow">Seller facts · provenance</span>
            {groups.size ? (
              <ul>
                {[...groups.entries()].map(([label, list]) => {
                  const differ = factsDiffer(list)
                  return (
                    <li key={label} className={cx('dr-fact', differ && 'is-differ')}>
                      <span className="dr-fact__label">{label}{differ ? <LCTooltip content="Sources disagree — both are shown, neither is picked"><em>differ</em></LCTooltip> : null}</span>
                      <div className="dr-fact__vals">
                        {list.map((f) => {
                          const sel = selection?.type === 'fact' && selection.key === f.key
                          return (
                            <button key={f.key} type="button" className={cx('dr-fact__val', sel && 'is-selected')} onClick={() => onSelect({ type: 'fact', key: f.key })} aria-pressed={sel}>
                              <Prov p={f.provenance} />
                              <b>{f.display}</b>
                              {f.at ? <small>{dateShort(f.at, now)}</small> : null}
                            </button>
                          )
                        })}
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : <p className="dr-none">No seller facts captured or recorded.</p>}
          </div>

          <div className="dr-asks">
            <span className="dr-eyebrow">Asking price</span>
            {asks.length ? (
              <ol>
                {[...asks].reverse().map((h, i) => (
                  <li key={`${h.at}-${i}`}><b className="lc-num">{usd(h.amount) ?? '—'}</b><span>{h.title}</span><em>{dateTime(h.at)}</em>{h.detail ? <q>{h.detail.replace(/^“|”$/g, '')}</q> : null}</li>
                ))}
              </ol>
            ) : <p className="dr-none">Not captured — the seller has not named a price.</p>}
            <span className="dr-eyebrow dr-asks__sub">Offers on record</span>
            {d.offer?.offers.length ? (
              <ol>
                {d.offer.offers.map((o) => (
                  <li key={o.id}><b className="lc-num">{usd(o.price) ?? '—'}</b><span>{o.direction === 'inbound' ? 'Seller counter' : 'Our offer'} · {humanize(o.status) ?? '—'}</span><em>{dateTime(o.sentAt) ?? (o.supersededAt ? 'superseded' : '')}</em></li>
                ))}
              </ol>
            ) : <p className="dr-none">None recorded — offers are made by the seller workflow, never from here.</p>}
          </div>

          {last ? (
            <figure className="dr-statement">
              <figcaption><span className="dr-eyebrow">Latest seller statement</span><em>{dateTime(last.at)}{last.intent ? ` · ${humanize(last.intent)}` : ''}</em></figcaption>
              <blockquote>“{last.body}”</blockquote>
              {links?.conversation ? <LCButton size="sm" variant="quiet" icon="message" onClick={links.conversation}>Open conversation</LCButton> : null}
            </figure>
          ) : null}
        </div>

        <div className="dr-prospect__col">
          <div className="dr-story">
            <span className="dr-eyebrow">Acquisition timeline</span>
            {storyLoading ? <LCSkeleton shape="rows" count={4} label="Loading the deal's story" /> : beats.length ? <LCTimeline items={beats} dense label="Deal story" /> : <p className="dr-none">{d.pipeline ? 'No recorded beats for this deal.' : 'No deal — no acquisition timeline.'}</p>}
          </div>
          <div className="dr-gaps">
            <span className="dr-eyebrow">Waiting on · next information</span>
            {gaps.length ? (
              <ol>
                {gaps.slice(0, variant === 'column' ? 5 : 6).map((g, i) => {
                  const sel = selection?.type === 'gap' && selection.key === g.key
                  return (
                    <li key={g.key}>
                      <button type="button" className={cx('dr-gap', i === 0 && 'is-first', sel && 'is-selected')} data-kind={g.kind} onClick={() => onSelect({ type: 'gap', key: g.key })} aria-pressed={sel}>
                        <b>{g.label}</b>
                        <span>{g.reason}</span>
                      </button>
                    </li>
                  )
                })}
              </ol>
            ) : <p className="dr-none">Nothing outstanding on record.</p>}
            <p className="dr-quiet">{GAP_RULE}</p>
          </div>
        </div>
      </div>
    </Plane>
  )
}
