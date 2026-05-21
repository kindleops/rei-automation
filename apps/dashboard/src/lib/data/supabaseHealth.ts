import { getSupabaseClient } from '../supabaseClient'

export interface TableHealthResult {
  table: string
  ok: boolean
  hasRows: boolean
  errorMessage: string | null
  possibleRlsIssue: boolean
}

export interface SupabaseHealthResult {
  ok: boolean
  envPresent: boolean
  useSupabaseData: boolean
  tableResults: TableHealthResult[]
}

const RLS_SIGNALS = ['permission denied', 'row-level security', 'policy', 'auth', 'jwt', 'unauthorized']

const isRlsError = (msg: string): boolean => {
  const lower = msg.toLowerCase()
  return RLS_SIGNALS.some((s) => lower.includes(s))
}

const probeTable = async (table: string): Promise<TableHealthResult> => {
  try {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase.from(table).select('*').limit(1)
    if (error) {
      return {
        table,
        ok: false,
        hasRows: false,
        errorMessage: error.message,
        possibleRlsIssue: isRlsError(error.message),
      }
    }
    return {
      table,
      ok: true,
      hasRows: Array.isArray(data) && data.length > 0,
      errorMessage: null,
      possibleRlsIssue: false,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      table,
      ok: false,
      hasRows: false,
      errorMessage: msg,
      possibleRlsIssue: isRlsError(msg),
    }
  }
}

export const checkSupabaseConnection = async (): Promise<SupabaseHealthResult> => {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  const envPresent = Boolean(supabaseUrl && supabaseKey)
  const useSupabaseData = import.meta.env.VITE_USE_SUPABASE_DATA === 'true'

  const tables = ['message_events', 'send_queue', 'properties']
  const tableResults = await Promise.all(tables.map(probeTable))

  const ok = envPresent && tableResults.every((r) => r.ok)

  return { ok, envPresent, useSupabaseData, tableResults }
}
