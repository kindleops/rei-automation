import { useEffect } from 'react'

/**
 * Keyboard ownership. Global shortcuts (single-letter app jumps, `/` for the
 * command bar) yield to the surface the operator is working in: a surface
 * that uses a key claims it while mounted, and global handlers skip claimed
 * keys. React handlers that call preventDefault are respected as well
 * (global listeners run in the bubble phase, after them).
 */
const claimed = new Map<string, number>()

export function claimKeys(keys: readonly string[]): () => void {
  for (const k of keys) claimed.set(k.toLowerCase(), (claimed.get(k.toLowerCase()) ?? 0) + 1)
  return () => {
    for (const k of keys) {
      const key = k.toLowerCase()
      const n = (claimed.get(key) ?? 1) - 1
      if (n <= 0) claimed.delete(key)
      else claimed.set(key, n)
    }
  }
}

export function isKeyClaimed(key: string): boolean {
  return claimed.has(key.toLowerCase())
}

/** Claim keys for as long as the calling surface is mounted (and enabled). */
export function useClaimedKeys(keys: readonly string[], enabled = true): void {
  const sig = keys.join('\u0000')
  useEffect(() => {
    if (!enabled) return
    return claimKeys(sig.split('\u0000'))
  }, [sig, enabled])
}
