/**
 * CONVERSATION SIGNAL — a transparent, deterministic seller-motivation read
 * computed from the messages of ONE thread. Pure: no DB, no network, no LLM.
 *
 * Every point in the score is contributed by a named factor that carries the
 * value it measured and, where a message triggered it, the quoted snippet.
 * Nothing in the output is invented — it is counted, timed or matched.
 *
 * ── What is excluded before anything is measured ────────────────────────────
 *   · rows flagged isTest by the loader, and bodies carrying proof/probe markers
 *   · outbound rows that never reached the seller (failed / send_failed)
 *   · outbound duplicates (same body within 120 s — double-logged sends)
 *   · inbound TAPBACK reactions ("👍 to “…”", "Liked “…”") count as a reply for
 *     responsiveness but carry no words and are never lexicon-scanned (they
 *     quote OUR text)
 *   · inbound AUTO-RESPONDERS ("sorry we missed your call", "I'm driving") are
 *     counted but excluded from every engagement / language measure
 *
 * ── Score (0-100, clamped; `rawScore` keeps the unclamped sum) ─────────────
 *   base                         +25  the seller replied at all
 *   distinct substantive inbound  2 → +6 · 3-4 → +10 · 5+ → +14
 *   avg words / distinct msg      ≥15 → +8 · ≥8 → +5 · ≥4 → +2 · <3 → −3 (≥2 msgs)
 *   median reply time            ≤15m +10 · ≤1h +7 · ≤4h +4 · ≤24h +1 · >24h −2
 *   reply rate (touches ≤72h)     ≥60% +5 · ≥30% +2 · <15% (≥4 touches) −5
 *   seller re-engaged unprompted +6   (inbound with no outbound in prior 72 h,
 *                                      after earlier history)
 *   deal questions               +2 each, cap +6 (identity "who is this" = 0)
 *   named a price                +10
 *   asked for our offer          +8
 *   next step / commitment       +12  (send it, email, tour, contract, close)
 *   property details             +4   (beds/units/roof/condition/occupancy)
 *   timeline talk                +4
 *   urgency language             +6 per message, cap +12
 *   distress, per CATEGORY       +8 each (financial · legal · life_event ·
 *                                      property_burden), cap +20
 *   affirmative replies          +3 each, cap +9
 *   profanity WITHOUT hostility  +2 each, cap +4  (intensity, see below)
 *   late-night replies           +2   (≥30% of ≥3 replies 22:00-05:00 local)
 *   work-hours replies           +1   (≥50% of ≥3 replies Mon-Fri 09-17 local)
 *   trend accelerating           +4 · cooling −8
 *   silence while we wait        >3d −2 · >7d −5 · >14d −10 · >30d −15 · >90d −20
 *                                 (when the LAST message is ours)
 *   seller's last msg unanswered >14d −4 · >30d −8 · >90d −12 (the seller
 *                                 spoke last; motivation still decays)
 *   refusal ("not interested",   −20 if in the seller's latest 2 substantive
 *     "not for sale", "no vendo")      messages, else −6 (later re-engaged)
 *   classifier-only refusal      −5   (stored intent not_interested, text did
 *                                      not confirm — the classifier is noisy)
 *   flat "No" / "Nope"           −20 if the seller's last word · −10 if 2nd-last
 *                                 · else −2
 *   hostility                    −15 per message, cap −35
 *   profanity WITH hostility     −5 per message (on top of the hostility)
 *
 * PROFANITY is ambiguous: "fuck off" is hostility, "I'm so f***ing tired of
 * this house" is intensity (frustration often IS the motivation). So a
 * profane message that also matches the hostility lexicon is scored
 * negative; a profane message with no hostility is a small positive
 * intensity signal. Both are counted in language.profanity.
 *
 * ── Bands ────────────────────────────────────────────────────────────────
 *   no_reply   zero inbound (score null)
 *   opted_out  STOP/remove-me text, transport is_opt_out, or stored intent
 *              opt_out — unless a LATER inbound is an explicit START/UNSTOP.
 *              score capped at 5.
 *   hostile    hostility in the latest substantive message, or hostile
 *              messages ≥ half of substantive inbound. score capped at 15.
 *   cold       wrong number (text or stored intent) caps score at 10;
 *              "not the owner / sold it" caps at 15; seller's LAST substantive
 *              message a refusal / flat No caps at 19; else score < 20
 *   lukewarm   20-39 · engaged 40-54 · warm 55-74 · hot ≥75
 *
 * Confidence: DISTINCT substantive inbound ≥6 high · ≥3 medium · else low.
 * TIMING is reported in the seller's timezone when one is supplied (IANA or
 * the app's 'Eastern'/'Central'/… labels); otherwise in UTC, labelled so.
 */

export const CONVERSATION_SIGNAL_VERSION = 'conversation_signal_v1'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const REPLY_WINDOW = 72 * HOUR
const TOUCH_COLLAPSE = 10 * MIN

const TZ_LABELS = {
  eastern: 'America/New_York',
  central: 'America/Chicago',
  mountain: 'America/Denver',
  pacific: 'America/Los_Angeles',
  hawaii: 'Pacific/Honolulu',
  alaska: 'America/Anchorage',
  arizona: 'America/Phoenix',
}

// ── Lexicons (case-insensitive; \b word boundaries; Spanish basics) ────────
const rx = (parts) => new RegExp(parts.join('|'), 'i')

const TEST_MARKERS = rx([String.raw`\[internal live proof`, String.raw`\bcontext probe\b`, String.raw`\bcertification probe\b`])

const REACTION = rx([
  String.raw`^\s*[​\s]*\S{1,4}[​\s]*\s+to\s+[“"]`,
  String.raw`^\s*(liked|loved|laughed at|emphasized|questioned|disliked|reacted \S+ to)\s+[“"]`,
  String.raw`^\s*(le gustó|le encantó|se rió de|enfatizó|cuestionó)\s+[“"]`,
])

