/**
 * pin-icons.ts
 *
 * Tactical property type icons for NEXUS map pins.
 * All icons are white-on-transparent canvas images loaded as MapLibre SDF sprites.
 * SDF mode lets icon-color expression colorize the shape per visual state.
 */

import type maplibregl from 'maplibre-gl'

// ─── Icon name registry ───────────────────────────────────────────────────

export const PIN_ICON = {
  sfr:        'nexus-pin-sfr',
  multi:      'nexus-pin-multi',
  apt:        'nexus-pin-apt',
  land:       'nexus-pin-land',
  comm:       'nexus-pin-comm',
  storage:    'nexus-pin-storage',
  retail:     'nexus-pin-retail',
  office:     'nexus-pin-office',
  industrial: 'nexus-pin-industrial',
  hotel:      'nexus-pin-hotel',
  mhp:        'nexus-pin-mhp',
  default:    'nexus-pin-default',
  selected:   'nexus-pin-selected',
} as const

export type PinIconSlug = keyof typeof PIN_ICON

// ─── Property type normalization ──────────────────────────────────────────

export function normalizePropertyTypeSlug(propertyType: string): PinIconSlug {
  const v = propertyType.toLowerCase().replace(/[\s\-_]/g, '')
  if (/sfr|single|house|mobile|residential/.test(v)) return 'sfr'
  if (/multi|duplex|triplex|24|2unit|3unit|4unit|units/.test(v)) return 'multi'
  if (/apart|condo|condom|complex|tower/.test(v)) return 'apt'
  if (/land|vacant|lot|parcel/.test(v)) return 'land'
  if (/storage|selfstorage/.test(v)) return 'storage'
  if (/retail|strip|plaza|shopping/.test(v)) return 'retail'
  if (/office/.test(v)) return 'office'
  if (/indust|warehouse|flex/.test(v)) return 'industrial'
  if (/hotel|motel|hospit/.test(v)) return 'hotel'
  if (/mhp|mobilehome|mobilepark/.test(v)) return 'mhp'
  if (/comm|mixed/.test(v)) return 'comm'
  return 'default'
}

// ─── Canvas helpers ───────────────────────────────────────────────────────

const ICON_SIZE = 64

function makeCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  canvas.width = ICON_SIZE
  canvas.height = ICON_SIZE
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE)
  return [canvas, ctx]
}

function setup(ctx: CanvasRenderingContext2D, lw = 2.6) {
  ctx.strokeStyle = 'white'
  ctx.lineWidth = lw
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.fillStyle = 'rgba(255,255,255,0.07)'
}

// Scale factor: all coordinates are designed for 64px canvas
const S = ICON_SIZE / 64

// ─── SFR — single-family residential ─────────────────────────────────────
// Classic peaked-roof house: body + arched door + side windows

function drawSFR(ctx: CanvasRenderingContext2D) {
  setup(ctx, 2.8)

  // House body (pentagon)
  ctx.beginPath()
  ctx.moveTo(32 * S,  6 * S)   // roof peak
  ctx.lineTo(57 * S, 24 * S)   // right eave
  ctx.lineTo(57 * S, 57 * S)   // right base
  ctx.lineTo(7  * S, 57 * S)   // left base
  ctx.lineTo(7  * S, 24 * S)   // left eave
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // Arched door (centered)
  const dL = 24 * S, dR = 40 * S, dB = 57 * S
  const dMid = (dL + dR) / 2
  const dRad = (dR - dL) / 2
  const dTop = 43 * S + dRad
  ctx.beginPath()
  ctx.moveTo(dL, dB)
  ctx.lineTo(dL, dTop)
  ctx.arc(dMid, dTop, dRad, Math.PI, 0)
  ctx.lineTo(dR, dB)
  ctx.stroke()

  // Left window
  ctx.strokeRect(11 * S, 30 * S, 10 * S, 9 * S)
  // Right window
  ctx.strokeRect(43 * S, 30 * S, 10 * S, 9 * S)
}

// ─── Multi-Family — 2-4 unit / duplex ────────────────────────────────────
// Two overlapping house silhouettes with depth offset

