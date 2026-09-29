import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../../../shared/icons'
import { useBackHandler } from '../../../domain/navigation/useBackHandler'
import {
  fetchDemoRoom, fetchRoom,
  type ActivityItem, type Closing, type ClosingDoc, type EmdLine, type Room,
} from './closing-execution-api'
import {
  countdown, DOC_STATUS, docTone, EMD_WORD, emdTone, money, OWNER_LABEL, shortDate, stamp, titleCase, weekdayDate, whenLabel,
} from './closing-format'
import { actionLink, linkAvailable, openLink, type LinkKind } from './closing-links'

/**
 * THE TRANSACTION ROOM — one closing, under glass. Hero → next action →
 * blockers → execution rail → ready-to-close → parties / money / title /
 * documents / timeline / activity, each disclosed on demand. Closing-day
 * deals lead with what is still required; closed deals resolve into their
 * immutable settlement record.
 */

const STEP_ICON: Record<string, IconName> = { complete: 'check', blocked: 'alert', waiting: 'clock', active: 'target', not_started: 'more' }

export function ClosingRoom({ id, demo, fallback, onClose }: { id: string; demo: boolean; fallback: Closing | null; onClose: () => void; onChanged?: () => void }) {
  const [room, setRoom] = useState<Room | null>(fallback ? { closing: fallback, activity: [], activityMore: false, degraded: [] } : null)
  const [roomError, setRoomError] = useState<string | null>(null)
  const [activityLoaded, setActivityLoaded] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [sheet, setSheet] = useState<{ kind: 'doc'; doc: ClosingDoc } | { kind: 'more' } | { kind: 'event'; label: string; rows: Array<[string, string]> } | null>(null)

  useBackHandler(true, 'closing-room', 'Close transaction room', () => { if (sheet) setSheet(null); else onClose(); return true })

  useEffect(() => {
    const ac = new AbortController()
    ;(demo ? fetchDemoRoom(id) : fetchRoom(id, null, ac.signal))
      .then((r) => { setRoom(r); setActivityLoaded(true); setRoomError(null) })
      .catch((err) => { if ((err as Error)?.name !== 'AbortError') setRoomError((err as Error)?.message || 'unavailable') })
    return () => ac.abort()
  }, [id, demo])

  const loadMore = useCallback(async () => {
    if (!room || demo) return
    const last = room.activity[room.activity.length - 1]
    if (!last) return
    setLoadingMore(true)
    try {
      const more = await fetchRoom(id, last.at)
      setRoom({ ...room, activity: [...room.activity, ...more.activity], activityMore: more.activityMore })
    } finally { setLoadingMore(false) }
  }, [room, demo, id])

  const c = room?.closing ?? null
  const body = !c ? (
    <div className="cd2-room__state">{roomError ? <><Icon name="alert" /><strong>{roomError === 'closing_not_found' ? 'This closing no longer exists' : 'Could not open this closing'}</strong></> : <span className="cd2-skel__card"><i /><i /><i /></span>}</div>
  ) : <RoomBody c={c} room={room!} activityLoaded={activityLoaded} loadingMore={loadingMore} onMore={loadMore} openSheet={setSheet} />

  const primary = c ? primaryAction(c) : null

  return createPortal(
    <div className={`cd2-room is-${c?.state.tone ?? 'active'}${c?.closed ? ' is-resolved' : ''}`} role="dialog" aria-modal="true" aria-label={c?.property.address ?? 'Closing'} data-testid="closing-room">
      <div className="cd2-room__scroll">
        <header className="cd2-room__bar">
          <button type="button" className="cd2-icon" aria-label="Back to Closing Desk" onClick={onClose}><Icon name="chevron-left" /></button>
          <span className="cd2-eyebrow"><i />Transaction room{demo ? <b className="cd2-demo">Demo</b> : null}</span>
          {c?.stage ? <span className="cd2-stage">{c.stage.code}</span> : <span />}
        </header>
        {body}
      </div>
      {c ? (
        <nav className="cd2-actionbar" aria-label="Closing actions">
          {primary ? <button type="button" className="cd2-act is-primary" onClick={() => openLink(primary.kind, c)}><Icon name={primary.kind === 'conversation' ? 'message' : primary.kind === 'buyer_match' ? 'users' : 'mail'} />{primary.label}</button> : null}
          {linkAvailable('pipeline', c) ? <button type="button" className="cd2-act" onClick={() => openLink('pipeline', c)}><Icon name="layers" />Pipeline</button> : null}
          <button type="button" className="cd2-act" onClick={() => setSheet({ kind: 'more' })}><Icon name="more" />More</button>
        </nav>
      ) : null}
      {c && sheet ? <RoomSheet c={c} sheet={sheet} onClose={() => setSheet(null)} /> : null}
    </div>,
    document.body,
  )
}

