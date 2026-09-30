/** Runs waiting on a person, with the node that holds them. */
import { getNeedsYou } from '@/lib/domain/workflow-studio/observatory/service.js'
import { optionsResponse, read } from '../_handler.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request) { return read(request, () => getNeedsYou(), 'observatory_needs_you_failed') }
