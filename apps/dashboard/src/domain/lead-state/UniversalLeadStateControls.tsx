import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../shared/icons'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import {
  CONTACTABILITY_META,
  CONTACTABILITY_ORDER,
  DISPOSITION_META,
  DISPOSITION_ORDER,
  LIFECYCLE_STAGE_META,
  LIFECYCLE_STAGE_ORDER,
  LEAD_TEMPERATURE_META,
  LEAD_TEMPERATURE_ORDER,
  OPERATIONAL_STATUS_META,
  OPERATIONAL_STATUS_ORDER,
  contactabilityBlocksSend,
  normalizeContactability,
  normalizeDisposition,
  normalizeLeadTemperature,
  normalizeLifecycleStage,
  normalizeOperationalStatus,
  type ContactabilityCode,
  type DispositionCode,
  type LeadTemperatureCode,
  type LifecycleStageCode,
  type OperationalStatusCode,
} from './universal-lead-state-registry'
import { useUniversalLeadStateMutation, type UseUniversalLeadStateMutationOptions } from './useUniversalLeadStateMutation'
import type { LeadStateSourceView } from './persistUniversalLeadState'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type SelectOption = { value: string; label: string; color?: string }

const STAGE_OPTIONS: SelectOption[] = LIFECYCLE_STAGE_ORDER.map((code) => ({
  value: code,
  label: `${LIFECYCLE_STAGE_META[code].shortLabel} ${LIFECYCLE_STAGE_META[code].label}`,
  color: LIFECYCLE_STAGE_META[code].color,
}))

const STATUS_OPTIONS: SelectOption[] = OPERATIONAL_STATUS_ORDER.map((code) => ({
  value: code,
  label: OPERATIONAL_STATUS_META[code].label,
  color: OPERATIONAL_STATUS_META[code].color,
}))

const TEMP_OPTIONS: SelectOption[] = LEAD_TEMPERATURE_ORDER.map((code) => ({
  value: code,
  label: LEAD_TEMPERATURE_META[code].label,
  color: LEAD_TEMPERATURE_META[code].color,
}))

const DISPOSITION_OPTIONS: SelectOption[] = DISPOSITION_ORDER.map((code) => ({
  value: code,
  label: DISPOSITION_META[code].label,
  color: DISPOSITION_META[code].color,
}))

const CONTACTABILITY_OPTIONS: SelectOption[] = CONTACTABILITY_ORDER.map((code) => ({
  value: code,
  label: CONTACTABILITY_META[code].label,
  color: CONTACTABILITY_META[code].color,
}))

const readThreadKey = (thread: InboxWorkflowThread | Record<string, unknown>): string =>
  String(
    (thread as InboxWorkflowThread).threadKey
    || (thread as InboxWorkflowThread).id
    || (thread as Record<string, unknown>).thread_key
    || '',
  ).trim()

const readBool = (thread: Record<string, unknown>, ...keys: string[]): boolean =>
  keys.some((key) => {
    const value = thread[key]
    return value === true || String(value).toLowerCase() === 'true'
  })

const readText = (thread: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys) {
    const value = thread[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value)
  }
  return ''
}

function CanonicalSelect({
  label,
  value,
  options,
  pending,
  disabled,
  onChange,
}: {
  label: string
  value: string
  options: SelectOption[]
  pending?: boolean
  disabled?: boolean
  onChange: (next: string) => void
}) {
  return (
    <label className="nx-ulsc__field">
      <span>{label}</span>
      <select
        value={value}
        disabled={disabled || pending}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </label>
  )
}

export interface UniversalLeadStateControlsProps {
  thread: InboxWorkflowThread | Record<string, unknown>
  sourceView: LeadStateSourceView
  compact?: boolean
  disabled?: boolean
  showPreferenceActions?: boolean
  showLockToggles?: boolean
  mutationOptions?: UseUniversalLeadStateMutationOptions
  onPatched?: () => void
}

