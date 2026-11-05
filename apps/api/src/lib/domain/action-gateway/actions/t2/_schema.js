// Closed, bounded input-schema pieces shared by the T2 tool specs (validated by agent/tools/schema.js).
import { str } from '../../../../agent/capabilities/defs/_schema.js'

export const CLIENT_KEY = str(80, { minLength: 8, pattern: '^[A-Za-z0-9_.:-]{8,80}$' })
export const ISO_TIME = str(40, { minLength: 10, pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$' })
export const TEXT = (max, min = 1) => str(max, { minLength: min, pattern: '^[^\\u0000-\\u001f\\u007f]+$' })
export const CODE = str(40, { minLength: 2, pattern: '^[a-z][a-z0-9_]{1,39}$' })
export const HHMM = str(5, { minLength: 5, pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' })
export const client = { client_request_id: CLIENT_KEY }