/** The one primary button: the next action's real destination, else email title. */
function primaryAction(c: Closing): { label: string; kind: LinkKind } | null {
  if (c.terminal) return null
  const fromNext = actionLink(c.next?.action, c)
  if (fromNext) return fromNext
  if (!c.closed && c.title.company && linkAvailable('email', c)) return { label: 'Email title', kind: 'email' }
  if (linkAvailable('conversation', c)) return { label: 'Conversation', kind: 'conversation' }
  return null
}

function RoomBody({ c, room, activityLoaded, loadingMore, onMore, openSheet }: {
  c: Closing; room: Room; activityLoaded: boolean; loadingMore: boolean; onMore: () => void
  openSheet: (s: { kind: 'doc'; doc: ClosingDoc } | { kind: 'event'; label: string; rows: Array<[string, string]> }) => void
}) {
  const closingDay = !c.closed && c.closing?.confirmed && c.closing.daysOut !== null && c.closing.daysOut >= 0 && c.closing.daysOut <= 1
  const met = c.requirements.filter((r) => r.met).length
  return (
    <>
      <Hero c={c} />
      {room.degraded.length ? <p className="cd2-degraded"><Icon name="alert" />{room.degraded.map((d) => d.source.replace(/_/g, ' ')).join(', ')} unavailable — shown as unknown, not empty.</p> : null}
      {c.stage?.diverged ? <p className="cd2-degraded"><Icon name="alert" />Pipeline shows {titleCase(c.stage.opportunityStage)} while the closing record is {c.stage.label}. The closing record is shown.</p> : null}

      {c.next ? <NextAction c={c} /> : null}

      {c.blockers.length ? (
        <section className="cd2-block" aria-label="Blockers">
          <h2 className="cd2-h2 is-bad">Blocking this closing</h2>
          {c.blockers.map((b) => {
            const link = actionLink(b.action, c)
            return (
              <article key={b.key} className="cd2-blocker">
                <strong>{b.what}</strong>
                <p>{b.why}</p>
                <footer><span className="cd2-owner">{b.ownerLabel} has the ball</span>{link ? <button type="button" className="cd2-link" onClick={() => openLink(link.kind, c)}>{link.label}<Icon name="chevron-right" /></button> : null}</footer>
              </article>
            )
          })}
        </section>
      ) : null}

      {closingDay || c.ready ? <Requirements c={c} met={met} emphasis /> : null}

      {!c.terminal ? (
        <Section title="Execution" icon="activity" open>
          <ol className="cd2-rail">
            {c.rail.map((s) => (
              <li key={s.key} className={`is-${s.status}`}>
                <i aria-hidden><Icon name={STEP_ICON[s.status] ?? 'more'} /></i>
                <div>
                  <b>{s.label}</b>
                  <span>{s.detail}</span>
                  {s.owner ? <em className="cd2-owner">{s.status === 'blocked' ? 'Blocked · ' : ''}{s.owner === 'you' ? 'Waiting on you' : s.owner === 'system' ? 'System handling' : `Waiting on ${OWNER_LABEL[s.owner].toLowerCase()}`}</em> : null}
                </div>
                {s.at ? <time>{shortDate(s.at.slice(0, 10))}</time> : null}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {!c.closed && !c.terminal && !closingDay && !c.ready ? <Requirements c={c} met={met} /> : null}

      {c.closed ? <FinalSettlement c={c} /> : null}

      <Section title="Buyer" icon="users" open={!c.closed && Boolean(c.buyer)} hint={c.buyer ? (c.buyer.committed ? 'Committed' : c.buyer.selected ? 'Selected' : titleCase(c.buyer.offerStatus)) : 'None selected'}>
        <BuyerBlock c={c} />
      </Section>

      <Section title="Earnest money" icon="dollar-sign" hint={c.emd.buyer ? EMD_WORD[c.emd.buyer.state] : c.emd.contract ? EMD_WORD[c.emd.contract.state] : 'None on record'}>
        {c.emd.buyer ? <Emd line={c.emd.buyer} title="Buyer EMD" /> : <p className="cd2-muted">Buyer EMD appears once a buyer is selected.</p>}
        {c.emd.contract ? <Emd line={c.emd.contract} title="Seller-contract EMD" /> : null}
      </Section>

      <Section title="Title" icon="shield" hint={c.title.clearToClose ? 'Clear to close' : c.title.company || 'Not routed'}>
        <dl className="cd2-dl">
          <Row k="Company" v={c.title.company} />
          <Row k="Order email" v={c.title.email} />
          <Row k="Market" v={c.title.routeMarket} />
          <Row k="Escrow file" v={c.title.escrowFile} />
          <Row k="Status" v={c.title.clearToClose ? 'Clear to close' : c.title.status ? titleCase(c.title.status) : c.title.routeStatus === 'title_route_unavailable' ? 'No route for this market' : null} />
          <Row k="Order sent" v={c.title.introSentAt ? stamp(c.title.introSentAt, c.property.tz) : null} />
          <Row k="Opened" v={c.title.openedAt ? stamp(c.title.openedAt, c.property.tz) : null} />
          <Row k="Commitment due" v={c.title.commitmentDue ? shortDate(c.title.commitmentDue.date) : null} />
        </dl>
        <p className="cd2-muted">Title exceptions are not recorded in LeadCommand; only issues on the closing record appear above.</p>
        {c.title.company && linkAvailable('email', c) ? <button type="button" className="cd2-link" onClick={() => openLink('email', c)}>Email title<Icon name="chevron-right" /></button> : null}
      </Section>

      <Section title="Contract" icon="file-text" hint={c.contract.status ? titleCase(c.contract.status) : '—'}>
        <dl className="cd2-dl">
          <Row k="Status" v={c.contract.status ? titleCase(c.contract.status) : null} />
          <Row k="Executed" v={c.contract.executedAt ? stamp(c.contract.executedAt, c.property.tz) : null} />
          <Row k="Sent" v={c.contract.sentAt ? stamp(c.contract.sentAt, c.property.tz) : null} />
          <Row k="Seller signer" v={c.contract.signer || c.seller.name} />
          <Row k="Purchase price" v={c.contract.price ? `${money(c.contract.price)}${c.contract.status === 'fully_executed' ? '' : ' · not yet executed'}` : null} />
          <Row k="Earnest money" v={c.contract.earnestMoney ? money(c.contract.earnestMoney) : null} />
          <Row k="DocuSign envelope" v={c.contract.envelope} mono />
        </dl>
      </Section>

      {!c.closed ? (
        <Section title="Money" icon="dollar-sign" hint="Estimated">
          <Estimated c={c} />
        </Section>
      ) : null}

      <Section title="Documents" icon="paperclip" hint={`${c.documents.length}`}>
        {c.documents.length ? (
          <ul className="cd2-docs">
            {c.documents.map((d) => (
              <li key={d.key}>
                <button type="button" className={`cd2-doc is-${docTone(d)}`} onClick={() => openSheet({ kind: 'doc', doc: d })}>
                  <Icon name="file-text" />
                  <span><b>{d.label}</b><small>{[d.party, d.source ? titleCase(d.source) : null].filter(Boolean).join(' · ')}</small></span>
                  <em>{DOC_STATUS[d.status] ?? titleCase(d.status)}</em>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="cd2-muted">No documents on record for this closing.</p>}
      </Section>

      {c.deadlines.length ? (
        <Section title="Deadlines" icon="clock" hint={c.deadlines.some((d) => d.overdue) ? 'Overdue' : `${c.deadlines.length}`}>
          <ul className="cd2-deadlines">
            {c.deadlines.map((d) => (
              <li key={d.key} className={d.overdue ? 'is-bad' : d.met ? 'is-good' : ''}>
                <span>{d.label}</span><b>{whenLabel(d).main}</b><em>{d.met ? 'Met' : d.overdue ? 'Overdue' : 'Open'}</em>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Timeline" icon="calendar" open={c.closed} hint={`${c.timeline.length} events`}>
        {c.timeline.length ? (
          <ol className="cd2-timeline">
            {c.timeline.map((e, i) => (
              <li key={`${e.at}-${i}`} className={e.planned ? 'is-planned' : ''}>
                <time>{weekdayDate(e.at.slice(0, 10))}</time>
                <b>{e.label}</b>
                <small>{e.source}</small>
              </li>
            ))}
          </ol>
        ) : <p className="cd2-muted">No dated events yet.</p>}
      </Section>

      <Section title="Activity" icon="list" hint={activityLoaded ? `${room.activity.length}${room.activityMore ? '+' : ''}` : '…'}>
        {room.activity.length ? (
          <ul className="cd2-activity">
            {room.activity.map((a) => <ActivityRow key={a.id} a={a} tz={c.property.tz} />)}
          </ul>
        ) : <p className="cd2-muted">{activityLoaded ? 'No operational activity recorded.' : 'Loading…'}</p>}
        {room.activityMore ? <button type="button" className="cd2-link" disabled={loadingMore} onClick={onMore}>{loadingMore ? 'Loading…' : 'Older activity'}</button> : null}
      </Section>

      <Section title="Property" icon="home" hint={[c.property.city, c.property.state].filter(Boolean).join(', ')}>
        <dl className="cd2-dl">
          <Row k="Address" v={c.property.address} />
          <Row k="Seller" v={c.seller.name} />
          <Row k="Time zone" v={c.property.tz ? `${c.property.tz}${c.property.tzConfident ? '' : ' (uncertain)'}` : 'Unknown'} />
          <Row k="Closing ID" v={c.id} mono />
        </dl>
        <div className="cd2-linkgrid">
          {(['underwriting', 'entity_property', 'entity_owner', 'map'] as LinkKind[]).filter((k) => linkAvailable(k, c)).map((k) => (
            <button key={k} type="button" className="cd2-act" onClick={() => openLink(k, c)}>{LINK_LABEL[k]}</button>
          ))}
        </div>
      </Section>
      <p className="cd2-prov">Read-only · derived from canonical closing records{c.updatedAt ? ` · updated ${stamp(c.updatedAt)}` : ''}</p>
    </>
  )
}

const LINK_LABEL: Record<LinkKind, string> = {
  conversation: 'Open conversation', email: 'Open email', pipeline: 'Open in Pipeline', buyer_match: 'Open Buyer Match', underwriting: 'View underwriting',
  entity_property: 'Property relationships', entity_owner: 'Seller / owner', map: 'Show on map', calendar: 'View in Calendar',
}

function Hero({ c }: { c: Closing }) {
  const w = whenLabel(c.closing)
  const cd = c.closing?.confirmed && !c.closed ? countdown(c.closing.daysOut) : null
  const lead = c.terminal ? 'Cancelled' : c.closed ? 'Closed' : cd || (c.closing ? 'Target closing' : 'No closing date')
  const facts = [
    c.buyer?.committed ? 'Buyer committed' : c.buyer?.selected ? 'Buyer selected' : null,
    c.emd.buyer?.state === 'verified' ? 'EMD verified' : c.emd.buyer?.state === 'received' ? 'EMD received' : null,
    c.buyer?.agreement?.status === 'fully_executed' ? 'Agreement executed' : null,
    c.title.clearToClose ? 'Clear to close' : null,
  ].filter(Boolean) as string[]
  return (
    <section className="cd2-hero">
      <span className={`cd2-hero__lead is-${c.state.tone}`}>{lead}</span>
      <h1>{c.property.line || c.property.address || 'Address not on record'}</h1>
      <p className="cd2-hero__city">{[c.property.city, c.property.state].filter(Boolean).join(', ')}</p>
      <div className="cd2-hero__row">
        <span className={`cd2-pill is-${c.state.tone}`}>{c.state.label}</span>
        {c.stage ? <span className="cd2-stage">{c.stage.code} · {c.stage.label}</span> : null}
      </div>
      {c.closing ? (
        <div className="cd2-hero__when">
          <b>{w.main}</b>
          <span>{c.closed ? 'Closing date' : c.closing.confirmed ? 'Scheduled' : 'Target only — not confirmed by title'}{w.alt ? ` · ${w.alt}` : ''}</span>
        </div>
      ) : null}
      {facts.length ? <ul className="cd2-hero__facts">{facts.map((f) => <li key={f}><Icon name="check" />{f}</li>)}</ul> : null}
    </section>
  )
}

function NextAction({ c }: { c: Closing }) {
  const n = c.next!
  const link = actionLink(n.action, c)
  return (
    <section className={`cd2-nextact${n.blocker ? ' is-bad' : ''}`} aria-label="Next action">
      <small>Next action</small>
      <strong>{n.what}</strong>
      <footer>
        <span className="cd2-owner">{n.ownerLabel ?? 'You'} has the ball</span>
        {link ? <button type="button" className="cd2-link" onClick={() => openLink(link.kind, c)}>{link.label}<Icon name="chevron-right" /></button>
          : <span className="cd2-muted">{n.owner === 'you' ? 'Done outside LeadCommand today' : 'Nothing to do here'}</span>}
      </footer>
    </section>
  )
}

function Requirements({ c, met, emphasis = false }: { c: Closing; met: number; emphasis?: boolean }) {
  return (
    <section className={`cd2-block cd2-reqs${emphasis ? ' is-emphasis' : ''}${c.ready ? ' is-ready' : ''}`} aria-label="Ready to close">
      <h2 className="cd2-h2">{c.ready ? 'Ready to close' : 'Before this can close'}<span>{met} of {c.requirements.length}</span></h2>
      <ul>
        {c.requirements.map((r) => (
          <li key={r.key} className={r.met ? 'is-met' : ''}>
            <i aria-hidden>{r.met ? <Icon name="check" /> : null}</i>
            <span>{r.label}</span>
            {r.detail ? <small>{r.detail}</small> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function BuyerBlock({ c }: { c: Closing }) {
  const b = c.buyer
  if (!b) {
    return (
      <>
        <p className="cd2-muted">No buyer offer on record.</p>
        {linkAvailable('buyer_match', c) ? <button type="button" className="cd2-link" onClick={() => openLink('buyer_match', c)}>Open Buyer Match<Icon name="chevron-right" /></button> : null}
      </>
    )
  }
  return (
    <>
      <p className="cd2-buyer">{b.name ?? 'Individual buyer · name withheld'}</p>
      <ol className="cd2-steps">
        <li className={b.selected ? 'is-on' : ''}><span>Selected</span><b>{b.selectedAt ? shortDate(b.selectedAt.slice(0, 10)) : '—'}</b></li>
        <li className={b.committed ? 'is-on' : ''}><span>Committed</span><b>{b.committedAt ? shortDate(b.committedAt.slice(0, 10)) : titleCase(b.commitmentStatus) || '—'}</b></li>
        <li className={b.agreement?.status === 'fully_executed' ? 'is-on' : ''}><span>Agreement</span><b>{b.agreement ? titleCase(b.agreement.status) : 'None'}</b></li>
        <li className={c.emd.buyer?.state === 'verified' ? 'is-on' : ''}><span>EMD</span><b>{c.emd.buyer ? EMD_WORD[c.emd.buyer.state] : '—'}</b></li>
      </ol>
      <dl className="cd2-dl">
        <Row k="Offer" v={b.price ? money(b.price) : null} big />
        <Row k="Strategy" v={b.strategy ? titleCase(b.strategy) : null} />
        <Row k="Proof of funds" v={b.pof.status ? titleCase(b.pof.status) : null} />
        <Row k="Buyer's closing date" v={b.closingDate ? shortDate(b.closingDate) : null} />
      </dl>
      {linkAvailable('buyer_match', c) ? <button type="button" className="cd2-link" onClick={() => openLink('buyer_match', c)}>Open Buyer Match<Icon name="chevron-right" /></button> : null}
    </>
  )
}

function Emd({ line, title }: { line: EmdLine; title: string }) {
  const r = line.receipt
  return (
    <article className={`cd2-emd is-${emdTone(line.state)}`}>
      <header><small>{title}</small><em>{EMD_WORD[line.state]}</em></header>
      <b className="cd2-emd__amt">{money(line.amount)}</b>
      {line.due ? <span className="cd2-emd__due">Due {shortDate(line.due.date)}{line.dueSoon ? ' · soon' : ''}</span> : null}
      {r ? (
        <p className="cd2-emd__prov">
          {r.verifiedAt ? `Verified ${stamp(r.verifiedAt)}` : r.receivedAt ? `Received ${stamp(r.receivedAt)}` : titleCase(r.status)}
          {r.verifiedBy ? ` · by ${r.verifiedBy}` : ''}{r.method ? ` via ${r.method.replace(/_/g, ' ')}` : ''}
          {r.evidence ? <><br />Evidence: {r.evidence}</> : null}
        </p>
      ) : line.required ? <p className="cd2-emd__prov">No receipt recorded.</p> : null}
    </article>
  )
}

function Estimated({ c }: { c: Closing }) {
  const e = c.money.estimated
  const rows: Array<[string, typeof e.contractPrice]> = [
    ['Purchase price', e.contractPrice], ['Buyer price', e.buyerPrice], ['Expected assignment fee', e.assignmentFee],
    ['Closing costs', e.closingCosts], ['Title fees', e.titleFees], ['Expected gross revenue', e.grossRevenue],
  ]
  const shown = rows.filter(([, v]) => v)
  return shown.length ? (
    <>
      <p className="cd2-badge is-est">Estimated — becomes actual only from the settlement statement</p>
      <dl className="cd2-dl cd2-money">
        {shown.map(([k, v]) => <div key={k}><dt>{k}<small>{v!.basis}</small></dt><dd>{money(v!.value)}</dd></div>)}
      </dl>
      {linkAvailable('underwriting', c) ? <button type="button" className="cd2-link" onClick={() => openLink('underwriting', c)}>View underwriting<Icon name="chevron-right" /></button> : null}
    </>
  ) : <p className="cd2-muted">No prices on the closing record yet.</p>
}

function FinalSettlement({ c }: { c: Closing }) {
  const a = c.money.actual
  return (
    <section className="cd2-final" aria-label="Final settlement">
      <h2 className="cd2-h2 is-gold">Final settlement</h2>
      {a ? (
        <>
          <div className="cd2-final__net"><small>Actual net</small><b>{money(a.netProceeds)}</b></div>
          {c.money.expectedFeeVsActual ? (
            <div className="cd2-final__cmp">
              <span><small>Expected fee</small><b>{money(c.money.expectedFeeVsActual.expected)}</b></span>
              <span><small>Actual fee</small><b>{money(c.money.expectedFeeVsActual.actual)}</b></span>
            </div>
          ) : null}
          {a.legs.map((l) => (
            <dl key={l.id ?? l.leg ?? 'leg'} className="cd2-dl cd2-money">
              {a.legs.length > 1 ? <div><dt>Leg</dt><dd>{l.leg?.replace('_', '→').toUpperCase()}</dd></div> : null}
              <div><dt>Closed</dt><dd>{stamp(l.closedAt, c.property.tz)}</dd></div>
              <div><dt>Purchase (seller)</dt><dd>{money(l.sellerAmount)}</dd></div>
              <div><dt>Sale (buyer)</dt><dd>{money(l.buyerAmount)}</dd></div>
              <div><dt>Assignment fee</dt><dd>{money(l.assignmentFee)}</dd></div>
              <div><dt>Closing costs</dt><dd>{money(l.closingCosts)}</dd></div>
              {l.otherCosts ? <div><dt>Other costs</dt><dd>{money(l.otherCosts)}</dd></div> : null}
              <div><dt>Net</dt><dd>{money(l.netProceeds)}</dd></div>
              <div><dt>Settled by</dt><dd>{l.provider || '—'}</dd></div>
              <div><dt>Statement</dt><dd>{l.statementRef || '—'}</dd></div>
              <div><dt>Recorded</dt><dd>{l.recording.at ? `${shortDate(l.recording.at.slice(0, 10))} · ${l.recording.instrument ?? ''}` : titleCase(l.recording.status) || '—'}</dd></div>
              <div><dt>Verified</dt><dd>{l.verifiedBy ? `${l.verifiedBy}${l.method ? ` · ${l.method.replace(/_/g, ' ')}` : ''}` : '—'}</dd></div>
            </dl>
          ))}
          {a.legs.some((l) => l.exception) ? <p className="cd2-degraded"><Icon name="alert" />Post-close exception recorded — see settlement record.</p> : null}
        </>
      ) : <p className="cd2-muted">Closed, but no settled settlement record exists — actual figures are unknown and are not estimated.</p>}
    </section>
  )
}

function ActivityRow({ a, tz }: { a: ActivityItem; tz: string | null }) {
  const label: Record<string, string> = { docusign_status: 'DocuSign update', title_route: 'Title routed', title_intro_email: 'Title order email sent' }
  const status = typeof a.detail?.status === 'string' ? ` · ${titleCase(a.detail.status as string)}` : ''
  return (
    <li><b>{label[a.type] ?? titleCase(a.type)}{status}</b><small>{stamp(a.at, tz)}{a.source ? ` · ${a.source.replace(/_/g, ' ')}` : ''}</small></li>
  )
}

function Section({ title, icon, hint, open = false, children }: { title: string; icon: IconName; hint?: string | null; open?: boolean; children: ReactNode }) {
  const [on, setOn] = useState(open)
  return (
    <section className={`cd2-sec${on ? ' is-open' : ''}`}>
      <button type="button" className="cd2-sec__head" aria-expanded={on} onClick={() => setOn((v) => !v)}>
        <Icon name={icon} /><b>{title}</b>{hint ? <span>{hint}</span> : null}<Icon name="chevron-down" />
      </button>
      {on ? <div className="cd2-sec__body">{children}</div> : null}
    </section>
  )
}

function Row({ k, v, mono = false, big = false }: { k: string; v: string | null | undefined; mono?: boolean; big?: boolean }) {
  if (!v) return null
  return <div><dt>{k}</dt><dd className={`${mono ? 'is-mono' : ''}${big ? ' is-big' : ''}`}>{v}</dd></div>
}

function RoomSheet({ c, sheet, onClose }: { c: Closing; sheet: { kind: 'doc'; doc: ClosingDoc } | { kind: 'more' } | { kind: 'event'; label: string; rows: Array<[string, string]> }; onClose: () => void }) {
  const links = useMemo(() => (['conversation', 'email', 'pipeline', 'buyer_match', 'underwriting', 'entity_property', 'entity_owner', 'map', 'calendar'] as LinkKind[]).filter((k) => linkAvailable(k, c)), [c])
  return (
    <div className="cd2-sheet" role="dialog" aria-modal="true">
      <button type="button" className="cd2-sheet__scrim" aria-label="Close" onClick={onClose} />
      <div className="cd2-sheet__panel">
        <div className="cd2-sheet__grab" />
        {sheet.kind === 'doc' ? (
          <>
            <span className="cd2-eyebrow"><i />Document</span>
            <h3>{sheet.doc.label}</h3>
            <p className={`cd2-docstatus is-${docTone(sheet.doc)}`}>{DOC_STATUS[sheet.doc.status] ?? titleCase(sheet.doc.status)}</p>
            <dl className="cd2-dl">
              <Row k="Party" v={sheet.doc.party} />
              <Row k="Source" v={sheet.doc.source ? titleCase(sheet.doc.source) : null} />
              <Row k="Reference" v={sheet.doc.reference} mono />
              <Row k="Version" v={sheet.doc.version ? `v${sheet.doc.version}` : null} />
              <Row k="Date" v={sheet.doc.at ? stamp(sheet.doc.at, c.property.tz) : null} />
            </dl>
            <p className="cd2-muted">{sheet.doc.status === 'missing' ? 'Expected by now and not on record.' : 'No viewable file is stored in LeadCommand — this is the record’s reference. Open it at the source.'}</p>
          </>
        ) : sheet.kind === 'more' ? (
          <>
            <span className="cd2-eyebrow"><i />Open elsewhere</span>
            <h3>{c.property.line || c.property.address}</h3>
            <div className="cd2-linkgrid">
              {links.map((k) => <button key={k} type="button" className="cd2-act" onClick={() => { onClose(); openLink(k, c) }}>{LINK_LABEL[k]}</button>)}
            </div>
            <p className="cd2-muted">Closing Desk is read-only: contract, title, EMD and settlement are recorded by their own systems.</p>
          </>
        ) : (
          <>
            <h3>{sheet.label}</h3>
            <dl className="cd2-dl">{sheet.rows.map(([k, v]) => <Row key={k} k={k} v={v} />)}</dl>
          </>
        )}
      </div>
    </div>
  )
}
