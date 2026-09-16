// Workflow Studio V2 — which node types can put a message in front of a seller.
//
// A leaf module on purpose. The dispatcher in action-executor.js is the
// behavioural authority, but it pulls in the acquisition engine, the SMS engine
// and the queue adapter; the read-only catalog needs the ANSWER, not that graph.
// Keeping the list here lets both sides share one definition without the list
// endpoint importing the executor.
//
// These four are exactly the node types whose execution reaches queue-adapter
// and therefore writes a send_queue row. Every other action mutates internal
// state only.

export const SELLER_FACING_NODE_TYPES = Object.freeze([
  'action.enqueue_sms',
  'action.send_sms',
  'action.enqueue_email',
  'action.send_email',
]);

export function isSellerFacingNodeType(nodeType) {
  return SELLER_FACING_NODE_TYPES.includes(String(nodeType ?? '').trim());
}