const AUTO_RESPONDER = rx([
  String.raw`\bmissed your call\b`,
  String.raw`\bautomated (message|reply|response|text)\b`,
  String.raw`\bauto[- ]?reply\b`,
  String.raw`\bi('m| am) (currently )?(driving|away|out of (the )?office)\b`,
  String.raw`\b(this (number|line|mailbox) is not monitored)\b`,
  String.raw`\breply stop to\b`,
])

const PROFANITY = rx([
  String.raw`\bf+u+c+k\w*`, String.raw`\bf\*+\w*`, String.raw`\bshit\w*`, String.raw`\bdamn\w*`, String.raw`\bhell\b`,
  String.raw`\bass(hole)?s?\b`, String.raw`\bbitch\w*`, String.raw`\bbastard\w*`, String.raw`\bcrap\b`, String.raw`\bwtf\b`, String.raw`\bstfu\b`,
  String.raw`\bpiss(ed)?\b`, String.raw`\bscum\w*`,
  String.raw`\bmierda\b`, String.raw`\bcabr[oó]n\w*`, String.raw`\bching\w*`, String.raw`\bpendej\w*`, String.raw`\bput[ao]s?\b`,
  String.raw`\bculo\b`, String.raw`\bpinche\w*`, String.raw`\bcarajo\b`, String.raw`\bperras?\b`, String.raw`\bno mames\b`,
])

const HOSTILITY = rx([
  String.raw`\bharass\w*`, String.raw`\bscam\w*`, String.raw`\bspam\w*`, String.raw`\bleave me alone\b`,
  String.raw`\blose (this|my) (number|#)\b`, String.raw`\bf+u+c+k (off|you|u|no)\b`, String.raw`\b(sick|tired|tire) of (you|u|your|ur)\b`, String.raw`\bgo to hell\b`, String.raw`\bscum\w*`,
  String.raw`\bvultures?\b`, String.raw`\bpredator\w*`, String.raw`\bnone of your (damn |fucking )?business\b`, String.raw`\bwhat (\w+ )?business (is it |it )?of yours\b`,
  String.raw`\bdon'?t give a (damn|fuck|shit)\b`, String.raw`\b(stupid|idiot\w*|moron\w*|nos(e)?y|jerks?|losers?|clowns?|creeps?|creepy)\b`, String.raw`\b(do not|don'?t) bother me\b`,
  String.raw`\breport(ed)? (you|for)\b`, String.raw`\blegal action\b`, String.raw`\bsue (you|u)\b`, String.raw`\bdrop dead\b`,
  String.raw`\bhope you die\b`, String.raw`\bpiss off\b`, String.raw`\bget lost\b`, String.raw`\bhow did you get (my|this) (number|#)\b`,
  String.raw`\bstop (f\w+ )?(texting|calling|contacting|messaging|harassing|bothering)\b`,
  String.raw`\bvete a (la mierda|tomar)\b`, String.raw`\bd[eé]jame en paz\b`, String.raw`\bdeja de (molestar|escribir|mandar)\b`,
  String.raw`\bno me molest\w*`, String.raw`\bacos\w*`, String.raw`\bqu[eé] (chingaos|carajos?) te importa\b`, String.raw`\bno mames\b`,
])

const OPT_OUT = rx([
  String.raw`^\s*(stop|stopall|unsubscribe|cancel|end|quit|remove)\s*[.!]*\s*$`,
  String.raw`\bstop (f\w+ )?(texting|messaging|contacting|sending|calling)\b`,
  String.raw`\bremove (me|my (name|number|#))\b`, String.raw`\btake me off\b`, String.raw`\b(do not|don'?t) bother me again\b`, String.raw`\b\w*move me (from|off)\b`, String.raw`\b(from|off) (all )?(of )?(your|you|ur) (mailing |contact |call |text )?lists?\b`,
  String.raw`\b(do not|don'?t|dont) (text|contact|message|call) (me|this)\b`, String.raw`\bunsubscribe\b`,
  String.raw`\bdeja de (escribir|mandar|enviar)\w*`, String.raw`\bno me (escrib|mand|contact)\w*`, String.raw`\bqu[ií]tame\b`, String.raw`\bb[oó]rrame\b`,
])
const RESUBSCRIBE = /^\s*(start|unstop|yes start)\s*[.!]*\s*$/i

const WRONG_NUMBER = rx([
  String.raw`\bwrong (number|#|person)\b`, String.raw`\byou have the wrong\b`, String.raw`\bno one by that name\b`,
  String.raw`\bn[uú]mero equivocado\b`, String.raw`\bno es (mi|el) n[uú]mero\b`, String.raw`\bthis is not \w+'?s? (number|phone)\b`,
  String.raw`\bno longer \w+'?s? number\b`, String.raw`\bya no es el n[uú]mero\b`,
])

const NOT_OWNER = rx([
  String.raw`\bi (do not|don'?t) own\b`, String.raw`\bno longer own\b`, String.raw`\bnot the owner\b`, String.raw`\bnever owned\b`,
  String.raw`\b(i|we) sold (it|that|this|the (house|property|home))\b`, String.raw`\bsold (it )?(\w+ )?years ago\b`, String.raw`\bsold to the\b`, String.raw`^\s*sold\b`, String.raw`\b(was|been|already|just|got) sold\b`,
  String.raw`\bsold (it |that |this )?(a few|a couple|last|\d+) (days?|weeks?|months?|years?|year)\b`,
  String.raw`\bno (soy|somos) (el|la|los) due[nñ]\w*`, String.raw`\bya (la|lo) vend[ií]\w*`,
])

