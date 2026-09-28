/**
 * RECORD LAYER — every populated field on the property, its owner, its people
 * and its recorded debt. Nothing here is derived or scored by this screen; it
 * is the record as the data providers hold it, grouped for reading.
 */
import { useState } from 'react'
import { Icon } from '../../../../shared/icons'
import type { IconName } from '../../../../shared/icons'
import type { DealDecision, RecordSection } from '../../../../domain/deal-intelligence/deal-decision-api'
import { cls, DdCard } from './dd-primitives'
import { DebtAndLiens } from './EvidenceLayer'

const SECTION_ICON: Record<string, IconName> = {
  Structure: 'home',
  'Lot & location': 'map',
  'Value & equity': 'trending-up',
  'Debt & liens': 'dollar-sign',
  Tax: 'file-text',
  Ownership: 'key',
  'Distress & market': 'alert',
  'Other recorded fields': 'database',
  Owner: 'user',
  Portfolio: 'layers',
  Reachability: 'phone',
}

function FieldGrid({ fields }: { fields: RecordSection['fields'] }) {
  return (
    <dl className="ddx-grid">
      {fields.map((f) => (
        <div key={`${f.label}-${f.value}`} className={cls(f.value.length > 26 && 'is-wide')}>
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Sections({ sections, openFirst = 2 }: { sections: RecordSection[]; openFirst?: number }) {
  return (
    <>
      {sections.map((s, i) => (
        <DdCard key={s.title} id={`rec-${s.title}`} title={s.title} icon={SECTION_ICON[s.title] ?? 'database'} meta={`${s.fields.length} fields`} defaultOpen={i < openFirst}>
          <FieldGrid fields={s.fields} />
        </DdCard>
      ))}
    </>
  )
}

export function OwnerAndPeople({ d }: { d: DealDecision }) {
  const [open, setOpen] = useState<string | null>(d.record.prospects[0]?.id ?? null)
  const owner = d.record.owner
  if (!owner && !d.record.prospects.length) return null
  return (
    <DdCard id="people" title="Owner & people" icon="users" meta={[owner?.name, d.record.prospects.length ? `${d.record.prospects.length} ${d.record.prospects.length === 1 ? 'person' : 'people'}` : null].filter(Boolean).join(' · ')}>
      {owner ? (
        <div className="ddx-owner">
          <div className="ddx-owner__mark">{(owner.name ?? '?').slice(0, 1)}</div>
          <div className="ddx-owner__id">
            <b>{owner.name ?? 'Owner'}</b>
            <span>Owner entity · portfolio grouping</span>
          </div>
        </div>
      ) : null}
      {owner?.sections.map((s) => (
        <div key={s.title} className="ddx-subsection">
          <span className="ddx-sub">{s.title}</span>
          <FieldGrid fields={s.fields} />
        </div>
      ))}
      {d.record.prospects.length ? <span className="ddx-sub">People linked to this owner</span> : null}
      <ul className="ddx-people">
        {d.record.prospects.map((p) => (
          <li key={p.id} className={cls('ddx-person', open === p.id && 'is-open')}>
            <button type="button" onClick={() => setOpen((o) => (o === p.id ? null : p.id))} aria-expanded={open === p.id}>
              <span className="ddx-person__mark">{p.name.slice(0, 1)}</span>
              <span className="ddx-person__name">{p.name}{p.primary ? <em>primary</em> : null}</span>
              <Icon name="chevron-down" />
            </button>
            {open === p.id ? <FieldGrid fields={p.fields} /> : null}
          </li>
        ))}
      </ul>
      <p className="ddx-note">Separate records from separate providers — nothing here asserts that these people are the same person as the owner of record.</p>
    </DdCard>
  )
}

export function RecordLayer({ d }: { d: DealDecision }) {
  return (
    <>
      <OwnerAndPeople d={d} />
      <DebtAndLiens d={d} />
      <Sections sections={d.record.sections} />
      {!d.record.sections.length ? <p className="ddx-empty">No parcel record is linked to this property.</p> : null}
    </>
  )
}
