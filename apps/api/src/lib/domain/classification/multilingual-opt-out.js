// ─── multilingual-opt-out.js ────────────────────────────────────────────────
// COMPLIANCE (owner 2026-10-07): a confident opt-out in ANY registry language
// is an opt-out. It goes to the canonical suppression path in the LIVE
// classifier, independent of every conversation flag. Compliance classification
// and conversational autonomy are separate switches.
//
// HIGH PRECISION by construction:
//   • whole-message STOP keywords only (the carrier-keyword convention): "停止",
//     "Stopp", "Arrêtez", "Стоп" — never a keyword buried in other text;
//   • otherwise an explicit CONTACT-REVOCATION phrase: a stop / don't verb bound
//     to a contact object (write / text / message / contact / call / number /
//     list). Plain negatives ("no", "not interested", "I don't want to sell")
//     are NOT opt-outs — they are nurture. Insults are NOT opt-outs unless they
//     carry a revocation phrase.
// Rules only, no AI. English and Spanish keep their existing classifier lists;
// the Spanish entries here fill colloquial forms those lists miss.

export const MULTILINGUAL_OPT_OUT_VERSION = "multilingual_opt_out_v1_2026_10_07";

const fold = (s) => String(s ?? "").normalize("NFC").trim();
// Marks (\p{M}) are part of the word: Devanagari / Thai vowel signs must survive the trim.
const bareOf = (s) => fold(s).replace(/^[^\p{L}\p{M}\p{N}]+/u, "").replace(/[^\p{L}\p{M}\p{N}]+$/u, "").toLowerCase();

/** Whole-message STOP keywords per language (after trimming punctuation). */
const EXACT_KEYWORDS = Object.freeze({
  Spanish: ["pare", "parar", "detener", "deténgase", "detengase", "cancelar", "baja", "darme de baja"],
  Portuguese: ["pare", "parar", "cancelar", "sair", "descadastrar"],
  French: ["arrêt", "arret", "arrêtez", "arretez", "stop svp", "désabonner", "desabonner", "désinscrire"],
  German: ["stopp", "abbestellen", "abmelden", "aufhören", "aufhoeren"],
  Italian: ["basta messaggi", "annulla iscrizione", "cancellami", "disiscrivimi"],
  Polish: ["stop proszę", "wypisz", "wypisz mnie", "rezygnuję", "rezygnuje"],
  Vietnamese: ["dừng", "dừng lại", "ngừng", "ngừng lại", "hủy", "huỷ"],
  Mandarin: ["停止", "退订", "取消订阅", "停", "别发了", "不要发了"],
  Korean: ["중지", "중단", "수신거부", "수신 거부", "그만"],
  Japanese: ["停止", "配信停止", "解除", "やめて", "止めて"],
  Hebrew: ["הסר", "הסרה", "עצור", "תפסיק"],
  Arabic: ["توقف", "الغاء", "إلغاء", "ايقاف", "إيقاف"],
  Russian: ["стоп", "отписаться", "отписка"],
  Greek: ["στοπ", "σταματήστε", "σταμάτα", "διαγραφή"],
  "Indian (Hindi or Other)": ["बंद करो", "बंद करें", "रोको", "स्टॉप"],
});

