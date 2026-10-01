import type { ReactNode } from 'react'

/**
 * EXTERNAL INTELLIGENCE — the shelf for outside sources (Search Console,
 * keyword rank, web traffic, form conversion…).
 *
 * A provider joins by registering here once it has a real, connected source
 * behind it. Until then the shelf renders nothing at all: Home does not show
 * empty widgets or "connect me" placeholders for data it does not have (owner,
 * 2026-09-30: the main surfaces do not advertise a dead sensor).
 */
export interface ExternalProvider {
  id: string
  label: string
  /** True only when a live, authenticated source answers. */
  connected: boolean
  render: () => ReactNode
}

/** No outside sources are connected yet. */
export const EXTERNAL_PROVIDERS: ExternalProvider[] = []

export function ExternalIntelligence({ providers = EXTERNAL_PROVIDERS }: { providers?: ExternalProvider[] }) {
  const live = providers.filter((p) => p.connected)
  if (!live.length) return null
  return (
    <section className="ch-area-external ch-external" aria-label="External intelligence">
      {live.map((p) => (
        <div key={p.id} className="ch-glass is-flat ch-external__card">
          <span className="ch-eyebrow">{p.label}</span>
          {p.render()}
        </div>
      ))}
    </section>
  )
}