export function UniversalLeadStateControls({
  thread,
  sourceView,
  compact = false,
  disabled = false,
  showPreferenceActions = true,
  showLockToggles = true,
  mutationOptions,
  onPatched,
}: UniversalLeadStateControlsProps) {
  const row = thread as Record<string, unknown>
  const threadKey = readThreadKey(thread as InboxWorkflowThread)

  const [stage, setStage] = useState<LifecycleStageCode>(() =>
    normalizeLifecycleStage(readText(row, 'lifecycle_stage', 'lifecycleStage', 'conversationStage', 'seller_stage', 'sellerStage')))
  const [status, setStatus] = useState<OperationalStatusCode>(() =>
    normalizeOperationalStatus(readText(row, 'operational_status', 'operationalStatus', 'conversation_status', 'conversationStatus', 'inboxStatus', 'status')))
  const [temperature, setTemperature] = useState<LeadTemperatureCode>(() =>
    normalizeLeadTemperature(readText(row, 'lead_temperature', 'leadTemperature', 'temperature')))
  const [disposition, setDisposition] = useState<DispositionCode>(() =>
    normalizeDisposition(readText(row, 'disposition')))
  const [contactability, setContactability] = useState<ContactabilityCode>(() =>
    normalizeContactability(readText(row, 'contactability_status', 'contactabilityStatus')))
  const [starred, setStarred] = useState(() => readBool(row, 'is_starred', 'isStarred'))
  const [pinned, setPinned] = useState(() => readBool(row, 'is_pinned', 'isPinned'))
  const [archived, setArchived] = useState(() => readBool(row, 'is_archived', 'isArchived', 'archived'))
  const [snoozedUntil, setSnoozedUntil] = useState(() => readText(row, 'snoozed_until', 'snoozedUntil'))
  const [manualStageLock, setManualStageLock] = useState(() => readBool(row, 'manual_stage_lock', 'manualStageLock'))
  const [manualTemperatureLock, setManualTemperatureLock] = useState(() => readBool(row, 'manual_temperature_lock', 'manualTemperatureLock'))

  const prevKeyRef = useRef(threadKey)
  useEffect(() => {
    if (prevKeyRef.current === threadKey) return
    prevKeyRef.current = threadKey
    setStage(normalizeLifecycleStage(readText(row, 'lifecycle_stage', 'lifecycleStage', 'conversationStage', 'seller_stage', 'sellerStage')))
    setStatus(normalizeOperationalStatus(readText(row, 'operational_status', 'operationalStatus', 'conversation_status', 'conversationStatus', 'inboxStatus', 'status')))
    setTemperature(normalizeLeadTemperature(readText(row, 'lead_temperature', 'leadTemperature', 'temperature')))
    setDisposition(normalizeDisposition(readText(row, 'disposition')))
    setContactability(normalizeContactability(readText(row, 'contactability_status', 'contactabilityStatus')))
    setStarred(readBool(row, 'is_starred', 'isStarred'))
    setPinned(readBool(row, 'is_pinned', 'isPinned'))
    setArchived(readBool(row, 'is_archived', 'isArchived', 'archived'))
    setSnoozedUntil(readText(row, 'snoozed_until', 'snoozedUntil'))
    setManualStageLock(readBool(row, 'manual_stage_lock', 'manualStageLock'))
    setManualTemperatureLock(readBool(row, 'manual_temperature_lock', 'manualTemperatureLock'))
  }, [row, threadKey])

  const { patch, pending, error } = useUniversalLeadStateMutation(sourceView, {
    ...mutationOptions,
    onSuccess: (result, patchPayload) => {
      mutationOptions?.onSuccess?.(result, patchPayload)
      onPatched?.()
    },
  })

  const commit = async (patchPayload: Record<string, unknown>) => {
    if (!threadKey || disabled) return
    await patch(threadKey, patchPayload)
  }

  const nextAction = readText(row, 'next_action', 'nextAction')
  const isSnoozed = Boolean(snoozedUntil) && new Date(snoozedUntil).getTime() > Date.now()

  return (
    <section className={cls('nx-ulsc', compact && 'is-compact', pending && 'is-syncing')} aria-label="Universal lead state">
      <div className="nx-ulsc__grid">
        <CanonicalSelect
          label="Stage"
          value={stage}
          options={STAGE_OPTIONS}
          pending={pending}
          disabled={disabled}
          onChange={(next) => {
            const normalized = normalizeLifecycleStage(next)
            setStage(normalized)
            void commit({ lifecycle_stage: normalized })
          }}
        />
        <CanonicalSelect
          label="Status"
          value={status}
          options={STATUS_OPTIONS}
          pending={pending}
          disabled={disabled}
          onChange={(next) => {
            const normalized = normalizeOperationalStatus(next)
            setStatus(normalized)
            void commit({ operational_status: normalized })
          }}
        />
        <CanonicalSelect
          label="Temperature"
          value={temperature}
          options={TEMP_OPTIONS}
          pending={pending}
          disabled={disabled}
          onChange={(next) => {
            const normalized = normalizeLeadTemperature(next)
            setTemperature(normalized)
            void commit({ lead_temperature: normalized })
          }}
        />
        <CanonicalSelect
          label="Disposition"
          value={disposition}
          options={DISPOSITION_OPTIONS}
          pending={pending}
          disabled={disabled}
          onChange={(next) => {
            const normalized = normalizeDisposition(next)
            setDisposition(normalized)
            void commit({ disposition: normalized })
          }}
        />
        <CanonicalSelect
          label="Contactability"
          value={contactability}
          options={CONTACTABILITY_OPTIONS}
          pending={pending}
          disabled={disabled}
          onChange={(next) => {
            const normalized = normalizeContactability(next)
            setContactability(normalized)
            void commit({ contactability_status: normalized })
          }}
        />
      </div>

      {nextAction ? (
        <p className="nx-ulsc__next-action">
          <span>Next action</span>
          <strong>{nextAction}</strong>
        </p>
      ) : null}

      {showLockToggles ? (
        <div className="nx-ulsc__locks">
          <label className="nx-ulsc__toggle">
            <input
              type="checkbox"
              checked={manualStageLock}
              disabled={disabled || pending}
              onChange={(e) => {
                const next = e.target.checked
                setManualStageLock(next)
                void commit({ manual_stage_lock: next })
              }}
            />
            <span>Manual stage lock</span>
          </label>
          <label className="nx-ulsc__toggle">
            <input
              type="checkbox"
              checked={manualTemperatureLock}
              disabled={disabled || pending}
              onChange={(e) => {
                const next = e.target.checked
                setManualTemperatureLock(next)
                void commit({ manual_temperature_lock: next })
              }}
            />
            <span>Manual temperature lock</span>
          </label>
        </div>
      ) : null}

      {showPreferenceActions ? (
        <div className="nx-ulsc__actions">
          <button type="button" className={cls('nx-ulsc__action', starred && 'is-active')} disabled={disabled || pending} onClick={() => {
            const next = !starred
            setStarred(next)
            void commit({ is_starred: next })
          }}>
            <Icon name="star" size={14} />
            {starred ? 'Starred' : 'Star'}
          </button>
          <button type="button" className={cls('nx-ulsc__action', pinned && 'is-active')} disabled={disabled || pending} onClick={() => {
            const next = !pinned
            setPinned(next)
            void commit({ is_pinned: next })
          }}>
            <Icon name="pin" size={14} />
            {pinned ? 'Pinned' : 'Pin'}
          </button>
          <button type="button" className={cls('nx-ulsc__action', archived && 'is-active')} disabled={disabled || pending} onClick={() => {
            const next = !archived
            setArchived(next)
            void commit(next ? { is_archived: true, archive_scope: 'conversation' } : { is_archived: false, archive_scope: null })
          }}>
            <Icon name="archive" size={14} />
            {archived ? 'Archived' : 'Archive'}
          </button>
          <button type="button" className={cls('nx-ulsc__action', isSnoozed && 'is-active')} disabled={disabled || pending} onClick={() => {
            if (isSnoozed) {
              setSnoozedUntil('')
              void commit({ snoozed_until: null, snooze_reason: null, operational_status: 'needs_review' })
              return
            }
            const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
            setSnoozedUntil(until)
            void commit({ snoozed_until: until, operational_status: 'snoozed' })
          }}>
            <Icon name="moon" size={14} />
            {isSnoozed ? 'Snoozed' : 'Snooze 24h'}
          </button>
        </div>
      ) : null}

      {contactabilityBlocksSend(contactability) ? (
        <p className="nx-ulsc__warning" role="status">Contactability blocks outbound send.</p>
      ) : null}
      {error ? <p className="nx-ulsc__error" role="alert">{error}</p> : null}

      <style>{`
        .nx-ulsc { display: grid; gap: 10px; padding: 10px 0; }
        .nx-ulsc.is-compact .nx-ulsc__grid { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
        .nx-ulsc__grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
        .nx-ulsc__field { display: grid; gap: 4px; font-size: 11px; color: var(--nexus-muted, #9ba8c0); }
        .nx-ulsc__field select {
          width: 100%;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(8,12,20,0.55);
          color: var(--nexus-text, #e8edf7);
          padding: 6px 8px;
          font-size: 12px;
        }
        .nx-ulsc__next-action { margin: 0; display: flex; gap: 8px; align-items: baseline; font-size: 12px; color: var(--nexus-muted, #9ba8c0); }
        .nx-ulsc__next-action strong { color: var(--nexus-text, #e8edf7); font-weight: 600; }
        .nx-ulsc__locks, .nx-ulsc__actions { display: flex; flex-wrap: wrap; gap: 8px; }
        .nx-ulsc__toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--nexus-muted, #9ba8c0); }
        .nx-ulsc__action {
          display: inline-flex; align-items: center; gap: 6px;
          border-radius: 999px; border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.04); color: var(--nexus-text, #e8edf7);
          padding: 5px 10px; font-size: 11px;
        }
        .nx-ulsc__action.is-active { border-color: rgba(91,182,255,0.45); background: rgba(91,182,255,0.12); }
        .nx-ulsc__warning, .nx-ulsc__error { margin: 0; font-size: 11px; }
        .nx-ulsc__warning { color: #ffd166; }
        .nx-ulsc__error { color: #ff6b64; }
        .nx-ulsc.is-syncing { opacity: 0.82; }
      `}</style>
    </section>
  )
}