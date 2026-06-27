import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { formatPhone } from '../../../shared/formatters'
import { formatParticipantRelationship, type PropertyParticipant } from '../utils/participantLabels'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const OWNER_RELATIONSHIPS = new Set([
  'master_owner',
  'probable_owner',
  'confirmed_owner',
  'primary_owner',
])

const isOwnerParticipant = (participant: PropertyParticipant) =>
  Boolean(participant.is_primary_owner_record)
  || OWNER_RELATIONSHIPS.has(String(participant.relationship_to_property ?? '').trim())

type Props = {
  participants: PropertyParticipant[]
  selectedPhone?: string | null
  loading?: boolean
  onSelectParticipant: (participant: PropertyParticipant) => void
}

const PropertyParticipantRailComponent = ({
  participants,
  selectedPhone = null,
  loading = false,
  onSelectParticipant,
}: Props) => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const normalizedSelected = String(selectedPhone ?? '').trim()

  const prospectParticipants = useMemo(
    () => participants.filter((row) => !isOwnerParticipant(row)),
    [participants],
  )

  const switcherList = prospectParticipants.length > 0 ? prospectParticipants : participants

  const selectedParticipant = useMemo(() => {
    if (!normalizedSelected) return switcherList[0] ?? null
    return participants.find((row) => String(row.canonical_e164 ?? '').trim() === normalizedSelected)
      ?? switcherList[0]
      ?? null
  }, [normalizedSelected, participants, switcherList])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!switcherList.length && !loading) return null

  const countLabel = switcherList.length === 1 ? '1 prospect' : `${switcherList.length} prospects`

  return (
    <div className="nx-prospect-switcher" ref={rootRef} role="region" aria-label="Prospect threads">
      <div className="nx-prospect-switcher__dropdown">
        <button
          type="button"
          className={cls('nx-prospect-switcher__trigger', open && 'is-open', loading && 'is-loading')}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="nx-prospect-switcher__trigger-icon" aria-hidden>
            <Icon name="users" />
          </span>
          <span className="nx-prospect-switcher__trigger-body">
            <span className="nx-prospect-switcher__trigger-label">Active prospect</span>
            <span className="nx-prospect-switcher__trigger-name">
              {loading && !selectedParticipant
                ? 'Loading…'
                : (selectedParticipant?.display_name || 'Select prospect')}
            </span>
            {selectedParticipant?.canonical_e164 ? (
              <span className="nx-prospect-switcher__trigger-phone">
                {formatPhone(selectedParticipant.canonical_e164)}
              </span>
            ) : null}
          </span>
          <span className="nx-prospect-switcher__trigger-meta">
            <span className="nx-prospect-switcher__count">{countLabel}</span>
            <Icon name="chevron-down" />
          </span>
        </button>

        {open ? (
          <ul className="nx-prospect-switcher__menu" role="listbox">
            {switcherList.map((participant) => {
              const phone = String(participant.canonical_e164 ?? '').trim()
              const selected = Boolean(normalizedSelected && phone === normalizedSelected)
              const name = participant.display_name || formatPhone(phone) || 'Unknown contact'
              const relationship = formatParticipantRelationship(
                participant.relationship_to_property || participant.identity_class,
              )
              return (
                <li key={participant.participant_id || phone} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={cls(
                      'nx-prospect-switcher__option',
                      selected && 'is-selected',
                      participant.is_referred_contact && 'is-referred',
                      participant.safe_to_contact === false && 'is-unsafe',
                    )}
                    onClick={() => {
                      onSelectParticipant(participant)
                      setOpen(false)
                    }}
                  >
                    <span className="nx-prospect-switcher__option-head">
                      <span className="nx-prospect-switcher__option-name">{name}</span>
                      {selected ? <span className="nx-prospect-switcher__option-active">Active</span> : null}
                    </span>
                    <span className="nx-prospect-switcher__option-meta">
                      {phone ? formatPhone(phone) : 'No phone'}
                      <span className="nx-prospect-switcher__dot">•</span>
                      {relationship}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

export const PropertyParticipantRail = memo(PropertyParticipantRailComponent)
PropertyParticipantRail.displayName = 'PropertyParticipantRail'