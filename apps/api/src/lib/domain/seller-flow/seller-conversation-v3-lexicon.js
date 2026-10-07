// ─── seller-conversation-v3-lexicon.js ──────────────────────────────────────
// Acquisition OS v1 §34/§37/§74: language → intent → CANONICAL intent, rules
// only. The classifier (classify.js rounds 1–8) reads English and Spanish in
// depth and the other registry languages mostly for yes/no; this lexicon fills
// the canonical turns the machine needs in EVERY registry language — opt-out,
// who/why, "make me an offer", not interested, a condition answer — so one
// state machine serves every language. Used only by the v3 planner (flag
// SELLER_CONVERSATION_V3); it never overrides a classifier verdict that
// already names one of these intents, and it never invents a price.
//
// Patterns are deliberately phrase-level (not single ambiguous words such as
// "no" / "ok"), in native script. A hit also names the message's language.

export const LEXICON_VERSION = "seller_conversation_v3_lexicon_v1";

export const LEXICON_INTENTS = Object.freeze({
  OPT_OUT: "opt_out",
  WHO_WHY: "who_why",
  OFFER_REQUEST: "offer_request",
  NOT_INTERESTED: "not_interested",
  CONDITION: "condition_answer",
});

const L = LEXICON_INTENTS;

/** [language, intent, pattern]. Order: opt-out first (compliance wins). */
const RULES = [
  // ── OPT-OUT ────────────────────────────────────────────────────────────
  ["English", L.OPT_OUT, /\b(?:stop\s+(?:texting|messaging|contacting)|don'?t\s+(?:text|message|contact)\s+me|remove\s+(?:me|my\s+number)|take\s+me\s+off|unsubscribe|lose\s+my\s+number)\b/i],
  ["Spanish", L.OPT_OUT, /\bno\s+me\s+(?:mande|mandes|env[ií]e|env[ií]es|escriba|escribas|contacte|contactes|vuelva\s+a\s+escribir)\b|\b(?:deje|dejen|deja)\s+de\s+(?:escribirme|mandarme|enviarme|contactarme)\b|\b(?:b[oó]rre(?:me)?|quite|quiten)\s+(?:mi\s+n[uú]mero|me\s+de\s+su\s+lista)\b/i],
  ["Portuguese", L.OPT_OUT, /\bpar[ea]\s+de\s+(?:me\s+)?(?:mandar|enviar|escrever)|\bn[aã]o\s+me\s+(?:mande|envie|escreva|contate)|\bremova\s+meu\s+n[uú]mero/i],
  ["French", L.OPT_OUT, /\barr[eê]te[sz]?\s+de\s+m'?(?:[eé]crire|envoyer|contacter)|\bne\s+m'?(?:[eé]crivez|envoyez|contactez)\s+plus|\bsupprimez\s+mon\s+num[eé]ro|\bd[eé]sabonn/i],
  ["German", L.OPT_OUT, /\bh[oö]ren\s+sie\s+auf,?\s+mir\s+zu\s+schreiben|\bschreiben\s+sie\s+mir\s+nicht\s+mehr|\bkeine\s+(?:nachrichten|sms)\s+mehr|\bl[oö]schen\s+sie\s+meine\s+nummer/i],
  ["Italian", L.OPT_OUT, /\bsmett(?:a|ete|i)\s+di\s+(?:scrivermi|contattarmi|mandarmi)|\bnon\s+mi\s+(?:scriva|scrivete|contatti|mandi)\s+pi[uù]|\bcancell(?:i|ate)\s+il\s+mio\s+numero/i],
  ["Polish", L.OPT_OUT, /\bprosz[eę]\s+przesta[cć]\s+(?:do\s+mnie\s+)?pisa[cć]|\bnie\s+(?:pisz|piszcie|pisa[cć])\s+do\s+mnie|\busu[nń](?:cie)?\s+m[oó]j\s+numer/i],
  ["Vietnamese", L.OPT_OUT, /đừng\s+nhắn\s+tin|ngừng\s+nhắn|đừng\s+liên\s+lạc|xóa\s+số\s+(?:của\s+)?tôi/i],
  ["Mandarin", L.OPT_OUT, /别再(?:给我)?发(?:短信|信息|消息)|不要再(?:给我)?发|不要(?:再)?联系我|别(?:再)?联系我|把我(?:的号码)?删(?:掉|除)/],
  ["Korean", L.OPT_OUT, /문자\s*(?:그만|보내지\s*마)|연락\s*(?:그만|하지\s*마)|번호\s*(?:지워|삭제)/],
  ["Japanese", L.OPT_OUT, /(?:もう)?連絡しないで|メッセージ(?:を)?送らないで|配信停止|番号を消して/],
  ["Hebrew", L.OPT_OUT, /תפסיק(?:ו)?\s+(?:לשלוח|לכתוב)|אל\s+(?:תשלח|תכתוב|תפנה)|תמחק(?:ו)?\s+את\s+המספר/],
  ["Arabic", L.OPT_OUT, /توقف(?:وا)?\s+عن\s+(?:مراسلتي|إرسال|الإرسال)|لا\s+(?:ترسل|تراسلني|تتصل)|احذف(?:وا)?\s+رقمي/],
  ["Russian", L.OPT_OUT, /перестаньте\s+(?:мне\s+)?писать|не\s+пишите\s+мне|удалите\s+мой\s+номер|больше\s+не\s+пишите/i],
  ["Greek", L.OPT_OUT, /σταματήστε\s+να\s+(?:μου\s+)?(?:στέλνετε|γράφετε)|μη(?:ν)?\s+μου\s+(?:στέλνετε|γράφετε)|διαγράψτε\s+τον\s+αριθμό/i],
  ["Indian (Hindi or Other)", L.OPT_OUT, /मैसेज\s+(?:करना\s+)?बंद\s+कर|मैसेज\s+मत\s+(?:करो|कीजिए|भेजो)|संपर्क\s+मत\s+कर|मेरा\s+नंबर\s+हटा/],

  // ── WHO / WHY / HOW DID YOU GET MY NUMBER ──────────────────────────────
  ["Portuguese", L.WHO_WHY, /\bquem\s+(?:é|e|fala)(?=$|[\s?!.,])|\bpor\s*que\s+(?:está|esta|você|voce)\s+(?:perguntando|me\s+escrevendo)|\bcomo\s+(?:conseguiu|pegou)\s+(?:o\s+)?meu\s+n[uú]mero/i],
  ["French", L.WHO_WHY, /\bqui\s+(?:est-ce|êtes-vous|etes-vous|est\s+là|parle)\b|\bpourquoi\s+(?:vous\s+)?(?:me\s+)?demande[zs]?|\bcomment\s+avez-vous\s+(?:eu|obtenu)\s+mon\s+num[eé]ro/i],
  ["German", L.WHO_WHY, /\bwer\s+(?:ist\s+(?:da|das)|sind\s+sie|spricht)\b|\bwarum\s+(?:fragen|schreiben)\s+sie\b|\bwoher\s+haben\s+sie\s+meine\s+nummer/i],
  ["Italian", L.WHO_WHY, /\bchi\s+(?:è|e'|sei|parla|siete)(?=$|[\s?!.,])|\bperch[eé]\s+(?:me\s+lo\s+)?(?:chiede|chiedete|mi\s+scrive)|\bcome\s+(?:ha|avete)\s+(?:avuto|preso)\s+il\s+mio\s+numero/i],
  ["Polish", L.WHO_WHY, /\bkto\s+(?:m[oó]wi|to|pisze)\b|\bdlaczego\s+(?:pan|pani|pa[nń]stwo)?\s*pyta|\bskąd\s+(?:pan|pani|ma(?:cie)?)\s+(?:m[oó]j\s+)?numer/i],
  ["Vietnamese", L.WHO_WHY, /\bai\s+(?:vậy|đó|đấy|thế)\b|sao\s+(?:anh|chị|bạn)?\s*hỏi|tại\s+sao\s+(?:anh|chị|bạn)?\s*hỏi|lấy\s+số\s+(?:của\s+)?tôi\s+ở\s+đâu/i],
  ["Mandarin", L.WHO_WHY, /你是谁|您是哪位|哪位|为什么问|你为什么|怎么有我的(?:电话|号码)/],
  ["Korean", L.WHO_WHY, /누구세요|누구시죠|누구신가요|왜\s*(?:물어|그러)|제\s*번호\s*어떻게/],
  ["Japanese", L.WHO_WHY, /どなた|誰ですか|なぜ聞|どうして聞|なんで聞|番号をどこで/],
  ["Hebrew", L.WHO_WHY, /מי\s+(?:זה|את|אתה|מדבר)|למה\s+(?:אתה|את)\s+שואל|מאיפה\s+(?:יש\s+לך|השגת)\s+את\s+המספר/],
  ["Arabic", L.WHO_WHY, /من\s+(?:أنت|انت|معي|يتكلم)|لماذا\s+تسأل|ليش\s+تسأل|من\s+أين\s+(?:حصلت|جبت)\s+(?:على\s+)?رقمي/],
  ["Russian", L.WHO_WHY, /(?:^|[\s,.!?])кто\s+(?:это|вы|говорит)|почему\s+вы\s+(?:спрашиваете|пишете)|откуда\s+у\s+вас\s+мой\s+номер/i],
  ["Greek", L.WHO_WHY, /ποιος\s+(?:είναι|είστε)|γιατί\s+(?:ρωτάτε|ρωτάς|μου\s+γράφετε)|πού\s+βρήκατε\s+τον\s+αριθμό/i],
  ["Indian (Hindi or Other)", L.WHO_WHY, /आप\s+कौन|कौन\s+(?:है|हैं|बोल)|क्यों\s+पूछ|मेरा\s+नंबर\s+कहाँ\s+से/],

  // ── MAKE ME AN OFFER / WHAT'S YOUR OFFER ───────────────────────────────
  ["Spanish", L.OFFER_REQUEST, /\b(?:h[aá]game|hazme|m[aá]nde(?:me)?|d[eé]me)\s+(?:una\s+)?oferta\b|\b(?:cu[aá]l\s+es\s+su|qu[eé])\s+oferta\b|\bcu[aá]nto\s+(?:me\s+)?(?:ofrece|da)\b/i],
  ["Portuguese", L.OFFER_REQUEST, /\b(?:me\s+)?fa[cç]a\s+(?:uma\s+)?oferta\b|\bqual\s+(?:é\s+)?(?:a\s+)?sua\s+oferta\b|\bquanto\s+(?:você\s+)?oferece/i],
  ["French", L.OFFER_REQUEST, /\bfaites-moi\s+une\s+offre\b|\bquelle\s+est\s+votre\s+offre\b|\bcombien\s+(?:vous\s+)?(?:proposez|offrez)/i],
  ["German", L.OFFER_REQUEST, /\bmachen\s+sie\s+mir\s+ein\s+angebot\b|\bwas\s+ist\s+ihr\s+angebot\b|\bwie\s+viel\s+(?:bieten|zahlen)\s+sie\b/i],
  ["Italian", L.OFFER_REQUEST, /\bmi\s+faccia\s+un'?\s*offerta\b|\bqual\s*(?:è|e')\s+la\s+sua\s+offerta\b|\bquanto\s+(?:mi\s+)?offre\b/i],
  ["Polish", L.OFFER_REQUEST, /prosz[eę]\s+z[łl]o[zż]y[cć]\s+ofert[eęy]|\bjaka\s+jest\s+(?:pana|pani|wasza)\s+oferta\b|\bile\s+(?:pan|pani)\s+oferuje/i],
  ["Vietnamese", L.OFFER_REQUEST, /đưa\s+ra\s+giá|trả\s+giá\s+(?:đi|bao\s+nhiêu)|(?:anh|chị|bạn)\s+trả\s+bao\s+nhiêu|ra\s+giá\s+đi/i],
  ["Mandarin", L.OFFER_REQUEST, /你出(?:个)?价|出个价|您出价|报个价|你的报价|给我(?:一个)?报价|你能出多少/],
  ["Korean", L.OFFER_REQUEST, /제안해\s*주세요|가격\s*(?:제시|불러)|얼마\s*(?:주실|줄)|오퍼\s*(?:주세요|해\s*주세요)/],
  ["Japanese", L.OFFER_REQUEST, /オファーをください|オファーを出して|いくらで買|金額を提示|提示してください/],
  ["Hebrew", L.OFFER_REQUEST, /תציע\s+(?:לי\s+)?הצעה|מה\s+ההצעה\s+שלך|כמה\s+אתה\s+מציע/],
  ["Arabic", L.OFFER_REQUEST, /قدم\s+(?:لي\s+)?عرض|ما\s+(?:هو\s+)?عرضك|كم\s+تعرض|اعطني\s+عرض/],
  ["Russian", L.OFFER_REQUEST, /сделайте\s+(?:мне\s+)?предложение|какое\s+ваше\s+предложение|сколько\s+(?:вы\s+)?(?:предлагаете|дадите)/i],
  ["Greek", L.OFFER_REQUEST, /κάντε\s+μου\s+(?:μια\s+)?προσφορά|ποια\s+είναι\s+η\s+προσφορά\s+σας|πόσα\s+(?:δίνετε|προσφέρετε)/i],
  ["Indian (Hindi or Other)", L.OFFER_REQUEST, /ऑफ़र\s+(?:दीजिए|दो|दें)|ऑफर\s+(?:दीजिए|दो|दें)|आप\s+कितना\s+(?:देंगे|ऑफ़र)/],

  // ── NOT INTERESTED ─────────────────────────────────────────────────────
  ["Portuguese", L.NOT_INTERESTED, /\bn[aã]o\s+tenho\s+interesse|\bn[aã]o\s+(?:estou\s+)?interessad[oa]|\bn[aã]o\s+(?:quero\s+)?vender/i],
  ["French", L.NOT_INTERESTED, /\bpas\s+int[eé]ress[eé]|\bje\s+ne\s+(?:veux|vends)\s+pas|\bpas\s+[aà]\s+vendre/i],
  ["German", L.NOT_INTERESTED, /\bkein\s+interesse|\bnicht\s+interessiert|\b(?:will|möchte)\s+nicht\s+verkaufen|\bnicht\s+zu\s+verkaufen/i],
  ["Italian", L.NOT_INTERESTED, /\bnon\s+mi\s+interessa|\bnon\s+(?:sono\s+)?interessat[oa]|\bnon\s+(?:voglio\s+)?vendere/i],
  ["Polish", L.NOT_INTERESTED, /\bnie\s+jestem\s+zainteresowan|\bnie\s+interesuje\s+mnie|\bnie\s+sprzedaj[eę]/i],
  ["Vietnamese", L.NOT_INTERESTED, /không\s+quan\s+tâm|không\s+(?:muốn\s+)?bán/i],
  ["Mandarin", L.NOT_INTERESTED, /没(?:有)?兴趣|不感兴趣|不卖|不想卖/],
  ["Korean", L.NOT_INTERESTED, /관심\s*없|안\s*팔|팔\s*생각\s*없/],
  ["Japanese", L.NOT_INTERESTED, /興味(?:は)?(?:ありません|ない)|売りません|売る気はない|売るつもりはない/],
  ["Hebrew", L.NOT_INTERESTED, /לא\s+מעוניי[ןנ]|לא\s+(?:רוצה\s+)?(?:למכור|מוכר)/],
  ["Arabic", L.NOT_INTERESTED, /لست\s+مهتم|غير\s+مهتم|مش\s+مهتم|لا\s+أريد\s+البيع|لن\s+أبيع/],
  ["Russian", L.NOT_INTERESTED, /не\s+интересно|не\s+интересует|не\s+продаю|не\s+хочу\s+продавать/i],
  ["Greek", L.NOT_INTERESTED, /δεν\s+(?:ενδιαφέρομαι|με\s+ενδιαφέρει)|δεν\s+(?:πουλάω|θέλω\s+να\s+πουλήσω)/i],
  ["Indian (Hindi or Other)", L.NOT_INTERESTED, /दिलचस्पी\s+नहीं|रुचि\s+नहीं|नहीं\s+बेचना|बेचना\s+नहीं/],

  // ── CONDITION ANSWER (a repair / component named) ──────────────────────
  ["Spanish", L.CONDITION, /\b(?:techo|cimientos|plomer[ií]a|aire\s+acondicionado|cocina|ba[nñ]os?)\b|\bnecesita\s+(?:trabajo|reparaciones|arreglos)|\b(?:buen|mal)\s+estado\b/i],
  ["Portuguese", L.CONDITION, /\b(?:telhado|funda[cç][aã]o|encanamento|cozinha|banheiros?)\b|\bprecisa\s+de\s+(?:reforma|reparos)|\b(?:bom|mau)\s+estado\b/i],
  ["French", L.CONDITION, /\b(?:toit|toiture|fondations?|plomberie|cuisine|salle\s+de\s+bain)\b|\b(?:bon|mauvais)\s+[eé]tat\b|\btravaux\b/i],
  ["Polish", L.CONDITION, /(?:trzeba|wymieni|wymian|naprawy|potrzeb)\S*\s+(?:\S+\s+)?(?:dach|fundament|hydraulik|kuchni|łazienk|ogrzewani)|do\s+remontu|(?:dobry|zły)\s+stan|łazienk|ogrzewani/i],
  ["German", L.CONDITION, /\b(?:dach|fundament|heizung|klimaanlage|k[uü]che|bad(?:ezimmer)?|sanitär)\b|\brenovierungsbed[uü]rftig|\b(?:guter|schlechter)\s+zustand\b/i],
  ["Italian", L.CONDITION, /\b(?:tetto|fondamenta|impianto|cucina|bagn[oi]|caldaia)\b|\bda\s+ristrutturare\b|\b(?:buono|cattivo)\s+stato\b/i],
  ["Vietnamese", L.CONDITION, /mái\s+nhà|móng\s+nhà|ống\s+nước|nhà\s+bếp|phòng\s+tắm|cần\s+sửa|cần\s+làm\s+lại/i],
  ["Mandarin", L.CONDITION, /屋顶|房顶|地基|水管|厨房|浴室|卫生间|需要(?:修|装修|翻新|换)/],
  ["Korean", L.CONDITION, /지붕|기초|배관|부엌|주방|욕실|화장실|수리|고쳐야/],
  ["Japanese", L.CONDITION, /屋根|基礎|配管|キッチン|台所|浴室|風呂|修理|リフォーム|交換が必要/],
  ["Hebrew", L.CONDITION, /גג|יסודות|אינסטלציה|מטבח|אמבטיה|שיפוץ|צריך\s+תיקון/],
  ["Arabic", L.CONDITION, /سقف|أساسات|سباكة|مطبخ|حمام|يحتاج\s+(?:إلى\s+)?(?:إصلاح|ترميم|تصليح)/],
  ["Russian", L.CONDITION, /крыш[аиу]|фундамент|сантехник|кухн[яи]|ванн(?:ая|ой)|ремонт/i],
  ["Greek", L.CONDITION, /στέγη|θεμέλια|υδραυλικά|κουζίνα|μπάνιο|επισκευ|ανακαίνιση/i],
  ["Indian (Hindi or Other)", L.CONDITION, /छत|नींव|प्लंबिंग|रसोई|किचन|बाथरूम|मरम्मत|ठीक\s+करवा|नई\s+लगवा/],
];

const GOOD_STATE_RE =
  /\b(?:buen|bom|bon|guter|gutem|buono|buone|dobry|dobrym)\s+(?:estado|[eé]tat|zustand|stato|stanie|stan)\b|\b(?:sin|sem|sans|ohne|senza|bez)\s+(?:problemas?|probl[eè]mes?|probleme|problemi|problem[oó]w)\b|状况很好|状态很好|상태\s*좋|状態は良い|במצב\s+טוב|حالة\s+جيدة|в\s+хорошем\s+состоянии|σε\s+καλή\s+κατάσταση|अच्छी\s+हालत/i;

/**
 * The canonical intent a message carries in any registry language, or null.
 * @returns {{ intent, language, rule_id } | null}
 */
export function lexiconIntent(message = "") {
  const text = String(message ?? "").trim();
  if (!text) return null;
  for (const [language, intent, re] of RULES) {
    if (re.test(text)) {
      const hit = { intent, language, rule_id: `v3_lexicon_${intent}_${language.split(" ")[0].toLowerCase()}`, version: LEXICON_VERSION };
      // A condition answer naming a component / repair is a repair report unless it says "good shape".
      if (intent === L.CONDITION) hit.needs_work = !GOOD_STATE_RE.test(text);
      return hit;
    }
  }
  return null;
}

/** Languages / intents the lexicon covers (for the coverage matrix). */
export function lexiconCoverage() {
  const out = {};
  for (const [language, intent] of RULES) (out[language] ||= new Set()).add(intent);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

// Common English function / real-estate words. Ambiguous across languages
// ("no", "ok", "si") are deliberately absent: they prove nothing.
const ENGLISH_EVIDENCE_RE =
  /\b(?:huh|hmm|sale|sales|maybe|possibly|nope|nah|correct|right|absolutely|definitely|course|cash|buy|buyer|million|thousand|the|is|are|was|you|your|yes|yeah|yep|who|what|why|how|this|that|my|it|its|it's|have|has|sell|selling|sold|house|home|property|price|offer|wrong|number|stop|please|thanks|thank|not|interested|need|needs|roof|new|good|sure|call|text|me|we|they|of|for|and|to|in|on|at|with|lol|do|don't|can|will|would|there|here|own|owner)\b/i;
const LETTER_RE = /\p{L}/u;

/**
 * §35/§92 v3 reply-language resolution, on top of the classifier's:
 *   1. a lexicon hit names the language (it is native evidence);
 *   2. a message with no letters (a number, an emoji) speaks the thread's language;
 *   3. the classifier's English DEFAULT (no English words at all) in a thread we
 *      opened in another language is NOT English — it is the thread language;
 *   4. otherwise the classifier's language stands.
 * Never resolves to English without English evidence or an English thread.
 */
export function resolveV3ReplyLanguage({ message = "", classification = null, conversation_context = null, lexicon = null } = {}) {
  const detected = String(classification?.language ?? "").trim() || null;
  const thread =
    String(conversation_context?.seller_reply_language || conversation_context?.last_outbound_template_language || conversation_context?.last_outbound_language || "").trim() || null;
  const text = String(message ?? "");
  if (lexicon?.language) return { language: lexicon.language, source: "v3_lexicon", changed: lexicon.language !== detected };
  if (!LETTER_RE.test(text) && thread) return { language: thread, source: "v3_thread_no_letters", changed: thread !== detected };
  const source = String(classification?.reply_language_source || "").trim();
  // The classifier fell back to the thread language as read from our body; the
  // catalog language of the template we actually sent is authoritative.
  const template_language = String(conversation_context?.last_outbound_template_language || "").trim() || null;
  if (source === "thread" && template_language && template_language !== detected && !conversation_context?.seller_reply_language) {
    return { language: template_language, source: "v3_thread_template_language", changed: true };
  }
  // Only the classifier's DEFAULT: a seller reply it positively identified as English ("Huh?", "199k sale") stays English.
  if (detected === "English" && thread && thread !== "English" && !ENGLISH_EVIDENCE_RE.test(text) && source !== "language_switch_request") {
    return { language: thread, source: "v3_thread_not_english_default", changed: true };
  }
  return { language: detected, source: source || "classifier", changed: false };
}
