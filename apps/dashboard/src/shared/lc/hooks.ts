import { useEffect, useRef, useState } from 'react'

/** Shows a transient value only after it has held for `ms` — for counts that flicker during refetch. */
export function useSettledValue<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value)
  const t = useRef(0)
  useEffect(() => {
    window.clearTimeout(t.current)
    t.current = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t.current)
  }, [value, ms])
  return v
}
