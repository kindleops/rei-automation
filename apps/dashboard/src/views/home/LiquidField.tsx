import { useEffect, useRef, type RefObject } from 'react'
import { subscribeSettings } from '../../shared/settings'
import { prefersStill } from './home-motion'

/**
 * THE LIQUID FIELD.
 *
 * A fragment shader of domain-warped noise: colour folded through itself twice, so
 * it moves like ink in water rather than drifting blobs. It is tinted from the live
 * accent, darkened into near-black with luminous veins, and it swirls around the
 * operator's finger.
 *
 * Cost is kept deliberately small: the canvas renders at half the CSS pixel size
 * (a liquid gradient has no detail to lose; the browser's upscale softens it
 * further), stops when the tab is hidden, and draws one still frame when motion is
 * off. If WebGL is unavailable the CSS field underneath simply stays visible.
 */

const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

const FRAGMENT = `
precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform float uScroll;
uniform float uLight;
uniform vec3 uBase;
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uC;
uniform vec3 uTouch;
uniform float uVel;

vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
float fbm(vec2 p) {
  float f = 0.0;
  float a = 0.55;
  for (int i = 0; i < 3; i++) { f += a * snoise(p); p = p * 1.9 + 11.7; a *= 0.45; }
  return f;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  p.y -= uScroll;
  float t = uTime * 0.035;

  // The finger stirs the liquid: a swirl that fades with distance and time.
  vec2 tp = (uTouch.xy * uRes - 0.5 * uRes) / uRes.y;
  tp.y -= uScroll;
  vec2 d = p - tp;
  float sw = uTouch.z * exp(-dot(d, d) * 5.0);
  p += vec2(-d.y, d.x) * sw * 1.4 + d * sw * 0.2;

  // Large, slow forms: low frequency, folded twice for the ink-in-water motion.
  vec2 s = p * 0.62;
  // Scrolling stirs the whole body of liquid, harder the faster it moves.
  s += vec2(0.0, uVel * 0.35);
  vec2 q = vec2(fbm(s + vec2(0.0, t)), fbm(s + vec2(5.2, -t * 0.8)));
  vec2 r = vec2(fbm(s + 1.7 * q + vec2(1.7, 9.2) + t * 0.9),
                fbm(s + 1.7 * q + vec2(8.3, 2.8) - t * 0.7));
  float n = fbm(s + (1.9 + uVel * 1.4) * r);

  vec3 col = mix(uA, uB, smoothstep(-0.45, 0.55, r.x));
  col = mix(col, uC, smoothstep(0.25, 0.9, length(q)));

  // Mostly deep and dark; colour only where the currents gather, with a soft
  // luminous crest along them.
  float body = smoothstep(-0.15, 0.75, n + 0.3 * r.y);
  float crest = pow(smoothstep(0.35, 0.0, abs(n - 0.18)), 2.0);
  vec3 dark = mix(uBase, col * 0.55, body * body * 0.85);
  dark += col * crest * 0.22 * (0.4 + body);
  // Caustic glints: light caught where the currents fold over.
  float glint = pow(max(0.0, snoise(s * 3.1 + r * 2.2 + vec2(t * 3.0, -t * 2.0))), 8.0);
  dark += mix(col, vec3(1.0), 0.45) * glint * (0.5 + body) * (0.35 + uVel);
  dark *= mix(0.55, 1.0, smoothstep(0.0, 0.75, uv.y));

  vec3 light = mix(vec3(0.955, 0.965, 0.985), col, 0.12 + 0.28 * body);

  vec3 o = mix(dark, light, uLight);
  vec2 vv = uv - 0.5;
  o *= 1.0 - dot(vv, vv) * 0.9 * (1.0 - uLight);
  o += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(o, 1.0);
}
`

type RGB = [number, number, number]

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

function readPalette(): { base: RGB; a: RGB; b: RGB; c: RGB; light: number } {
  const root = document.documentElement
  const raw = getComputedStyle(root).getPropertyValue('--nexus-accent-rgb').trim()
  const parts = raw.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n))
  const accent: RGB = parts.length >= 3 ? [parts[0] / 255, parts[1] / 255, parts[2] / 255] : [0.22, 0.74, 0.97]
  const light = root.getAttribute('data-nexus-theme') === 'light' ? 1 : 0
  return {
    base: mix([0.012, 0.016, 0.03], accent, 0.05),
    a: mix(accent, [0.43, 0.2, 0.93], 0.55),
    b: accent,
    c: mix(accent, [0.05, 0.72, 0.6], 0.5),
    light,
  }
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

const RESOLUTION_SCALE = 0.5

