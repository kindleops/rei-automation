import { useMemo, type ComponentProps } from 'react'
import type { ThreadMessage } from '../../../lib/data/inboxData'
import { Composer } from '../components/Composer'
import { deriveComposerPhase, useComposerPhase } from './composer-phase'
import { useLedgerClock } from './use-ledger-clock'

type ComposerProps = ComponentProps<typeof Composer>

/**
 * The existing composer, unchanged, given its one automation signal. The
 * phase is derived from the conversation the operator is reading (see
 * composer-phase.ts); the clock only bounds how long a "replying" marker may
 * stand, and it ticks only while a desktop conversation is open.
 */
export function DeskComposer({
  messages,
  queueStatus,
  threadId,
  ...props
}: Omit<ComposerProps, 'phase'> & {
  messages: readonly ThreadMessage[]
  queueStatus: (queueId: string) => string | null
  threadId: string | null
}) {
  const now = useLedgerClock()
  const base = useMemo(() => deriveComposerPhase(messages, now, queueStatus), [messages, now, queueStatus])
  const phase = useComposerPhase(base, threadId)
  return <Composer {...props} phase={phase} />
}
