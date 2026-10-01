import { useSyncExternalStore, type ReactNode } from 'react'
import { MotionConfig } from 'framer-motion'
import { loadSettings, subscribeSettings } from '../settings'

const animationsOff = () => loadSettings().animationsEnabled === false

/**
 * One motion switch for the whole product: every framer-motion animation
 * honours the OS "reduce motion" request AND LeadCommand's own Animations
 * setting (transform/layout motion stops, opacity fades remain). CSS gets
 * the same switch through `data-lc-motion` on <html> (shared/settings.ts).
 */
export function LcMotionRoot({ children }: { children: ReactNode }) {
  const off = useSyncExternalStore(subscribeSettings, animationsOff, () => false)
  return <MotionConfig reducedMotion={off ? 'always' : 'user'}>{children}</MotionConfig>
}
