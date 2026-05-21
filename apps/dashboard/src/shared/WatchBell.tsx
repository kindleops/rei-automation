import type { MouseEvent } from 'react'
import { useWatchlist } from '../lib/watchlistContext'
import type { WatchlistTogglePayload } from '../lib/data/watchlistData'

interface WatchBellProps {
  watch_type: WatchlistTogglePayload['watch_type']
  watch_key: string
  label?: string
  thread_key?: string
  prospect_id?: string
  owner_id?: string
  master_owner_id?: string
  property_id?: string
  phone?: string
  address?: string
  market?: string
  className?: string
}

const BellOutline = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 2a4.5 4.5 0 0 1 4.5 4.5c0 2.5.8 3.5 1.5 4.5H2c.7-1 1.5-2 1.5-4.5A4.5 4.5 0 0 1 8 2Z" />
    <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0" />
  </svg>
)

const BellFilled = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 2a4.5 4.5 0 0 1 4.5 4.5c0 2.5.8 3.5 1.5 4.5H2c.7-1 1.5-2 1.5-4.5A4.5 4.5 0 0 1 8 2Z" />
    <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0" />
  </svg>
)

export function WatchBell({
  watch_type,
  watch_key,
  label,
  thread_key,
  prospect_id,
  owner_id,
  master_owner_id,
  property_id,
  phone,
  address,
  market,
  className,
}: WatchBellProps) {
  const { isWatched, toggleWatch } = useWatchlist()
  const watching = isWatched(watch_type, watch_key)

  const handleClick = (e: MouseEvent) => {
    e.stopPropagation()
    toggleWatch({
      watch_type,
      watch_key,
      label,
      thread_key,
      prospect_id,
      owner_id,
      master_owner_id,
      property_id,
      phone,
      address,
      market,
    })
  }

  return (
    <button
      type="button"
      className={`wb-btn${watching ? ' is-watching' : ''}${className ? ` ${className}` : ''}`}
      onClick={handleClick}
      title={watching ? 'Stop watching' : `Watch this ${watch_type}`}
      aria-pressed={watching}
    >
      {watching ? <BellFilled /> : <BellOutline />}
    </button>
  )
}
