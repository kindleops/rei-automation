/**
 * Universal object navigation — the public surface (System Refinement 8.2 §2).
 * Import from here, not from the files behind it.
 */
export {
  OBJECT_TYPES,
  asObjectRef,
  buyerObject,
  campaignObject,
  closingObject,
  companyObject,
  dealObject,
  hintOf,
  isObjectType,
  objectCapabilities,
  objectSpec,
  propertyIdOf,
  propertyObject,
  sellerObject,
  workflowObject,
  type MapBehaviour,
  type ObjectCapabilities,
  type ObjectRef,
  type ObjectSource,
  type ObjectType,
  type ObjectTypeSpec,
} from './object-registry'
export {
  MOD_KEY,
  gestureOf,
  handleObjectClick,
  inspectObject,
  objectActions,
  objectAttrs,
  openObject,
  openObjectBeside,
  showOnMap,
  startObjectMission,
  type ObjectAction,
  type ObjectActionId,
  type ObjectActionResult,
  type ObjectActionsOptions,
  type ObjectGesture,
  type ShowOnMapOptions,
} from './object-actions'
export { ObjectMenu, ObjectMenuButton } from './ObjectMenu'
export { objectMenuEntries } from './object-menu-model'
