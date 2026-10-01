/**
 * The Studio's few glyphs the shared icon set does not carry (plus, copy,
 * eyedropper, undo, trash, duplicate). Same 1.7 stroke language as shared/icons.
 */
type GlyphName = 'plus' | 'copy' | 'eyedropper' | 'undo' | 'trash' | 'duplicate' | 'pencil' | 'reset' | 'sliders'

const PATHS: Record<GlyphName, string> = {
  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  eyedropper: 'M17.5 3.5a2.12 2.12 0 0 1 3 3L18 9l-3-3 2.5-2.5zM13 7l4 4M15 9l-9 9-3 1 1-3 9-9',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  duplicate: 'M8 8h11v11H8zM5 16V5h11',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  reset: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v5h5',
  sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4',
}

export function Glyph({ name, size = 14, className }: { name: GlyphName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  )
}
