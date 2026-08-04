import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import { formatPhone } from '../../../shared/formatters'
import {
  classifyOwnerName,
  deriveOwnerMatchFlags,
  formatParticipantRelationship,
  isEntityRelationship,
  ownerMatchFlagTone,
  resolveOwnershipVerification,
  selectOwnerCandidates,
  sortParticipantsByOwnerPriority,
  type OwnershipVerification,
  type PropertyParticipant,
} from '../utils/participantLabels'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

type Props = {
  participants: PropertyParticipant[]
  selectedParticipant: PropertyParticipant | null
  prospectName?: string | null
  /** Owner-of-record name from the thread row — the multi-party / entity source. */
  ownerRecordName?: string | null
  loading?: boolean
  onSelectParticipant: (participant: PropertyParticipant) => void
  onTryNextEligible?: (participant: PropertyParticipant) => void
  nextEligiblePreview?: PropertyParticipant | null
}

/**
 * RC-7. The badge never says "verified" unless `resolveOwnershipVerification`
 * found a source. The evidence sentence is rendered next to it, always — a
 * badge on its own is an assertion the operator cannot audit.
 */
const VerificationBadge = ({ verification }: { verification: OwnershipVerification }) => (
  <span
    className={cls('nx-idv-verify', `is-${verification.level}`)}
    data-ownership-level={verification.level}
  >
    <Icon name={verification.icon as IconName} />
    <span className="nx-idv-verify__label">{verification.label}</span>
    {verification.confidence != null ? (
      <span className="nx-idv-verify__confidence">{Math.round(verification.confidence * 100)}%</span>
    ) : null}
  </span>
)

const RECORD_ICON: Record<string, IconName> = {
  entity: 'briefcase',
  multiple: 'users',
  person: 'user',
}

