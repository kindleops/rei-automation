// Action Gateway Tier-2 tool family (docs/ACTION-MCP.md §8). One module per tool; each exports its catalog
// spec and its logic (resolve / params / policy [/ execute]). The catalog and the action-logic table register
// them with one line each.
import * as updateLeadDisposition from './update-lead-disposition.js'
import * as updateLeadTemperature from './update-lead-temperature.js'
import * as updateLeadStage from './update-lead-stage.js'
import * as createDealAction from './create-deal-action.js'
import * as requestThreadHoldRelease from './request-thread-hold-release.js'
import * as scheduleFollowup from './schedule-followup.js'
import * as cancelFollowup from './cancel-followup.js'
import * as pauseCampaign from './pause-campaign.js'
import * as requestCampaignResume from './request-campaign-resume.js'
import * as adjustCampaignPlan from './adjust-campaign-plan.js'

const MODULES = [updateLeadDisposition, updateLeadTemperature, updateLeadStage, createDealAction, requestThreadHoldRelease, scheduleFollowup, cancelFollowup, pauseCampaign, requestCampaignResume, adjustCampaignPlan]

export const T2_SPECS = Object.freeze(MODULES.map((m) => m.spec))
export const T2_NAMES = Object.freeze(new Set(T2_SPECS.map((s) => s.name)))
export const T2_LOGIC = Object.freeze(Object.fromEntries(MODULES.map((m) => [m.spec.name, m.logic])))
/** The T2 actions a standing grant authorizes alone (mirror of the link #27 registry rows, pinned by a test). */
export const T2_STANDING = Object.freeze({
  reversible: Object.freeze(T2_SPECS.filter((s) => s.reversible === true).map((s) => s.name).sort()),
  request_only: Object.freeze(T2_SPECS.filter((s) => s.request_only === true).map((s) => s.name).sort()),
})
export { createT2Services } from './services.js'
