/**
 * BULK ARCHIVE — reversible archive / unarchive for Inbox threads, Pipeline
 * opportunities and Campaigns through each object's canonical archive state.
 * See lib/domain/archive/bulk-archive-service.js.
 */
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { createBulkArchiveService, createDefaultBulkArchivePorts } from '@/lib/domain/archive/bulk-archive-service.js'
import { createBulkArchiveRoutes } from '@/lib/domain/archive/bulk-archive-routes.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

let service = null
const getService = async () => {
  if (!service) service = createBulkArchiveService(await createDefaultBulkArchivePorts())
  return service
}

const routes = createBulkArchiveRoutes({ getService, authorize: ensureMutationAuth, cors: corsHeaders })

export const OPTIONS = routes.OPTIONS
export const POST = routes.POST
