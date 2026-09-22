import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import { formatPhone } from '../../../shared/formatters'
import {
  formatParticipantRelationship,
  hasSellerAuthorityEvidence,
  resolveOwnershipPresentation,
  type OwnershipPresentation,
  type PropertyParticipant,
} from '../utils/participantLabels'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')
type Props = {
  participants: PropertyParticipant[]
  selectedParticipant: PropertyParticipant | null
  prospectName?: string | null
  loading?: boolean
  onSelectParticipant: (participant: PropertyParticipant) => void
  onTryNextEligible?: (participant: PropertyParticipant) => void
  nextEligiblePreview?: PropertyParticipant | null
  /** Canonical thread facts, used only to tell "unverified" from "already negotiating". */
  thread?: Record<string, unknown> | null
  /**
   * Collapses the card to an identity strip while the operator is typing, so the
   * keyboard does not leave the conversation with a sliver of room. Nothing is
   * lost -- the full card returns when the keyboard closes.
   */
  compact?: boolean
}
const OWNERSHIP_TONE_ICON = {
  confirmed: 'check',
  inferred: 'alert-circle',
  denied: 'x',
  behavioral: 'message',
  neutral: 'user',
} as const satisfies Record<OwnershipPresentation['tone'], IconName>
const OwnershipIndicator = ({
  status,
  sellerAuthority = false,
}: { status?: string | null; sellerAuthority?: boolean }) => {
  const { tone, label, title } = resolveOwnershipPresentation(status, sellerAuthority)
  return (
    <span className={`nx-active-prospect__ownership is-${tone}`} title={title}>
      <Icon name={OWNERSHIP_TONE_ICON[tone]} />
      <span>{label}</span>
    </span>
  )
}
const ActiveProspectCardComponent = ({
  participants,
  selectedParticipant,
  prospectName = null,
  loading = false,
  onSelectParticipant,
  onTryNextEligible,
  nextEligiblePreview = null,
  thread = null,
  compact = false,
}: Props) => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const selected = selectedParticipant || participants[0] || null
  const switcherList = useMemo(() => participants, [participants])
  // Both come straight from the canonical record: contact_rank_label is
  // phones.contact_rank_position rendered as #1/#2/#3, and the relationship is
  // the humanised form of the stored vocabulary -- never inferred here.
  const rankLabel = selected?.contact_rank_label
    || (selected?.contact_rank ? `#${selected.contact_rank}` : null)
  const relationshipLabel = selected
    ? formatParticipantRelationship(selected.relationship_to_property || selected.identity_class)
    : null
  const headlineName = selected?.display_name || prospectName || 'Select prospect'
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
  const phone = String(selected?.canonical_e164 ?? '').trim()
  /**
   * COMPOSING STATE: an identity strip, not half the remaining viewport.
   *
   * With the keyboard up on a 375pt phone the conversation has roughly 260pt to
   * work with, and the full Active Prospect card was taking most of it. Collapsed
   * it keeps the one thing the operator needs while typing -- who am I talking
   * to, and is ownership settled -- and the full card returns on blur. Rendered
   * from the same `selected` participant, so no context is lost or refetched.
   */
  if (compact) {
    return (
      <section className="nx-active-prospect is-compact" ref={rootRef} aria-label="Active prospect">
        <div className="nx-active-prospect__strip">
          <span className="nx-active-prospect__strip-name">
            {loading && !selected ? 'Loading…' : headlineName}
          </span>
          <OwnershipIndicator
            status={selected?.ownership_status}
            sellerAuthority={hasSellerAuthorityEvidence(thread, selected)}
          />
          {switcherList.length > 1 && (
            <span className="nx-active-prospect__strip-count">{switcherList.length} linked</span>
          )}
        </div>
      </section>
    )
  }
  return (
    <section className="nx-active-prospect" ref={rootRef} aria-label="Active prospect">
      <div className="nx-active-prospect__card is-selected">
        {/*
          §12 -- ONE CONTEXTUAL ROW, NOT A DOSSIER CARD.
          The eyebrow ("Active Prospect") and the standalone heading were
          spending two lines to say what the identity line already says, on the
          surface where the message history is supposed to dominate. What
          survives is the set an operator actually needs before typing: who,
          where they sit in the canonical order, how this system classifies
          their link to the property, whether ownership is settled, and the
          number we are about to text. Everything else is one tap away.
        */}
        <div className="nx-active-prospect__identity-line">
          <span className="nx-active-prospect__name">
            {loading && !selected ? 'Loading…' : headlineName}
          </span>
          {rankLabel ? (
            <>
              <span className="nx-active-prospect__dot">·</span>
              <span className="nx-active-prospect__rank">{rankLabel}</span>
            </>
          ) : null}
          {relationshipLabel ? (
            <>
              <span className="nx-active-prospect__dot">·</span>
              <span className="nx-active-prospect__relationship">{relationshipLabel}</span>
            </>
          ) : null}
        </div>
        <div className="nx-active-prospect__sub-line">
          {phone ? <span className="nx-active-prospect__phone">{formatPhone(phone)}</span> : null}
          <OwnershipIndicator
            status={selected?.ownership_status}
            sellerAuthority={hasSellerAuthorityEvidence(thread, selected)}
          />
          {switcherList.length > 1 ? (
            <button
              type="button"
              className={cls('nx-active-prospect__expand', open && 'is-open')}
              aria-haspopup="listbox"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              <span>{switcherList.length} linked</span>
              <Icon name="chevron-down" />
            </button>
          ) : null}
        </div>
        {nextEligiblePreview && onTryNextEligible ? (
          <div className="nx-active-prospect__next">
            <button
              type="button"
              className="nx-active-prospect__next-btn"
              onClick={() => onTryNextEligible(nextEligiblePreview)}
            >
              Try Next Eligible Contact
            </button>
            <span className="nx-active-prospect__next-preview">
              {nextEligiblePreview.display_name || 'Next contact'}
            </span>
          </div>
        ) : null}
      </div>
      {open ? (
        <ul className="nx-active-prospect__menu" role="listbox">
          {switcherList.map((participant) => {
            const participantPhone = String(participant.canonical_e164 ?? '').trim()
            const isSelected = Boolean(phone && participantPhone === phone)
            const name = participant.display_name || formatPhone(participantPhone) || 'Unknown contact'
            const participantRelationship = formatParticipantRelationship(
              participant.relationship_to_property || participant.identity_class,
            )
            const rankLabel = participant.contact_rank_label
              || (participant.contact_rank ? `#${participant.contact_rank}` : null)
            return (
              <li key={participant.participant_id || participantPhone} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={cls(
                    'nx-active-prospect__option',
                    isSelected && 'is-selected',
                    participant.excluded_as_renter && 'is-excluded',
                    participant.safe_to_contact === false && 'is-unsafe',
                  )}
                  onClick={() => {
                    onSelectParticipant(participant)
                    setOpen(false)
                  }}
                >
                  <span className="nx-active-prospect__option-head">
                    <span className="nx-active-prospect__option-name">{name}</span>
                    {isSelected ? <span className="nx-active-prospect__option-active">Active</span> : null}
                  </span>
                  <span className="nx-active-prospect__option-meta">
                    {participantPhone ? formatPhone(participantPhone) : 'No phone'}
                    <span className="nx-active-prospect__dot">•</span>
                    {participantRelationship}
                    {rankLabel ? (
                      <>
                        <span className="nx-active-prospect__dot">•</span>
                        {rankLabel}
                      </>
                    ) : null}
                  </span>
                  <span className="nx-active-prospect__option-sub">
                    <OwnershipIndicator status={participant.ownership_status} />
                    {/* §8 -- only the exception is worth the pixels. "SMS OK"
                        next to the number we are actively texting is noise;
                        a blocked number is not. */}
                    {participant.sms_eligible === false ? (
                      <span className="nx-active-prospect__option-pill is-blocked">No SMS</span>
                    ) : null}
                    {participant.excluded_as_renter ? (
                      <span className="nx-active-prospect__option-pill is-excluded">Renter excluded</span>
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