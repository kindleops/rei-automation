// ─── revocation-morphology.js ───────────────────────────────────────────────
// rc-8.5.21 v4 (S1). The GENERATIVE half of the contact-revocation grammar
// (multilingual-contact-revocation.js). The v3 grammar listed inflected forms by
// hand per rule, so a verb that was never listed ("bájenme"), a person / mood
// that was never listed (Rioplatense voseo "dejá de"), a register that was never
// listed (formal "absténgase de", "cese todo contacto") or a message that mixed
// two languages ("唔該唔好再send message俾我") fell through to "unclear and
// contactable".
//
// Here the forms are DERIVED:
//   • Spanish verb LEMMA CLASSES per revocation family (remove-from-list, stop,
//     communication, avoid) are conjugated by a small conjugator: infinitive,
//     tú / voseo / usted / ustedes / vosotros imperatives, the subjunctive of
//     every person (negative imperatives, "que + subjunctive" requests), the
//     present indicative used as a request ("¿me bajan de la lista?"), the
//     gerund, with enclitic / proclitic pronouns and the orthographic changes
//     (c→qu, g→gu, z→c, gu→gü, stem change o→ue / e→ie, -uir → -uy-, -tener →
//     -tén / -tenga);
//   • every language's communication lexicon is joined with an ENGLISH
//     communication lexicon (code-switching: "deja de textearme", "đừng inbox
//     nữa", "不要再text我", "唔好再send message俾我", "wag nyo na ako i-text");
//   • Cantonese is part of the Chinese family (唔好 / 咪 / 唔使 / 唔該, 俾我 / 畀我);
//   • uncertain, stop-LIKE whole-message words of the 12 languages ("thôi",
//     "됐어요", "خلاص", "Ase atò", "ya chole", "chega", "ça suffit", "dość",
//     "够了") are a POSSIBLE opt-out (precautionary contact-wide hold), never
//     "unclear and contactable" and never a confident opt-out;
//   • OBJECT / TARGET analysis for stop words: WHAT is being stopped and WHO
//     stops it. "Basta ya con ese inquilino" (a third party), "Para mí está bien"
//     (the preposition), "J'arrête pas de recevoir des offres" / "can't stop
//     thinking about selling" (a negated, first-person continuation), "No es
//     suficiente" (not enough money) are not revocations.
//
// Spanish 1st / 3rd person PRETERITES ("quité", "dejé", "sacó") are never an
// imperative: the Spanish matching view marks a word-final é / ó before
// accents are folded (see spanishView).
//
// Rules only, no AI, no I/O.

export const REVOCATION_MORPHOLOGY_VERSION = "revocation_morphology_v1_2026_10_20";

// ── Spanish conjugator (accent-free output; the matching view is accent-folded) ──
const SPANISH_CLITICS = ["me", "nos", "le", "les", "lo", "la", "los", "las"];

/**
 * @param {string} lemma  infinitive ("quitar", "remover", "abstenerse")
 * @param {object} [o]
 * @param {string} [o.stressedStem]  stem used in stressed persons (o→ue / e→ie): "remuev"
 * @param {string} [o.subjStem]      irregular subjunctive stem ("absteng", "deteng")
 * @param {string} [o.impTu]         irregular tú imperative ("absten", "deten")
 * @returns {{ inf: string[], imp: string[], subj: string[], ind: string[], ger: string[], all: string[] }}
 */
