// ─── scripts/llm-audit/scrub.mjs ─────────────────────────────────────────────
// PII scrubber for any text that leaves this machine for an external model
// (offline reply / template audits). Pure, deterministic, no I/O.
//
// Replaces, in this order:
//   <EMAIL>  e-mail addresses, including "name at gmail dot com" obfuscations
//   <ADDR>   street addresses (house number + street + suffix, directionals,
//            unit / apt / suite / lot / # numbers, PO boxes, rural / county
//            routes, ", City, ST 12345"), the thread's own record addresses
//            (full, street line, and the bare street name) and ZIP codes
//   <PHONE>  phone numbers in every common shape (+1, (555) 555-5555,
//            555.555.5555, 5555555555, 555 555 5555, 555-5555, x/ext, full-
//            width digits, spaced digits) -- any 7+ digit run that is not a
//            money amount
//   <NAME>   person names: the thread's own seller / owner names from our
//            records (first, last, full, case- and accent-insensitive, with
//            possessives), our sender (agent) names, relatives' names after a
//            relation word ("my daughter Maria", "Maria is my daughter", "mi
//            hijo José"), names after "my name is / this is / soy / talk to /
//            ask for / his name is", greeting names ("Hi Bob"), and signature
//            names ("Thanks, Bob", "- Carol", "***Bob***", a trailing name line)
//
// Residual risk (documented, see tests): a name with no cue and not in our
// records written in lowercase mid-sentence; nicknames / misspellings of a
// record name beyond accent folding; city / landmark / employer names; numbers
// spelled out in words; addresses with no house number and no record match.
// detectResidualPII() is a second, independent gate run before any request
// leaves the machine.

export const SCRUB_VERSION = "llm-audit-scrub-2026-10-08";

// ── helpers ──────────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const L = "\\p{L}";

/** Normalize width (full-width digits / letters), quotes and zero-width chars. */
export function normalizeForScrub(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„‟]/g, '"');
}

// Words that are never treated as a name token even when capitalized.
export const NEVER_NAME = new Set([
  "the", "and", "llc", "inc", "trust", "estate", "of", "mr", "mrs", "ms", "dr", "jr", "sr", "ii", "iii", "iv",
  "family", "living", "revocable", "irrevocable", "company", "properties", "property", "homes", "home", "house",
  "investments", "group", "holdings", "corp", "owner", "owners", "unknown", "de", "la", "del", "los", "las", "van",
  "von", "st", "yes", "no", "not", "stop", "please", "thanks", "thank", "hi", "hey", "hello", "hola", "this",
  "that", "is", "who", "here", "sir", "maam", "madam", "senor", "senora", "the", "a", "an", "i", "im", "me", "my",
  "you", "your", "we", "our", "it", "its", "interested", "selling", "sale", "for", "sure", "ok", "okay", "na",
  "nope", "nah", "yeah", "yep", "si", "gracias", "buenas", "buenos", "dias", "tardes", "noches", "mister",
  "miss", "missus", "mom", "dad", "mother", "father", "son", "daughter", "wife", "husband", "brother", "sister",
  "aunt", "uncle", "god", "jesus", "lord", "amen", "texas", "florida", "georgia", "ohio", "real", "estate",
  "investor", "investors", "buyer", "buyers", "number", "wrong", "person", "people", "everyone", "anyone",
  "someone", "nobody", "lol", "omg", "haha", "today", "tomorrow", "monday", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "sunday", "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "street", "avenue", "road", "drive", "lane", "court", "way",
  "boulevard", "circle", "place", "trail", "unit", "apt", "suite", "box", "po", "city", "county", "state", "usa",
  "us", "am", "pm", "best", "regards", "sincerely", "cheers", "atentamente", "saludos", "bendiciones", "blessings",
  "sent", "from", "iphone", "android", "samsung", "galaxy", "mobile", "cell", "phone", "text", "texts", "message",
  "messages", "again", "never", "already", "sorry", "good", "great", "nice", "fine", "well", "also", "just", "only",
  // Capitalized non-name words that follow "I'm / This is / Thanks" in real replies.
  "i'll", "i'd", "i've", "i'm", "ill", "ive", "id", "dont", "don't", "cant", "can't", "wont", "won't", "driving",
  "busy", "retired", "interested", "available", "unavailable", "away", "out", "there", "okay", "currently", "still",
  "very", "too", "so", "glad", "happy", "ready", "done", "positive", "confused", "curious", "looking", "working",
  "calling", "texting", "moving", "car", "in", "on", "at", "with", "over", "under", "tenant", "tenants",
  "occupied", "rented", "vacant", "excellent", "cash", "price", "offer", "offers", "sold", "listed", "bout",
  "about", "going", "trying", "aware", "afraid", "fine", "dueño", "dueno", "duena", "dueña", "propietario",
  "propietaria", "yo", "el", "ella", "usted", "mucho", "muy", "for", "all", "any", "but", "or", "if", "what",
  "why", "how", "when", "where", "which", "right", "correct", "wrong", "true", "false", "maybe", "perhaps",
  "again", "later", "soon", "now", "then", "here's", "there's", "it's", "that's", "what's", "who's",
]);

