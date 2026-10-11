import { Icon } from '../../../../shared/icons'
import { cx, LCTooltip } from '../../../../shared/lc'
import { CONTACT_SCORE_DEFINITION } from '../../../../domain/deal-intelligence/contact-score'
import { dateTime, humanize, phone as fmtPhone, usd } from '../di-format'
import type { DiLinks } from '../di-links'
import { sellerIdentity } from '../di-model'
import { sellerIdentityFacts } from '../di-evidence'
import type { DiDecision, DiSelection } from '../di-types'
import { Basis, Cards, Meter, Plane, SectionHead } from '../di-ui'
import { CommunicationCard, SellerFactsCard } from './EvidenceMode'
import { OwnershipSnapshot } from './RecordMode'

/**
 * SELLER — who the seller is and how reachable, what they said, and the
 * people linked to the owner. Age and language are DISPLAY-ONLY identity
 * facts (vendor person record): age is a protected characteristic and is
 * never read by pricing, ranking or offers.
 */
export function SellerMode({ d, selection, onSelect, links, now }: { d: DiDecision; selection: DiSelection | null; onSelect: (s: DiSelection) => void; links: DiLinks | null; now: number }) {
  const who = sellerIdentity(d)
  const facts = sellerIdentityFacts(d)
  const contact = d.contact
  const primary = d.record.prospects.find((p) => p.primary) ?? d.record.prospects[0] ?? null
  const rawScore = primary?.fields.find((f) => f.label === 'Contact score')?.value ?? null
  const asks = d.history.filter((h) => h.kind === 'ask')
  return (
    <div className="dr-mode dr-section">
      <SectionHead title="Seller" summary="Identity and reachability from the owner and person records, what the seller has said, and the conversation’s signal." bases={['recorded', 'seller', 'estimated', 'inferred']} />
      <Cards>
        <Plane id="seller-who" eyebrow="Who" title={who.name} depth={1} aside={<Basis b="recorded" />}>
          <dl className="dr-kv">
            <div><dt>Role</dt><dd>{who.roleLabel}</dd></div>
            <div><dt>Owner of record</dt><dd>{who.recordOwner ?? <span className="dr-none">Not recorded</span>}{who.namesMatch === true ? <span className="dr-match is-yes"><Icon name="check" size={10} />names match</span> : who.namesMatch === false ? <span className="dr-match is-no">names differ</span> : null}</dd></div>
            <div><dt>Holder</dt><dd>{[who.entity.corporate && 'Corporate owner', who.entity.trust && 'Trust', who.entity.bank && 'Bank-owned'].filter(Boolean).join(' · ') || 'Individual (no entity flag on record)'}</dd></div>
            <div>
              <dt>Age</dt>
              <dd>{facts.age !== null ? <LCTooltip content="From the birth month on the vendor person record. Display only — age is never a pricing, ranking or offer input."><span className="lc-num">{facts.age}</span></LCTooltip> : <span className="dr-none">Not on record</span>}</dd>
            </div>
            <div><dt>Language</dt><dd>{facts.language ?? <span className="dr-none">Unknown</span>}</dd></div>
          </dl>
        </Plane>

        <Plane id="seller-reach" eyebrow="Reachability" title={contact?.suppressed ? 'Suppressed — automation cannot message' : contact?.contactability ? humanize(contact.contactability) ?? 'Contactability recorded' : 'Contactability not recorded'} depth={1}
          under={contact?.suppressed ? 'crit' : null} aside={<Basis b="estimated" />}>
          <div className="dr-reach">
            <LCTooltip content={`${CONTACT_SCORE_DEFINITION}${rawScore ? ` On record: ${rawScore}.` : ' Not scored.'}`}>
              <div className="dr-reach__score" tabIndex={0}>
                <span>Contact score</span>
                <b className="lc-num">{facts.contactScore ?? '—'}<small>/100</small></b>
                <Meter value={facts.contactScore} label="Contact score, 0–100" tone="exec" />
                <em>skip-trace vendor · rescaled from 0–120</em>
              </div>
            </LCTooltip>
            <dl className="dr-kv">
              <div><dt>Phone</dt><dd>{contact?.phone ? fmtPhone(contact.phone) : <span className="dr-none">None on the conversation</span>}</dd></div>
              <div><dt>Temperature</dt><dd>{contact?.temperature ? humanize(contact.temperature) : <span className="dr-none">—</span>}</dd></div>
              <div><dt>Messages</dt><dd className="lc-num">{contact?.messageCount ?? 0}</dd></div>
            </dl>
          </div>
        </Plane>

        <Plane id="seller-asks" eyebrow="Asking price & offers" title={asks.length ? `${usd(asks[asks.length - 1].amount) ?? '—'} latest ask` : 'No price named yet'} depth={1} aside={<Basis b="seller" />}>
          {asks.length ? (
            <ol className="dr-asklist">
              {[...asks].reverse().slice(0, 4).map((h, i) => <li key={`${h.at}-${i}`}><b className="lc-num">{usd(h.amount) ?? '—'}</b><span>{h.title}</span><em>{dateTime(h.at)}</em></li>)}
            </ol>
          ) : <p className="dr-none">The seller has not named a price.</p>}
          {d.offer?.offers.length ? (
            <ol className="dr-asklist is-offers">
              {d.offer.offers.slice(0, 3).map((o) => <li key={o.id}><b className="lc-num">{usd(o.price) ?? '—'}</b><span>{o.direction === 'inbound' ? 'Seller counter' : 'Our offer'} · {humanize(o.status) ?? '—'}</span><em>{dateTime(o.sentAt) ?? ''}</em></li>)}
            </ol>
          ) : null}
        </Plane>

        {d.conversation ? <CommunicationCard d={d} now={now} /> : null}

        <SellerFactsCard d={d} selection={selection} onSelect={onSelect} now={now} />

        {d.record.prospects.length ? (
          <Plane id="seller-people" eyebrow="People linked to the owner" title={`${d.record.prospects.length} ${d.record.prospects.length === 1 ? 'person' : 'people'}`} depth={1} className="is-wide" aside={<Basis b="recorded" />}>
            <ul className="dr-people is-grid">
              {d.record.prospects.map((p) => (
                <li key={p.id}>
                  <details className="dr-details">
                    <summary>
                      <span className="dr-person__mark">{p.name.slice(0, 1)}</span>{p.name}{p.primary ? <em>primary</em> : null}
                      <span className="dr-person__facts lc-num">{[typeof p.age === 'number' ? `age ${p.age}` : null, p.language, typeof p.contactScore === 'number' ? `contact ${p.contactScore}/100` : null].filter(Boolean).join(' · ')}</span>
                    </summary>
                    <dl className="dr-fieldgrid is-compact">
                      {p.fields.map((f) => <div key={f.label} className={cx('dr-field is-static')}><dt className="dr-field__k">{f.label}</dt><dd className="dr-field__v">{f.value}</dd></div>)}
                    </dl>
                  </details>
                </li>
              ))}
            </ul>
            <p className="dr-quiet">Separate records from separate providers — nothing here asserts that these people are the owner of record. Demographics are shown as recorded and never used to price.</p>
          </Plane>
        ) : null}

        <Plane id="seller-graph" eyebrow="Ownership" title="Owner → property → companies & people" depth={1} className="is-wide" aside={<Basis b="recorded" />}>
          <OwnershipSnapshot d={d} onOpenGraph={links?.graph ?? null} />
        </Plane>
      </Cards>
    </div>
  )
}
