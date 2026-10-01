/**
 * Arc's components asked framer-motion alone whether to animate, which reads
 * only the operating-system preference. LeadCommand also has its own switch
 * (Settings → Appearance → animations), so the adapted components ask both.
 */
import { useSyncExternalStore } from 'react'
import { useReducedMotion as useOsReducedMotion } from 'framer-motion'
import { loadSettings, subscribeSettings } from '../../settings'

const animationsOff = () => loadSettings().animationsEnabled === false

export function useReducedMotion(): boolean {
  const os = useOsReducedMotion()
  const off = useSyncExternalStore(subscribeSettings, animationsOff, () => false)
  return Boolean(os) || off
}
