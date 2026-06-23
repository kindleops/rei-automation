import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'wfs2-studio-prefs'

export interface WorkflowStudioPrefs {
  leftRailCollapsed: boolean
  rightRailCollapsed: boolean
  focusMode: boolean
}

const DEFAULT_PREFS: WorkflowStudioPrefs = {
  leftRailCollapsed: false,
  rightRailCollapsed: false,
  focusMode: false,
}

function readPrefs(): WorkflowStudioPrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<WorkflowStudioPrefs>
    return {
      leftRailCollapsed: parsed.leftRailCollapsed === true,
      rightRailCollapsed: parsed.rightRailCollapsed === true,
      focusMode: parsed.focusMode === true,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

function writePrefs(prefs: WorkflowStudioPrefs) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Ignore quota / privacy errors.
  }
}

export function useWorkflowStudioPrefs() {
  const [prefs, setPrefs] = useState<WorkflowStudioPrefs>(() => readPrefs())

  const patchPrefs = useCallback((patch: Partial<WorkflowStudioPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch }
      writePrefs(next)
      return next
    })
  }, [])

  const toggleLeftRail = useCallback(() => {
    patchPrefs({ leftRailCollapsed: !prefs.leftRailCollapsed })
  }, [patchPrefs, prefs.leftRailCollapsed])

  const toggleRightRail = useCallback(() => {
    patchPrefs({ rightRailCollapsed: !prefs.rightRailCollapsed })
  }, [patchPrefs, prefs.rightRailCollapsed])

  const toggleFocusMode = useCallback(() => {
    patchPrefs({ focusMode: !prefs.focusMode })
  }, [patchPrefs, prefs.focusMode])

  return {
    prefs,
    patchPrefs,
    toggleLeftRail,
    toggleRightRail,
    toggleFocusMode,
  }
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
}

function isMetaKey(event: KeyboardEvent) {
  return event.metaKey || event.ctrlKey
}

export interface WorkflowStudioShortcutHandlers {
  onToggleLeftRail?: () => void
  onToggleRightRail?: () => void
  onToggleFocusMode?: () => void
  onUndo?: () => void
  onRedo?: () => void
}

export function useWorkflowStudioShortcuts(handlers: WorkflowStudioShortcutHandlers) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (!isMetaKey(event)) return

      const key = event.key.toLowerCase()

      if (key === 'b' && !event.shiftKey) {
        event.preventDefault()
        handlers.onToggleLeftRail?.()
        return
      }

      if (key === 'i' && !event.shiftKey) {
        event.preventDefault()
        handlers.onToggleRightRail?.()
        return
      }

      if (key === 'f' && event.shiftKey) {
        event.preventDefault()
        handlers.onToggleFocusMode?.()
        return
      }

      if (key === 'z' && event.shiftKey) {
        event.preventDefault()
        handlers.onRedo?.()
        return
      }

      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        handlers.onUndo?.()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handlers])
}