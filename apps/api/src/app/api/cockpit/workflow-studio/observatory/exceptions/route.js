/** Workflow Observatory exception queue — what needs a person, linked to workflow · run · node · subject. */
import { getExceptions } from '@/lib/domain/workflow-studio/observatory/exceptions.js'
import { optionsResponse, read } from '../_handler.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function OPTIONS(request) { return optionsResponse(request) }
export async function GET(request) { return read(request, () => getExceptions(), 'observatory_exceptions_failed') }
