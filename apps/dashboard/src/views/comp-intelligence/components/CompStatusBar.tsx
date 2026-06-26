interface Props {
  evidenceCount: number
  mappedCount: number
  isDegraded: boolean
  isAuthoritative: boolean
  searchMode?: string | null
  subjectResolved: boolean
  liveAuthOff?: boolean
}

export function CompStatusBar({
  evidenceCount,
  mappedCount,
  isDegraded,
  isAuthoritative,
  searchMode,
  subjectResolved,
  liveAuthOff = true,
}: Props) {
  const segments: string[] = []

  if (evidenceCount > 0) {
    segments.push(`EVIDENCE RECOVERED · ${evidenceCount} COMPS · ${mappedCount} MAPPED`)
  } else {
    segments.push('NO EVIDENCE RECOVERED')
  }

  if (isDegraded) segments.push('V3 DECISION UNAVAILABLE')
  else if (isAuthoritative) segments.push('V3 DECISION ACTIVE')

  if (searchMode) segments.push(searchMode.replace(/_/g, ' ').toUpperCase())
  if (!subjectResolved) segments.push('SUBJECT PIN UNAVAILABLE')
  if (liveAuthOff) segments.push('LIVE AUTHORIZATION OFF')

  return (
    <div className="ci-status-bar" role="status" aria-live="polite">
      {segments.join(' · ')}
    </div>
  )
}