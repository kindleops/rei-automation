import { createContext, useContext, useEffect, useState } from 'react'
import { pushRoutePath } from '../../../../app/router'
import { announceWorkspace, isWorkspaceRunning, openApp } from '../../../../modules/desktop/workspace/workspace-store'
import { requestNotificationsSurface } from '../../../../modules/mobile/shell-surface-bridge'
import { useHomeSource } from './home-sources'
import type { SourceDef } from './board-data'

/**
 * What a widget gets from its frame without asking: whether it is on screen
 * (it reads only then) and the operator's refresh override.
 */
export interface WidgetRuntime { active: boolean; refreshMs: number | null }

export const WidgetRuntimeContext = createContext<WidgetRuntime>({ active: true, refreshMs: null })

/** Read a Home source for this widget (shared, lazy, at the widget's cadence). */
export function useWidgetSource<T>(def: SourceDef<T> | null) {
  const rt = useContext(WidgetRuntimeContext)
  return useHomeSource<T>(def?.key ?? null, def?.load ?? NEVER, { everyMs: rt.refreshMs ?? def?.everyMs ?? 120_000, active: rt.active, apps: def?.apps })
}

const NEVER = () => new Promise<never>(() => {})

/** Open a path the way the shell does: here, or beside the acting pane when the workspace is running. */
export function openPath(path: string, beside = false): void {
  // Notifications is the Command Deck's plane, not a route
  if (path === '/notifications' || path.startsWith('/notifications?')) { requestNotificationsSurface(); return }
  if (beside && isWorkspaceRunning()) {
    if (openApp(path, 'beside') === 'refused') {
      announceWorkspace('No room beside — opened here instead.')
      pushRoutePath(path)
    }
    return
  }
  pushRoutePath(path)
}

export const cx = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
export const fmt = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n >= 10_000 ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : Math.round(n).toLocaleString('en-US'))
export const pct = (r: number | null | undefined, digits = 1): string => (r === null || r === undefined || !Number.isFinite(r) ? '—' : `${(r * 100).toFixed(digits)}%`)

/** A minute clock for relative times (render stays pure; the clock is state). */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), everyMs); return () => window.clearInterval(t) }, [everyMs])
  return now
}