/** Contact-revocation phrases (anywhere in the message). */
const PHRASES = Object.freeze([
  ["Spanish", /\bd[eé]j(?:a|e|en|ame)\s+de\s+(?:escribir(?:me)?|mandar(?:me)?|enviar(?:me)?|contactar(?:me)?|llamar(?:me)?|molestar(?:me)?)\b|\bya\s+no\s+me\s+(?:escribas?|mandes?|env[ií]es?|contactes?|llames?)\b|\bno\s+me\s+vuelvas?\s+a\s+(?:escribir|mandar|contactar|llamar)\b|\bno\s+me\s+(?:mandes?|mande|env[ií]es?|env[ií]e)\s+(?:m[aá]s\s+)?(?:mensajes|textos)\b|\b(?:b[oó]rr|quit|sac)(?:a|e|en)(?:me)?\s+de\s+(?:tu|su)\s+lista\b|\bborre\s+mi\s+n[uú]mero\b/i],
  ["Portuguese", /\bpar[ea]\s+de\s+(?:me\s+)?(?:mandar|enviar|escrever|ligar|contatar|incomodar)\b|\bn[aã]o\s+me\s+(?:mande|envie|escreva|ligue|contate|procure)\s+mais\b|\b(?:remova|tire|apague)\s+(?:o\s+)?meu\s+n[uú]mero\b|\bme\s+(?:tire|remova)\s+da\s+(?:sua\s+)?lista\b/i],
  ["French", /\barr[eê]te[sz]?\s+de\s+m['’]?\s*(?:[eé]crire|envoyer|contacter|appeler|harceler)\b|\bne\s+m['’]?\s*(?:[eé]crivez|envoyez|contactez|appelez)\s+plus\b|\b(?:supprimez|retirez|effacez)\s+mon\s+num[eé]ro\b|\bretirez[- ]moi\s+de\s+(?:votre|la)\s+liste\b/i],
  ["German", /\bh[oö]ren\s+sie\s+auf,?\s+mir\s+zu\s+(?:schreiben|simsen|texten)\b|\bh[oö]r\s+auf,?\s+mir\s+zu\s+schreiben\b|\bschreiben\s+sie\s+mir\s+nicht\s+mehr\b|\bkontaktieren\s+sie\s+mich\s+nicht\s+mehr\b|\bkeine\s+(?:nachrichten|sms|textnachrichten)\s+mehr\b|\bl[oö]schen\s+sie\s+meine\s+nummer\b|\bnehmen\s+sie\s+mich\s+(?:von|aus)\s+(?:der|ihrer)\s+liste\b/i],
  ["Italian", /\bsmett(?:a|ete|i)\s+di\s+(?:scrivermi|contattarmi|mandarmi|chiamarmi|messaggiarmi)\b|\bnon\s+(?:contattarmi|scrivermi|chiamarmi)\b|\bnon\s+mi\s+(?:contatti|contattate|scriva|scrivete|mandi|mandate|chiami)\s+pi[uù](?=$|[\s.,!?])|\bnon\s+mi\s+(?:mandi|mandate|scriva)\s+(?:altri\s+)?messaggi\b|\bcancell(?:i|ate)\s+il\s+mio\s+numero\b|\btogli(?:etemi|mi)\s+dalla\s+lista\b/i],
  ["Polish", /prosz[eę]\s+(?:mi\s+)?przesta[cć]\s+(?:do\s+mnie\s+)?(?:pisa[cć]|dzwoni[cć]|wysy[łl]a[cć])|przesta[nń](?:cie)?\s+(?:do\s+mnie\s+)?(?:pisa[cć]|dzwoni[cć])|\bnie\s+(?:piszcie|pisz|dzwo[nń]cie|dzwo[nń])\s+(?:wi[eę]cej\s+)?do\s+mnie\b|usu[nń](?:cie)?\s+m[oó]j\s+numer/i],
  ["Vietnamese", /đừng\s+(?:nhắn\s+tin|nhắn|liên\s+lạc|gọi|làm\s+phiền)(?:\s+(?:cho|với))?\s+tôi|ngừng\s+nhắn(?:\s+tin)?|xóa\s+số\s+(?:điện\s+thoại\s+)?(?:của\s+)?tôi|không\s+(?:được\s+)?nhắn\s+tin\s+cho\s+tôi\s+nữa/i],
  ["Mandarin", /(?:不要|别|勿)再?(?:给我)?(?:发|传)(?:短信|信息|消息)|(?:不要|别|勿)再?(?:联系|打扰|打电话给)我|把我(?:的(?:号码|电话))?(?:删(?:掉|除)|移除)|停止(?:给我)?(?:发送?|联系)/],
  ["Korean", /문자\s*(?:그만\s*(?:보내|해)|보내지\s*마)|연락\s*(?:그만\s*(?:하|해)|하지\s*마)|더\s*이상\s*(?:연락|문자)\s*하지|번호\s*(?:지워|삭제해)/],
  ["Japanese", /(?:もう)?(?:連絡|メッセージ|メール|ショートメール)(?:を)?(?:しないで|送らないで|やめて)|連絡(?:は)?不要|番号を(?:消して|削除して)/],
  ["Hebrew", /(?:תפסיק|תפסיקו|הפסק|הפסיקו)\s+(?:לשלוח|לכתוב|להתקשר|לפנות)|אל\s+(?:תשלח|תשלחו|תכתוב|תכתבו|תתקשר|תפנה)\s+(?:לי\s+)?(?:יותר|עוד)|(?:תמחק|תמחקו|הסר|הסירו)\s+את\s+(?:המספר|מספר\s+הטלפון)\s+שלי/],
  ["Arabic", /(?:توقف|توقفوا|كف|كفوا)\s+عن\s+(?:مراسلتي|إرسال|ارسال|الاتصال|التواصل|إزعاجي|ازعاجي)|لا\s+(?:ترسل|ترسلوا|تراسلني|تتصل|تتصلوا)\s+(?:بي|لي)?\s*(?:مرة\s+أخرى|مجددا|مجدداً|بعد\s+الآن)?|(?:احذف|احذفوا|امسح)\s+رقمي/],
  ["Russian", /(?:перестаньте|прекратите|хватит)\s+(?:мне\s+)?(?:писать|звонить|присылать|отправлять)|не\s+(?:пишите|звоните)\s+мне|больше\s+не\s+(?:пишите|звоните)|удалите\s+мой\s+номер/i],
  ["Greek", /σταματήστε\s+να\s+(?:μου\s+)?(?:στέλνετε|γράφετε|τηλεφωνείτε)|μη(?:ν)?\s+μου\s+(?:στέλνετε|ξαναστείλετε|γράφετε|τηλεφωνείτε)|διαγράψτε\s+τον\s+αριθμό\s+μου/i],
  ["Indian (Hindi or Other)", /(?:मैसेज|मेसेज|संदेश|एसएमएस)\s+(?:भेजना\s+|करना\s+)?बंद\s+(?:करो|करें|कीजिए|कर\s+दो)|(?:मुझे\s+)?(?:मैसेज|मेसेज|संदेश)\s+मत\s+(?:करो|कीजिए|भेजो|भेजिए)|(?:मुझसे\s+)?संपर्क\s+मत\s+(?:करो|कीजिए|करें)|मेरा\s+नंबर\s+(?:हटा|डिलीट)/],
]);

const EXACT_INDEX = new Map();
for (const [language, words] of Object.entries(EXACT_KEYWORDS)) for (const w of words) if (!EXACT_INDEX.has(w)) EXACT_INDEX.set(w, language);

/**
 * A confident opt-out in a registry language, or null.
 * @returns {{ language, rule_id, kind: 'keyword'|'phrase', version } | null}
 */
export function matchMultilingualOptOut(message = "") {
  const raw = fold(message);
  if (!raw) return null;
  const bare = bareOf(raw);
  if (EXACT_INDEX.has(bare)) {
    const language = EXACT_INDEX.get(bare);
    return { language, rule_id: `ml_opt_out_keyword_${language.split(" ")[0].toLowerCase()}`, kind: "keyword", version: MULTILINGUAL_OPT_OUT_VERSION };
  }
  for (const [language, re] of PHRASES) {
    if (re.test(raw)) return { language, rule_id: `ml_opt_out_phrase_${language.split(" ")[0].toLowerCase()}`, kind: "phrase", version: MULTILINGUAL_OPT_OUT_VERSION };
  }
  return null;
}

export function isMultilingualOptOut(message = "") {
  return matchMultilingualOptOut(message) !== null;
}

export default matchMultilingualOptOut;