export function conjugateSpanish(lemma, o = {}) {
  const reflexive = /se$/.test(lemma);
  const inf = reflexive ? lemma.slice(0, -2) : lemma;
  const cls = inf.slice(-2); // ar | er | ir
  const stem = inf.slice(0, -2);
  const stressed = o.stressedStem || stem;
  const out = { inf: [inf], imp: [], subj: [], ind: [], ger: [] };
  // -uir verbs (excluir → excluy-)
  const uir = cls === "ir" && /u$/.test(stem);
  const subjStem = o.subjStem || (cls === "ar" ? orthoBeforeE(stressed) : uir ? `${stressed}y` : stressed);
  const subjStemPlain = o.subjStem || (cls === "ar" ? orthoBeforeE(stem) : uir ? `${stem}y` : stem);
  if (cls === "ar") {
    out.imp.push(`${stressed}a`, `${stem}a` /* voseo quitá → quita */, `${stem}ad` /* vosotros */);
    out.subj.push(`${subjStem}e`, `${subjStem}es`, `${subjStem}en`, `${subjStemPlain}emos`, `${subjStemPlain}eis`);
    out.ind.push(`${stressed}an`, `${stressed}as`, `${stressed}a`, `${stem}ais`);
    out.ger.push(`${stem}ando`);
  } else {
    const e = cls === "er" ? "e" : "i";
    out.imp.push(o.impTu || (uir ? `${stressed}ye` : `${stressed}e`), o.impVos || `${stem}${e}` /* voseo removė / excluí → remove / exclui */, `${stem}${e}d`);
    out.subj.push(`${subjStem}a`, `${subjStem}as`, `${subjStem}an`, `${subjStemPlain}amos`, `${subjStemPlain}ais`);
    out.ind.push(uir ? `${stressed}yen` : `${stressed}en`, uir ? `${stressed}yes` : `${stressed}es`, uir ? `${stressed}ye` : `${stressed}e`);
    out.ger.push(uir ? `${stem}yendo` : `${stem}${cls === "er" ? "iendo" : "iendo"}`);
  }
  if (o.extraImp) out.imp.push(...o.extraImp);
  if (o.extraSubj) out.subj.push(...o.extraSubj);
  out.all = [...new Set([...out.inf, ...out.imp, ...out.subj, ...out.ind, ...out.ger])];
  return out;
}

function orthoBeforeE(stem) {
  if (/c$/.test(stem)) return `${stem.slice(0, -1)}qu`;
  if (/gu$/.test(stem)) return `${stem.slice(0, -2)}gu`; // averiguar → averigu (ü folded)
  if (/g$/.test(stem)) return `${stem}u`;
  if (/z$/.test(stem)) return `${stem.slice(0, -1)}c`;
  return stem;
}

/** Every form of the lemmas, with optional enclitics ("bajenme", "quitarme", "absténganse", "sacandome"). */
export function spanishFormsWithClitics(conjugations, { clitics = SPANISH_CLITICS, reflexive = false } = {}) {
  const forms = new Set();
  for (const c of conjugations) {
    for (const f of c.all) forms.add(f);
    // enclitics attach to the infinitive, the affirmative imperatives / subjunctive-as-imperative and the gerund
    for (const base of [...c.inf, ...c.imp, ...c.subj, ...c.ger]) {
      for (const cl of clitics) forms.add(`${base}${cl}`);
      if (reflexive) {
        forms.add(`${base}se`); forms.add(`${base}te`); forms.add(`${base}nos`);
      }
    }
    // vosotros + os / me: "quitadme", "absteneos"
    for (const base of c.imp.filter((x) => /d$/.test(x))) forms.add(`${base.slice(0, -1)}os`);
  }
  return [...forms];
}

