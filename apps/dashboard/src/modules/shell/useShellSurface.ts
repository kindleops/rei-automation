import { useCallback, useEffect, useRef, useState } from 'react'
import type { ShellSurfaceId } from './shell-types'

type TriggerMap = Partial<Record<Exclude<ShellSurfaceId, null>, HTMLElement | null>>

export const useShellSurface = () => {
  const [activeSurface, setActiveSurface] = useState<ShellSurfaceId>(null)
  const triggersRef = useRef<TriggerMap>({})

  const registerTrigger = useCallback((surface: Exclude<ShellSurfaceId, null>, element: HTMLElement | null) => {
    triggersRef.current[surface] = element
  }, [])

  const openSurface = useCallback((surface: Exclude<ShellSurfaceId, null>) => {
    setActiveSurface((current) => (current === surface ? null : surface))
  }, [])

  const closeSurface = useCallback(() => {
    setActiveSurface(null)
  }, [])

  const toggleSurface = useCallback((surface: Exclude<ShellSurfaceId, null>) => {
    setActiveSurface((current) => (current === surface ? null : surface))
  }, [])

  const isOpen = useCallback((surface: Exclude<ShellSurfaceId, null>) => activeSurface === surface, [activeSurface])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && activeSurface) {
        const trigger = activeSurface ? triggersRef.current[activeSurface] : null
        setActiveSurface(null)
        window.requestAnimationFrame(() => trigger?.focus())
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeSurface])

  const closeAndRestoreFocus = useCallback((surface?: Exclude<ShellSurfaceId, null>) => {
    const target = surface ?? activeSurface
    const trigger = target ? triggersRef.current[target] : null
    setActiveSurface(null)
    window.requestAnimationFrame(() => trigger?.focus())
  }, [activeSurface])

  return {
    activeSurface,
    openSurface,
    closeSurface,
    toggleSurface,
    isOpen,
    registerTrigger,
    closeAndRestoreFocus,
    setActiveSurface,
  }
}