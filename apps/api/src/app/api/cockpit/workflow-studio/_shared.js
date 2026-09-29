import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../_shared.js'

export const withCors = (request, payload, status = 200) => NextResponse.json(payload, { status, headers: corsHeaders(request) })
export const optionsResponse = (request) => new NextResponse(null, { status: 204, headers: corsHeaders(request) })
export const requireAuth = (request) => ensureMutationAuth(request)
export const params = (request) => Object.fromEntries(new URL(request.url).searchParams.entries())
