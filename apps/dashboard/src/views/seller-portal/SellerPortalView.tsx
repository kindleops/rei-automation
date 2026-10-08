import { SellerPortalPanel } from '../../modules/inbox/desk/SellerPortalPanel'
import './seller-portal-view.css'

/**
 * Seller portal conversations as a first-class Inbox destination
 * (/seller-portal). The same panel the desk Inbox shows under More →
 * Seller portal, reachable from every Inbox layout's category rail.
 */
export function SellerPortalView() {
  return (
    <main className="seller-portal-view" aria-label="Seller portal">
      <SellerPortalPanel />
    </main>
  )
}
