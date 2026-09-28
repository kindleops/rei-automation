/**
 * Buyer name privacy — one rule for every surface that shows a W8C buyer.
 *
 * Company names are shown; people are not (serving-layer rule from the W8C
 * integration). Some registry "company" entities carry a bare personal name
 * ("WILLIAMS,MICHAEL" — a sole proprietorship or a mis-typed filer). A name
 * with no business token is withheld exactly like an individual's, whatever
 * the entity type says.
 */
const clean = (v) => String(v ?? '').trim()
export const BUSINESS_TOKEN = /\b(l\.?\s?l\.?\s?c|inc|corp(oration)?|co|company|trust|holdings?|propert(y|ies)|invest(ment|ments|ors?)?|capital|partners(hip)?|l\.?p|ltd|group|realty|homes?|rentals?|ventures?|enterprises?|management|fund|bank|associates|development|builders?|construction|housing|equity|assets?|solutions|acquisitions?|estates?|real estate|financial|services|association|society|federal|national|mortgage|servicing|lending|authority|department|secretary|state|county|city|foundation|church|ministries|llp|pllc|pc|dba)\b/i
export function displayableCompanyName(name) {
  const n = clean(name)
  if (!n) return null
  return BUSINESS_TOKEN.test(n) ? n : null
}