/** A regex alternation of the forms, longest first (no capturing groups). */
export function alternation(forms) {
  return `(?:${[...new Set(forms)].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})`;
}
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Lemma classes ────────────────────────────────────────────────────────────
// remove-from-list ("take me off"): the verbs a Spanish speaker uses with "de la lista"
export const ES_REMOVE_LEMMAS = Object.freeze([
  conjugateSpanish("quitar"), conjugateSpanish("sacar"), conjugateSpanish("borrar"), conjugateSpanish("eliminar"),
  conjugateSpanish("retirar"), conjugateSpanish("tachar"), conjugateSpanish("desapuntar"), conjugateSpanish("desanotar"),
  conjugateSpanish("remover", { stressedStem: "remuev" }), conjugateSpanish("excluir"), conjugateSpanish("suprimir"),
]);
// the CORE remove verbs: a bare clitic imperative ("Bórrenme", "Sáqueme") is itself a confident request;
// "bajar" / "dar" / "descartar" alone are not (only with a list / number object, else a possible opt-out)
export const ES_REMOVE_CORE_LEMMAS = Object.freeze([
  conjugateSpanish("quitar"), conjugateSpanish("sacar"), conjugateSpanish("borrar"), conjugateSpanish("eliminar"),
  conjugateSpanish("retirar"), conjugateSpanish("remover", { stressedStem: "remuev" }), conjugateSpanish("excluir"), conjugateSpanish("suprimir"),
  conjugateSpanish("tachar"), conjugateSpanish("desapuntar"),
]);
export const ES_REMOVE_SOFT_LEMMAS = Object.freeze([conjugateSpanish("bajar")]);
// stop + "de" + communication ("dejá de mandarme", "absténgase de contactarme", "desistan de escribirme")
export const ES_STOP_DE_LEMMAS = Object.freeze([
  conjugateSpanish("dejar"), conjugateSpanish("parar"), conjugateSpanish("cesar"), conjugateSpanish("desistir"),
  conjugateSpanish("abstenerse", { impTu: "absten", impVos: "abstene", subjStem: "absteng", extraImp: ["abstente", "abstenete"] }),
]);
// stop + a communication NOUN object ("cese todo contacto", "suspendan el envío de mensajes", "paren los mensajes")
export const ES_STOP_NOUN_LEMMAS = Object.freeze([
  conjugateSpanish("parar"), conjugateSpanish("cesar"), conjugateSpanish("suspender"), conjugateSpanish("cancelar"),
  conjugateSpanish("detener", { impTu: "deten", impVos: "detene", subjStem: "deteng" }), conjugateSpanish("cortar"),
  conjugateSpanish("terminar"), conjugateSpanish("finalizar"),
  conjugateSpanish("abstenerse", { impTu: "absten", impVos: "abstene", subjStem: "absteng", extraImp: ["abstente", "abstenete"] }),
]);
// avoid + infinitive ("eviten contactarme")
export const ES_AVOID_LEMMAS = Object.freeze([conjugateSpanish("evitar"), conjugateSpanish("omitir")]);
// communication verbs (the object of a stop / a negation)
export const ES_COMM_LEMMAS = Object.freeze([
  conjugateSpanish("escribir"), conjugateSpanish("mandar"), conjugateSpanish("enviar"), conjugateSpanish("textear"), conjugateSpanish("texear"),
  conjugateSpanish("textar"), conjugateSpanish("mensajear"), conjugateSpanish("contactar"), conjugateSpanish("llamar"), conjugateSpanish("marcar"),
  conjugateSpanish("molestar"), conjugateSpanish("buscar"), conjugateSpanish("acosar"), conjugateSpanish("hostigar"), conjugateSpanish("fastidiar"),
  conjugateSpanish("spamear"), conjugateSpanish("whatsappear"), conjugateSpanish("wasapear"), conjugateSpanish("insistir"), conjugateSpanish("comunicar"),
  conjugateSpanish("hablar"), conjugateSpanish("importunar"), conjugateSpanish("incomodar"), conjugateSpanish("chatear"), conjugateSpanish("joder"),
  conjugateSpanish("chingar"), conjugateSpanish("fregar", { stressedStem: "frieg" }), conjugateSpanish("jorobar"), conjugateSpanish("telefonear"),
]);
export const ES_CALL_LEMMA_RE = /^(?:llam|marc|telefone)/;

// English communication lexicon used inside other languages' frames (code-switching)
export const EN_COMM_VERB = "(?:text(?:ing|s|ear|earme)?|txt(?:ing)?|msg(?:ing|s)?|messag(?:e|es|ing)|sms|send(?:ing)?|call(?:ing|s)?|contact(?:ing)?|whats\\s*app\\w*|whatsapp\\w*|inbox|pm|dm|spam(?:ming)?|email(?:ing)?|reach(?:ing)?\\s+out)";
export const EN_COMM_NOUN = "(?:texts?|txts?|msgs?|messages?|sms|calls?|emails?|spam|whats\\s*apps?|dms?|pms?)";