const NOT_INTERESTED = rx([
  String.raw`\bnot interested\b`, String.raw`\bno interest\b`, String.raw`\bnot (for|4) (sale|sell)\b`, String.raw`\bnot (for )?rent or sale\b`,
  String.raw`\bnot selling\b`, String.raw`\bnot looking to sell\b`, String.raw`\bnot (going|planning|trying) to sell\b`, String.raw`\bno thanks?( you)?\b`,
  String.raw`\bnot at this time\b`, String.raw`\bnever sell\b`, String.raw`\bnot (willing|ready) to sell\b`, String.raw`\b(i'?m|we'?re) keeping (it|the)\b`,
  String.raw`\bno vend\w*`, String.raw`\bno (estoy|estamos) interesad\w*`, String.raw`\bno me interesa\b`, String.raw`\bno (est[aá]) (a la venta|en venta)\b`,
  String.raw`\bno gracias\b`, String.raw`\bde vender no\b`, String.raw`\b(hell|heck|fuck|f\*+k) no\b`, String.raw`\bno (pienso|quiero) vender\b`,
])
const FLAT_NO = /^\s*(no|nope|nah|no sir|no ma'?am)\s*[.!]*\s*$/i
// "Claro que no" = "of course not": never an affirmation, counted negative (0 pts on its own).
const SPANISH_NEGATION = /\bclaro (que |q )?no\b/i

const AFFIRMATIVE = rx([
  String.raw`^\s*(yes|yeah|yep|yup|sure|ok|okay|k|si|sí|claro|correct|i do|i would|we do|we would)\b`,
  String.raw`\binterested\b`, String.raw`\bopen to\b`, String.raw`\bwould consider\b`, String.raw`\bsounds good\b`, String.raw`\bperfect\b`,
  String.raw`\blet'?s (do|talk|go)\b`, String.raw`\bme interesa\b`, String.raw`\b(estoy|estamos) vendiendo\b`, String.raw`\b(la|lo) vendo\b`, String.raw`\bquiero vender\b`, String.raw`\bi could use\b`, String.raw`\bgood to go\b`,
])

const ASKS_OFFER = rx([
  String.raw`\b(what'?s|what is|what would be|whats) (your|the|ur) (offer|number|price|proposal)\b`,
  String.raw`\bhow much (would|will|can|could|do) (you|u)\b`, String.raw`\bwhat (would|will|can|could) (you|u) (pay|offer|give)\b`,
  String.raw`\bmake (me )?an offer\b`, String.raw`\b(give|send) (me )?(an|your|a) (offer|number)\b`,
  String.raw`\bcu[aá]nto (me )?(ofrece|ofreces|pagar|paga|da|das)\w*`, String.raw`\bsu oferta\b`, String.raw`\btu oferta\b`,
])

const COMMITMENT = rx([
  String.raw`\bsend (it|me|over|the|them|that)\b`, String.raw`\b[\w.+-]+@[\w-]+\.[\w.]+\b`, String.raw`\bmy email\b`,
  String.raw`\bmove forward\b`, String.raw`\blet'?s do (it|this)\b`, String.raw`\b(we have|it'?s) a deal\b`, String.raw`\bsign(ed|ing|s)?\b`,
  String.raw`(?<!under )\b(agreement|contract)\b`, String.raw`\btour\b`, String.raw`\bwalk ?through\b`, String.raw`\bcome (by|see|look)\b`,
  String.raw`\bmeet (at|you|me|up)\b`, String.raw`\bcheck out the (house|property|place)\b`, String.raw`\bproof of funds\b`,
  String.raw`\bgood to go\b`, String.raw`\bcall me\b`, String.raw`\bll(á|a)mame\b`,
])

const PROPERTY_DETAILS = rx([
  String.raw`\b\d+\s*(bed|beds|bd|br|bedrooms?|bath|baths|ba|units?|sq ?ft|sqft|square feet)\b`, String.raw`\bbedrooms?\b`, String.raw`\bbathrooms?\b`,
  String.raw`\broof\b`, String.raw`\bhvac\b`, String.raw`\bfurnace\b`, String.raw`\bfoundation\b`, String.raw`\bcondition\b`, String.raw`\bremodel\w*`,
  String.raw`\brenovat\w*`, String.raw`\bupdated\b`, String.raw`\boccupied\b`, String.raw`\bvacant\b`, String.raw`\btenant\w*`, String.raw`\brent(ed|ing|s)?\b`,
  String.raw`\bappliances\b`, String.raw`\btecho\b`, String.raw`\brec[aá]maras?\b`, String.raw`\bcuartos\b`, String.raw`\brent[aá]ndose\b`, String.raw`\bremodelaci[oó]n\b`,
])

const TIMELINE = rx([
  String.raw`\b(\d+|few|couple( of)?|a) (days?|weeks?|months?)\b`, String.raw`\bthis (week|month|year)\b`, String.raw`\bnext (week|month|year)\b`,
  String.raw`\bby (the )?end of\b`, String.raw`\bclos(e|ing) (by|in|on|date)\b`, String.raw`\btimeline\b`, String.raw`\bwhen can (you|we)\b`,
  String.raw`\b(pr[oó]xima|esta) semana\b`, String.raw`\b(\d+) d[ií]as\b`,
])

const URGENCY = rx([
  String.raw`\basap\b`, String.raw`\burgent\w*`, String.raw`\bquickly\b`, String.raw`\bquick (sale|close|closing|cash)\b`, String.raw`\bsell (it )?quick\b`, String.raw`\bfast\b`, String.raw`\bright away\b`, String.raw`\bimmediately\b`,
  String.raw`\b(need|have|got) to sell\b`, String.raw`\bmust sell\b`, String.raw`\bas soon as (possible|you can)\b`, String.raw`\bmoves? quickly\b`,
  String.raw`\burgente\b`, String.raw`\br[aá]pido\b`, String.raw`\blo antes posible\b`, String.raw`\bnecesito vender\b`, String.raw`\btengo que vender\b`,
])

const DISTRESS = {
  financial: rx([
    String.raw`\bforeclos\w*`, String.raw`\bbehind on\b`, String.raw`\bback taxes\b`, String.raw`\btax lien\b`, String.raw`\bcan'?t afford\b`, String.raw`\bcannot afford\b`,
    String.raw`\bbankrupt\w*`, String.raw`\bneed (the )?(cash|money)\b`, String.raw`\bunderwater\b`, String.raw`\bowe more\b`, String.raw`\blate on (the )?(payments?|mortgage)\b`,
    String.raw`\blost my job\b`, String.raw`\bmedical bills\b`, String.raw`\bin debt\b`, String.raw`\bbills\b`,
    String.raw`\bejecuci[oó]n hipotecaria\b`, String.raw`\batrasad[oa]s? en\b`, String.raw`\bnecesito (el )?dinero\b`, String.raw`\bdeudas?\b`,
  ]),
  legal: rx([
    String.raw`\bprobate\b`, String.raw`\bliens?\b`, String.raw`\bcode violation\w*`, String.raw`\bcourt\b`, String.raw`\blawsuit\b`, String.raw`\bjudg(e)?ment\b`,
    String.raw`\bestate attorney\b`, String.raw`\bexecutor\b`, String.raw`\btitle (issue|problem)s?\b`, String.raw`\bsucesi[oó]n\b`, String.raw`\btestamento\b`,
  ]),
  life_event: rx([
    String.raw`\bdivorc\w*`, String.raw`\bpassed away\b`, String.raw`\bdied\b`, String.raw`\bdeceased\b`, String.raw`\binherit\w*`, String.raw`(?<!real\s)\bestate\b`,
    String.raw`\brelocat\w*`, String.raw`\bmoving (out|to|away)\b`, String.raw`\bjob transfer\b`, String.raw`\bretir\w*`, String.raw`\bnursing home\b`, String.raw`\bassisted living\b`,
    String.raw`\bhealth (issues?|problems?)\b`, String.raw`\bdivorcio\b`, String.raw`\bfalleci\w*`, String.raw`\bherencia\b`, String.raw`\bhered[eé]\w*`, String.raw`\bmud[aá]ndo\w*`,
  ]),
  property_burden: rx([
    String.raw`\bevict\w*`, String.raw`\b(bad|problem|nightmare) tenants?\b`, String.raw`\b(won'?t|don'?t|doesn'?t|not|stopped) pay(ing)? (the )?rent\b`, String.raw`\bsquatters?\b`,
    String.raw`\bvacant\b`, String.raw`\b(sitting|currently|house is) empty\b`, String.raw`\bempty of tenants\b`, String.raw`\bneeds? (a lot of )?(work|repairs?|fixing)\b`, String.raw`\brepairs?\b`,
    String.raw`\bfixer\b`, String.raw`\bfix(ing)?\b`, String.raw`\b(fire|water|storm|flood) damage\b`, String.raw`\bmold\b`, String.raw`\bfoundation (issues?|problems?)\b`, String.raw`\broof leak\w*`,
    String.raw`\btired of (being|dealing|managing|renting|landlording|it|the (house|property|place|tenants?))\b`, String.raw`\bheadache\b`, String.raw`\btoo much (work|to handle)\b`, String.raw`\bcan'?t keep up\b`, String.raw`\bcansad[oa]\b`, String.raw`\bdesocupad[oa]\b`,
  ]),
}
const DISTRESS_LABEL = { financial: 'financial', legal: 'legal', life_event: 'life event', property_burden: 'property burden' }

const IDENTITY_QUESTION = /\b(who('?s| is| are) (this|you|in this)|qui[eé]n (es|eres|habla))\b/i
const QUESTION_START = /^\s*(what|how|when|where|why|who|can|could|do|does|did|are|is|would|will|qu[eé]|c[oó]mo|cu[aá]ndo|cu[aá]nto|d[oó]nde|por qu[eé])\b/i

const NEGATION_BEFORE = /\b(no|not|never|sin|zero|without|nothing)\s+(\w+\s+)?$/i

// ── helpers ───────────────────────────────────────────────────────────────
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const ts = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null }
const quote = (s) => { const c = clean(s); return c.length > 140 ? `${c.slice(0, 137)}…` : c }
const words = (s) => clean(s).split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10)
const fmtMinutes = (m) => { if (m === null) return '—'; if (m < 1) return `${Math.round(m * 60)}s`; if (m < 60) return `${Math.round(m)}m`; if (m < 1440) return `${round1(m / 60)}h`; return `${round1(m / 1440)}d` }
const pct = (x) => `${Math.round(x * 100)}%`

/** Match honouring a simple preceding negation ("no liens", "not vacant"). */
function matchUnnegated(re, text) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  for (const m of text.matchAll(g)) {
    const before = text.slice(Math.max(0, m.index - 16), m.index)
    if (!NEGATION_BEFORE.test(before)) return m[0]
  }
  return null
}