// Common words that are also first / last names: replaced only when written
// capitalized, so "I will sell" keeps "will" but "Will" (a name) is scrubbed.
export const COMMON_WORD_NAMES = new Set([
  "will", "may", "june", "april", "august", "mark", "bill", "rose", "grant", "hope", "faith", "joy", "sunny", "don",
  "art", "guy", "frank", "rich", "chase", "hunter", "carol", "pat", "sue", "dean", "ray", "gene", "jack", "jean",
  "max", "miles", "page", "paris", "penny", "ruby", "summer", "autumn", "dawn", "eve", "lane", "lee", "love",
  "star", "wade", "young", "king", "price", "cash", "sale", "house", "home", "bond", "banks", "bank", "street",
  "hill", "hall", "wood", "woods", "rice", "white", "black", "brown", "green", "gray", "grey", "long", "little",
  "short", "small", "west", "east", "north", "south", "way", "ford", "cook", "baker", "miller", "hunt", "fox",
  "bell", "rock", "stone", "lake", "river", "field", "fields", "park", "parks", "march", "christian", "angel",
  "angela", "deal", "case", "best", "major", "noble", "sharp", "strong", "hardy", "fair", "glass", "law", "lord",
  "cross", "ball", "bush", "rush", "sky", "storm", "joy", "iris", "ivy", "holly", "lily", "daisy", "violet",
  "olive", "pearl", "jade", "amber", "crystal", "destiny", "harmony", "trinity", "unique", "precious", "royal",
  "sol", "luz", "paz", "rosa", "flor", "dolores", "mercedes", "cruz", "jesus", "angeles", "santos", "reyes",
  "amparo", "consuelo", "esperanza", "milagros", "soledad", "rocio", "pilar", "blanca", "clara", "gloria",
  "victoria", "rey", "leal", "bueno", "casas", "campo", "vega", "rios", "flores", "salazar",
]);