export function LiquidField({ scroller, touchRoot }: {
  scroller: RefObject<HTMLElement | null>
  touchRoot: RefObject<HTMLElement | null>
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false })
    if (!gl) return

    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
    const program = gl.createProgram()
    if (!vs || !fs || !program) return
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return
    gl.useProgram(program)

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    const u = (name: string) => gl.getUniformLocation(program, name)
    const uRes = u('uRes'), uTime = u('uTime'), uScroll = u('uScroll'), uLight = u('uLight')
    const uBase = u('uBase'), uA = u('uA'), uB = u('uB'), uC = u('uC'), uTouch = u('uTouch'), uVel = u('uVel')

    const applyPalette = () => {
      const palette = readPalette()
      gl.uniform3fv(uBase, palette.base)
      gl.uniform3fv(uA, palette.a)
      gl.uniform3fv(uB, palette.b)
      gl.uniform3fv(uC, palette.c)
      gl.uniform1f(uLight, palette.light)
    }
    applyPalette()
    // The theme engine writes its attributes in its own settings subscriber; read
    // the palette a frame later so this sees the new values, not the old ones.
    const unsubscribe = subscribeSettings(() => requestAnimationFrame(() => { applyPalette(); resume() }))

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const w = Math.max(1, Math.round(rect.width * RESOLUTION_SCALE))
      const h = Math.max(1, Math.round(rect.height * RESOLUTION_SCALE))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        gl.viewport(0, 0, w, h)
        gl.uniform2f(uRes, w, h)
      }
    }
    resize()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    observer?.observe(canvas)

    // Touch: target position and a strength that blooms on contact and ebbs away.
    const touch = { x: 0.5, y: 0.6, strength: 0, target: 0, held: false }
    const toLocal = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      touch.x = (event.clientX - rect.left) / rect.width
      touch.y = 1 - (event.clientY - rect.top) / rect.height
    }
    const down = (event: PointerEvent) => { toLocal(event); touch.held = true; touch.target = 1 }
    const move = (event: PointerEvent) => { if (touch.held) toLocal(event) }
    const up = () => { touch.held = false; touch.target = 0 }
    const touchNode = touchRoot.current
    touchNode?.addEventListener('pointerdown', down, { passive: true })
    touchNode?.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', up, { passive: true })
    window.addEventListener('pointercancel', up, { passive: true })

    let frame = 0
    let lost = false
    let lastScroll = scroller.current?.scrollTop ?? 0
    let velocity = 0
    const start = performance.now()
    const draw = (now: number) => {
      if (lost) return
      touch.strength += (touch.target - touch.strength) * (touch.target > touch.strength ? 0.12 : 0.025)
      const scrollTop = scroller.current?.scrollTop ?? 0
      // Scroll speed, eased: rises with a flick, settles back over a second.
      const speed = Math.min(1, Math.abs(scrollTop - lastScroll) / 60)
      lastScroll = scrollTop
      velocity += (speed - velocity) * (speed > velocity ? 0.3 : 0.04)
      gl.uniform1f(uVel, velocity)
      gl.uniform1f(uTime, prefersStill() ? 12 : (now - start) / 1000)
      gl.uniform1f(uScroll, (scrollTop / Math.max(1, canvas.clientHeight)) * 0.35)
      gl.uniform3f(uTouch, touch.x, touch.y, touch.strength)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      if (!canvas.classList.contains('is-ready')) {
        canvas.classList.add('is-ready')
        // The canvas is opaque: the CSS field beneath it can no longer be seen,
        // so it stops animating rather than compositing for nothing.
        canvas.parentElement?.classList.add('has-shader')
      }
    }
    // Slow liquid reads identically at 30fps, at half the GPU cost of 60.
    let lastDraw = 0
    const loop = (now: number) => {
      if (now - lastDraw >= 32) {
        lastDraw = now
        draw(now)
      }
      if (!prefersStill() && document.visibilityState === 'visible') frame = requestAnimationFrame(loop)
      else frame = 0
    }
    function resume() {
      if (!frame && document.visibilityState === 'visible') frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    document.addEventListener('visibilitychange', resume)
    // A still frame still has to follow the scroll.
    const onScroll = () => { if (!frame) requestAnimationFrame(draw) }
    scroller.current?.addEventListener('scroll', onScroll, { passive: true })

    const onLost = (event: Event) => {
      event.preventDefault()
      lost = true
      canvas.classList.remove('is-ready')
      canvas.parentElement?.classList.remove('has-shader')
    }
    canvas.addEventListener('webglcontextlost', onLost)

    const scrollNode = scroller.current
    return () => {
      cancelAnimationFrame(frame)
      unsubscribe()
      observer?.disconnect()
      document.removeEventListener('visibilitychange', resume)
      scrollNode?.removeEventListener('scroll', onScroll)
      touchNode?.removeEventListener('pointerdown', down)
      touchNode?.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      canvas.removeEventListener('webglcontextlost', onLost)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [scroller, touchRoot])

  return <canvas ref={canvasRef} className="nx-home__shader" aria-hidden />
}
