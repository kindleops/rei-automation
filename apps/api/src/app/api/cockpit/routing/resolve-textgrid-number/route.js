import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { chooseTextgridNumber } from '@/lib/domain/routing/choose-textgrid-number.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }

  try {
    const { searchParams } = new URL(request.url)
    const market_name = searchParams.get('market_name')
    const phone_item_id = searchParams.get('phone_item_id')
    const preferred_language = searchParams.get('preferred_language')
    const first_touch = searchParams.get('first_touch') === 'true'
    const require_local_routing = searchParams.get('require_local_routing') === 'true'
    const rotation_key = searchParams.get('rotation_key')

    const result = await chooseTextgridNumber({
      context: {
        ids: { phone_item_id },
        summary: {
          market_name,
          language_preference: preferred_language,
          first_touch,
          require_local_routing,
        }
      },
      preferred_language,
      rotation_key,
      first_touch,
      require_local_routing,
    })

    return NextResponse.json({ ok: true, data: result }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors }
    )
  }
}