const RELATION_WORDS = [
  "son", "daughter", "wife", "husband", "brother", "sister", "mom", "mother", "dad", "father", "uncle", "aunt",
  "cousin", "nephew", "niece", "grandson", "granddaughter", "grandma", "grandmother", "grandpa", "grandfather",
  "boyfriend", "girlfriend", "partner", "fiance", "fiancee", "spouse", "ex", "ex-wife", "ex-husband",
  "stepson", "stepdaughter", "stepmom", "stepdad", "mother-in-law", "father-in-law", "son-in-law",
  "daughter-in-law", "sister-in-law", "brother-in-law", "tenant", "renter", "neighbor", "neighbour", "friend",
  "roommate", "attorney", "lawyer", "realtor", "agent", "manager", "landlord", "caregiver", "executor",
  "hijo", "hija", "esposa", "esposo", "marido", "mujer", "hermano", "hermana", "mama", "mamá", "papa", "papá",
  "madre", "padre", "tio", "tío", "tia", "tía", "primo", "prima", "nieto", "nieta", "abuela", "abuelo",
  "suegra", "suegro", "cuñado", "cuñada", "sobrino", "sobrina", "novio", "novia", "inquilino", "vecino",
  "vecina", "amigo", "amiga", "abogado", "abogada", "filho", "filha", "esposa", "marido", "irmão", "irmã",
];
// Case-insensitive on the first letter only ("Son" / "son"): the whole regex
// must stay case-SENSITIVE, or \p{Lu} in the name part matches any word.
const ciFirst = (w) => {
  const c = w.charAt(0);
  const up = c.toUpperCase();
  return (up !== c ? `[${up}${c}]` : esc(c)) + esc(w.slice(1));
};
const RELATION_RE_SRC = RELATION_WORDS.sort((a, b) => b.length - a.length).map(ciFirst).join("|");

// A capitalized name token (Unicode letters; O'Neil, Mary-Kate, José).
const CAP = `\\p{Lu}[\\p{Ll}\\p{Lu}'’-]*`;
const CAP_NAME_RE_SRC = `${CAP}(?:\\s+${CAP}){0,2}`;

function isNameToken(word) {
  const w = fold(word).toLowerCase().replace(/['’]s$/, "").replace(/[^a-z'-]/g, "");
  return w.length >= 2 && !NEVER_NAME.has(w);
}

