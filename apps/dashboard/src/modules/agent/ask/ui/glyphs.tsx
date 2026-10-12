/** A few 16px stroke glyphs the shared icon set does not carry (same stroke language). */
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export type GlyphName = 'copy' | 'check' | 'stop' | 'at' | 'history' | 'plus' | 'dock' | 'palette' | 'tool' | 'model' | 'up' | 'arrow' | 'chev' | 'refused' | 'lift' | 'campaign' | 'owner' | 'market' | 'hot' | 'property' | 'selection' | 'slash'

export function Glyph({ name, size = 14 }: { name: GlyphName; size?: number }) {
  const s = { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true as const }
  switch (name) {
    case 'copy': return <svg {...s}><rect x="5.5" y="5.5" width="8" height="8" rx="2" {...P} /><path d="M10.5 3.5V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" {...P} /></svg>
    case 'check': return <svg {...s}><path d="m3.5 8.5 3 3 6-7" {...P} /></svg>
    case 'stop': return <svg {...s}><rect x="4.5" y="4.5" width="7" height="7" rx="1.6" fill="currentColor" /></svg>
    case 'at': return <svg {...s}><circle cx="8" cy="8" r="2.6" {...P} /><path d="M10.6 8v1a1.9 1.9 0 0 0 3.8 0V8A6.4 6.4 0 1 0 11 13.6" {...P} /></svg>
    case 'history': return <svg {...s}><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.4h2.4" {...P} /><path d="M8 5v3.2l2 1.3" {...P} /></svg>
    case 'plus': return <svg {...s}><path d="M8 3.5v9M3.5 8h9" {...P} /></svg>
    case 'dock': return <svg {...s}><rect x="2" y="3" width="12" height="10" rx="2" {...P} /><path d="M10 3v10" {...P} /></svg>
    case 'palette': return <svg {...s}><rect x="2" y="3.5" width="12" height="9" rx="2" {...P} /><path d="M4.8 6.5h6.4M4.8 9.5h3.6" {...P} /></svg>
    case 'tool': return <svg {...s}><path d="M3 4.5h10M3 8h7M3 11.5h4" {...P} /></svg>
    case 'model': return <svg {...s}><path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8l4.2-1.3z" {...P} /></svg>
    case 'up': return <svg {...s}><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" {...P} /></svg>
    case 'arrow': return <svg {...s}><path d="M5.5 10.5 10.5 5.5M6 5.5h4.5V10" {...P} /></svg>
    case 'chev': return <svg {...s}><path d="m6 4 4 4-4 4" {...P} /></svg>
    case 'refused': return <svg {...s}><circle cx="8" cy="8" r="5.5" {...P} /><path d="m4.2 11.8 7.6-7.6" {...P} /></svg>
    case 'lift': return <svg {...s}><path d="M8 13V5M4.8 8.2 8 5l3.2 3.2M3.5 2.8h9" {...P} /></svg>
    case 'campaign': return <svg {...s}><path d="M3 6.5v3l7 3v-9zM10 5.5h1.5a2.5 2.5 0 0 1 0 5H10" {...P} /></svg>
    case 'owner': return <svg {...s}><circle cx="8" cy="5.5" r="2.5" {...P} /><path d="M3.5 13a4.5 4.5 0 0 1 9 0" {...P} /></svg>
    case 'market': return <svg {...s}><path d="M8 14s4.5-4 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 10 8 14 8 14z" {...P} /><circle cx="8" cy="6.5" r="1.6" {...P} /></svg>
    case 'hot': return <svg {...s}><path d="M8 14a4.2 4.2 0 0 0 4.2-4.2C12.2 6.6 9.6 5 9.4 2c-1.9 1.2-3 3.1-3 4.9-.6-.4-1-1.2-1.1-2C4.4 6 3.8 7.6 3.8 9.8A4.2 4.2 0 0 0 8 14z" {...P} /></svg>
    case 'property': return <svg {...s}><path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h8V6.5" {...P} /></svg>
    case 'selection': return <svg {...s}><rect x="2.5" y="2.5" width="5" height="5" rx="1.2" {...P} /><rect x="8.5" y="2.5" width="5" height="5" rx="1.2" {...P} /><rect x="2.5" y="8.5" width="5" height="5" rx="1.2" {...P} /><rect x="8.5" y="8.5" width="5" height="5" rx="1.2" {...P} /></svg>
    case 'slash': return <svg {...s}><path d="m10.5 2.5-5 11" {...P} /></svg>
  }
}

export const KIND_GLYPH: Record<string, GlyphName> = { property: 'property', campaign: 'campaign', owner: 'owner', market: 'market', hot_leads: 'hot', selection: 'selection' }
