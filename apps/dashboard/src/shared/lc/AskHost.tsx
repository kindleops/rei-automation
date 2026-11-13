import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { LCButton } from './Button'
import { LCConfirm, LCDialog } from './Dialog'
import { getAskQueue, registerAskHost, settleAsk, subscribeAsk, type LCPromptRequest } from './ask-bus'

/**
 * Renders `lcConfirm` / `lcPrompt` requests with LCConfirm and LCDialog.
 * Mount once in the desktop shell. One request is shown at a time; the rest
 * wait their turn. Dismissal (Esc, Cancel, outside click) is always "no".
 */
export function LCAskHost() {
  useEffect(() => registerAskHost(), [])
  const queue = useSyncExternalStore(subscribeAsk, getAskQueue, getAskQueue)
  const head = queue[0]
  if (!head) return null
  if (head.kind === 'confirm') {
    const { req } = head
    return (
      <LCConfirm
        key={head.id}
        open
        onOpenChange={(open) => { if (!open) settleAsk(head.id, false) }}
        title={req.title}
        effects={req.effects}
        confirmLabel={req.confirmLabel}
        cancelLabel={req.cancelLabel}
        tone={req.tone}
        onConfirm={() => settleAsk(head.id, true)}
      />
    )
  }
  return <PromptDialog key={head.id} req={head.req} onSettle={(value) => settleAsk(head.id, value)} />
}

function PromptDialog({ req, onSettle }: { req: LCPromptRequest; onSettle: (value: string | null) => void }) {
  const [value, setValue] = useState(req.initialValue ?? '')
  const [acknowledged, setAcknowledged] = useState(false)
  const fieldId = useId()
  const ackId = useId()
  const empty = value.trim().length < Math.max(1, req.minLength ?? 1) || (Boolean(req.acknowledge) && !acknowledged)
  const submit = () => { if (!empty) onSettle(value) }
  return (
    <LCDialog
      open
      onOpenChange={(open) => { if (!open) onSettle(null) }}
      title={req.title}
      width={420}
      footer={(
        <>
          <LCButton variant="quiet" onClick={() => onSettle(null)}>Cancel</LCButton>
          <LCButton variant="primary" disabled={empty} onClick={submit}>{req.confirmLabel ?? 'Save'}</LCButton>
        </>
      )}
    >
      <label className="lc-field" htmlFor={fieldId}>
        <span className="lc-field__label">{req.label}</span>
        <input
          id={fieldId}
          className="lc-field__input"
          value={value}
          placeholder={req.placeholder}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
        />
      </label>
      {req.acknowledge ? (
        <label className="lc-field lc-field--check" htmlFor={ackId}>
          <input
            id={ackId}
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span className="lc-field__label">{req.acknowledge}</span>
        </label>
      ) : null}
    </LCDialog>
  )
}
