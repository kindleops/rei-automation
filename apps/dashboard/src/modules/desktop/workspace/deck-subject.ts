import { useEffect, useSyncExternalStore } from 'react'
import { useAppInstance } from './instance-context'

/**
 * What an app is looking at, in words, for the Command Deck — e.g. Inbox:
 * "Wendy B Stuhr" · "3831 Sheridan Ave N · S2". Apps describe their own
 * subject; the deck shows the focused pane's. Display only — never a source
 * of business truth.
 */
export interface DeckSubject { title: string; subtitle?: string | null }

const subjects = new Map<string, DeckSubject>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
let version = 0

export function useDeckSubject(subject: DeckSubject | null) {
  const { instanceId } = useAppInstance()
  const title = subject?.title ?? null
  const subtitle = subject?.subtitle ?? null
  useEffect(() => {
    if (!instanceId) return
    if (title) subjects.set(instanceId, { title, subtitle })
    else subjects.delete(instanceId)
    version += 1
    emit()
    return () => { subjects.delete(instanceId); version += 1; emit() }
  }, [instanceId, title, subtitle])
}

export function useFocusedDeckSubject(instanceId: string | null): DeckSubject | null {
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => version, () => version)
  return instanceId ? subjects.get(instanceId) ?? null : null
}
