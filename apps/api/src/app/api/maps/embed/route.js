import { NextResponse } from 'next/server.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ORIGINS = new Set([
  'https://ops.leadcommand.ai',
  'https://nexus-dashboard.vercel.app',
  'http://localhost:5173',
])

function resolveAllowedOrigin(origin) {
  if (!origin) return null
  if (ALLOWED_ORIGINS.has(origin)) return origin
  if (/^https:\/\/nexus-dashboard(-[a-z0-9]+)*\.vercel\.app$/.test(origin)) return origin
  return null
}

function corsHeaders(request) {
  const origin = request.headers.get('origin')
  const allowedOrigin = resolveAllowedOrigin(origin)
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin
  return headers
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const { searchParams } = new URL(request.url)
  const type = String(searchParams.get('type') || 'streetview').toLowerCase()
  const lat = searchParams.get('lat')
  const lng = searchParams.get('lng')
  const address = searchParams.get('address')
  const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_SERVER_KEY

  if (!apiKey) {
    return NextResponse.json({ ok: false, error: 'maps_key_unavailable' }, { status: 503, headers: cors })
  }

  const hasCoords = lat && lng && Math.abs(Number(lat)) > 0.0001 && Math.abs(Number(lng)) > 0.0001
  const location = hasCoords ? `${lat},${lng}` : address
  if (!location) {
    return NextResponse.json({ ok: false, error: 'location_required' }, { status: 400, headers: cors })
  }

  const params = new URLSearchParams({ key: apiKey, location })
  if (type === 'aerial' || type === 'satellite') {
    params.set('center', hasCoords ? `${lat},${lng}` : String(address))
    params.set('zoom', hasCoords ? '19' : '17')
    params.set('maptype', 'satellite')
    const embedUrl = `https://www.google.com/maps/embed/v1/view?${params.toString()}`
    return NextResponse.json({ ok: true, type: 'aerial', embed_url: embedUrl }, { headers: cors })
  }

  params.set('heading', searchParams.get('heading') || '210')
  params.set('pitch', searchParams.get('pitch') || '2')
  params.set('fov', searchParams.get('fov') || '85')
  const embedUrl = `https://www.google.com/maps/embed/v1/streetview?${params.toString()}`
  return NextResponse.json({ ok: true, type: 'streetview', embed_url: embedUrl }, { headers: cors })
}