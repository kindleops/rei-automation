// FENCED stand-in for apps/api/src/lib/supabase/client.js (see ../alias-hooks.mjs).
// The original builds a SERVICE-ROLE client from process.env when it is imported. This
// stub holds no credential and reads no environment. Any use of the default client is
// refused, so a service that is not handed the MCP's read-only client fails closed.
const refuse = (what) => Object.assign(new Error(`ambient Supabase client refused (${String(what).slice(0, 40)}): LeadCommand MCP passes its read-only client explicitly`), { code: 'AMBIENT_CLIENT_REFUSED' })

export function hasSupabaseConfig() {
  return false
}

export const supabase = new Proxy(Object.freeze({}), {
  get(_t, prop) {
    if (prop === Symbol.toStringTag) return 'FencedSupabaseClient'
    throw refuse(prop)
  },
  has() { return false },
  set() { throw refuse('set') },
})

export default supabase
