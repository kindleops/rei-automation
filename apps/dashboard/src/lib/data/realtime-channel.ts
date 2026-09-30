/**
 * A realtime channel name that is unique to one mount.
 *
 * Supabase's `client.channel(name)` returns the EXISTING channel for a name it has
 * seen, and adding a postgres_changes callback to a channel that already called
 * subscribe() throws — so any subscriber mounted twice (a split pane, a second
 * KPI orb) crashed its whole surface. The suffix is client-side only: the server
 * filter is the postgres_changes binding, not the topic name.
 */
let seq = 0
export const uniqueChannelName = (base: string): string => `${base}:${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`
