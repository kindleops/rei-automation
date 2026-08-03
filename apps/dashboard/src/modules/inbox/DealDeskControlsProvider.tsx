/**
 * The Deal Desk controls provider.
 *
 * Kept in its own module, exporting only this component, so Fast Refresh keeps working
 * (`react-refresh/only-export-components`). The context object and the consumer hooks live
 * in `deal-desk-controls-context.ts`.
 */

import { useMemo, type ReactNode } from 'react'
import type { ThreadIdentityInput } from '../../domain/inbox/canonical-thread-reference'
import { DealDeskControlsContext } from './deal-desk-controls-context'
import {
  useDealDeskThreadControls,
  type DealDeskControlsOptions,
} from './useDealDeskThreadControls'

export interface DealDeskControlsProviderProps extends DealDeskControlsOptions {
  thread: ThreadIdentityInput
  children: ReactNode
}

export function DealDeskControlsProvider({
  thread,
  onPersisted,
  onTelemetry,
  children,
}: DealDeskControlsProviderProps) {
  const controls = useDealDeskThreadControls(thread, { onPersisted, onTelemetry })
  const value = useMemo(() => ({ controls, thread }), [controls, thread])
  return (
    <DealDeskControlsContext.Provider value={value}>
      {children}
    </DealDeskControlsContext.Provider>
  )
}
