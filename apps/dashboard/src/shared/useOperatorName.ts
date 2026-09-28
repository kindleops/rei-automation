import { useSyncExternalStore } from 'react'
import { useAuth } from '../components/auth/AuthProvider'
import { loadSettings, subscribeSettings } from './settings'

const readOperatorName = () => loadSettings().operatorName?.trim() ?? ''

/**
 * The operator's first name: the name set in Settings, else the signed-in
 * user's profile metadata. Empty when neither exists — callers greet without a
 * name rather than invent one.
 */
export function useOperatorName(): string {
  const configured = useSyncExternalStore(subscribeSettings, readOperatorName, () => '')
  const { user } = useAuth()
  if (configured) return configured.split(/\s+/)[0]
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>
  const fromProfile = [meta.first_name, meta.full_name, meta.name].find((v): v is string => typeof v === 'string' && v.trim() !== '')
  return fromProfile ? fromProfile.trim().split(/\s+/)[0] : ''
}
