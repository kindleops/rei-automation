import { handleEntityGraphDossierGET, entityGraphDossierOPTIONS } from '../../_dossier-route.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return entityGraphDossierOPTIONS(request)
}

export async function GET(request, { params }) {
  return handleEntityGraphDossierGET(request, 'zip', params.zip)
}