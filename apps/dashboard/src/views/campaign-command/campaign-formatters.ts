export const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export const fmt = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export const fmtPct = (n: number): string => `${n.toFixed(1)}%`

export const fmtInterval = (secs: number): string => {
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  return `${(secs / 3600).toFixed(1)}h`
}

export const fmtRelative = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const diff = new Date(iso).getTime() - Date.now()
  if (diff < 0) {
    const ago = Math.abs(diff)
    const mins = Math.floor(ago / 60_000)
    if (mins < 60) return `${mins}m ago`
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
    return `${Math.floor(mins / 1440)}d ago`
  }
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `in ${mins}m`
  if (mins < 1440) return `in ${Math.floor(mins / 60)}h`
  return `in ${Math.floor(mins / 1440)}d`
}