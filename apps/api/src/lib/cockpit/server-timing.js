const isDev = process.env.NODE_ENV !== 'production'

export function createRequestTimer(routeName) {
  const startedAt = Date.now()
  const phases = []

  return {
    mark(phase, extra = {}) {
      phases.push({
        phase,
        ms: Date.now() - startedAt,
        ...extra,
      })
    },
    summary(extra = {}) {
      const totalMs = Date.now() - startedAt
      const summary = {
        route: routeName,
        totalMs,
        phases,
        ...extra,
      }
      if (isDev) {
        console.log(`[COCKPIT_TIMING] ${routeName}`, summary)
      }
      return summary
    },
  }
}