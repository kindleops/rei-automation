// FENCED stand-in for apps/api/src/lib/supabase/client.js (see ../alias-hooks.mjs). Holds no credential and
// reads no environment. Any use of the default client is refused: a service not handed the gateway's
// lc_action_gateway client fails closed.
const refuse = (what) => Object.assign(new Error(`ambient Supabase client refused (${String(what).slice(0, 40)}): the Action MCP passes its lc_action_gateway client explicitly`), { code: 'AMBIENT_CLIENT_REFUSED' })

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
