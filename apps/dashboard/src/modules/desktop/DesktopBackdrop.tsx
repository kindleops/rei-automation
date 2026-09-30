import { useBackdropColors, useBackdropSettings } from './backdrop-settings'

/**
 * The flowing colour under the desktop's glass. Fixed, full-bleed, inert
 * (pointer-events: none), and cheap: every moving part is a pre-blurred layer
 * moved by transform, so the compositor animates a cached texture instead of
 * re-rasterising. Intensity scales opacity; motion off freezes the frame.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const WAVE = (amp: number, len: number, base: number) => {
  // One seamless strip two views wide (every period divides 1000, so a
  // -1000 translate loops without a seam): cubic crests, closed at the bottom.
  let d = `M0 ${base} `
  for (let x = 0; x < 2000; x += len) d += `C${x + len * 0.25} ${base - amp}, ${x + len * 0.75} ${base + amp}, ${x + len} ${base} `
  return `${d}L2000 120 L0 120 Z`
}

export function DesktopBackdrop() {
  const [settings] = useBackdropSettings()
  const colors = useBackdropColors(settings.palette)
  const vars = {
    ['--bd-a' as string]: colors[0],
    ['--bd-b' as string]: colors[1 % colors.length],
    ['--bd-c' as string]: colors[2 % colors.length],
    ['--bd-d' as string]: colors[3 % colors.length],
    ['--bd-e' as string]: colors[4 % colors.length] ?? colors[0],
    ['--bd-f' as string]: colors[5 % colors.length] ?? colors[1],
    ['--bd-i' as string]: String(settings.intensity / 100),
  }
  return (
    <div className={cls('dsk-bd', `is-${settings.style}`, !settings.motion && 'is-still')} style={vars} aria-hidden>
      {settings.style === 'liquid' || settings.style === 'still' ? (
        <div className="dsk-bd__liquid"><i /><i /><i /><i /></div>
      ) : null}
      {settings.style === 'waves' ? (
        <svg className="dsk-bd__waves" viewBox="0 0 1000 120" preserveAspectRatio="none">
          <defs>
            <linearGradient id="dsk-bd-w1" x1="0" x2="1"><stop offset="0" stopColor="var(--bd-a)" /><stop offset="0.5" stopColor="var(--bd-b)" /><stop offset="1" stopColor="var(--bd-a)" /></linearGradient>
            <linearGradient id="dsk-bd-w2" x1="0" x2="1"><stop offset="0" stopColor="var(--bd-c)" /><stop offset="0.5" stopColor="var(--bd-a)" /><stop offset="1" stopColor="var(--bd-c)" /></linearGradient>
            <linearGradient id="dsk-bd-w3" x1="0" x2="1"><stop offset="0" stopColor="var(--bd-d)" /><stop offset="0.5" stopColor="var(--bd-c)" /><stop offset="1" stopColor="var(--bd-d)" /></linearGradient>
          </defs>
          <g className="dsk-bd__wave is-1"><path d={WAVE(14, 500, 40)} fill="url(#dsk-bd-w1)" /></g>
          <g className="dsk-bd__wave is-2"><path d={WAVE(10, 250, 58)} fill="url(#dsk-bd-w2)" /></g>
          <g className="dsk-bd__wave is-3"><path d={WAVE(7, 1000 / 6, 76)} fill="url(#dsk-bd-w3)" /></g>
        </svg>
      ) : null}
      {settings.style === 'aurora' ? <div className="dsk-bd__aurora"><i /><i /></div> : null}
      <div className="dsk-bd__grain" />
      <div className="dsk-bd__vignette" />
    </div>
  )
}