// ── Spanish matching view ──────────────────────────────────────────────────
// lower-case, curly apostrophes normalized; a word-final é / ó (a preterite: "quité", "dejé", "sacó")
// is MARKED so it can never read as the usted imperative ("quite", "deje"); then accents are folded
// and letter elongation collapsed.
export function spanishView(lower = "") {
  return String(lower)
    .replace(/(\p{L}{2,}[éó])(?![\p{L}\p{N}])/gu, (w) => `${w}xpret`)
    .normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC")
    .replace(/ñ/g, "n")
    .replace(/([a-z])\1{2,}/g, "$1");
}

// ── whole-message UNCERTAIN stop-like words (S3) ───────────────────────────
// A short message that is only one of these (plus fillers / punctuation / emoji) in a language we do not
// converse in MAY be a stop ("enough", "that's it", "never mind"): a person decides, every automated path
// is held meanwhile. Never a confident opt-out (that is the grammar's), never ignored.
export const UNCERTAIN_STOP_WORDS = Object.freeze({
  Vietnamese: ["thôi", "thôi đi", "thôi nhé", "thôi nha", "thôi ạ", "thôi khỏi", "thôi khỏi đi", "khỏi", "khỏi đi", "khỏi cần", "đủ rồi", "đủ rồi đó", "thôi được rồi", "thoi", "thoi di", "khoi", "du roi"],
  Korean: ["됐어요", "됐어", "됐습니다", "됐다", "됐거든요", "됐고요", "이제 됐어요", "됐어요 이제", "괜찮습니다 그만", "그만 됐어요", "이제 그만요"],
  Arabic: ["خلاص", "خلاص بقى", "خلص", "كفى", "كفايه", "كفاية", "يكفي", "بس", "بس خلاص", "بلاش", "خلاص يا اخي", "يا اخي خلاص"],
  "Haitian Creole": ["ase", "ase ato", "ase atò", "sa ase", "ase konsa", "bon ase", "kite sa", "kite sa la", "fini", "fini ak sa", "sa fini", "ase la"],
  Tagalog: ["ayoko na", "wag na", "huwag na", "sige na lang", "enough na", "ayaw ko na", "wag na po", "huwag na po", "ayoko na po"],
  Spanish: ["ya estuvo", "ya chole", "chole", "párenle", "parenle", "ya párenle", "ya parenle", "bájenle", "ya bájenle", "suficiente", "ya fue", "ya no más", "ya no mas", "ya stop", "ya es suficiente", "es suficiente", "bájenme", "bajenme", "ya bájenme", "bájame", "bájeme", "bajame"],
  Portuguese: ["chega", "já chega", "ja chega", "chega disso", "chega né", "para com isso", "pare com isso", "basta", "já deu", "ja deu"],
  French: ["ça suffit", "ca suffit", "assez", "c'est assez", "laissez tomber", "laisse tomber", "ça va aller", "stop là", "basta"],
  Italian: ["lascia stare", "lasciate stare", "lasci stare", "finiscila", "finitela", "piantala", "piantatela", "ora basta", "adesso basta"],
  Polish: ["dość", "dosyć", "wystarczy", "koniec", "daj spokój", "dajcie spokój", "dość tego", "starczy"],
  Russian: ["довольно", "не надо", "не надо больше", "всё хватит", "все хватит", "достаточно", "отстань уже", "прекратите уже"],
  // "不用了" / "唔使啦" = "no thanks" (plain disinterest, nurture) — deliberately absent
  Mandarin: ["够了", "夠了", "算了", "得了", "行了够了", "别了", "別了", "得啦", "算啦", "夠喇", "夠啦", "够啦", "收皮", "唔好啦"],
});
const UNCERTAIN_FILLERS_RE = /(?:^|\s)(?:ok|okay|pls|please|por\s+favor|porfa|xfa|po|na|nha|nhé|nhe|ạ|a|đi|di|yo|ya|plz|thanks?|gracias|merci|grazie|obrigad[oa]|cảm\s+ơn|cam\s+on|감사합니다|شكرا|спасибо|dziękuję|dziekuje|謝謝|谢谢|唔該|mèsi|mesi|salamat)(?=\s|$)/giu;

