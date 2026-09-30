import { useEffect, useMemo, type ReactNode } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import type { ActivityItem, Closing, ClosingDoc, Deadline, Item, Owner, Room, StoredFile } from '../mobile/closing-execution-api'
import { clock, DOC_STATUS, docTone, EMD_WORD, emdTone, money, shortDate, stamp, titleCase, weekdayDate, whenLabel, zoneAbbr } from '../mobile/closing-format'
import { availableActions as availableFor, type ActionSpec } from '../mobile/ClosingActions'
import { BALL_OWNERS, countdown, links, OWNER_WORD, relativeMoment, SECTIONS, stateWord, type Section } from './desk-model'
import { formFor, resolveAction } from './desk-actions'
import { loopStateWord, reasonWord, type Subject } from './DeskInspector'
import { Empty, Fact, go, OwnerTag, SevChip, Spec, StateChip } from './desk-ui'

/**
 * THE EXECUTION ROOM — one closing: who has the ball and the one next action,
 * the execution rail, the canonical READY TO CLOSE checklist, what blocks it
 * (and what merely waits), then every section on demand. Closed deals resolve
 * into their final settlement record; cancelled ones into what ended them.
 */

const RAIL_LABEL: Record<string, string> = { contract: 'Contract', buyer: 'Buyer', agreement: 'Buyer agreement', emd: 'EMD', title: 'Title', schedule: 'Closing date', settlement: 'Settlement', close: 'Closed' }
const RAIL_REQ: Record<string, string> = { contract: 'contract', buyer: 'buyer', agreement: 'agreement', emd: 'emd', title: 'title', schedule: 'schedule' }
const SECTION_LABEL: Record<Section, string> = { overview: 'Overview', buyer: 'Buyer', emd: 'EMD', title: 'Title', contract: 'Contract', money: 'Money', documents: 'Documents', deadlines: 'Deadlines', timeline: 'Timeline', activity: 'Activity', automation: 'Automation', property: 'Property' }
const ACTIVITY_LABEL: Record<string, string> = {
  docusign_status: 'DocuSign update', title_intro_email: 'Title order email requested', title_acknowledged: 'Title acknowledged', title_commitment_received: 'Title commitment received',
  clear_to_close: 'Clear to close recorded', buyer_selected: 'Buyer selected', buyer_committed: 'Buyer committed', buyer_agreement_status: 'Buyer agreement', emd_received: 'EMD received', emd_verified: 'EMD verified',
  emd_waived: 'EMD waived', title_issue_opened: 'Title issue opened', title_issue_updated: 'Title issue updated', settlement_recorded: 'Settlement recorded', settlement_settled: 'Settlement settled',
  email_requested: 'Email requested', contract_emd_deposited: 'Contract EMD deposited', closing_date_changed: 'Closing date changed', automation_paused: 'Automation paused', automation_resumed: 'Automation resumed',
  automation_escalated: 'Automation escalated', closing_terminated: 'Closing ended', closing_finalized: 'Closing finalized', title_commitment_date_set: 'Commitment date set',
}

export function DeskRoom({ c, room, demo, now, section, onSection, highlight, inspectKey, onInspect, files, filesState, onLoadFiles, onMoreActivity, loadingMore }: {
  c: Closing; room: Room; demo: boolean; now: number; section: Section; onSection: (s: Section) => void; highlight: string[] | null; inspectKey: string | null
  onInspect: (s: Subject) => void; files: StoredFile[] | null; filesState: 'idle' | 'loading' | 'error' | 'ready'; onLoadFiles: () => void; onMoreActivity: () => void; loadingMore: boolean
}) {
  const active = !c.closed && !c.terminal
  const sections = useMemo<Section[]>(() => (c.closed ? ['overview', 'money', 'documents', 'timeline', 'activity', 'property'] : c.terminal ? ['overview', 'documents', 'timeline', 'activity', 'property'] : [...SECTIONS]), [c.closed, c.terminal])
  const current: Section = sections.includes(section) ? section : 'overview'
  useEffect(() => { if (current === 'documents' && filesState === 'idle') onLoadFiles() }, [current, filesState, onLoadFiles])
  const record = (spec: ActionSpec | null) => { if (spec) onInspect({ kind: 'form', spec }) }

  return (
    <article className={`cdx-room is-${c.state.tone}${c.closed ? ' is-closed' : ''}${c.terminal ? ' is-cancelled' : ''}`} aria-label={`Transaction room · ${c.property.line || c.property.address || c.id}`}>
      <Hero c={c} demo={demo} now={now} />
      {room.degraded.length ? <p className="cdx-note is-warn"><Icon name="alert" />{room.degraded.map((d) => titleCase(d.source)).join(', ')} unavailable — shown as unknown, not empty.</p> : null}
      {c.stage?.diverged ? <p className="cdx-note is-warn"><Icon name="alert" />Pipeline shows {titleCase(c.stage.opportunityStage)} while the closing record is {c.stage.code} {c.stage.label}. The closing record is shown.</p> : null}
      {active ? (
        <>
          <BallPlane c={c} now={now} onInspect={onInspect} />
          <ExecutionRail c={c} highlight={highlight} onInspect={onInspect} />
          <div className="cdx-room__pair">
            <ReadyPlane c={c} highlight={highlight} inspectKey={inspectKey} onInspect={onInspect} onFinalize={() => record(formFor(c, 'finalize'))} />
            <BlockingPlane c={c} now={now} inspectKey={inspectKey} onInspect={onInspect} />
          </div>
        </>
      ) : c.closed ? <SettlementPlane c={c} /> : <CancelledPlane c={c} />}

      <nav className="cdx-tabs" role="tablist" aria-label="Sections">
        {sections.map((s) => (
          <button key={s} type="button" role="tab" id={`cdx-tab-${s}`} aria-selected={current === s} aria-controls="cdx-section" className={current === s ? 'is-on' : ''} onClick={() => onSection(s)}>
            {SECTION_LABEL[s]}{s === 'documents' && c.documents.some((d) => d.status === 'missing') ? <i className="cdx-tabdot is-bad" aria-label="missing documents" /> : null}
            {s === 'automation' && (c.automation?.held || (c.automation?.escalations ?? []).some((e) => e.active)) ? <i className="cdx-tabdot is-warn" aria-label="needs attention" /> : null}
          </button>
        ))}
      </nav>
      <section id="cdx-section" role="tabpanel" aria-labelledby={`cdx-tab-${current}`} className={`cdx-section is-${current}`} key={current}>
        {current === 'overview' ? <Overview c={c} now={now} onInspect={onInspect} onSection={onSection} /> : null}
        {current === 'buyer' ? <BuyerSection c={c} now={now} onInspect={onInspect} /> : null}
        {current === 'emd' ? <EmdSection c={c} now={now} onInspect={onInspect} /> : null}
        {current === 'title' ? <TitleSection c={c} now={now} onInspect={onInspect} /> : null}
        {current === 'contract' ? <ContractSection c={c} /> : null}
        {current === 'money' ? <MoneySection c={c} /> : null}
        {current === 'documents' ? <DocumentsSection c={c} demo={demo} files={files} filesState={filesState} onRetry={onLoadFiles} onInspect={onInspect} /> : null}
        {current === 'deadlines' ? <DeadlinesSection c={c} now={now} onInspect={onInspect} /> : null}
        {current === 'timeline' ? <TimelineSection c={c} /> : null}
        {current === 'activity' ? <ActivitySection c={c} room={room} demo={demo} onMore={onMoreActivity} loadingMore={loadingMore} /> : null}
        {current === 'automation' ? <AutomationSection c={c} now={now} onInspect={onInspect} /> : null}
        {current === 'property' ? <PropertySection c={c} /> : null}
      </section>
      <p className="cdx-prov">Derived from canonical closing records{c.updatedAt ? ` · updated ${stamp(c.updatedAt, c.property.tz)}` : ''} · closing {c.id}</p>
    </article>
  )
}