export function resolveTimezone(tz) {
  const raw = clean(tz)
  if (!raw) return null
  const mapped = TZ_LABELS[raw.toLowerCase()] || raw
  try { new Intl.DateTimeFormat('en-US', { timeZone: mapped }); return mapped } catch { return null }
}

function localParts(ms, tz) {
  const d = new Date(ms)
  if (!tz) return { hour: d.getUTCHours(), weekday: d.getUTCDay(), date: d.toISOString().slice(0, 10) }
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' })
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]))
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday]
  return { hour: Number(p.hour) % 24, weekday: wd, date: `${p.year}-${p.month}-${p.day}` }
}

/** Seller-stated prices: $-prefixed, k/m/mil-suffixed, or comma/dot-grouped ≥ 10,000. */
export function extractPrices(text) {
  const out = []
  const s = clean(text)
  if (/\b(a|one) million\b/i.test(s)) out.push(1_000_000)
  const re = /(\$)?\s?(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s?(k|m|mil|million|thousand)?(?![\w])/gi
  for (const m of s.matchAll(re)) {
    const [, dollar, numRaw, suffixRaw] = m
    const suffix = (suffixRaw || '').toLowerCase()
    const grouped = /[,.]\d{3}$/.test(numRaw) && /^\d{1,3}([,.]\d{3})+$/.test(numRaw)
    let n = grouped ? Number(numRaw.replace(/[,.]/g, '')) : Number(numRaw)
    if (!Number.isFinite(n)) continue
    if (suffix === 'k' || suffix === 'mil' || suffix === 'thousand') n *= 1000
    else if (suffix === 'm' || suffix === 'million') n *= 1_000_000
    if (!dollar && !suffix && !grouped) continue
    if (n >= 10_000 && n <= 50_000_000) out.push(Math.round(n))
  }
  return [...new Set(out)]
}

function normalize(messages) {
  const rows = []
  for (const m of Array.isArray(messages) ? messages : []) {
    const at = ts(m?.created_at ?? m?.at)
    if (at === null) continue
    const dir = clean(m.direction).toLowerCase()
    const direction = dir.startsWith('in') ? 'inbound' : dir.startsWith('out') ? 'outbound' : null
    if (!direction) continue
    const body = clean(m.message_body ?? m.body)
    if (m.isTest || TEST_MARKERS.test(body) || /proof/i.test(clean(m.event_type))) continue
    if (direction === 'outbound') {
      const status = clean(m.delivery_status).toLowerCase()
      if (status === 'failed' || /failed/i.test(clean(m.event_type))) continue
    }
    rows.push({ at, direction, body, intent: clean(m.detected_intent ?? m.intent).toLowerCase() || null, isOptOut: m.is_opt_out === true })
  }
  rows.sort((a, b) => a.at - b.at)
  // Drop double-logged outbound sends (same body within 120 s).
  const deduped = []
  for (const r of rows) {
    if (r.direction === 'outbound' && deduped.some((p) => p.direction === 'outbound' && p.body === r.body && Math.abs(r.at - p.at) < 120_000)) continue
    deduped.push(r)
  }
  return deduped
}

function bandFromScore(score) {
  if (score >= 75) return 'hot'
  if (score >= 55) return 'warm'
  if (score >= 40) return 'engaged'
  if (score >= 20) return 'lukewarm'
  return 'cold'
}

/**
 * @param {Array<object>} messages  message_events-like rows (direction, message_body, created_at, detected_intent|intent, delivery_status, event_type, is_opt_out, isTest)
 * @param {{ now?: number|string|Date, timezone?: string|null }} [opts]
 */
export function analyzeConversation(messages, opts = {}) {
  const now = opts.now instanceof Date ? opts.now.getTime() : (ts(opts.now) ?? (Number.isFinite(opts.now) ? opts.now : Date.now()))
  const tz = resolveTimezone(opts.timezone)
  const rows = normalize(messages)

  const inbound = rows.filter((r) => r.direction === 'inbound')
  const outbound = rows.filter((r) => r.direction === 'outbound')
  for (const r of inbound) {
    r.reaction = REACTION.test(r.body)
    r.auto = !r.reaction && AUTO_RESPONDER.test(r.body)
    r.words = r.reaction || r.auto ? 0 : words(r.body)
    r.scan = r.reaction || r.auto ? '' : r.body
    r.substantive = !r.reaction && !r.auto && r.body.length > 0
  }
  const substantive = inbound.filter((r) => r.substantive)
  // A seller re-sending the same text ("Yes I own it" ×8, usually because nobody answered)
  // is one statement: repeats are counted but never add volume, length or affirmation points.
  const seenBodies = new Set()
  for (const r of substantive) {
    const key = r.body.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    r.repeat = seenBodies.has(key)
    seenBodies.add(key)
  }
  const distinct = substantive.filter((r) => !r.repeat)

  const intents = {}
  for (const r of inbound) if (r.intent) intents[r.intent] = (intents[r.intent] || 0) + 1

  const timingBase = { hourBuckets: Array(24).fill(0), share: { morning: 0, workday: 0, evening: 0, lateNight: 0 }, weekendShare: 0, timezone: tz || 'UTC', timezoneSource: tz ? 'seller' : 'utc_fallback' }

  if (!inbound.length) {
    const lastOut = outbound.at(-1)
    return {
      version: CONVERSATION_SIGNAL_VERSION,
      counts: { inbound: 0, substantiveInbound: 0, reactions: 0, autoReplies: 0, outbound: outbound.length, distinctInbound: 0, repeatedInbound: 0, inboundWords: 0, avgWordsPerInbound: null, questionsAsked: 0, daysActive: 0 },
      responsiveness: { medianReplyMinutes: null, fastestReplyMinutes: null, replyRate: outbound.length ? 0 : null, touches: countTouches(outbound), lastInboundAt: null, lastOutboundAt: lastOut ? new Date(lastOut.at).toISOString() : null, silenceDays: null, awaitingUs: false, trend: null },
      timing: timingBase,
      language: { profanity: 0, hostility: 0, urgency: 0, distress: { financial: 0, legal: 0, life_event: 0, property_burden: 0 }, priceMentions: [], positive: 0, negative: 0, optOut: 0, wrongNumber: 0, notOwner: 0 },
      intents,
      score: null,
      rawScore: null,
      band: 'no_reply',
      factors: outbound.length ? [{ key: 'no_reply', label: 'No reply yet', value: `${outbound.length} message${outbound.length === 1 ? '' : 's'} sent, 0 replies`, points: 0 }] : [],
      confidence: 'low',
    }
  }

  // ── Responsiveness: collapse outbound bursts into touches, pair replies ──
  const touches = []
  for (const r of outbound) {
    const last = touches.at(-1)
    if (last && r.at - last.lastAt <= TOUCH_COLLAPSE && !inbound.some((i) => i.at > last.lastAt && i.at < r.at)) last.lastAt = r.at
    else touches.push({ at: r.at, lastAt: r.at, answeredAt: null })
  }
  for (let i = 0; i < touches.length; i++) {
    const t = touches[i]
    const nextAt = touches[i + 1]?.at ?? Infinity
    const reply = inbound.find((m) => m.at > t.lastAt && m.at < nextAt)
    if (reply && reply.at - t.lastAt <= REPLY_WINDOW) t.answeredAt = reply.at
  }
  const latencies = touches.filter((t) => t.answeredAt).map((t) => (t.answeredAt - t.lastAt) / MIN)
  const medianReply = median(latencies)
  const fastestReply = latencies.length ? Math.min(...latencies) : null
  const replyRate = touches.length ? touches.filter((t) => t.answeredAt).length / touches.length : null

  const lastIn = inbound.at(-1)
  const lastMsg = rows.at(-1)
  const awaitingUs = lastMsg.direction === 'inbound'
  const silenceDays = (now - lastIn.at) / DAY

  // Trend: reply latency, first half vs second half (needs ≥4 measured replies).
  let trend = null
  if (latencies.length >= 4) {
    const h = latencies.length >> 1
    const a = median(latencies.slice(0, h)), b = median(latencies.slice(latencies.length - h))
    // Ratios on tiny latencies are noise (1m → 3m is not cooling): require absolute weight.
    trend = b <= a * 0.5 && a >= 60 ? 'accelerating' : b >= a * 2 && b >= 240 ? 'cooling' : 'steady'
  }
  const inboundGaps = []
  for (let i = 1; i < inbound.length; i++) inboundGaps.push(inbound[i].at - inbound[i - 1].at)
  const typicalGap = median(inboundGaps)
  if (!awaitingUs && inbound.length >= 3 && typicalGap !== null && now - lastIn.at > Math.max(7 * DAY, 3 * typicalGap)) trend = 'cooling'

  // ── Timing ──
  const timing = { ...timingBase, hourBuckets: Array(24).fill(0) }
  let weekend = 0, workHours = 0
  const activeDays = new Set()
  for (const r of inbound) {
    const p = localParts(r.at, tz)
    timing.hourBuckets[p.hour]++
    activeDays.add(p.date)
    if (p.weekday === 0 || p.weekday === 6) weekend++
    if (p.weekday >= 1 && p.weekday <= 5 && p.hour >= 9 && p.hour < 17) workHours++
    const k = p.hour >= 5 && p.hour < 9 ? 'morning' : p.hour >= 9 && p.hour < 17 ? 'workday' : p.hour >= 17 && p.hour < 22 ? 'evening' : 'lateNight'
    timing.share[k]++
  }
  for (const k of Object.keys(timing.share)) timing.share[k] = Math.round((timing.share[k] / inbound.length) * 100) / 100
  timing.weekendShare = Math.round((weekend / inbound.length) * 100) / 100

  // ── Language ──
  const lang = { profanity: 0, hostility: 0, urgency: 0, distress: { financial: 0, legal: 0, life_event: 0, property_burden: 0 }, priceMentions: [], positive: 0, negative: 0, optOut: 0, wrongNumber: 0, notOwner: 0 }
  const hits = { hostile: [], profaneHostile: [], profaneOnly: [], urgency: [], distress: {}, refusal: [], flatNo: [], affirm: [], optOut: [], wrong: [], notOwner: [], price: null, asksOffer: null, commitment: null, details: null, timeline: null, dealQuestions: [], reengaged: null }
  let questionsAsked = 0
  const isIso = (r) => new Date(r.at).toISOString()
  const ev = (r) => ({ quote: quote(r.body), at: isIso(r) })

  for (const r of inbound) {
    if (r.isOptOut) { lang.optOut++; hits.optOut.push({ r, via: 'transport' }) }
    if (!r.substantive) continue
    const t = r.scan
    const hostile = HOSTILITY.test(t)
    const profane = PROFANITY.test(t)
    const optOut = OPT_OUT.test(t)
    const refusal = NOT_INTERESTED.test(t)
    const wrong = WRONG_NUMBER.test(t)
    const notOwner = NOT_OWNER.test(t)
    if (hostile) { lang.hostility++; hits.hostile.push(r) }
    if (optOut && !r.isOptOut) { lang.optOut++; hits.optOut.push({ r, via: 'text' }) }
    if (wrong) { lang.wrongNumber++; hits.wrong.push({ r, via: 'text' }) }
    if (notOwner) { lang.notOwner++; hits.notOwner.push(r) }
    const esNeg = SPANISH_NEGATION.test(t)
    if (refusal) { lang.negative++; hits.refusal.push(r) } else if (FLAT_NO.test(t)) { lang.negative++; hits.flatNo.push(r) } else if (esNeg) lang.negative++
    const negativeMsg = hostile || optOut || refusal || wrong || notOwner || esNeg || FLAT_NO.test(t)
    // Profanity: hostile context → negative; inside a refusal → counted, 0 pts; otherwise → intensity.
    if (profane) { lang.profanity++; if (hostile) hits.profaneHostile.push(r); else if (!negativeMsg) hits.profaneOnly.push(r) }
    if (!negativeMsg && AFFIRMATIVE.test(t)) { lang.positive++; if (!r.repeat) hits.affirm.push(r) }
    if (!negativeMsg && matchUnnegated(URGENCY, t)) { lang.urgency++; hits.urgency.push(r) }
    for (const [cat, re] of Object.entries(DISTRESS)) {
      if (matchUnnegated(re, t)) { lang.distress[cat]++; if (!hits.distress[cat]) hits.distress[cat] = r }
    }
    const prices = extractPrices(t)
    if (prices.length) { lang.priceMentions.push(...prices); if (!hits.price) hits.price = r }
    const asks = ASKS_OFFER.test(t)
    if (!hits.asksOffer && asks) hits.asksOffer = r
    if (!negativeMsg && !asks && !hits.commitment && COMMITMENT.test(t)) hits.commitment = r
    if (!hits.details && matchUnnegated(PROPERTY_DETAILS, t)) hits.details = r
    if (!hits.timeline && TIMELINE.test(t)) hits.timeline = r
    const isQuestion = t.includes('?') || QUESTION_START.test(t)
    if (isQuestion) {
      questionsAsked++
      if (!IDENTITY_QUESTION.test(t) && !negativeMsg && r.words >= 2) hits.dealQuestions.push(r)
    }
  }
  lang.priceMentions = [...new Set(lang.priceMentions)]
  // Stored-intent corroboration (the classifier column; noisy, so it never adds text-level points on its own except where noted).
  for (const r of inbound) {
    if (r.intent === 'opt_out' && !hits.optOut.some((h) => h.r === r)) { lang.optOut++; hits.optOut.push({ r, via: 'classifier' }) }
    if (r.intent === 'wrong_number' && !hits.wrong.some((h) => h.r === r)) { lang.wrongNumber++; hits.wrong.push({ r, via: 'classifier' }) }
    if (r.intent === 'asks_offer' && !hits.asksOffer && r.substantive) hits.asksOffer = r
  }
  // Seller re-engaged on their own: inbound with no outbound in the prior 72 h, after earlier history.
  for (const r of substantive) {
    const prior = rows.filter((x) => x.at < r.at)
    if (!prior.length) continue
    if (!outbound.some((o) => o.at < r.at && r.at - o.at <= REPLY_WINDOW) && !prior.slice(-1).some((p) => p.direction === 'inbound' && r.at - p.at < REPLY_WINDOW)) { hits.reengaged = r; break }
  }

  // ── Factors ──
  const factors = []
  const add = (key, label, value, points, r) => { if (points !== 0 || key === 'base') factors.push({ key, label, value, points, ...(r ? { evidence: ev(r) } : {}) }) }

  add('base', 'Seller replied', `${inbound.length} repl${inbound.length === 1 ? 'y' : 'ies'}`, 25)

  const n = distinct.length
  const repeats = substantive.length - n
  add('volume', 'Substantive replies', `${n} distinct message${n === 1 ? '' : 's'} with content${repeats ? ` (+${repeats} repeated)` : ''}`, n >= 5 ? 14 : n >= 3 ? 10 : n === 2 ? 6 : 0)

  const totalWords = substantive.reduce((s, r) => s + r.words, 0)
  const distinctWords = distinct.reduce((s, r) => s + r.words, 0)
  const avgWords = n ? distinctWords / n : null
  if (avgWords !== null) add('length', 'Message length', `${round1(avgWords)} words / reply`, avgWords >= 15 ? 8 : avgWords >= 8 ? 5 : avgWords >= 4 ? 2 : avgWords < 3 && n >= 2 ? -3 : 0)

  if (medianReply !== null) {
    const pts = medianReply <= 15 ? 10 : medianReply <= 60 ? 7 : medianReply <= 240 ? 4 : medianReply <= 1440 ? 1 : -2
    add('reply_speed', 'Reply speed', `median ${fmtMinutes(medianReply)} (fastest ${fmtMinutes(fastestReply)}) over ${latencies.length} repl${latencies.length === 1 ? 'y' : 'ies'}`, pts)
  }
  if (replyRate !== null && touches.length) {
    const pts = replyRate >= 0.6 ? 5 : replyRate >= 0.3 ? 2 : replyRate < 0.15 && touches.length >= 4 ? -5 : 0
    add('reply_rate', 'Reply rate', `${pct(replyRate)} of ${touches.length} touch${touches.length === 1 ? '' : 'es'} answered within 72h`, pts)
  }
  if (hits.reengaged) add('reengaged', 'Re-engaged unprompted', 'wrote in with no message from us in the prior 72h', 6, hits.reengaged)
  if (hits.dealQuestions.length) add('questions', 'Asked deal questions', `${hits.dealQuestions.length} question${hits.dealQuestions.length === 1 ? '' : 's'}`, Math.min(6, 2 * hits.dealQuestions.length), hits.dealQuestions.at(-1))
  if (hits.price) add('price', 'Named a price', lang.priceMentions.map((p) => `$${p.toLocaleString('en-US')}`).join(', ') || 'price stated', 10, hits.price)
  if (hits.asksOffer) add('asks_offer', 'Asked for our offer', 'requested a number', 8, hits.asksOffer)
  if (hits.commitment) add('commitment', 'Next step / commitment', 'agreed to or proposed a concrete next step', 12, hits.commitment)
  if (hits.details) add('details', 'Shared property details', 'described the property or occupancy', 4, hits.details)
  if (hits.timeline) add('timeline', 'Talked timeline', 'referenced timing', 4, hits.timeline)
  if (hits.urgency.length) add('urgency', 'Urgency language', `${hits.urgency.length} message${hits.urgency.length === 1 ? '' : 's'}`, Math.min(12, 6 * hits.urgency.length), hits.urgency[0])
  const cats = Object.keys(hits.distress)
  if (cats.length) {
    let budget = 20
    for (const c of cats) {
      const pts = Math.min(8, budget)
      budget -= pts
      add(`distress_${c}`, `Distress: ${DISTRESS_LABEL[c]}`, `${lang.distress[c]} mention${lang.distress[c] === 1 ? '' : 's'}`, pts, hits.distress[c])
    }
  }
  if (hits.affirm.length) add('affirmative', 'Affirmative replies', `${hits.affirm.length}`, Math.min(9, 3 * hits.affirm.length), hits.affirm.at(-1))
  if (hits.profaneOnly.length) add('profanity_intensity', 'Profanity without hostility (intensity)', `${hits.profaneOnly.length} message${hits.profaneOnly.length === 1 ? '' : 's'}`, Math.min(4, 2 * hits.profaneOnly.length), hits.profaneOnly[0])

  if (inbound.length >= 3) {
    if (timing.share.lateNight >= 0.3) add('late_night', 'Replies late at night', `${pct(timing.share.lateNight)} of replies 22:00-05:00 ${tz || 'UTC'}`, 2)
    if (workHours / inbound.length >= 0.5) add('work_hours', 'Replies during work hours', `${pct(workHours / inbound.length)} Mon-Fri 09-17 ${tz || 'UTC'}`, 1)
  }
  if (trend === 'accelerating') add('trend', 'Replies accelerating', 'recent replies at least 2x faster', 4)
  if (trend === 'cooling') add('trend', 'Cooling', typicalGap !== null && !awaitingUs && now - lastIn.at > 7 * DAY ? `silent ${round1(silenceDays)}d vs typical ${fmtMinutes(typicalGap / MIN)} between replies` : 'recent replies at least 2x slower', -8)
  if (!awaitingUs) {
    const pts = silenceDays > 90 ? -20 : silenceDays > 30 ? -15 : silenceDays > 14 ? -10 : silenceDays > 7 ? -5 : silenceDays > 3 ? -2 : 0
    add('silence', 'Silence since our last message', `${round1(silenceDays)}d since last reply`, pts)
  } else {
    // The seller spoke last and we never answered: motivation still decays with time, but more gently.
    const pts = silenceDays > 90 ? -12 : silenceDays > 30 ? -8 : silenceDays > 14 ? -4 : 0
    add('stale_unanswered', "Seller's last message unanswered", `${round1(silenceDays)}d ago`, pts, lastIn)
  }

  const recent = substantive.slice(-2)
  if (hits.refusal.length) {
    const latest = hits.refusal.filter((x) => recent.includes(x)).at(-1)
    if (latest) add('refusal', 'Refused (latest)', 'said not interested / not for sale', -20, latest)
    else add('refusal', 'Refused earlier, re-engaged since', 'later messages continued the conversation', -6, hits.refusal.at(-1))
  }
  const classifierRefusal = inbound.filter((r) => r.intent === 'not_interested' && r.substantive && !hits.refusal.includes(r) && !hits.flatNo.includes(r))
  if (classifierRefusal.length && !hits.refusal.length) add('classifier_refusal', 'Classifier tagged not_interested', 'text did not confirm a refusal', -5, classifierRefusal.at(-1))
  if (hits.flatNo.length) {
    const lastNo = hits.flatNo.at(-1)
    const pos = lastNo === substantive.at(-1) ? 'last' : recent.includes(lastNo) ? 'recent' : 'earlier'
    const label = pos === 'last' ? 'Flat "No" (last word)' : pos === 'recent' ? 'Flat "No" (recent)' : 'Flat "No" earlier, conversation continued'
    add('flat_no', label, `${hits.flatNo.length}`, pos === 'last' ? -20 : pos === 'recent' ? -10 : -2, lastNo)
  }
  if (hits.hostile.length) add('hostility', 'Hostility', `${hits.hostile.length} hostile message${hits.hostile.length === 1 ? '' : 's'}`, Math.max(-35, -15 * hits.hostile.length), hits.hostile.at(-1))
  if (hits.profaneHostile.length) add('profanity_hostile', 'Profanity with hostility', `${hits.profaneHostile.length}`, -5 * hits.profaneHostile.length, hits.profaneHostile.at(-1))

  const rawScore = factors.reduce((s, f) => s + f.points, 0)
  let score = Math.max(0, Math.min(100, rawScore))

  // ── Band caps (a cap is itself a factor: its points are the reduction it caused) ──
  let band
  const cap = (limit, key, label, value, r) => {
    const reduced = Math.min(score, limit)
    factors.push({ key, label, value: `${value} (score capped at ${limit})`, points: reduced - score, cap: limit, ...(r ? { evidence: ev(r) } : {}) })
    score = reduced
  }
  const lastOptOut = hits.optOut.map((h) => h.r).sort((a, b) => a.at - b.at).at(-1)
  const resubscribed = lastOptOut && inbound.some((r) => r.at > lastOptOut.at && RESUBSCRIBE.test(r.body))
  const lastSub = substantive.at(-1)
  if (lastOptOut && !resubscribed) {
    const h = hits.optOut.find((x) => x.r === lastOptOut)
    cap(5, 'opt_out', 'Opted out', h.via === 'text' ? 'asked us to stop' : h.via === 'transport' ? 'carrier STOP keyword' : 'classifier tagged opt_out', lastOptOut)
    band = 'opted_out'
  } else if (hits.hostile.length && (hits.hostile.includes(lastSub) || hits.hostile.length * 2 >= n)) {
    cap(15, 'hostile_cap', 'Hostile thread', hits.hostile.includes(lastSub) ? 'latest message is hostile' : 'most messages are hostile', hits.hostile.at(-1))
    band = 'hostile'
  } else if (hits.wrong.length) {
    const h = hits.wrong.at(-1)
    cap(10, 'wrong_number', 'Wrong number', h.via === 'text' ? 'respondent said wrong number' : 'classifier tagged wrong_number', h.r)
    band = 'cold'
  } else if (hits.notOwner.length) {
    cap(15, 'not_owner', 'Not the owner / already sold', 'respondent disclaimed ownership', hits.notOwner.at(-1))
    band = 'cold'
  } else if (lastSub && (hits.refusal.includes(lastSub) || hits.flatNo.includes(lastSub))) {
    // A fast, polite "not interested" is still a no: the seller's last word caps the read.
    cap(19, 'last_word_refusal', "Seller's last word is a refusal", 'no later message reopened it', lastSub)
    band = 'cold'
  } else {
    band = bandFromScore(score)
  }

  factors.sort((a, b) => (a.key === 'base' ? -1 : b.key === 'base' ? 1 : Math.abs(b.points) - Math.abs(a.points)))

  return {
    version: CONVERSATION_SIGNAL_VERSION,
    counts: {
      inbound: inbound.length,
      substantiveInbound: substantive.length,
      distinctInbound: n,
      repeatedInbound: repeats,
      reactions: inbound.filter((r) => r.reaction).length,
      autoReplies: inbound.filter((r) => r.auto).length,
      outbound: outbound.length,
      inboundWords: totalWords,
      avgWordsPerInbound: round1(avgWords),
      questionsAsked,
      daysActive: activeDays.size,
    },
    responsiveness: {
      medianReplyMinutes: round1(medianReply),
      fastestReplyMinutes: round1(fastestReply),
      replyRate: replyRate === null ? null : Math.round(replyRate * 100) / 100,
      touches: touches.length,
      lastInboundAt: new Date(lastIn.at).toISOString(),
      lastOutboundAt: outbound.length ? new Date(outbound.at(-1).at).toISOString() : null,
      silenceDays: round1(silenceDays),
      awaitingUs,
      trend,
    },
    timing,
    language: lang,
    intents,
    score: Math.round(score),
    rawScore,
    band,
    factors,
    confidence: n >= 6 ? 'high' : n >= 3 ? 'medium' : 'low',
  }
}

function countTouches(outbound) {
  let c = 0, last = -Infinity
  for (const r of outbound) { if (r.at - last > TOUCH_COLLAPSE) c++; last = r.at }
  return c
}