const UNCERTAIN_INDEX = new Map();
for (const [language, words] of Object.entries(UNCERTAIN_STOP_WORDS)) {
  for (const w of words) UNCERTAIN_INDEX.set(bareKey(w), language);
}
function bareKey(s) {
  return String(s ?? "").normalize("NFC").toLowerCase()
    .replace(/[’‘`´ʼ]/g, "'")
    .replace(/[\p{P}\p{S}\p{Extended_Pictographic}]+/gu, " ")
    .replace(/\s+/g, " ").trim();
}
/** The whole message is an uncertain stop-like word of one of the 12 languages. */
export function matchUncertainStopWord(message = "") {
  const key = bareKey(message);
  if (!key || key.length > 40) return null;
  const candidates = [key, key.replace(UNCERTAIN_FILLERS_RE, " ").replace(/\s+/g, " ").trim()];
  for (const k of candidates) {
    if (k && UNCERTAIN_INDEX.has(k)) return { language: UNCERTAIN_INDEX.get(k), token: k };
    // a repeated word ("ase ase", "thôi thôi")
    const parts = k.split(" ");
    if (parts.length >= 2 && parts.every((p) => p === parts[0]) && UNCERTAIN_INDEX.has(parts[0])) return { language: UNCERTAIN_INDEX.get(parts[0]), token: parts[0] };
  }
  return null;
}

// ── OBJECT / TARGET analysis of a stop word ────────────────────────────────
// What is being stopped, and is it us / our messages?
//   'bare'           the stop word stands alone (its own sentence / clause, fillers only): it is about this
//                    conversation → a stop
//   'communication'  its object is communication or the addressee ("basta de mensajes", "para de escribir",
//                    "basta con ustedes", "stop texting")
//   'other'          its object is something else ("basta con ese inquilino", "pare de llorar"), it is a
//                    preposition / adjective ("Para mí…", "no es suficiente"), or the stop is a NEGATED,
//                    first-person continuation ("j'arrête pas de recevoir des offres", "can't stop thinking")
export const COMM_TARGET_RE = new RegExp(
  "(?<![\\p{L}])(?:mensaj\\w*|msjs?|mjs|textos?|sms|llamad\\w*|whats\\w*|wasap\\w*|correos?|contacto|comunicaci\\w*|envios?|publicidad|spam|notificaci\\w*" +
  "|escrib\\w*|mand\\w*|envi\\w*|contact\\w*|llam\\w*|molest\\w*|textea\\w*|texte\\w*|mensaje\\w*|insist\\w*|joder\\w*|chinga\\w*|frega\\w*" +
  "|ustedes|usted|ti|vos|tu|ust|uds|ud|you|u|y'?all|ya'?ll|your|ur" +
  "|messages?|messagerie|appels?|textos?|ecrire|envoyer|appeler|contacter|harcel\\w*|sollicit\\w*|vos|votre" +
  "|mensage\\w*|ligac\\w*|ligar|liga\\w*|escrever|mandar|voces|vocês" +
  "|messaggi\\w*|chiamat\\w*|scriver\\w*|chiamar\\w*|contattar\\w*" +
  "|texts?|texting|txts?|msgs?|messaging|calls?|calling|contacting|emails?|emailing|writing|bugging|bothering|harass\\w*|reaching\\s+out" +
  "|it|this|that|esto|eso|ça|ca|isso|questo)(?![\\p{L}])",
  "iu",
);
/** Communication objects only (no pronoun / addressee): what a FIRST-PERSON stop must name to be about us. */
export const COMM_OBJECT_RE = /(?<![\p{L}])(?:texts?|texting|txts?|msgs?|messages?|messaging|calls?|calling|contacting|contact\s+me|emails?|emailing|writing\s+(?:me|you)|reaching\s+out|talking\s+to\s+(?:you|u)|hearing\s+from\s+(?:you|u)|getting\s+(?:your|these)\s+\w+|responding|replying)(?![\p{L}])/iu;
const FILLER_AFTER_STOP_RE = /^(?:\s*(?:ya|por\s+favor|porfa|porfavor|xfa|gracias|ok|okay|please|pls|plz|now|already|ahora|ahorita|de\s+una\s+vez|en\s+serio|ok\s+gracias|señor|senor|señora|senora|amigo|man|bro|\p{Extended_Pictographic}|[!¡.…]+))*\s*$/iu;

/**
 * @param {string} text           the message
 * @param {RegExp} keywordRe      the stop keyword (non-global), e.g. /(?<![\p{L}])basta(?![\p{L}])/iu
 * @returns {'bare'|'communication'|'other'|'absent'}
 */
export function stopKeywordTarget(text = "", keywordRe) {
  const s = String(text ?? "").normalize("NFC");
  const m = keywordRe.exec(s);
  if (!m) return "absent";
  const before = s.slice(0, m.index);
  // negated / first-person continuation: "no es suficiente", "no paro de", "je n'arrête pas", "can't stop"
  if (/(?:^|[^\p{L}])(?:no|nunca|jamás|jamas|ni|não|nao|non|ne|n'|pas|not|can'?t|cannot|couldn'?t|won'?t|wouldn'?t|don'?t|didn'?t|doesn'?t|never|nie|не)\s*$/iu.test(before)) return "other";
  // adjective / noun use: "es muy alto", "lo suficiente", "el alto", "un alto en el camino", "más que suficiente"
  if (/(?:^|[^\p{L}])(?:muy|mas|más|tan|demasiado|bastante|bien|es|está|esta|son|están|estan|era|fue|sea|lo|el|la|un|una|del|al|que|precio|monto|oferta|tiene|tienen)\s*$/iu.test(before)) return "other";
  // the rest of the clause after the keyword
  const after = s.slice(m.index + m[0].length);
  const clause = after.split(/[.!?;\n]|,(?=\s*\p{L})/u)[0] ?? "";
  if (FILLER_AFTER_STOP_RE.test(clause)) return "bare";
  if (COMM_TARGET_RE.test(clause)) return "communication";
  return "other";
}

/** A stop VERB that is negated with a first-person / continuation reading ("je n'arrête pas de", "j'arrête pas de", "no paro de", "não paro de", "non smetto di", "nie przestaję", "can't stop"). */
export const NEGATED_CONTINUATION_RE = new RegExp(
  [
    "(?:^|[^\\p{L}])(?:je\\s+n['’]?\\s*|j['’]\\s*|on\\s+n['’]?\\s*|ils\\s+n['’]?\\s*|ça\\s+n['’]?\\s*|ca\\s+n['’]?\\s*)?(?:arr[eê]te|arr[eê]tent|arr[eê]tons|cesse|cessent)\\s+(?:pas|plus|jamais)\\s+d['’e]?",
    "(?:^|[^\\p{L}])n['’]\\s*(?:arr[eê]te|arr[eê]tent|cesse|cessent)\\s+(?:pas|plus|jamais)\\s+d['’e]?",
    "(?:^|[^\\p{L}])(?:yo\\s+)?(?:no|nunca|jam[aá]s)\\s+(?:paro|dejo|paramos|dejamos|he\\s+parado|he\\s+dejado|puedo\\s+dejar|puedo\\s+parar|paran|dejan|para|deja|paras|dejas|paraste|dejaste|han\\s+parado|han\\s+dejado)\\s+de",
    "(?:^|[^\\p{L}])(?:vous|tu|ils|elles)\\s+n['’]?\\s*(?:arr[eê]tez|arr[eê]tes|arr[eê]tent|cessez|cessent)\\s+(?:pas|jamais|plus)\\s+d['’e]?",
    "(?:^|[^\\p{L}])(?:you|u|y'?all|ya'?ll|they|you\\s+guys|you\\s+people)\\s+(?:never|don'?t|won'?t|can'?t|just\\s+won'?t)\\s+stop\\s+\\p{L}+ing",
    "(?:^|[^\\p{L}])(?:eu\\s+)?(?:n[aã]o|nunca)\\s+(?:paro|deixo|consigo\\s+parar)\\s+de",
    "(?:^|[^\\p{L}])non\\s+(?:smetto|riesco\\s+a\\s+smettere)\\s+di",
    "(?:^|[^\\p{L}])nie\\s+(?:przestaj[eę]|mog[eę]\\s+przesta[cć])",
    "(?:^|[^\\p{L}])(?:i\\s+|we\\s+)?(?:can'?t|cannot|can\\s+not|couldn'?t|won'?t|wouldn'?t|don'?t|didn'?t|never|not\\s+gonna|not\\s+going\\s+to)\\s+stop\\s+\\p{L}+ing",
  ].join("|"),
  "iu",
);
/** The continued activity of a negated continuation is OUR communication ("no paran de mandarme mensajes"). */
export const CONTINUATION_COMM_OBJECT_RE = /(?<![\p{L}])(?:vos\s+(?:messages|textos|sms|appels)|m['’]\s*(?:écrire|ecrire|envoyer|appeler)|de\s+me\s+(?:contacter|harceler|relancer)|sus\s+mensajes|tus\s+mensajes|sus\s+textos|sus\s+llamadas|escribirme|mandarme\s+mensajes|enviarme\s+mensajes|llamarme|contactarme|suas\s+mensagens|me\s+mandar|me\s+ligar|your\s+(?:texts?|messages?|calls?)|(?:getting|receiving)\s+(?:your|these|ur)\s+(?:texts?|messages?)|texting\s+me|messaging\s+me|calling\s+me|contacting\s+me)(?![\p{L}])/iu;

/** A stop with a FIRST-PERSON subject ("I need to stop the foreclosure", "we had to stop renting it") is not addressed to us — unless its object is communication. */
export const FIRST_PERSON_STOP_RE = /(?:^|[^\p{L}'])(?:i|we|i'?ll|i'?m|i'?d|i'?ve|we'?re|we'?ll)\s+(?:(?:just|really|have|had|need|needed|want|wanted|got|gotta|gonna|going|to|would|like|should|will|might|must|could|can|tried|trying|plan|planning|hope|decided)\s+){0,4}stop(?:ped|ping)?\s+(?<obj>[^.,!?;\n]{0,60})/iu;

/**
 * Is a stop WORD in this message aimed at us / our messages? (bare, or a communication object). A stop word whose
 * target is something else, used as a preposition / adjective, or negated is not a revocation.
 * @param {string} text
 * @param {string} word   the keyword ("basta", "para", "alto", "suficiente", "arrête")
 */
export function stopWordTargetsUs(text = "", word = "") {
  const w = String(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const t = stopKeywordTarget(text, new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, "iu"));
  return t === "bare" || t === "communication";
}

const CONTINUATION_G = new RegExp(NEGATED_CONTINUATION_RE.source, "giu");
const TARGETED_STOP_WORDS = ["basta", "parar", "alto"];
/** The text with every stop that is NOT aimed at us blanked out (pure): a negated first-person continuation, a
 *  first-person stop of something other than communication, a Spanish stop word aimed at a third party. */
export function stopSpansAimedAtUs(text) {
  let u = String(text ?? "");
  if (NEGATED_CONTINUATION_RE.test(u) && !CONTINUATION_COMM_OBJECT_RE.test(u)) u = u.replace(CONTINUATION_G, " ");
  for (let i = 0; i < 4; i += 1) {
    const fp = FIRST_PERSON_STOP_RE.exec(u);
    if (!fp || COMM_OBJECT_RE.test(String(fp.groups?.obj || ""))) break;
    u = `${u.slice(0, fp.index)} ${u.slice(fp.index + fp[0].length)}`;
  }
  for (const w of TARGETED_STOP_WORDS) {
    const re = new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, "iu");
    if (re.test(u) && !stopWordTargetsUs(u, w)) u = u.replace(new RegExp(re.source, "giu"), " ");
  }
  return u;
}
