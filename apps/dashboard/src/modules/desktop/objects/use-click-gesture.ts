import { useCallback, useMemo, useRef, type MouseEvent } from 'react'

type Mods = { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; preventDefault: () => void; stopPropagation: () => void }

/**
 * The modifiers of the click that is being handled, for surfaces whose row
 * callback does not receive the event (LCDataGrid's onActivate(row)). Spread
 * `captureProps` on a wrapper; call `take()` inside the callback — it returns
 * the click's modifiers once (a keyboard activation gets none: a plain open).
 */
export function useClickGesture() {
  const last = useRef<{ mods: Mods; at: number } | null>(null)
  const onClickCapture = useCallback((e: MouseEvent) => {
    last.current = { mods: { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, preventDefault: () => e.preventDefault(), stopPropagation: () => {} }, at: Date.now() }
  }, [])
  const take = useCallback((): Mods | null => {
    const l = last.current
    last.current = null
    return l && Date.now() - l.at < 400 ? l.mods : null
  }, [])
  return useMemo(() => ({ captureProps: { onClickCapture }, take }), [onClickCapture, take])
}
