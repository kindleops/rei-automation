/**
 * The renderers the Universal Inspector knows. Each reads its owning app's
 * existing endpoint (see ./renderers/*); a type without one shows a quiet
 * "open it in its app" note instead of a guessed panel.
 */
import { registerInspector } from './inspector-registry'
import { buyerInspector } from './renderers/buyer'
import { campaignInspector } from './renderers/campaign'
import { closingInspector } from './renderers/closing'
import { dealInspector } from './renderers/deal'
import { propertyInspector } from './renderers/property'
import { sellerInspector } from './renderers/seller'
import { workflowInspector } from './renderers/workflow'

for (const r of [propertyInspector, sellerInspector, campaignInspector, buyerInspector, closingInspector, workflowInspector, dealInspector]) registerInspector(r)
