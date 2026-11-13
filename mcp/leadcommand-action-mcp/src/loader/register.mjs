import { register } from 'node:module'

// LeadCommand is the CRM; the gateway never talks to Podio. Some shared domain modules still import the legacy Podio
// provider; its own kill switch refuses every Podio network call and (with this set) prints no credential warnings.
// Set here, before any app module loads, so no launch path can start the gateway with Podio enabled.
process.env.PODIO_INTEGRATION_DISABLED = '1'

register('./alias-hooks.mjs', import.meta.url)