/* ── hero ─────────────────────────────────────────────────────────────── */

function Hero({ c, demo, now }: { c: Closing; demo: boolean; now: number }) {
  const w = whenLabel(c.closing)
  const cd = c.proximity?.key === 'today' ? countdown(c.closing?.at, now) : null
  const prox = c.proximity ? `${c.proximity.label}${cd ? ` · ${cd}` : ''}` : null
  const place = [c.property.city, [c.property.state, c.property.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  return (
    <header className="cdx-hero">
      <div className="cdx-hero__id">
        <Spec className="cdx-hero__meta" parts={[c.market && c.market !== [c.property.city, c.property.state].filter(Boolean).join(', ') ? c.market : c.market ? `${c.market} market` : null, c.stage ? `${c.stage.code} · ${c.stage.label}` : null, c.title.escrowFile ? `File ${c.title.escrowFile}` : null, demo ? <b className="cdx-demo">Demo data</b> : null]} />
        <h1>{c.property.line || c.property.address || 'Address not on record'}</h1>
        <p className="cdx-hero__place">{place || '—'}{c.seller.name ? <span> · Seller {c.seller.name}</span> : null}</p>
      </div>
      <div className="cdx-hero__when">
        {prox ? <span className={`cdx-prox is-${c.proximity!.key}`}>{prox}</span> : null}
        {c.closing ? (
          <>
            <strong className="cdx-hero__date">{c.closing.time ? `${weekdayDate(c.closing.date)} · ${clock(c.closing.time)}${c.closing.tz ? ` ${zoneAbbr(c.closing.tz)}` : ''}` : weekdayDate(c.closing.date)}</strong>
            <small>{c.closed ? 'Closing date held' : c.terminal ? 'Closing date on record' : c.closing.confirmed ? `Confirmed${c.closing.source ? ` · ${titleCase(c.closing.source)}` : ''}` : 'Target — not confirmed by title'}{w.alt ? ` · ${w.alt}` : ''}</small>
          </>
        ) : <strong className="cdx-hero__date is-none">No closing date</strong>}
      </div>
      <StateChip big tone={c.state.tone} word={stateWord({ state: c.state, ball: null, terminal: c.terminal, closed: c.closed, money: { expectedFee: null, actualNet: c.money.actual?.netProceeds ?? null, actualFee: null, closedAt: null } })} />
    </header>
  )
}

/* ── who has the ball ─────────────────────────────────────────────────── */

function BallPlane({ c, now, onInspect }: { c: Closing; now: number; onInspect: (s: Subject) => void }) {
  const b = c.ball
  if (!b) return null
  const system = b.owner === 'system'
  const auto = b.automation
  const act = resolveAction(b.action, c)
  const top = b.source ? (c.items ?? []).find((i) => i.key === b.source) : null
  return (
    <section className={`cdx-ball is-${b.owner}${b.blocker ? ' is-blocker' : ''}`} aria-label="Who has the ball">
      <div className="cdx-ball__who">
        <span className="cdx-eyebrow">Who has the ball</span>
        <ol>
          {BALL_OWNERS.map((o) => <li key={o} className={o === b.owner ? 'is-on' : o === b.waitingOn ? 'is-owes' : ''} aria-current={o === b.owner ? 'true' : undefined}>{OWNER_WORD[o]}</li>)}
        </ol>
      </div>
      <div className="cdx-ball__next">
        <span className="cdx-eyebrow">{system ? 'System handling' : b.blocker ? 'Blocking — next action' : 'Next action'}</span>
        <strong>{b.what}</strong>
        {system && auto ? (
          <Spec className="cdx-ball__spec" parts={[relativeMoment(auto.at, c.property.tz, now), auto.max ? `${auto.done} of ${auto.max} sent` : null, auto.why ? `Why: ${auto.why.toLowerCase()}` : null, b.waitingOn ? `${OWNER_WORD[b.waitingOn]} owes the next step` : null]} />
        ) : b.why ? <p>{b.why}</p> : null}
        {!system && auto ? <small className="cdx-ball__auto"><Icon name="refresh-cw" />{auto.label}{auto.sequence ? ` #${auto.sequence}` : ''} · {relativeMoment(auto.at, c.property.tz, now)}{auto.held ? ' · held' : ''}</small> : null}
      </div>
      <div className="cdx-ball__acts">
        {act?.kind === 'form' ? <button type="button" className="cdx-btn is-primary" onClick={() => onInspect({ kind: 'form', spec: act.spec })}>{act.label}</button> : null}
        {act?.kind === 'link' ? <button type="button" className="cdx-btn is-primary" onClick={() => go(act.path, act.locate ? c : null)}>{act.label}<Icon name="arrow-up-right" /></button> : null}
        {top ? <button type="button" className="cdx-btn" onClick={() => onInspect({ kind: 'item', item: top })}>Details</button> : null}
        {system && auto ? <button type="button" className="cdx-btn" onClick={() => { const loop = c.automation?.loops?.find((l) => l.category === auto.category); if (loop) onInspect({ kind: 'loop', loop }) }}>Automation</button> : null}
      </div>
    </section>
  )
}

/* ── the execution rail ───────────────────────────────────────────────── */

function ExecutionRail({ c, highlight, onInspect }: { c: Closing; highlight: string[] | null; onInspect: (s: Subject) => void }) {
  return (
    <ol className="cdx-rail" aria-label="Execution rail">
      {c.rail.map((s, i) => {
        const req = RAIL_REQ[s.key]
        const hl = Boolean(req && highlight?.includes(req))
        const item = (c.items ?? []).find((x) => x.requirement === req && x.severity !== 'resolved')
        return (
          <li key={s.key} className={`is-${s.status}${hl ? ' is-hl' : ''}${s.key === 'contract' ? ' is-contract' : ''}`} style={{ ['--i' as string]: i }}>
            <button type="button" onClick={() => (item ? onInspect({ kind: 'item', item }) : req ? onInspect({ kind: 'requirement', key: req }) : undefined)} aria-label={`${RAIL_LABEL[s.key]}: ${s.detail}`}>
              <i className="cdx-rail__node" aria-hidden>{s.status === 'complete' ? <Icon name="check" /> : s.status === 'blocked' ? <b>!</b> : null}</i>
              <span className="cdx-rail__label">{RAIL_LABEL[s.key]}</span>
              <span className="cdx-rail__tele">{s.short || s.detail}</span>
              {s.owner ? <em className={`cdx-rail__owner is-${s.owner}`}>{OWNER_WORD[s.owner]}</em> : null}
            </button>
          </li>
        )
      })}
    </ol>
  )
}

/* ── READY TO CLOSE ───────────────────────────────────────────────────── */

function ReadyPlane({ c, highlight, inspectKey, onInspect, onFinalize }: { c: Closing; highlight: string[] | null; inspectKey: string | null; onInspect: (s: Subject) => void; onFinalize: () => void }) {
  const met = c.requirements.filter((r) => r.met)
  const open = c.requirements.filter((r) => !r.met)
  const complete = open.length === 0
  return (
    <section className={`cdx-plane cdx-ready${complete ? ' is-complete' : ''}`} aria-label="Ready to close">
      <h2>Ready to close <b>{met.length}/{c.requirements.length}</b></h2>
      {complete ? (
        <p className="cdx-ready__all">
          <span className="cdx-ready__ticks" aria-hidden>{c.requirements.map((r) => <i key={r.key}><Icon name="check" /></i>)}</span>
          All {c.requirements.length} canonical requirements are met.
        </p>
      ) : (
        <ul className="cdx-ready__open">
          {open.map((r) => (
            <li key={r.key} className={`${highlight?.includes(r.key) ? 'is-hl' : ''}${inspectKey === `req:${r.key}` ? ' is-inspected' : ''}`}>
              <button type="button" onClick={() => onInspect({ kind: 'requirement', key: r.key })}>
                <i aria-hidden />
                <span><b>{r.label}</b>{r.detail ? <small>{r.detail}</small> : null}</span>
                <OwnerTag owner={r.owner ?? null} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!complete && met.length ? (
        <p className="cdx-ready__met">{met.map((r) => <button key={r.key} type="button" onClick={() => onInspect({ kind: 'requirement', key: r.key })}><Icon name="check" />{r.label}</button>)}</p>
      ) : null}
      {complete ? <p className="cdx-muted">Read from the S10 guard itself. Finalize additionally needs the settled settlement record.</p> : null}
      {c.finalize?.ok ? <button type="button" className="cdx-btn is-primary is-gold" onClick={onFinalize}><Icon name="check" />Finalize closing</button> : null}
    </section>
  )
}

/* ── BLOCKING THIS CLOSING (every open item, with its severity) ────────── */

function BlockingPlane({ c, now, inspectKey, onInspect }: { c: Closing; now: number; inspectKey: string | null; onInspect: (s: Subject) => void }) {
  const items = c.items ?? []
  const open = items.filter((i) => i.severity !== 'resolved')
  const resolved = items.filter((i) => i.severity === 'resolved')
  const hard = open.filter((i) => i.severity === 'blocking' || i.severity === 'overdue')
  return (
    <section className={`cdx-plane cdx-block${hard.length ? ' has-hard' : ''}`} aria-label="Blocking this closing">
      <h2>Blocking this closing <span>{hard.length ? `${hard.length} blocking` : 'Nothing blocking'}{open.length > hard.length ? ` · ${open.length - hard.length} open` : ''}</span></h2>
      {open.length ? (
        <ul>
          {open.map((i) => <ItemRow key={i.key} c={c} i={i} now={now} on={inspectKey === `item:${i.key}`} onInspect={onInspect} />)}
        </ul>
      ) : <p className="cdx-block__clear"><Icon name="check" />Nothing open on this closing.</p>}
      {resolved.length ? (
        <ul className="cdx-block__resolved">
          {resolved.map((i) => <ItemRow key={i.key} c={c} i={i} now={now} on={inspectKey === `item:${i.key}`} onInspect={onInspect} />)}
        </ul>
      ) : null}
    </section>
  )
}

function ItemRow({ c, i, now, on, onInspect }: { c: Closing; i: Item; now: number; on: boolean; onInspect: (s: Subject) => void }) {
  return (
    <li className={`is-${i.severity}${on ? ' is-inspected' : ''}`}>
      <button type="button" onClick={() => onInspect({ kind: 'item', item: i })}>
        <SevChip severity={i.severity} />
        <span className="cdx-item__body">
          <span className="cdx-item__what">{i.what}</span>
          <span className="cdx-item__meta">{i.severity === 'resolved' ? null : <OwnerTag owner={i.owner} />}{i.at ? <time>{i.severity === 'resolved' ? 'Resolved ' : i.severity === 'overdue' ? 'Due ' : ''}{relativeMoment(i.at, c.property.tz, now, i.dateOnly)}</time> : null}</span>
        </span>
      </button>
    </li>
  )
}

/* ── closed: the final record ─────────────────────────────────────────── */

function SettlementPlane({ c }: { c: Closing }) {
  const a = c.money.actual
  const leg = a?.legs[0]
  return (
    <section className={`cdx-settle${a ? '' : ' is-unavailable'}`} aria-label="Final settlement">
      <span className="cdx-eyebrow">Final settlement</span>
      {a ? (
        <>
          <div className="cdx-settle__net">
            <small>Actual net</small>
            <strong>{money(a.netProceeds)}</strong>
            <Spec parts={[leg?.closedAt ? `Settled ${stamp(leg.closedAt, c.property.tz)}` : null, leg?.provider ? `by ${leg.provider}` : null, leg?.statementRef]} />
          </div>
          <CompareTable c={c} />
          <dl className="cdx-facts is-two">
            <Fact k="Verified" v={leg?.verifiedBy ? `${leg.verifiedBy}${leg.method ? ` · ${titleCase(leg.method)}` : ''}${leg.verifiedAt ? ` · ${stamp(leg.verifiedAt, c.property.tz)}` : ''}` : null} />
            <Fact k="Evidence" v={leg?.evidence} mono />
            <Fact k="Funds" v={leg?.funding?.fundedAmount ? `${money(leg.funding.fundedAmount)} received${leg.funding.fundedAt ? ` ${stamp(leg.funding.fundedAt, c.property.tz)}` : ''}` : null} />
            <Fact k="Disbursed" v={leg?.funding?.disbursedAmount ? `${money(leg.funding.disbursedAmount)}${leg.funding.disbursedAt ? ` · ${stamp(leg.funding.disbursedAt, c.property.tz)}` : ''}` : null} />
            <Fact k="Recorded" v={leg?.recording.at ? `${shortDate(leg.recording.at.slice(0, 10))} · ${leg.recording.instrument ?? ''} · ${leg.recording.jurisdiction ?? ''}` : leg?.recording.status ? titleCase(leg.recording.status) : null} />
            <Fact k="Closing costs" v={a.closingCosts !== null ? money(a.closingCosts) : null} />
          </dl>
          {a.legs.some((l) => l.exception) ? <p className="cdx-note is-warn"><Icon name="alert" />Post-close exception recorded — see the settlement record.</p> : null}
        </>
      ) : (
        <div className="cdx-settle__none">
          <strong>Closed · settlement record unavailable</strong>
          <p>No settled settlement record exists for this closing, so actual figures are unknown — and are not estimated.{c.money.estimated.assignmentFee ? ` The closing record expected a ${money(c.money.estimated.assignmentFee.value)} fee.` : ''}</p>
        </div>
      )}
    </section>
  )
}

function CompareTable({ c }: { c: Closing }) {
  const rows = c.money.comparison ?? []
  if (!rows.length) return null
  return (
    <table className="cdx-cmp">
      <thead><tr><th scope="col">Line</th><th scope="col">Expected</th><th scope="col">Actual</th><th scope="col">Variance</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row">{r.label}</th>
            <td>{r.expected !== null ? money(r.expected) : '—'}</td>
            <td className="is-actual">{r.actual !== null ? money(r.actual) : <span className="cdx-muted">Not settled</span>}</td>
            <td className={r.variance === null ? '' : r.variance < 0 ? 'is-neg' : r.variance > 0 ? 'is-pos' : ''}>{r.variance === null ? '—' : `${r.variance > 0 ? '+' : r.variance < 0 ? '−' : ''}${money(Math.abs(r.variance))}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function CancelledPlane({ c }: { c: Closing }) {
  const k = c.cancellation
  return (
    <section className="cdx-cancel" aria-label="Cancellation">
      <span className="cdx-eyebrow">{k?.label || 'Cancelled'}</span>
      <dl className="cdx-facts is-two">
        <Fact k="Cancelled at" v={k?.at ? stamp(k.at, c.property.tz) : k?.lastUpdatedAt ? `Not recorded · last updated ${stamp(k.lastUpdatedAt, c.property.tz)}` : 'Not recorded'} />
        <Fact k="By" v={k?.actor || 'Not recorded'} />
        <Fact k="Reason" v={k?.reason || 'Not recorded'} />
        <Fact k="Last milestone" v={k?.lastMilestone ? `${k.lastMilestone.label} · ${stamp(k.lastMilestone.at, c.property.tz)}` : 'None before it ended'} />
      </dl>
      <p className="cdx-muted">Automation stopped and pending requests were withdrawn. History is kept; a cancelled closing can never become Closed.</p>
    </section>
  )
}

/* ── sections ─────────────────────────────────────────────────────────── */

function Block({ title, aside, children, className = '' }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`cdx-plane cdx-sub ${className}`}><h3>{title}{aside ? <span>{aside}</span> : null}</h3>{children}</section>
}

function Thread({ c, which }: { c: Closing; which: 'title' | 'buyer' }) {
  const t = which === 'title' ? c.title.thread : c.buyer?.thread
  if (!t) return <p className="cdx-muted">No {which} conversation in Email Command yet.</p>
  return (
    <button type="button" className="cdx-thread" onClick={() => t.id && go(links.emailThread(t.id), c)} disabled={!t.id}>
      <Icon name={t.direction === 'inbound' ? 'arrow-down-left' : 'send'} />
      <span>
        <b>{t.counterparty || t.email || titleCase(which)}</b>
        <small>{t.direction === 'inbound' ? 'Replied' : 'We wrote'} {t.lastAt ? stamp(t.lastAt, c.property.tz) : ''}{t.needs ? ` · needs you: ${t.needs.reason}` : ''}{t.takenOver ? ' · taken over' : ''}</small>
        {t.preview ? <q>{t.preview}</q> : null}
      </span>
      <Icon name="arrow-up-right" />
    </button>
  )
}

function Overview({ c, now, onInspect, onSection }: { c: Closing; now: number; onInspect: (s: Subject) => void; onSection: (s: Section) => void }) {
  if (c.terminal) return <TimelineSection c={c} compact />
  const closingRow = c.closing && !c.closed ? [{ ...c.closing, key: 'closing', label: c.closing.confirmed ? 'Closing' : 'Target closing', met: false, overdue: c.closing.state === 'overdue', owner: 'title' as Owner, state: c.closing.state, calendar: c.closing.calendar ?? null }] : []
  const upcoming = [...closingRow, ...(c.deadlines ?? [])].filter((d) => d.state !== 'satisfied' && d.state !== 'cancelled').sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(0, 4)
  return (
    <div className="cdx-grid">
      <Block title="Parties">
        <dl className="cdx-facts">
          <Fact k="Seller" v={c.seller.name || c.contract.signer} />
          <Fact k="Buyer" v={c.buyer ? `${c.buyer.name ?? 'Individual buyer · name withheld'} · ${c.buyer.committed ? 'Committed' : c.buyer.selected ? 'Selected — not committed' : titleCase(c.buyer.offerStatus)}` : 'None selected'} />
          <Fact k="Title" v={c.title.company ? `${c.title.company}${c.title.contact ? ` · ${c.title.contact.split(' · ')[0]}` : ''}` : 'Not routed'} />
          <Fact k="File" v={c.title.escrowFile} mono />
        </dl>
      </Block>
      <Block title="Latest with title" aside={c.title.thread?.lastAt ? relativeMoment(c.title.thread.lastAt, c.property.tz, now) : null}><Thread c={c} which="title" /></Block>
      {!c.closed ? (
        <Block title="Next deadlines" aside={<button type="button" className="cdx-link" onClick={() => onSection('deadlines')}>All</button>}>
          {upcoming.length ? (
            <ul className="cdx-mini">
              {upcoming.map((d) => <li key={d.key} className={`is-${d.state}`}><button type="button" onClick={() => onInspect({ kind: 'deadline', deadline: d, closingDate: d.key === 'closing' })}><b>{d.label}</b><span>{whenLabel(d).main}</span><em>{titleCase(d.state)}</em></button></li>)}
            </ul>
          ) : <p className="cdx-muted">No open deadlines on record.</p>}
        </Block>
      ) : null}
      <Block title={c.closed ? 'Money · expected vs actual' : 'Money · expected'} aside={<button type="button" className="cdx-link" onClick={() => onSection('money')}>Detail</button>}>
        <dl className="cdx-facts">
          <Fact k="Purchase" v={c.money.estimated.contractPrice ? `${money(c.money.estimated.contractPrice.value)} expected${c.money.actual?.sellerAmount != null ? ` · ${money(c.money.actual.sellerAmount)} actual` : ''}` : null} />
          <Fact k="Sale" v={c.money.estimated.buyerPrice ? `${money(c.money.estimated.buyerPrice.value)} expected${c.money.actual?.buyerAmount != null ? ` · ${money(c.money.actual.buyerAmount)} actual` : ''}` : null} />
          <Fact k="Fee" v={c.money.estimated.assignmentFee ? `${money(c.money.estimated.assignmentFee.value)} expected${c.money.actual ? ` · ${money(c.money.actual.assignmentFee)} actual` : ''}` : null} />
          <Fact k="Actual net" v={c.money.actual ? money(c.money.actual.netProceeds) : c.closed ? 'Settlement record unavailable' : 'Only from the settled statement'} />
        </dl>
      </Block>
    </div>
  )
}

function BuyerSection({ c, now, onInspect }: { c: Closing; now: number; onInspect: (s: Subject) => void }) {
  const b = c.buyer
  const e = c.emd.buyer
  const ladder: Array<[string, boolean, string | null]> = b ? [
    ['Selected', b.selected, b.selectedAt ? shortDate(b.selectedAt.slice(0, 10)) : null],
    ['Agreement sent', Boolean(b.agreement?.sentAt) || ['sent', 'viewed', 'buyer_signed', 'counterparty_signed', 'fully_executed'].includes(b.agreement?.status || ''), b.agreement?.sentAt ? shortDate(b.agreement.sentAt.slice(0, 10)) : null],
    ['Executed', b.agreement?.status === 'fully_executed', b.agreement?.executedAt ? shortDate(b.agreement.executedAt.slice(0, 10)) : null],
    ['Committed', b.committed, b.committedAt ? shortDate(b.committedAt.slice(0, 10)) : null],
    ['EMD due', Boolean(e?.due), e?.due ? shortDate(e.due.date) : e?.state === 'not_required' ? 'Waived' : null],
    ['Verified', e?.state === 'verified', e?.receipt?.verifiedAt ? shortDate(e.receipt.verifiedAt.slice(0, 10)) : null],
  ] : []
  const buyerMatch = resolveAction('select_buyer', c)
  return (
    <div className="cdx-grid">
      <Block title="Buyer" aside={b ? (b.committed ? 'Committed' : b.selected ? 'Selected ≠ committed' : titleCase(b.offerStatus)) : 'None'} className="is-wide">
        {b ? (
          <>
            <p className="cdx-lead">{b.name ?? 'Individual buyer · name withheld'}</p>
            <ol className="cdx-ladder">{ladder.map(([k, on, d]) => <li key={k} className={on ? 'is-on' : ''}><i aria-hidden>{on ? <Icon name="check" /> : null}</i><b>{k}</b><span>{d ?? '—'}</span></li>)}</ol>
            <dl className="cdx-facts is-two">
              <Fact k="Offer" v={b.price ? money(b.price) : null} />
              <Fact k="Strategy" v={b.strategy ? titleCase(b.strategy) : null} />
              <Fact k="Commitment" v={b.commitmentType ? titleCase(b.commitmentType) : titleCase(b.commitmentStatus)} />
              <Fact k="Agreement" v={b.agreement ? `${titleCase(b.agreement.type)} v${b.agreement.version ?? 1} · ${titleCase(b.agreement.status)}${b.agreement.provider ? ` · ${b.agreement.provider}` : ''}` : 'None'} />
              <Fact k="Envelope" v={b.agreement?.envelope} mono />
              <Fact k="Proof of funds" v={b.pof.status ? `${titleCase(b.pof.status)}${b.pof.verifiedAt ? ` · ${shortDate(b.pof.verifiedAt.slice(0, 10))}` : ''}` : null} />
              <Fact k="Buyer's closing date" v={b.closingDate ? shortDate(b.closingDate) : null} />
            </dl>
          </>
        ) : <Empty title="No buyer offer on record">Selection happens in Buyer Match; the desk never re-ranks buyers.</Empty>}
        {buyerMatch?.kind === 'link' ? <button type="button" className="cdx-btn" onClick={() => go(buyerMatch.path, c)}><Icon name="users" />Open Buyer Match<Icon name="arrow-up-right" /></button> : null}
      </Block>
      <Block title="Latest with buyer" aside={b?.thread?.lastAt ? relativeMoment(b.thread.lastAt, c.property.tz, now) : null}><Thread c={c} which="buyer" /></Block>
      <RecordList c={c} groups={['Buyer']} onInspect={onInspect} />
    </div>
  )
}

function EmdCard({ c, line, title }: { c: Closing; line: NonNullable<Closing['emd']['buyer']>; title: string }) {
  const r = line.receipt
  return (
    <div className={`cdx-emd is-${emdTone(line.state)}`}>
      <header><small>{title}</small><span className={`cdx-sev is-${line.state === 'verified' || line.state === 'not_required' ? 'resolved' : line.state === 'overdue' || line.state === 'failed' || line.state === 'disputed' ? 'overdue' : 'waiting'}`}>{EMD_WORD[line.state]}</span></header>
      <strong className="cdx-emd__amt">{money(line.amount)}</strong>
      <Spec parts={[line.due ? `Due ${shortDate(line.due.date)}` : null, r?.escrow ? `Held by ${r.escrow}` : null, r?.reference ? `Ref ${r.reference}` : null]} />
      {r ? (
        <dl className="cdx-facts">
          <Fact k="Received" v={r.receivedAt ? `${stamp(r.receivedAt, c.property.tz)}${r.source ? ` · ${titleCase(r.source)}` : ''}` : null} />
          <Fact k="Verified" v={r.verifiedAt ? `${stamp(r.verifiedAt, c.property.tz)} · ${r.verifiedBy ?? '—'}${r.method ? ` · ${titleCase(r.method)}` : ''}` : line.state === 'received' ? 'Not verified — needs a method and evidence' : null} />
          <Fact k="Evidence" v={r.evidence} mono />
        </dl>
      ) : line.required ? <p className="cdx-muted">No receipt recorded. An offer's own EMD fields never count as received.</p> : null}
    </div>
  )
}

function EmdSection({ c, now, onInspect }: { c: Closing; now: number; onInspect: (s: Subject) => void }) {
  const loop = c.automation?.loops?.find((l) => l.key === 'buyer_emd')
  return (
    <div className="cdx-grid">
      {c.emd.buyer ? <EmdCard c={c} line={c.emd.buyer} title="Buyer EMD" /> : <Block title="Buyer EMD"><p className="cdx-muted">Appears once a buyer is selected.</p></Block>}
      {c.emd.contract ? <EmdCard c={c} line={c.emd.contract} title="Seller-contract EMD (ours)" /> : null}
      {loop ? (
        <Block title="Reminders" aside={loopStateWord(loop.state)}>
          <button type="button" className="cdx-thread" onClick={() => onInspect({ kind: 'loop', loop })}>
            <Icon name="refresh-cw" />
            <span><b>{loop.done} of {loop.max ?? '—'} reminders</b><small>{loop.next ? `Next #${loop.next.sequence} ${relativeMoment(loop.next.at, c.property.tz, now)}` : loop.escalateAt ? `Escalates ${relativeMoment(loop.escalateAt, c.property.tz, now)}` : loopStateWord(loop.state)}</small></span>
            <Icon name="chevron-right" />
          </button>
        </Block>
      ) : null}
      <RecordList c={c} groups={['EMD']} onInspect={onInspect} />
    </div>
  )
}

function TitleSection({ c, now, onInspect }: { c: Closing; now: number; onInspect: (s: Subject) => void }) {
  const t = c.title
  const issues = c.titleIssues ?? []
  return (
    <div className="cdx-grid">
      <Block title="Title company" aside={t.clearToClose ? 'Clear to close' : t.routeStatus === 'title_route_unavailable' ? 'No route' : t.company ? 'Working' : 'Not routed'} className="is-wide">
        <dl className="cdx-facts is-two">
          <Fact k="Company" v={t.company} />
          <Fact k="Contact" v={t.contact || t.email} />
          <Fact k="File number" v={t.escrowFile} mono />
          <Fact k="Market" v={t.routeMarket} />
          <Fact k="Order sent" v={t.introSentAt ? stamp(t.introSentAt, c.property.tz) : null} />
          <Fact k="Acknowledged" v={t.acknowledgedAt ? `${stamp(t.acknowledgedAt, c.property.tz)}${t.acknowledgedSource ? ` · ${titleCase(t.acknowledgedSource)}` : ''}` : t.introSentAt ? 'Not yet' : null} />
          <Fact k="Opened" v={t.openedAt ? stamp(t.openedAt, c.property.tz) : null} />
          <Fact k="Commitment due" v={t.commitmentDue ? whenLabel(t.commitmentDue).main : null} />
          <Fact k="Commitment" v={t.commitmentReceivedAt ? `Received ${stamp(t.commitmentReceivedAt, c.property.tz)}` : 'Not received'} tone={t.commitmentReceivedAt ? 'good' : undefined} />
          <Fact k="Commitment evidence" v={t.commitmentEvidence} mono />
          <Fact k="Clear to close" v={t.ctc ? `${stamp(t.ctc.at, c.property.tz)} · ${titleCase(t.ctc.source)}${t.ctc.actor ? ` · ${t.ctc.actor}` : ''}` : t.legacyCtcFlag ? 'Legacy flag without provenance — not counted' : 'Not given'} tone={t.ctc ? 'good' : undefined} />
          <Fact k="CTC evidence" v={t.ctc?.evidence} mono />
        </dl>
      </Block>
      <Block title="Latest with title" aside={t.thread?.lastAt ? relativeMoment(t.thread.lastAt, c.property.tz, now) : null}><Thread c={c} which="title" /></Block>
      <Block title="Title issues" aside={issues.filter((i) => ['open', 'in_progress'].includes(i.status)).length ? `${issues.filter((i) => ['open', 'in_progress'].includes(i.status)).length} open` : 'None open'}>
        {issues.length ? (
          <ul className="cdx-issues">
            {issues.map((i) => {
              const item = (c.items ?? []).find((x) => x.key === `title_issue:${i.id}`)
              return (
                <li key={i.id} className={`is-${i.status}`}>
                  <button type="button" onClick={() => item && onInspect({ kind: 'item', item })} disabled={!item}>
                    <span className={`cdx-sev is-${['open', 'in_progress'].includes(i.status) ? 'blocking' : 'resolved'}`}>{titleCase(i.status)}</span>
                    <span><b>{i.label || titleCase(i.type)}</b><small>{i.description}{i.evidence ? ` · ${i.evidence}` : ''}{i.resolution ? ` · resolved: ${i.resolution}` : ''}</small></span>
                    <OwnerTag owner={(i.owner as Owner | null) ?? 'title'} />
                  </button>
                </li>
              )
            })}
          </ul>
        ) : <p className="cdx-muted">No title issues on the closing record. Issues from the commitment are recorded by Email Command or the operator — never cleared automatically.</p>}
      </Block>
      <RecordList c={c} groups={['Title']} onInspect={onInspect} />
    </div>
  )
}

function ContractSection({ c }: { c: Closing }) {
  const k = c.contract
  return (
    <div className="cdx-grid">
      <Block title="Seller contract" aside={k.status ? titleCase(k.status) : '—'} className="is-wide is-contract">
        <dl className="cdx-facts is-two">
          <Fact k="Status" v={k.status ? titleCase(k.status) : null} />
          <Fact k="Accepted" v={k.acceptedAt ? stamp(k.acceptedAt, c.property.tz) : null} />
          <Fact k="Sent for signature" v={k.sentAt ? stamp(k.sentAt, c.property.tz) : null} />
          <Fact k="Executed" v={k.executedAt ? stamp(k.executedAt, c.property.tz) : null} />
          <Fact k="Effective" v={k.effectiveAt ? stamp(k.effectiveAt, c.property.tz) : null} />
          <Fact k="Seller signer" v={k.signer || c.seller.name} />
          <Fact k="Purchase price" v={k.price ? `${money(k.price)}${k.status === 'fully_executed' ? '' : ' · not yet executed'}` : null} />
          <Fact k="Earnest money" v={k.earnestMoney ? money(k.earnestMoney) : null} />
          <Fact k="Inspection deadline" v={k.inspectionDeadline ? whenLabel(k.inspectionDeadline).main : null} />
          <Fact k="DocuSign envelope" v={k.envelope} mono />
        </dl>
        <p className="cdx-muted">Contract state comes from the DocuSign reconciler; the desk never sets it.</p>
      </Block>
    </div>
  )
}

function MoneySection({ c }: { c: Closing }) {
  const e = c.money.estimated
  const rows: Array<[string, typeof e.contractPrice]> = [['Purchase price', e.contractPrice], ['Buyer price', e.buyerPrice], ['Expected assignment fee', e.assignmentFee], ['Closing costs', e.closingCosts], ['Title fees', e.titleFees], ['Expected gross revenue', e.grossRevenue]]
  const shown = rows.filter(([, v]) => v)
  return (
    <div className="cdx-grid">
      <Block title="Expected" aside="From the closing record and offers" className="cdx-money is-expected">
        {shown.length ? <dl className="cdx-facts">{shown.map(([k, v]) => <Fact key={k} k={k} v={<>{money(v!.value)}<small>{v!.basis}</small></>} />)}</dl> : <p className="cdx-muted">No prices on the closing record yet.</p>}
      </Block>
      <Block title="Actual" aside={c.money.actual ? 'Settled settlement record' : 'Only from a settled statement'} className="cdx-money is-actual">
        {c.money.actual ? (
          <dl className="cdx-facts">
            <Fact k="Net proceeds" v={money(c.money.actual.netProceeds)} tone="good" />
            <Fact k="Assignment fee" v={money(c.money.actual.assignmentFee)} />
            <Fact k="Purchase (seller)" v={money(c.money.actual.sellerAmount ?? null)} />
            <Fact k="Sale (buyer)" v={money(c.money.actual.buyerAmount ?? null)} />
            <Fact k="Closing costs" v={money(c.money.actual.closingCosts)} />
          </dl>
        ) : (
          <>
            <p className="cdx-muted">No actual figures until title's final statement is recorded as settled (with evidence). Estimates are never copied in.</p>
            {(c.money.pendingSettlement ?? []).map((p) => <p key={p.id || 'p'} className="cdx-note"><Icon name="file-text" />{p.statementRef ? `Statement received: ${p.statementRef}` : 'Settlement pending — no statement'} · funds {p.funding || 'expected'}</p>)}
          </>
        )}
      </Block>
      {(c.money.comparison ?? []).length ? <Block title="Expected vs actual" className="is-wide"><CompareTable c={c} /></Block> : null}
    </div>
  )
}

function DocumentsSection({ c, demo, files, filesState, onRetry, onInspect }: { c: Closing; demo: boolean; files: StoredFile[] | null; filesState: string; onRetry: () => void; onInspect: (s: Subject) => void }) {
  const docs = c.documents
  const missing = docs.filter((d) => d.status === 'missing')
  return (
    <div className="cdx-grid">
      <Block title="On record" aside={`${docs.length - missing.length} referenced${missing.length ? ` · ${missing.length} missing` : ''}`} className="is-wide">
        {docs.length ? (
          <ul className="cdx-docs">
            {docs.map((d) => <DocRow key={d.key} c={c} d={d} onInspect={onInspect} />)}
          </ul>
        ) : <p className="cdx-muted">No documents on record for this closing.</p>}
      </Block>
      <Block title="Stored files" aside={filesState === 'loading' ? 'Loading…' : files ? `${files.length}` : ''}>
        {filesState === 'error' ? <p className="cdx-note is-warn"><Icon name="alert" />Stored files could not be read. <button type="button" className="cdx-link" onClick={onRetry}>Retry</button></p>
          : files && files.length ? (
            <ul className="cdx-docs">
              {files.map((f) => (
                <li key={f.id}>
                  <button type="button" className="cdx-doc is-good" onClick={() => onInspect({ kind: 'document', doc: null, file: f })}>
                    <Icon name="paperclip" /><span><b>{f.filename || 'Attachment'}</b><small>{[f.party, f.docType ? titleCase(f.docType) : null, f.at ? stamp(f.at, c.property.tz) : null].filter(Boolean).join(' · ')}</small></span><em>{f.stored ? 'Preview' : 'Not fetched'}</em>
                  </button>
                </li>
              ))}
            </ul>
          ) : filesState === 'ready' ? <p className="cdx-muted">{demo ? 'Demo data carries no stored files — live, attachments routed to this closing by Email Command appear here.' : 'No files attached to this closing or its email threads.'}</p> : <p className="cdx-muted">Loading stored files…</p>}
      </Block>
    </div>
  )
}

function DocRow({ c, d, onInspect }: { c: Closing; d: ClosingDoc; onInspect: (s: Subject) => void }) {
  return (
    <li>
      <button type="button" className={`cdx-doc is-${docTone(d)}`} onClick={() => onInspect({ kind: 'document', doc: d })}>
        <Icon name={d.status === 'missing' ? 'alert' : 'file-text'} />
        <span><b>{d.label}</b><small>{[d.party, d.source ? titleCase(d.source) : null, d.at ? stamp(d.at, c.property.tz) : null].filter(Boolean).join(' · ')}</small></span>
        <em>{DOC_STATUS[d.status] ?? titleCase(d.status)}</em>
      </button>
    </li>
  )
}

function DeadlinesSection({ c, now, onInspect }: { c: Closing; now: number; onInspect: (s: Subject) => void }) {
  const closingRow: Deadline | null = c.closing ? { ...c.closing, key: 'closing', label: c.closing.confirmed ? 'Closing' : 'Target closing', met: c.closed, overdue: c.closing.state === 'overdue', field: 'closing_cases.scheduled_closing_date', owner: 'title', state: c.closing.state, calendar: c.closing.calendar ?? null } : null
  const rows = [...(closingRow ? [closingRow] : []), ...c.deadlines].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const history = c.deadlineHistory ?? []
  return (
    <div className="cdx-grid">
      <Block title="Deadlines" aside="Projected to Calendar" className="is-wide">
        {rows.length ? (
          <table className="cdx-dltable">
            <thead><tr><th scope="col">Deadline</th><th scope="col">When</th><th scope="col">Owner</th><th scope="col">State</th><th scope="col"><span className="cdx-sr">Calendar</span></th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.key} className={`is-${d.state}`} onClick={() => onInspect({ kind: 'deadline', deadline: d, closingDate: d.key === 'closing' })}>
                  <th scope="row">{d.label}</th>
                  <td>{whenLabel(d).main}<small>{d.state === 'upcoming' || d.state === 'due_today' ? relativeMoment(d.at, c.property.tz, now, !d.time) : ''}</small></td>
                  <td><OwnerTag owner={d.owner ?? null} /></td>
                  <td><span className={`cdx-dl-state is-${d.state}`}>{titleCase(d.state)}</span></td>
                  <td>{d.calendar ? <button type="button" className="cdx-icon" aria-label={`Open ${d.label} in Calendar`} onClick={(e) => { e.stopPropagation(); go(links.calendarEvent(d.calendar!.eventId, d.calendar!.date)) }}><Icon name="calendar" /></button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="cdx-muted">No deadlines on record.</p>}
      </Block>
      {history.length ? (
        <Block title="Superseded" aside="Kept by the audit trail">
          <ul className="cdx-mini">{history.map((d) => <li key={d.key} className="is-superseded"><button type="button" onClick={() => onInspect({ kind: 'deadline', deadline: d })}><b>{d.label}</b><span>{whenLabel(d).main}</span><em>{d.reason || 'Superseded'}</em></button></li>)}</ul>
        </Block>
      ) : null}
    </div>
  )
}

function TimelineSection({ c, compact = false }: { c: Closing; compact?: boolean }) {
  const ev = c.timeline
  if (!ev.length) return <p className="cdx-muted">No dated events yet.</p>
  return (
    <ol className={`cdx-spine${compact ? ' is-compact' : ''}`} aria-label="How this deal got here">
      {ev.map((e, i) => (
        <li key={`${e.at}-${i}`} className={`is-${e.kind || (e.planned ? 'planned' : 'event')}`}>
          <i aria-hidden />
          <time>{weekdayDate(e.at.slice(0, 10))}{e.planned ? '' : ` · ${new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: c.property.tz || undefined })}`}</time>
          <b>{e.label}</b>
          <small>{e.planned ? 'Planned' : e.source}</small>
        </li>
      ))}
    </ol>
  )
}

function ActivitySection({ c, room, demo, onMore, loadingMore }: { c: Closing; room: Room; demo: boolean; onMore: () => void; loadingMore: boolean }) {
  if (!room.activity.length) return <p className="cdx-muted">No operational activity recorded.</p>
  return (
    <>
      <ul className="cdx-activity">
        {room.activity.map((a: ActivityItem) => {
          const d = a.detail || {}
          const tail = typeof d.status === 'string' ? titleCase(d.status) : typeof d.after === 'string' ? titleCase(d.after) : typeof d.action === 'string' ? `${titleCase(d.action)}${d.sequence ? ` #${d.sequence}` : ''}${typeof d.reason === 'string' ? ` · ${reasonWord(d.reason)}` : ''}` : typeof d.reason === 'string' ? d.reason : null
          return (
            <li key={a.id}>
              <b>{ACTIVITY_LABEL[a.type] ?? titleCase(a.type)}{tail ? <span> · {tail}</span> : null}</b>
              <small>{stamp(a.at, c.property.tz)}{a.actor ? ` · ${a.actor}` : ''}{a.source ? ` · ${titleCase(a.source)}` : ''}</small>
            </li>
          )
        })}
      </ul>
      {room.activityMore && !demo ? <button type="button" className="cdx-btn" disabled={loadingMore} onClick={onMore}>{loadingMore ? 'Loading…' : 'Older activity'}</button> : null}
    </>
  )
}

function AutomationSection({ c, now, onInspect }: { c: Closing; now: number; onInspect: (s: Subject) => void }) {
  const a = c.automation
  const rt = a?.runtime
  const pause = formFor(c, 'resume_automation')
  const loops = a?.loops ?? []
  return (
    <div className="cdx-grid">
      <Block title="Closing automation" aside={a?.paused ? 'Paused' : a?.held ? 'Held' : 'Running'} className="is-wide is-workflow">
        <Spec className="cdx-runtime" parts={[
          rt ? <><i className={`cdx-dot ${rt.automationEnabled ? 'is-good' : 'is-bad'}`} />Automation {rt.automationEnabled ? 'on' : 'off'}</> : null,
          rt?.heartbeatAt ? <><i className={`cdx-dot ${rt.heartbeatStale ? 'is-bad' : 'is-good'}`} />Worker checked in {relativeMoment(rt.heartbeatAt, c.property.tz, now)}</> : null,
          rt ? <><i className={`cdx-dot ${rt.emailSendEnabled ? 'is-good' : 'is-warn'}`} />Email sending {rt.emailSendEnabled ? 'on' : 'off'}</> : null,
        ]} />
        {a?.paused ? <p className="cdx-note is-warn"><Icon name="pause" />Paused {a.pausedAt ? stamp(a.pausedAt, c.property.tz) : ''}{a.pausedBy ? ` by ${a.pausedBy}` : ''}{a.pausedReason ? ` — ${a.pausedReason}` : ''}</p> : null}
        {a?.handling ? <p className="cdx-note is-system"><Icon name="refresh-cw" /><span><b>System handling · {a.handling.label}{a.handling.sequence ? ` #${a.handling.sequence}` : ''}</b> · {relativeMoment(a.handling.at, c.property.tz, now)}{a.handling.why ? ` · Why: ${a.handling.why.toLowerCase()}` : ''}</span></p> : null}
        <div className="cdx-row-acts">
          <button type="button" className="cdx-btn" onClick={() => go(links.workflow())}><Icon name="layers" />View workflow</button>
          <button type="button" className="cdx-btn" onClick={() => go(links.workflowRun(c.id))}><Icon name="activity" />View run</button>
          {pause && !c.closed && !c.terminal ? <button type="button" className={`cdx-btn${a?.paused ? ' is-primary' : ''}`} onClick={() => onInspect({ kind: 'form', spec: pause })}>{a?.paused ? <><Icon name="play" />Resume automation</> : <><Icon name="pause" />Take over — pause automation</>}</button> : null}
        </div>
      </Block>
      <Block title="Follow-up loops" aside={`${loops.length}`}>
        {loops.length ? (
          <ul className="cdx-loops">
            {loops.map((l) => (
              <li key={l.category} className={`is-${l.state}`}>
                <button type="button" onClick={() => onInspect({ kind: 'loop', loop: l })}>
                  <b>{l.label}</b>
                  <span>{loopStateWord(l.state)}{l.next && l.state !== 'satisfied' ? ` · #${l.next.sequence} ${relativeMoment(l.next.at, c.property.tz, now)}` : ''}{l.escalateAt ? ` · escalates ${relativeMoment(l.escalateAt, c.property.tz, now)}` : ''}</span>
                  <em>{l.max ? `${l.done}/${l.max}` : l.done ? 'Sent' : ''}</em>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="cdx-muted">{a?.state === 'awaiting_contract' ? 'Automation starts once the seller contract is fully executed.' : 'No follow-up loops active.'}</p>}
      </Block>
      <Block title="Email requests" aside={a?.pendingEmails ? `${a.pendingEmails} queued` : 'Via Email Command'}>
        {(a?.emails ?? []).length ? (
          <ul className="cdx-reqlog">
            {(a?.emails ?? []).map((e) => (
              <li key={e.id || `${e.category}:${e.sequence}`} className={`is-${e.status}`}>
                <b>{e.label || titleCase(e.action)}{e.sequence ? ` #${e.sequence}` : ''} · {titleCase(e.status)}</b>
                <small>{e.sentAt ? `Sent ${stamp(e.sentAt, c.property.tz)}` : e.requestedAt ? `Requested ${stamp(e.requestedAt, c.property.tz)}` : ''}{e.reason ? ` · ${reasonWord(e.reason)}` : ''}</small>
              </li>
            ))}
          </ul>
        ) : <p className="cdx-muted">Nothing requested yet. Closing automation never sends email itself — it asks Email Command.</p>}
      </Block>
      <Block title="Escalations & interventions">
        {(a?.escalations ?? []).length || (a?.interventions ?? []).length ? (
          <ul className="cdx-reqlog">
            {(a?.escalations ?? []).map((e) => <li key={`esc:${e.category}`} className={e.active ? 'is-failed' : 'is-sent'}><b>{e.message || titleCase(e.category)}</b><small>{e.active ? 'Needs you' : 'Resolved'}{e.at ? ` · ${stamp(e.at, c.property.tz)}` : ''}</small></li>)}
            {(a?.interventions ?? []).map((i, n) => <li key={`int:${n}`}><b>{titleCase(i.type)}</b><small>{i.actor || 'operator'}{i.at ? ` · ${stamp(i.at, c.property.tz)}` : ''}{i.reason ? ` · ${i.reason}` : ''}</small></li>)}
          </ul>
        ) : <p className="cdx-muted">No escalations; no human interventions recorded.</p>}
      </Block>
    </div>
  )
}

function PropertySection({ c }: { c: Closing }) {
  const acts: Array<[string, IconName, string | null, boolean]> = [
    ['Property', 'home', c.propertyId ? `/entity-graph/property/${encodeURIComponent(c.propertyId)}` : null, false],
    ['Deal', 'brain', c.propertyId ? `/deal-intelligence?property_id=${encodeURIComponent(c.propertyId)}${c.threadKey ? `&thread_key=${encodeURIComponent(c.threadKey)}` : ''}` : null, true],
    ['Graph', 'database', c.masterOwnerId ? `/entity-graph/owner/${encodeURIComponent(c.masterOwnerId)}` : null, false],
    ['Map', 'map', c.propertyId ? '/map' : null, true],
    ['Pipeline', 'layers', c.opportunityId ? links.pipeline(c.opportunityId) : null, false],
    ['Conversation', 'message', c.threadKey ? `/inbox?thread=${encodeURIComponent(c.threadKey)}` : null, false],
  ]
  return (
    <div className="cdx-grid">
      <Block title="Property" className="is-wide">
        <dl className="cdx-facts is-two">
          <Fact k="Address" v={c.property.address} />
          <Fact k="Market" v={c.market} />
          <Fact k="Time zone" v={c.property.tz ? `${c.property.tz}${c.property.tzConfident ? '' : ' (uncertain)'}` : 'Unknown'} />
          <Fact k="Address source" v={c.property.addressSource === 'property' ? 'Canonical property record' : c.property.addressSource === 'closing_case' ? 'Closing case' : null} />
          <Fact k="Property ID" v={c.propertyId} mono />
          <Fact k="Closing ID" v={c.id} mono />
          <Fact k="Opportunity" v={c.opportunityId} mono />
        </dl>
        <div className="cdx-row-acts">{acts.filter(([, , p]) => p).map(([label, icon, path, locate]) => <button key={label} type="button" className="cdx-btn" onClick={() => go(path!, locate ? c : null)}><Icon name={icon} />{label}</button>)}</div>
      </Block>
    </div>
  )
}

/** Authority forms for a group (Buyer / EMD / Title …) — one server write each. */
function RecordList({ c, groups, onInspect }: { c: Closing; groups: string[]; onInspect: (s: Subject) => void }) {
  if (c.closed || c.terminal) return null
  const specs = availableFor(c).filter((s) => groups.includes(s.group))
  if (!specs.length) return null
  return (
    <Block title="Record">
      <ul className="cdx-records">{specs.map((s) => <li key={s.action + JSON.stringify(s.fixed ?? {})}><button type="button" onClick={() => onInspect({ kind: 'form', spec: s })}><span>{s.label}</span><Icon name="chevron-right" /></button></li>)}</ul>
    </Block>
  )
}