const ActiveProspectCardComponent = ({
  participants,
  selectedParticipant,
  prospectName = null,
  ownerRecordName = null,
  loading = false,
  onSelectParticipant,
  onTryNextEligible,
  nextEligiblePreview = null,
}: Props) => {
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // RC-8: owner-priority order replaces the positional `participants[0]`.
  const ordered = useMemo(() => sortParticipantsByOwnerPriority(participants), [participants])
  const selected = selectedParticipant || ordered[0] || null

  const verification = useMemo(() => resolveOwnershipVerification(selected), [selected])

  const matchFlags = useMemo(
    () => (selected?.owner_match_flags?.length
      ? selected.owner_match_flags
      : deriveOwnerMatchFlags(selected || {})),
    [selected],
  )

  // The owner-of-record string is the evidence for entity / multi-party status.
  const recordIdentity = useMemo(
    () => classifyOwnerName(ownerRecordName || selected?.display_name || prospectName),
    [ownerRecordName, selected?.display_name, prospectName],
  )

  const ownerCandidates = useMemo(() => selectOwnerCandidates(ordered), [ordered])

  useEffect(() => {
    if (!switcherOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setSwitcherOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSwitcherOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [switcherOpen])

  // RC-4b / §8: a loading skeleton that mirrors the resolved geometry, never a
  // permanent "Loading…" string.
  if (loading && !selected) {
    return (
      <section className="nx-idv" aria-label="Active contact" aria-busy="true">
        <div className="nx-idv__card">
          <span className="nx-idv__eyebrow">Active contact</span>
          <div className="nx-idv__skeleton nx-idv__skeleton--name" />
          <div className="nx-idv__skeleton nx-idv__skeleton--line" />
          <div className="nx-idv__skeleton nx-idv__skeleton--line is-short" />
        </div>
      </section>
    )
  }

  if (!ordered.length) {
    if (!selected) return null
  }

  const phone = String(selected?.canonical_e164 ?? '').trim()
  const canonicalName = selected?.display_name?.trim() || ''
  const threadName = selected?.thread_display_name?.trim() || ''
  const headlineName = canonicalName || prospectName || formatPhone(phone) || 'Contact not identified'
  const relationship = formatParticipantRelationship(
    selected?.relationship_to_property || selected?.identity_class,
  )
  const entityRelationship = isEntityRelationship(
    selected?.relationship_to_property || selected?.identity_class,
  )
  const showRecordBlock = recordIdentity.kind !== 'person' || entityRelationship
  const contactCount = ordered.length

  return (
    <section className="nx-idv" ref={rootRef} aria-label="Active contact">
      <div className="nx-idv__card">
        <div className="nx-idv__head">
          <div className="nx-idv__identity">
            <span className="nx-idv__eyebrow">Active contact</span>
            <h3 className="nx-idv__name">
              <Icon name={RECORD_ICON[recordIdentity.kind] || 'user'} />
              <span>{headlineName}</span>
            </h3>
            <div className="nx-idv__sub">
              {phone ? <span className="nx-idv__phone">{formatPhone(phone)}</span> : null}
              <span className="nx-idv__rel">{relationship}</span>
              {selected?.contact_rank_label ? (
                <span className="nx-idv__rank">{selected.contact_rank_label}</span>
              ) : null}
            </div>
          </div>

          <button
            type="button"
            className={cls('nx-idv__switch', switcherOpen && 'is-open')}
            aria-haspopup="listbox"
            aria-expanded={switcherOpen}
            onClick={() => setSwitcherOpen((value) => !value)}
            disabled={contactCount <= 1}
            title={contactCount <= 1 ? 'Only one contact on this property' : 'Switch contact'}
          >
            <span>
              {contactCount} {contactCount === 1 ? 'contact' : 'contacts'}
            </span>
            <Icon name="chevron-down" />
          </button>
        </div>

        {/* RC-7 — verification badge and its evidence are inseparable. */}
        <div className={cls('nx-idv__verify-row', verification.claimDowngraded && 'is-downgraded')}>
          <VerificationBadge verification={verification} />
          <p className="nx-idv__evidence">{verification.detail}</p>
        </div>

        {matchFlags.length ? (
          <div className="nx-idv__flags">
            {matchFlags.map((flag) => (
              <span
                key={flag.key}
                className={cls('nx-idv__flag', `is-${ownerMatchFlagTone(flag.key)}`)}
              >
                {flag.label}
              </span>
            ))}
          </div>
        ) : null}

        {/* RC-8 — an entity or a multi-party owner record is disclosed here, in
            the open, with the token from the record that proves it. */}
        {showRecordBlock ? (
          <div className={cls('nx-idv__record', `is-${recordIdentity.kind}`)}>
            <div className="nx-idv__record-head">
              <Icon name={RECORD_ICON[recordIdentity.kind] || 'user'} />
              <span className="nx-idv__record-type">
                {recordIdentity.kind === 'entity' ? `Entity — ${recordIdentity.typeLabel}` : recordIdentity.typeLabel}
              </span>
            </div>
            {recordIdentity.kind === 'multiple' ? (
              <ul className="nx-idv__parties">
                {recordIdentity.parties.map((party) => (
                  <li key={party} className="nx-idv__party">{party}</li>
                ))}
              </ul>
            ) : null}
            <p className="nx-idv__record-evidence">{recordIdentity.evidence}</p>
            {recordIdentity.kind === 'entity' ? (
              <p className="nx-idv__record-note">
                Whoever replies is speaking for the entity. Signing authority is not on record.
              </p>
            ) : null}
            {recordIdentity.kind === 'multiple' ? (
              <p className="nx-idv__record-note">
                An offer may need every named party. Only the contact above has replied.
              </p>
            ) : null}
          </div>
        ) : null}

        {threadName && canonicalName && threadName !== canonicalName ? (
          <p className="nx-idv__conflict">
            Inbox row labels this thread “{threadName}”. Contact record says “{canonicalName}”.
          </p>
        ) : null}

        {ownerCandidates.length > 1 ? (
          <div className="nx-idv__owners">
            <span className="nx-idv__owners-label">
              {ownerCandidates.length} contacts carry owner-level evidence
            </span>
            <ul className="nx-idv__owners-list">
              {ownerCandidates.map((candidate) => (
                <li key={candidate.participant_id || candidate.canonical_e164 || candidate.display_name}>
                  <button
                    type="button"
                    className={cls(
                      'nx-idv__owner-chip',
                      candidate.participant_id === selected?.participant_id && 'is-active',
                    )}
                    onClick={() => onSelectParticipant(candidate)}
                  >
                    {candidate.display_name || formatPhone(String(candidate.canonical_e164 ?? '')) || 'Unnamed contact'}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {selected?.is_client_derived ? (
          <p className="nx-idv__derived">
            No contact graph returned for this property. Details below come from the inbox row only.
          </p>
        ) : null}

        {nextEligiblePreview && onTryNextEligible ? (
          <div className="nx-idv__next">
            <button
              type="button"
              className="nx-idv__next-btn"
              onClick={() => onTryNextEligible(nextEligiblePreview)}
            >
              Switch to next eligible contact
            </button>
            <span className="nx-idv__next-name">
              {nextEligiblePreview.display_name
                || formatPhone(String(nextEligiblePreview.canonical_e164 ?? ''))
                || 'Next contact'}
            </span>
          </div>
        ) : null}
      </div>

      {switcherOpen ? (
        <ul className="nx-idv__menu" role="listbox" aria-label="Contacts on this property">
          {ordered.map((participant) => {
            const participantPhone = String(participant.canonical_e164 ?? '').trim()
            const isSelected = Boolean(phone && participantPhone === phone)
            const name = participant.display_name
              || formatPhone(participantPhone)
              || 'Unnamed contact'
            const participantVerification = resolveOwnershipVerification(participant)
            return (
              <li key={participant.participant_id || participantPhone} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={cls(
                    'nx-idv__option',
                    isSelected && 'is-selected',
                    participant.excluded_as_renter && 'is-excluded',
                    participant.safe_to_contact === false && 'is-unsafe',
                  )}
                  onClick={() => {
                    onSelectParticipant(participant)
                    setSwitcherOpen(false)
                  }}
                >
                  <span className="nx-idv__option-head">
                    <span className="nx-idv__option-name">{name}</span>
                    {isSelected ? <span className="nx-idv__option-active">Active</span> : null}
                  </span>
                  <span className="nx-idv__option-meta">
                    {participantPhone ? formatPhone(participantPhone) : 'No phone on file'}
                    <span className="nx-idv__dot">·</span>
                    {formatParticipantRelationship(
                      participant.relationship_to_property || participant.identity_class,
                    )}
                  </span>
                  <span className="nx-idv__option-sub">
                    <VerificationBadge verification={participantVerification} />
                    <span className={cls(
                      'nx-idv__option-pill',
                      participant.sms_eligible === false && 'is-blocked',
                    )}>
                      {participant.sms_eligible === false ? 'SMS blocked' : 'SMS allowed'}
                    </span>
                    {participant.excluded_as_renter ? (
                      <span className="nx-idv__option-pill is-blocked">Renter — excluded</span>
                    ) : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}

export const ActiveProspectCard = memo(ActiveProspectCardComponent)
ActiveProspectCard.displayName = 'ActiveProspectCard'
