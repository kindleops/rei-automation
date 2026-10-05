/**
 * CRIME TAXONOMY — one vocabulary for every city's own offense words.
 *
 * Each city publishes its own labels (NIBRS categories, IUCR primary types,
 * UCR Part I descriptions…). The Map needs two things from them:
 *
 *   cat   the filter family   violent · property · drugs · other
 *   type  the map glyph       assault · robbery · burglary · theft · vehicle ·
 *                             vandalism · drugs · weapons · other
 *
 * The city's own words always travel with the incident (category, offense);
 * this mapping only chooses a glyph and a filter bucket. It is a label, never
 * a score. Order matters: the first rule that matches wins, so the specific
 * ("theft from motor vehicle", "carjacking", "armed robbery") is checked
 * before the general ("theft", "assault").
 */

export const CRIME_CATS = Object.freeze(['violent', 'property', 'drugs', 'other'])
export const CRIME_TYPES = Object.freeze(['assault', 'robbery', 'burglary', 'theft', 'vehicle', 'vandalism', 'drugs', 'weapons', 'other'])

/** type → cat */
export const TYPE_CAT = Object.freeze({
  assault: 'violent', robbery: 'violent',
  burglary: 'property', theft: 'property', vehicle: 'property', vandalism: 'property',
  drugs: 'drugs',
  weapons: 'other', other: 'other',
})

const RULES = [
  // Robbery first: "armed robbery", "carjacking", "robbery of a business".
  ['robbery', /\brobber|carjack|car jack|hijack/],
  // Vehicle crimes before burglary/theft: "theft from motor vehicle", "burglary of vehicle", "BMV", "UUMV".
  ['vehicle', /motor vehicle|grand theft auto|theft auto|vehicle theft|theft from (a )?(motor )?vehicle|theft of (a )?(motor )?vehicle|from auto|auto theft|stolen (auto|vehicle|car)|burglary of (a )?(motor )?(vehicle|auto)|vehicle burglary|\bbmv\b|\buumv\b|unauthori[sz]ed use of (a )?(motor )?vehicle|vehicle break|catalytic|joyrid|\bgta\b/],
  ['burglary', /burglar|breaking (and|&) entering|\bb ?& ?e\b|break[- ]?in|home invasion|housebreak/],
  // Person crimes: assault, homicide, sex offenses, kidnapping, threats.
  ['assault', /assault|battery|homicide|murder|manslaughter|kidnap|abduct|sex(ual)? (assault|abuse|offense)|\brape\b|sodomy|fondl|intimidat|stalk|human trafficking|offense involving children|crimes? against (a )?person|aggravated|shooting|stabbing|domestic|strangl|threat/],
  ['drugs', /narcotic|\bdrug|controlled substance|marijuana|cannabis|cocaine|heroin|fentanyl|methamphetamine|paraphernalia|opium|possession of (a )?controlled/],
  ['weapons', /weapon|firearm|\bgun|concealed carry|shots fired|ammunition|discharg/],
  ['vandalism', /vandal|criminal damage|criminal mischief|destruction|damage(d)? (to )?property|graffiti|\barson|property damage|defac/],
  ['theft', /theft|larceny|shoplift|pick ?pocket|purse snatch|stolen property|steal|fraud|forgery|counterfeit|embezzl|identity|deceptive|swindl|bad check|credit card|extortion|blackmail/],
]

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim().toLowerCase())

/**
 * The glyph type + filter cat for one incident.
 * @param {{category?:string, offense?:string|null, family?:string}} i
 * @returns {{type:string, cat:string}}
 */
export function classifyCrime({ category, offense, family } = {}) {
  const text = `${clean(category)} | ${clean(offense)}`
  for (const [type, re] of RULES) if (re.test(text)) return { type, cat: TYPE_CAT[type] }
  // Nothing in the city's words matched: fall back to the NIBRS family it publishes.
  if (family === 'person') return { type: 'assault', cat: 'violent' }
  if (family === 'property') return { type: 'other', cat: 'property' }
  return { type: 'other', cat: 'other' }
}

/** A cats query param ("violent,drugs") → a validated Set, or null for "all". */
export function parseCats(raw) {
  if (raw === null || raw === undefined || raw === '' || raw === 'all') return null
  const want = String(raw).split(',').map((s) => s.trim().toLowerCase()).filter((s) => CRIME_CATS.includes(s))
  return want.length && want.length < CRIME_CATS.length ? new Set(want) : null
}