/** Tokens worth scrubbing from record name fields ("SMITH JOHN & MARY", "Maria Lopez Trust"). */
export function nameTokens(...values) {
  const out = new Set();
  for (const value of values.flat()) {
    for (const raw of String(value ?? "").split(/[\s,&/.()"+;:|]+/)) {
      const token = raw.trim().replace(/^['-]+|['-]+$/g, "");
      if (token.length < 2 || /\d/.test(token)) continue;
      if (NEVER_NAME.has(fold(token).toLowerCase())) continue;
      out.add(token);
    }
  }
  return [...out];
}

// ── e-mail ───────────────────────────────────────────────────────────────────

const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const EMAIL_OBFUSCATED_RE =
  /\b[\p{L}\p{N}._%+-]+\s*(?:\(at\)|\[at\]|\{at\}|\s+at\s+)\s*[\p{L}\p{N}-]+\s*(?:\(dot\)|\[dot\]|\{dot\}|\s+dot\s+|\.)\s*(?:com|net|org|edu|gov|us|io|co|me|info|biz|mx)\b/giu;
const EMAIL_PROVIDER_RE =
  /\b[\p{L}\p{N}._%+-]{2,}\s*(?:@|\s+at\s+)\s*(?:gmail|yahoo|hotmail|outlook|aol|icloud|live|msn|comcast|att|sbcglobal|verizon|protonmail|me)\b(?:\s*(?:\.|dot)\s*\w{2,4})?/giu;

// ── addresses ────────────────────────────────────────────────────────────────

const STREET_SUFFIX =
  "(?:St|Str|Street|Rd|Road|Ave|Av|Avn|Aven|Avenue|Dr|Drv|Drive|Ln|Lane|Blvd|Boulevard|Ct|Crt|Court|Way|Wy|Pl|Place|Plz|Plaza|Cir|Circ|Circle|Ter|Terr|Terrace|Pkwy|Parkway|Hwy|Highway|Fwy|Freeway|Expy|Expressway|Trl|Trail|Loop|Run|Pass|Row|Sq|Square|Pt|Point|Xing|Crossing|Cv|Cove|Holw|Hollow|Bnd|Bend|Path|Pike|Aly|Alley|Walk|Grv|Grove|Hts|Heights|Mnr|Manor|Rdg|Ridge|Vw|View|Vly|Valley|Crk|Creek|Spgs|Springs|Est|Estates|Gdns|Gardens|Lndg|Landing|Mdws|Meadows|Pkwy|Cres|Crescent|Cswy|Causeway|Commons|Green|Glen|Knoll|Mews|Oval|Park|Ramp|Spur|Track|Trce|Trace|Tpke|Turnpike|Bypass|Calle|Camino|Avenida|Rua)";
const DIRECTIONAL = "(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West|Northeast|Northwest|Southeast|Southwest)\\.?";
const UNIT =
  "(?:\\s*,?\\s*(?:#\\s*|(?:Apt|Apartment|Unit|Ste|Suite|Bldg|Building|Lot|Space|Spc|Trlr|Trailer|Rm|Room|Fl|Floor|Dept|Depto|Departamento|Int|Interior|No)\\.?\\s*#?\\s*)[A-Za-z0-9-]{1,6})";
const HOUSE_NUMBER = "(?<!\\d[\\s.\\-–—)(]{0,2})\\b\\d{1,6}(?:-?[A-Za-z]|\\s?1\\/2|-\\d{1,4})?";
const STREET_WORD = "(?:\\d{1,3}(?:st|nd|rd|th)|[\\p{L}][\\p{L}.'’-]*)";

const ADDR_RE = new RegExp(
  `${HOUSE_NUMBER}\\s+(?:${DIRECTIONAL}\\s+)?(?:${STREET_WORD}\\s+){1,4}${STREET_SUFFIX}\\b\\.?(?:\\s+${DIRECTIONAL}(?![\\p{L}]))?${UNIT}*`,
  "giu"
);
// Spanish / Portuguese order: "Calle Sol 123", "Avenida Juárez #45", "Rua das Flores 12".
const ADDR_LEADING_SUFFIX_RE = new RegExp(
  `\\b(?:Calle|Camino|Avenida|Av\\.|Rua|Carrera|Carretera|Privada|Callejon|Callejón)\\s+(?:[\\p{L}][\\p{L}.'’-]*\\s+){1,4}#?\\s*\\d{1,6}${UNIT}*`,
  "giu"
);
const PO_BOX_RE = /\b(?:P\.?\s*O\.?\s*Box|Post\s+Office\s+Box|PO\s*Box|Apartado(?:\s+Postal)?)\s*#?\s*\d{1,8}\b/giu;
const RURAL_ROUTE_RE =
  /\b(?:\d{1,6}\s+)?(?:RR|Rural\s+Route|County\s+Road|County\s+Rd|CR|FM|Farm\s+to\s+Market(?:\s+Road)?|State\s+Route|State\s+Road|SR|Route|Rte|Rt|US|Hwy|Highway|Interstate|I-)\s*-?\s*\d{1,5}[A-Za-z]?(?:\s+Box\s+\d{1,6})?\b/giu;
// "<ADDR>, Memphis, TN 38106" / "<ADDR> TN 38106"
const ADDR_TAIL_RE = /<ADDR>(?:\s*,?\s*[\p{L} .'’-]{2,30})?,?\s*\b[A-Z]{2}\.?\s*\d{5}(?:-\d{4})?\b/gu;
const STATE_ZIP_RE = /\b(?:A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY]|PR)\.?\s+\d{5}(?:-\d{4})?\b/gu;
const ZIP_CUE_RE = /\b(?:zip(?:\s*code)?|c[oó]digo\s+postal|cp)\s*:?\s*#?\s*\d{5}(?:-\d{4})?\b/giu;
// A bare number + capitalized street-looking name with no suffix ("I own 1234
// Elmwood"), unless the word after the number is a unit of something.
const NUMBER_NAME_RE = new RegExp(`\\b\\d{3,6}\\s+(?:${DIRECTIONAL}\\s+)?\\p{Lu}[\\p{Ll}]{2,}(?:\\s+\\p{Lu}[\\p{Ll}]{2,})?(?=[\\s,.!?;:)]|$)`, "gu");
const NUMBER_NAME_KEEP_RE =
  /\b(?:Dollars?|Thousand|Million|Grand|Sq|Square|Feet|Foot|Ft|Acres?|Units?|Years?|Yrs?|Months?|Days?|Weeks?|Hours?|Bedrooms?|Beds?|Baths?|Bathrooms?|Homes?|Houses?|Properties|Doors|Miles?|Times|Pesos|Mil|Cash|Down|Per|Each|Total|Monthly|Rent|Rents|Sold|Offer|Offers|Plus|Or|And|Is|Was|Not|Max|Min|Firm|Obo|Today|Tomorrow|Please|Thanks|Thank)\b/i;

// ── phones ───────────────────────────────────────────────────────────────────

// Any digit run (allowing separators) of 7..15 digits. Money is excluded
// below ($ prefix, k / million / dollars suffix, thousands commas).
const PHONE_CANDIDATE_RE = /(?<![\p{N}$])(?:\+\s?\d{1,3}[\s.\-–—]*)?\(?\d(?:[\s.\-–—()\/]{0,3}\d){6,14}(?:\s*(?:x|ext\.?|extension)\s*\d{1,6})?(?![\p{N}])/gu;
const MONEY_AFTER_RE = /^\s*(?:k\b|m\b|mil\b|million|thousand|grand|dollars?|usd|pesos|cash|obo)/i;

function countDigits(s) {
  return (String(s).match(/\d/g) || []).length;
}

function scrubPhones(text) {
  return text.replace(PHONE_CANDIDATE_RE, (match, offset, whole) => {
    const digits = countDigits(match);
    if (digits < 7) return match;
    const before = whole.slice(Math.max(0, offset - 2), offset);
    const after = whole.slice(offset + match.length, offset + match.length + 12);
    // "$1500000", "1500000 dollars", "2,500,000" (commas never reach here).
    if (/\$\s*$/.test(before)) return match;
    if (MONEY_AFTER_RE.test(after) && digits < 10) return match;
    // A plain year range / date ("2019-2020", "10/08/2026") is not a phone.
    if (/^\d{4}\s*[-–]\s*\d{4}$/.test(match.trim())) return match;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(match.trim())) return match;
    const lead = match.match(/^\s*/)[0];
    const trail = match.match(/\s*$/)[0];
    return `${lead}<PHONE>${trail}`;
  });
}

// ── names ────────────────────────────────────────────────────────────────────

function nameVariants(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return [];
  const set = new Set([raw, fold(raw)]);
  return [...set].filter((n) => n.length >= 2);
}

function replaceKnownName(text, name) {
  const lowerName = fold(name).toLowerCase();
  const common = COMMON_WORD_NAMES.has(lowerName);
  let out = text;
  for (const variant of nameVariants(name)) {
    const body = esc(variant);
    if (common) {
      // Only the capitalized spelling of a common word ("Will", "Rose").
      const cap = variant.charAt(0).toUpperCase() + variant.slice(1).toLowerCase();
      const capUpper = variant.toUpperCase();
      for (const form of new Set([cap, capUpper])) {
        out = out.replace(new RegExp(`(?<![${L}<])${esc(form)}(?:['’]s)?(?![${L}>])`, "gu"), "<NAME>");
      }
    } else {
      out = out.replace(new RegExp(`(?<![${L}<])${body}(?:['’]s)?(?![${L}>])`, "giu"), "<NAME>");
    }
  }
  // Accent-insensitive pass: "Jose" in records vs "José" in text (and back).
  if (!common && lowerName.length >= 3) {
    const folded = fold(out);
    if (folded.length === out.length) {
      const re = new RegExp(`(?<![${L}<])${esc(fold(name))}(?:['’]s)?(?![${L}>])`, "giu");
      let m;
      const spans = [];
      while ((m = re.exec(folded))) spans.push([m.index, m.index + m[0].length]);
      for (let i = spans.length - 1; i >= 0; i -= 1) out = out.slice(0, spans[i][0]) + "<NAME>" + out.slice(spans[i][1]);
    }
  }
  return out;
}

// A capitalized name immediately after a cue. The cue itself is kept.
function replaceCued(text, cueSrc, { flags = "gu", maxTokens = 3 } = {}) {
  const re = new RegExp(`(${cueSrc})(\\s*,?\\s*)(${CAP}(?:\\s+${CAP}){0,${maxTokens - 1}})`, flags);
  return text.replace(re, (m, cue, sp, name) => {
    const tokens = name.split(/\s+/);
    if (!isNameToken(tokens[0])) return m;
    // Keep any trailing tokens that are not names ("Maria Not interested").
    let keep = tokens.length;
    while (keep > 0 && !isNameToken(tokens[keep - 1])) keep -= 1;
    if (keep === 0) return m;
    const rest = tokens.slice(keep).join(" ");
    return `${cue}${sp}<NAME>${rest ? ` ${rest}` : ""}`;
  });
}

const SELF_INTRO_CUE =
  "\\b(?:[Mm]y name is|[Mm]y name's|[Tt]his is|[Ii] am|[Ii]'m|[Ss]oy|[Mm]e llamo|[Mm]i nombre es|[Hh]abla|[Ee]u sou|[Mm]eu nome [eé]|[Hh]is name is|[Hh]er name is|[Hh]is name's|[Hh]er name's|[Tt]heir name is|[Ss]u nombre es|[Ss]e llama|[Tt]alk to|[Tt]alk with|[Ss]peak to|[Ss]peak with|[Aa]sk for|[Cc]ontact|[Cc]all|[Tt]ext|[Rr]each out to|[Hh]abla con|[Hh]ablar con|[Ll]lame a|[Ll]lamar a|[Pp]regunte por|[Pp]regunta por|[Oo]wned by|[Bb]elongs to|[Pp]ertenece a|[Ee]s de|[Ee]s del|[Tt]he owner is|[Ee]l due[ñn]o es|[Ll]a due[ñn]a es)";
const GREETING_CUE =
  "\\b(?:Hi|Hey|Hello|Hiya|Dear|Hola|Buenas|Buenos d[ií]as|Buenas tardes|Buenas noches|Ciao|Ol[aá]|Bonjour|Hallo|Good morning|Good afternoon|Good evening|Morning|Afternoon|Mr\\.?|Mrs\\.?|Ms\\.?|Miss|Sr\\.?|Sra\\.?|Srta\\.?|Don|Doña|Dona)";
const SIGNOFF_CUE =
  "\\b(?:[Tt]hanks|[Tt]hank you|[Tt]hx|[Tt]y|[Rr]egards|[Bb]est regards|[Kk]ind regards|[Bb]est|[Cc]heers|[Ss]incerely|[Rr]espectfully|[Bb]lessings|[Gg]od bless|[Tt]ake care|[Gg]racias|[Aa]tentamente|[Ss]aludos|[Bb]endiciones|[Oo]brigad[oa]|[Ss]ent by|[Ss]igned)";

function scrubSignature(text) {
  let out = text;
  // "- Carol", "~ Bob Smith", "-- Jane" at the end, or "***Bob***".
  out = out.replace(new RegExp(`(^|\\s)([-–—~]{1,2}\\s*)(${CAP_NAME_RE_SRC})\\s*[.!]?\\s*$`, "u"), (m, pre, dash, name) =>
    name.split(/\s+/).some(isNameToken) ? `${pre}${dash}<NAME>` : m
  );
  out = out.replace(/\*{1,4}\s*([\p{L}][\p{L}'’ -]{1,40}?)\s*\*{1,4}/gu, (m, name) =>
    name.split(/\s+/).some(isNameToken) ? "***<NAME>***" : m
  );
  // A final line that is only 1-3 capitalized words (a signature line).
  const lines = out.split(/\r?\n/);
  if (lines.length > 1) {
    const last = lines[lines.length - 1].trim();
    if (new RegExp(`^${CAP_NAME_RE_SRC}[.!]?$`, "u").test(last) && last.split(/\s+/).every(isNameToken)) {
      lines[lines.length - 1] = lines[lines.length - 1].replace(last, "<NAME>");
      out = lines.join("\n");
    }
  }
  return out;
}

function scrubRelatives(text) {
  let out = text;
  // "my daughter Maria", "my son, Jose", "mi hijo José", "her husband Bob Smith"
  out = replaceCued(out, `(?<![\\p{L}])(?:${RELATION_RE_SRC})(?:['’]s)?(?![\\p{L}])`, { flags: "gu" });
  // "my daughter's name is Maria" / "my son is named Jose"
  out = replaceCued(out, `(?<![\\p{L}])(?:${RELATION_RE_SRC})(?:['’]s)?\\s+(?:name\\s+is|is\\s+named|se\\s+llama|named)`, { flags: "gu" });
  // "Maria is my daughter", "Jose es mi hijo", "Bob and I"
  out = out.replace(
    new RegExp(`(${CAP}(?:\\s+${CAP})?)(\\s+(?:is|was|es|era|[eé])\\s+(?:my|our|his|her|mi|nuestro|nuestra|su|meu|minha)\\s+(?:${RELATION_RE_SRC})(?![\\p{L}]))`, "gu"),
    (m, name, rest) => (name.split(/\s+/).some(isNameToken) ? `<NAME>${rest}` : m)
  );
  out = out.replace(new RegExp(`(${CAP})(\\s+(?:and|&|y)\\s+(?:I|me|yo)\\b)`, "gu"), (m, name, rest) =>
    isNameToken(name) ? `<NAME>${rest}` : m
  );
  // "Mary's house", "the Smiths"
  return out;
}

/**
 * scrub(text, {
 *   names:      string[]  thread record names (first / last / full / entity) -- required for good recall
 *   agentNames: string[]  our sender first names ("Alex")
 *   addresses:  string[]  thread record addresses (full one-line)
 *   extraNames: string[]  any other names known for the batch (e.g. every record name not a dictionary word)
 * })
 */
export function scrub(text, { names = [], agentNames = [], addresses = [], extraNames = [] } = {}) {
  let t = normalizeForScrub(text);
  if (!t) return t;

  // 1. e-mail (before phones: "john5551234567@gmail.com")
  t = t.replace(EMAIL_RE, "<EMAIL>").replace(EMAIL_OBFUSCATED_RE, "<EMAIL>").replace(EMAIL_PROVIDER_RE, "<EMAIL>");

  // 2. record addresses: full, street line, street name without number.
  for (const address of addresses.filter(Boolean)) {
    const full = normalizeForScrub(address).trim();
    const street = full.split(",")[0].trim();
    for (const piece of [full, street]) {
      if (piece.length >= 6) t = t.replace(new RegExp(esc(piece).replace(/\s+/g, "\\s+"), "giu"), "<ADDR>");
    }
    const m = street.match(/^\d+[A-Za-z]?\s+(.+)$/u);
    if (m) {
      const streetName = m[1].replace(new RegExp(`\\s+${STREET_SUFFIX}\\.?$`, "iu"), "").replace(new RegExp(`^${DIRECTIONAL}\\s+`, "iu"), "").trim();
      if (streetName.length >= 4 && !NEVER_NAME.has(streetName.toLowerCase())) {
        t = t.replace(new RegExp(`(?<![${L}])${esc(streetName)}(?:\\s+${STREET_SUFFIX}\\b\\.?)?(?![${L}])`, "giu"), "<ADDR>");
      }
    }
  }

  // 3. generic addresses
  t = t.replace(PO_BOX_RE, "<ADDR>");
  t = t.replace(ADDR_RE, "<ADDR>");
  t = t.replace(ADDR_LEADING_SUFFIX_RE, "<ADDR>");
  t = t.replace(RURAL_ROUTE_RE, (m) => (/\d/.test(m) && !/^\d+\s*$/.test(m) ? "<ADDR>" : m));
  t = t.replace(ADDR_TAIL_RE, "<ADDR>");
  t = t.replace(STATE_ZIP_RE, "<ADDR>");
  t = t.replace(ZIP_CUE_RE, "<ADDR>");
  t = t.replace(NUMBER_NAME_RE, (m) => (NUMBER_NAME_KEEP_RE.test(m) ? m : "<ADDR>"));
  t = t.replace(/(?:<ADDR>[\s,]*){2,}/g, "<ADDR> ");

  // 4. phones
  t = scrubPhones(t);

  // 5. known names (longest first), agent names
  const known = [...new Set([...nameTokens(names), ...nameTokens(extraNames), ...nameTokens(agentNames), ...names.filter((n) => /\s/.test(String(n || "").trim()))])]
    .map((n) => String(n).trim())
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const name of known) t = replaceKnownName(t, name);

  // 6. cue-based names
  t = scrubRelatives(t);
  t = replaceCued(t, SELF_INTRO_CUE, { flags: "gu", maxTokens: 3 });
  t = replaceCued(t, GREETING_CUE, { flags: "gu", maxTokens: 2 });
  t = replaceCued(t, SIGNOFF_CUE, { flags: "gu", maxTokens: 3 });
  // "not Maria" / "no soy María" / "this isn't Bob" (a wrong-person claim names the person)
  t = replaceCued(t, "\\b(?:[Nn]ot|[Nn]o es|[Nn]o soy|[Ii]sn'?t|[Ii]s not|[Aa]in'?t|[Nn][aã]o sou)", { flags: "gu", maxTokens: 2 });
  t = scrubSignature(t);

  // 7. "<NAME> Lastname" -> "<NAME>"
  t = t.replace(new RegExp(`<NAME>(\\s+)(${CAP})(?=[\\s,.!?;:]|$)`, "gu"), (m, sp, next) => (isNameToken(next) ? "<NAME>" : m));
  t = t.replace(/<NAME>(?:\s*<NAME>)+/g, "<NAME>");
  return t;
}

// ── residual PII gate ───────────────────────────────────────────────────────

const RESIDUAL_CHECKS = [
  ["phone", /(?<![\p{N}$])\d(?:[\s.\-–—()]{0,3}\d){9,}(?!\p{N})/u],
  ["phone7", /\b\d{3}[\s.\-–—]\d{4}\b/u],
  ["email", /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+\.\p{L}{2,}/u],
  ["street_address", new RegExp(`\\b\\d{1,6}\\s+(?:[\\p{L}][\\p{L}.'’-]*\\s+){1,4}${STREET_SUFFIX}\\b`, "iu")],
  ["state_zip", /\b[A-Z]{2}\s+\d{5}\b/u],
];

/**
 * Independent second check on text that is about to leave the machine.
 * Returns the list of residual PII kinds found (empty = clean), and checks the
 * thread's record names again so a scrubber miss is caught here.
 */
export function detectResidualPII(text, { names = [], agentNames = [] } = {}) {
  const t = normalizeForScrub(text);
  const found = [];
  for (const [kind, re] of RESIDUAL_CHECKS) if (re.test(t)) found.push(kind);
  for (const name of [...nameTokens(names), ...nameTokens(agentNames)]) {
    if (fold(name).length < 3) continue;
    const common = COMMON_WORD_NAMES.has(fold(name).toLowerCase());
    const re = common
      ? new RegExp(`(?<![${L}<])${esc(name.charAt(0).toUpperCase() + name.slice(1).toLowerCase())}(?![${L}>])`, "u")
      : new RegExp(`(?<![${L}<])${esc(fold(name))}(?![${L}>])`, "iu");
    if (re.test(common ? t : fold(t))) {
      found.push("record_name");
      break;
    }
  }
  return found;
}

/** Throws when any residual PII is detected. Use before every external request. */
export function assertScrubbed(text, opts = {}) {
  const found = detectResidualPII(text, opts);
  if (found.length) {
    const err = new Error(`residual PII detected: ${found.join(",")}`);
    err.code = "RESIDUAL_PII";
    err.kinds = found;
    throw err;
  }
  return true;
}