function drawMulti(ctx: CanvasRenderingContext2D) {
  setup(ctx, 2.2)

  // Back house (slightly inset, dimmer)
  ctx.globalAlpha = 0.45
  ctx.beginPath()
  ctx.moveTo(36 * S,  8 * S)
  ctx.lineTo(58 * S, 24 * S)
  ctx.lineTo(58 * S, 56 * S)
  ctx.lineTo(16 * S, 56 * S)
  ctx.lineTo(16 * S, 24 * S)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.globalAlpha = 1.0

  // Front house (full opacity)
  ctx.beginPath()
  ctx.moveTo(26 * S, 14 * S)
  ctx.lineTo(50 * S, 30 * S)
  ctx.lineTo(50 * S, 58 * S)
  ctx.lineTo(6  * S, 58 * S)
  ctx.lineTo(6  * S, 30 * S)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // Front door
  const dL2 = 22 * S, dR2 = 32 * S, dB2 = 58 * S, dMid2 = (dL2 + dR2) / 2, dRad2 = (dR2 - dL2) / 2
  ctx.beginPath()
  ctx.moveTo(dL2, dB2)
  ctx.lineTo(dL2, 47 * S + dRad2)
  ctx.arc(dMid2, 47 * S + dRad2, dRad2, Math.PI, 0)
  ctx.lineTo(dR2, dB2)
  ctx.stroke()

  // "2x" unit indicator — two small dots top right
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.beginPath(); ctx.arc(55 * S, 8 * S, 2.5 * S, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.arc(60 * S, 8 * S, 2.5 * S, 0, Math.PI * 2); ctx.fill()
}

// ─── Apartment / large multifamily ───────────────────────────────────────
// Tall tower: outer rect + floor lines + window grid + entrance

function drawApartment(ctx: CanvasRenderingContext2D) {
  setup(ctx, 2.6)

  // Tower outline
  ctx.beginPath()
  ctx.rect(16 * S, 5 * S, 32 * S, 54 * S)
  ctx.fill()
  ctx.stroke()

  // Floor divider lines
  for (const y of [18, 30, 42]) {
    ctx.beginPath()
    ctx.moveTo(16 * S, y * S)
    ctx.lineTo(48 * S, y * S)
    ctx.globalAlpha = 0.5
    ctx.stroke()
    ctx.globalAlpha = 1.0
  }

  // Window grid (2 per floor, 3 floors)
  ctx.lineWidth = 1.8
  for (const [col, row] of [[20, 8], [38, 8], [20, 21], [38, 21], [20, 34], [38, 34]]) {
    ctx.strokeRect(col * S, row * S, 7 * S, 7 * S)
  }

  ctx.lineWidth = 2.6
  // Entrance doors
  ctx.beginPath()
  ctx.moveTo(23 * S, 59 * S)
  ctx.lineTo(23 * S, 48 * S)
  ctx.lineTo(41 * S, 48 * S)
  ctx.lineTo(41 * S, 59 * S)
  ctx.moveTo(32 * S, 48 * S) // center split
  ctx.lineTo(32 * S, 59 * S)
  ctx.stroke()
}

// ─── Vacant Land — parcel marker ─────────────────────────────────────────
// Outer boundary + inner survey grid + corner markers

function drawLand(ctx: CanvasRenderingContext2D) {
  setup(ctx, 2.6)

  // Outer parcel
  ctx.strokeRect(6 * S, 6 * S, 52 * S, 52 * S)

  // Inner grid (soft)
  ctx.lineWidth = 1.4
  ctx.globalAlpha = 0.4
  ctx.beginPath()
  ctx.moveTo(6 * S,  32 * S); ctx.lineTo(58 * S, 32 * S)
  ctx.moveTo(32 * S,  6 * S); ctx.lineTo(32 * S, 58 * S)
  ctx.stroke()
  ctx.globalAlpha = 1.0

  // Survey corner markers (cross ticks)
  ctx.lineWidth = 2.2
  const tick = 6 * S
  for (const [cx, cy] of [[6, 6], [58, 6], [58, 58], [6, 58]] as [number, number][]) {
    ctx.beginPath()
    ctx.moveTo(cx * S - tick, cy * S); ctx.lineTo(cx * S + tick, cy * S)
    ctx.moveTo(cx * S, cy * S - tick); ctx.lineTo(cx * S, cy * S + tick)
    ctx.stroke()
  }
}

// ─── Commercial ─────────────────────────────────────────────────────────
// Modern building block: wide silhouette + column divisions + cornice

function drawCommercial(ctx: CanvasRenderingContext2D) {
  setup(ctx, 2.6)

  // Building outline
  ctx.beginPath()
  ctx.rect(5 * S, 10 * S, 54 * S, 49 * S)
  ctx.fill()
  ctx.stroke()

  // Header / cornice line
  ctx.beginPath()
  ctx.moveTo(5  * S, 18 * S)
  ctx.lineTo(59 * S, 18 * S)
  ctx.stroke()

  // Vertical column divisions
  ctx.lineWidth = 1.6
  ctx.globalAlpha = 0.6
  for (const x of [23, 41]) {
    ctx.beginPath()
    ctx.moveTo(x * S, 10 * S); ctx.lineTo(x * S, 59 * S)
    ctx.stroke()
  }
  ctx.globalAlpha = 1.0

  // Center entrance
  ctx.lineWidth = 2.4
  ctx.beginPath()
  ctx.moveTo(26 * S, 59 * S)
  ctx.lineTo(26 * S, 44 * S)
  ctx.lineTo(38 * S, 44 * S)
  ctx.lineTo(38 * S, 59 * S)
  ctx.moveTo(32 * S, 44 * S)
  ctx.lineTo(32 * S, 59 * S)
  ctx.stroke()

  // Window rows (left column, right column)
  ctx.lineWidth = 1.6
  for (const [col, row] of [[8, 21], [8, 31], [44, 21], [44, 31]]) {
    ctx.strokeRect(col * S, row * S, 11 * S, 8 * S)
  }
}

// ─── Default — tactical diamond ──────────────────────────────────────────

function drawDefault(ctx: CanvasRenderingContext2D) {
  setup(ctx, 2.6)
  const cx = 32 * S, cy = 30 * S, r = 18 * S
  ctx.beginPath()
  ctx.moveTo(cx, cy - r)
  ctx.lineTo(cx + r, cy)
  ctx.lineTo(cx, cy + r)
  ctx.lineTo(cx - r, cy)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(cx, cy, 3.5 * S, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.fill()
}

// ─── Storage — self-storage / warehouse box ───────────────────────────────
// Sectioned box with roll-up door

function drawStorage(ctx: CanvasRenderingContext2D) {
  setup(ctx, 2.4)

  // Outer box
  ctx.beginPath()
  ctx.rect(8 * S, 10 * S, 48 * S, 50 * S)
  ctx.fill()
  ctx.stroke()

  // Roof cap / header
  ctx.beginPath()
  ctx.moveTo(5  * S, 10 * S)
  ctx.lineTo(59 * S, 10 * S)
  ctx.stroke()

  // Horizontal roll-up door slats
  ctx.lineWidth = 1.4
  ctx.globalAlpha = 0.6
  for (const y of [22, 30, 38, 46]) {
    ctx.beginPath()
    ctx.moveTo(8 * S, y * S)
    ctx.lineTo(56 * S, y * S)
    ctx.stroke()
  }
  ctx.globalAlpha = 1.0

  // Door pull handle
  ctx.lineWidth = 2.2
  ctx.beginPath()
  ctx.moveTo(28 * S, 54 * S)
  ctx.lineTo(36 * S, 54 * S)
  ctx.stroke()
}

// ─── Retail / strip center ────────────────────────────────────────────────
// Low wide building with storefronts + awning line

function drawRetail(ctx: CanvasRenderingContext2D) {
  setup(ctx, 2.4)

  // Main building
  ctx.beginPath()
  ctx.rect(4 * S, 16 * S, 56 * S, 44 * S)
  ctx.fill()
  ctx.stroke()

  // Awning line
  ctx.beginPath()
  ctx.moveTo(4  * S, 28 * S)
  ctx.lineTo(60 * S, 28 * S)
  ctx.stroke()

  // Storefront dividers
  ctx.lineWidth = 1.4
  ctx.globalAlpha = 0.55
  for (const x of [22, 40]) {
    ctx.beginPath()
    ctx.moveTo(x * S, 28 * S)
    ctx.lineTo(x * S, 60 * S)
    ctx.stroke()
  }
  ctx.globalAlpha = 1.0

  // Three storefronts
  ctx.lineWidth = 2
  for (const x of [6, 24, 42]) {
    const w = 14 * S
    ctx.strokeRect(x * S, 36 * S, w, 24 * S)
  }
}

// ─── Office building ──────────────────────────────────────────────────────
// Tall narrow tower with horizontal floor bands + window grid

function drawOffice(ctx: CanvasRenderingContext2D) {
  setup(ctx, 2.6)

  // Tower
  ctx.beginPath()
  ctx.rect(18 * S, 4 * S, 28 * S, 56 * S)
  ctx.fill()
  ctx.stroke()

  // Horizontal bands every floor
  ctx.lineWidth = 1.2
  ctx.globalAlpha = 0.45
  for (const y of [14, 24, 34, 44]) {
    ctx.beginPath()
    ctx.moveTo(18 * S, y * S)
    ctx.lineTo(46 * S, y * S)
    ctx.stroke()
  }
  ctx.globalAlpha = 1.0

  // Window pairs per floor
  ctx.lineWidth = 1.6
  for (const [col, row] of [[20, 6], [38, 6], [20, 16], [38, 16], [20, 26], [38, 26], [20, 36], [38, 36]]) {
    ctx.strokeRect(col * S, row * S, 6 * S, 6 * S)
  }

  // Entrance arch
  ctx.lineWidth = 2.4
  const dL = 26 * S, dR = 38 * S, dTop = 52 * S
  const mid = (dL + dR) / 2
  const rad = (dR - dL) / 2
  ctx.beginPath()
  ctx.moveTo(dL, 60 * S)
  ctx.lineTo(dL, dTop + rad)
  ctx.arc(mid, dTop + rad, rad, Math.PI, 0)
  ctx.lineTo(dR, 60 * S)
  ctx.stroke()
}

// ─── Industrial / warehouse ───────────────────────────────────────────────
// Wide flat building with sawtooth roof + loading dock

function drawIndustrial(ctx: CanvasRenderingContext2D) {
  setup(ctx, 2.6)

  // Main structure
  ctx.beginPath()
  ctx.rect(4 * S, 22 * S, 56 * S, 38 * S)
  ctx.fill()
  ctx.stroke()

  // Sawtooth roofline (3 teeth)
  ctx.beginPath()
  ctx.moveTo(4 * S, 22 * S)
  for (const i of [0, 1, 2]) {
    const x = 4 + i * 18.6
    ctx.lineTo((x + 9.3) * S, 8 * S)
    ctx.lineTo((x + 18.6) * S, 22 * S)
  }
  ctx.stroke()

  // Loading dock cutout
  ctx.lineWidth = 2
  ctx.strokeRect(22 * S, 45 * S, 20 * S, 15 * S)

  // Dock bump bumper line
  ctx.lineWidth = 1.4
  ctx.globalAlpha = 0.55
  ctx.beginPath()
  ctx.moveTo(22 * S, 52 * S)
  ctx.lineTo(42 * S, 52 * S)
  ctx.stroke()
  ctx.globalAlpha = 1.0
}

// ─── Hotel / hospitality ──────────────────────────────────────────────────
// Tall tower with many floors, marquee sign, main entrance

function drawHotel(ctx: CanvasRenderingContext2D) {
  setup(ctx, 2.4)

  // Tower block
  ctx.beginPath()
  ctx.rect(14 * S, 4 * S, 36 * S, 56 * S)
  ctx.fill()
  ctx.stroke()

  // Floor bands
  ctx.lineWidth = 1.2
  ctx.globalAlpha = 0.4
  for (const y of [12, 20, 28, 36, 44]) {
    ctx.beginPath()
    ctx.moveTo(14 * S, y * S)
    ctx.lineTo(50 * S, y * S)
    ctx.stroke()
  }
  ctx.globalAlpha = 1.0

  // Window rows
  ctx.lineWidth = 1.4
  for (const [col, row] of [[16, 5], [26, 5], [38, 5], [16, 13], [26, 13], [38, 13], [16, 21], [26, 21], [38, 21], [16, 29], [26, 29], [38, 29]]) {
    ctx.strokeRect(col * S, row * S, 8 * S, 6 * S)
  }

  // Marquee sign
  ctx.lineWidth = 2.2
  ctx.strokeRect(16 * S, 44 * S, 32 * S, 8 * S)

  // Entrance canopy
  ctx.beginPath()
  ctx.moveTo(24 * S, 60 * S)
  ctx.lineTo(24 * S, 52 * S)
  ctx.lineTo(40 * S, 52 * S)
  ctx.lineTo(40 * S, 60 * S)
  ctx.stroke()
}

// ─── Mobile home park / MHP ───────────────────────────────────────────────
// Simple mobile home silhouette + skirt + wheels

function drawMHP(ctx: CanvasRenderingContext2D) {
  setup(ctx, 2.4)

  // Main body — wide shallow rectangle with slight roof pitch
  ctx.beginPath()
  ctx.moveTo(4  * S, 42 * S)   // left base
  ctx.lineTo(4  * S, 24 * S)   // left wall
  ctx.lineTo(16 * S, 14 * S)   // left roof pitch
  ctx.lineTo(48 * S, 14 * S)   // right roof flat
  ctx.lineTo(60 * S, 24 * S)   // right wall
  ctx.lineTo(60 * S, 42 * S)   // right base
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // Windows
  ctx.lineWidth = 1.8
  ctx.strokeRect(10 * S, 24 * S, 10 * S, 8 * S)
  ctx.strokeRect(27 * S, 24 * S, 10 * S, 8 * S)
  ctx.strokeRect(44 * S, 24 * S, 10 * S, 8 * S)

  // Door
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(29 * S, 42 * S)
  ctx.lineTo(29 * S, 34 * S)
  ctx.lineTo(35 * S, 34 * S)
  ctx.lineTo(35 * S, 42 * S)
  ctx.stroke()

  // Skirt / undercarriage
  ctx.lineWidth = 1.4
  ctx.globalAlpha = 0.5
  ctx.strokeRect(6 * S, 42 * S, 52 * S, 6 * S)
  ctx.globalAlpha = 1.0

  // Two wheels
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.arc(20 * S, 48 * S, 5 * S, 0, Math.PI * 2); ctx.stroke()
  ctx.beginPath(); ctx.arc(44 * S, 48 * S, 5 * S, 0, Math.PI * 2); ctx.stroke()
}

// ─── Selected property golden star ───────────────────────────────────────

function drawSelectedStar(ctx: CanvasRenderingContext2D) {
  setup(ctx, 2.4)
  ctx.fillStyle = 'rgba(255,255,255,0.96)'

  const cx = 32 * S, cy = 32 * S
  const outer = 27 * S, inner = 11 * S
  const spikes = 5

  ctx.beginPath()
  for (let i = 0; i < spikes * 2; i++) {
    const angle = (i * Math.PI) / spikes - Math.PI / 2
    const r = i % 2 === 0 ? outer : inner
    const x = cx + r * Math.cos(angle)
    const y = cy + r * Math.sin(angle)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
}

// ─── Loader ───────────────────────────────────────────────────────────────

const DRAW_FNS: Record<PinIconSlug, (ctx: CanvasRenderingContext2D) => void> = {
  sfr:        drawSFR,
  multi:      drawMulti,
  apt:        drawApartment,
  land:       drawLand,
  comm:       drawCommercial,
  storage:    drawStorage,
  retail:     drawRetail,
  office:     drawOffice,
  industrial: drawIndustrial,
  hotel:      drawHotel,
  mhp:        drawMHP,
  default:    drawDefault,
  selected:   drawSelectedStar,
}

type DrawFn = (ctx: CanvasRenderingContext2D) => void

export function loadPropertyIcons(map: maplibregl.Map): void {
  for (const [slug, drawFn] of Object.entries(DRAW_FNS) as [PinIconSlug, DrawFn][]) {
    const name = PIN_ICON[slug]
    if (map.hasImage(name)) continue
    const [canvas, ctx] = makeCanvas()
    drawFn(ctx)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    map.addImage(name, imageData, { sdf: true })
  }
}
